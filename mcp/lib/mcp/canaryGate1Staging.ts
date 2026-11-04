/**
 * lib/mcp/canaryGate1Staging.ts — lotul OAuth staging, partea C: orchestratorul PUR al probei automate (Gate 1 extins,
 * design rev3 §8). Ordinea: E0a–E0e, E1–E12, la final E14; fiecare cont de test e separat.
 *
 * Doctrina Gate 1 (canaryGate1.ts), păstrată:
 *   - IZOLARE ÎNAINTE DE PAȘI: `vetStagingProbe` (+ legătura cu env-ul procesului) rulează înainte ca fabrica de I/O
 *     (`makeIo`) să fie invocată → pe un config care atinge producția adaptoarele nici nu există.
 *   - CODURI ÎNCHISE: fiecare pas întoarce PASS sau FAIL + un cod din `StepCode`; raportul = cod + descriere STATICĂ a
 *     pasului. Nicio valoare primită (token, cod OAuth, email, corp) nu ajunge în raport.
 *   - NU ARUNCĂ: orice throw (pas, setup, cleanup) e prins și devine un cod generic (`threw`, `setup`).
 *   - I/O INJECTAT (`StagingProbeIo`): orchestratorul și toate deciziile (canaryGate1StagingChecks.ts) sunt testabile
 *     cu fake-uri; adaptoarele reale (canaryGate1StagingIo.ts / canaryGate1StagingBrowser.ts) sunt subțiri.
 *
 * Lanțuri (un FAIL blochează restul lanțului lui, nu și celelalte; un pas blocat e FAIL `blocked`, nu PASS):
 *   L  E0a → E0b → E0c → E0d → E0e        (calea veche + refresh legacy)
 *   D  E1                                   (descoperire)
 *   A  E2 → E3 → E3n → E4 → E5 → E6 → E7 → E8 → E9 → E10   (cont invitat A)
 *   B  E2n                                  (cont neinvitat B)
 *   X  E11 → E12                            (cont invitat C, expirare)
 *   R  E14_rpc → E14_select → E14_expiry → E14_admin       (cont D, drepturi PostgREST)
 * Cleanup-ul (sesiuni browser, invitații, clienți, useri — doar ce a creat rularea) rulează MEREU, best-effort, și
 * intră în verdict (reziduu = roșu, ca la `runWithGate1Fixture`).
 *
 * Redis: proba NU scrie în Redis până nu dovedește că `REDIS_URL` e Redis-ul staging-ului (E0a: tokenul emis de
 * server există în acest Redis). Singura scriere e fixture-ul E0e (cod + refresh legacy), cu funcțiile de produs.
 * Fixture pentru `tp_situation_report`: NU e nevoie (Redis gol → raport `ok:true`; vezi raportul părții C).
 *
 * LOGIN (conturile din browser: E2, E2n, E11) = fluxul PKCE REAL al produsului, fără nicio ramură de test în produs:
 *   (invitație: linkul `/signup/invite?token=…` în ACELAȘI context →) `/signup` → formularul real (`signInWithOtp`;
 *   `@supabase/ssr` pune verifier-ul PKCE în cookie-ul ACESTUI context) → GoTrue nu trimite email: Send Email Hook-ul
 *   de STAGING (mcp/staging/auth_mail_capture.sql) scrie payload-ul în `public.staging_auth_mail_capture` → proba citește
 *   rândul proaspăt (service-role, poll mărginit), îl șterge, apoi navighează ACELAȘI context la
 *   `<supabase>/auth/v1/verify?token=pkce_…&type=…&redirect_to=<origin>/auth/callback` → GoTrue redirecționează cu
 *   `?code=`, produsul îl schimbă cu verifier-ul browserului și răscumpără invitația. Preflight-ul verifică întâi că
 *   hook-ul e activ (`mail_capture_hook_absent` → stop; NU există fallback pe generateLink pentru browser).
 * EXCEPȚIE asumată: JWT-ul `authenticated` al lui E14 se obține în Node (`generateLink` + `verifyOtp` cu cheia anon,
 *   fără browser) — nu atinge callback-ul produsului și nicio sesiune de browser; servește doar apelurilor PostgREST.
 */

import type { PostForm } from "./canaryTokenClient";
import type { PostJson } from "./canaryMcpClient";
import { buildForm, exchangeAuthCode, refreshToken } from "./canaryTokenClient";
import { buildJsonRpcRequest, callMcpTool, initializeMcp, listMcpTools, MCP_PROBE_PROTOCOL_VERSION } from "./canaryMcpClient";
import { generatePkcePair, generateState } from "./canaryPkce";
import { assertReadiness, parseHealthReport } from "./releaseGate";
import {
  vetStagingProbe, vetProcessEnvBinding, STAGING_VET_MSG, ENV_BINDING_MSG,
  type StagingProbeConfig, type StagingSecrets, type StagingTargets, type StagingVetCode, type EnvBindingCode,
} from "./canaryGate1StagingTargets";
import * as C from "./canaryGate1StagingChecks";
import { planAccessChange, type AdminClientRow } from "../db/adminClientAccess";
import { planAuthCodeTokenIssuance } from "../oauth/authCodeIssuancePlan";
import { accessTokenKey, refreshTokenKey } from "../db/oauthStorageKeys";
import { BETA_ACCESS_DAYS, INVITE_COOKIE, hashInviteToken } from "../oauth/inviteRedeem";
import type { AuthCodePayload } from "../db/oauthAtomic";
import type { TokenPayload } from "../db/oauth-tokens";

/** Tool-ul exercitat de „apelul valid” (acceptă `read:basic`, lib/mcp/scopes.ts). */
export const PROBE_TOOL = "tp_situation_report";
/** Nota de audit a autorizărilor temporare făcute de probă (`admin_authorized_by`). */
export const PROBE_AUTH_NOTE = "gate1-staging-probe (temporar, rulare automată)";

// ────────────────────────────── portul de I/O ──────────────────────────────

export type ReadResult<T> = { status: "found"; row: T } | { status: "not_found" } | { status: "unavailable" };
export type DeleteStatus = "deleted" | "not_found" | "unavailable";

export type PgRole = { kind: "anon" } | { kind: "service" } | { kind: "user"; jwt: string };
export interface PgRequest {
  method: "GET" | "POST" | "PATCH";
  path:   string;   // relativ la `${restUrl}/` (ex. `rpc/redeem_beta_invite`, `beta_invites?select=…`)
  body?:  unknown;
  returnRepresentation?: boolean;
}

export type ApproveResult =
  | { kind: "captured"; location: string }      // redirect-ul post-consimțământ, CAPTURAT (cererea nu a plecat)
  | { kind: "not_redirected"; status: number }  // consimțământul a răspuns local (fără redirect)
  | { kind: "failed" };

/** O sesiune de browser = un context Playwright izolat (cookie-uri proprii), un cont de test. */
export interface BrowserSession {
  open(url: string): Promise<{ finalUrl: string | null }>;
  /** Formularul real `/signup` (auth-form.tsx): completează emailul, trimite, așteaptă „Check your email”. */
  submitSignup(email: string): Promise<"sent" | "form_error" | "failed">;
  /** Doar NUMELE cookie-urilor contextului (niciodată valorile). */
  cookieNames(): Promise<string[]>;
  hasApproveButton(): Promise<boolean>;
  approveConsent(): Promise<ApproveResult>;
  /**
   * E3n: navigare MANUALĂ cu cookie-urile contextului (fără browser-follow): urmează DOAR `/authorize` → `/start` pe
   * aceeași origine; orice alt redirect e raportat în `redirectLocation` și NU e urmat (nicio cerere nu pleacă).
   * `startStatus` = statusul final dacă răspunsul final vine de la `/api/oauth/authorize/start`, altfel null.
   */
  probeAuthorizeNoFollow(url: string): Promise<{ startStatus: number | null; redirectLocation: string | null; approveVisible: boolean }>;
  clickRevoke(): Promise<"ok" | "error" | "missing">;
  /** URL-urile spre claude.ai/claude.com/loopback interceptate ȘI anulate de garda contextului (doar în memorie). */
  offsiteCaptures(): readonly string[];
  close(): Promise<void>;
}

export interface StagingProbeIo {
  postJson: PostJson;
  postForm: PostForm;
  get(url: string): Promise<C.RawHttp | null>;
  admin: {
    readCimdRegistration(clientId: string): Promise<ReadResult<Record<string, unknown>>>;
    createUser(email: string): Promise<{ ok: true; userId: string } | { ok: false }>;
    deleteUser(userId: string): Promise<DeleteStatus>;
    /** Id-ul unui user după email (cleanup pentru conturi create de formular al căror rând capturat lipsește). */
    findUserIdByEmail(email: string): Promise<ReadResult<string>>;
    /** Rândurile `staging_auth_mail_capture` ale emailului (service-role), ordonate după id. */
    readMailCaptures(email: string): Promise<ReadResult<unknown[]>>;
    /** Șterge TOATE rândurile capturate ale emailului (după folosire și în cleanup). */
    deleteMailCaptures(email: string): Promise<DeleteStatus>;
    /** Sesiune `authenticated` (JWT) pentru E14: `generateLink` + `verifyOtp` cu cheia anon, fără browser, fără callback. */
    userAccessToken(email: string): Promise<{ ok: true; jwt: string } | { ok: false }>;
    /** `createBetaInvite` (biblioteca de produs, nu CLI-ul). */
    createInvite(email: string): Promise<{ ok: true; inviteId: string; token: string } | { ok: false }>;
    deleteInvite(inviteId: string): Promise<DeleteStatus>;
    readInvite(inviteId: string): Promise<ReadResult<Record<string, unknown>>>;
    readEntitlement(userId: string): Promise<ReadResult<Record<string, unknown>>>;
    setEntitlementExpiry(userId: string, iso: string): Promise<boolean>;
    /** `createOAuthClient` (biblioteca de produs): `dashboard_free_trial` = modelul vechi al dashboard-ului; `admin` = M2M. */
    createLegacyClient(spec: { userId: string | null; model: "dashboard_free_trial" | "admin"; name: string }): Promise<{ ok: true; clientId: string; secret: string } | { ok: false }>;
    readClient(clientId: string): Promise<ReadResult<Record<string, unknown>>>;
    /** UPDATE-ul lui `adminClientAccess` (aceeași formă): patch + `status=active` opțional; true DOAR pe 1 rând confirmat. */
    patchClientAuthorization(clientId: string, patch: { admin_authorized_at: string | null; admin_authorized_by: string | null }, requireActive: boolean): Promise<boolean>;
    deleteClient(clientId: string): Promise<DeleteStatus>;
    readGrants(userId: string): Promise<ReadResult<Array<Record<string, unknown>>>>;
  };
  postgrest(role: PgRole, req: PgRequest): Promise<{ status: number; body: string } | null>;
  redis: {
    exists(key: string): Promise<"present" | "absent" | "unavailable">;
    /** E0e: `issueAuthCode` → `peekAuthCode` → `consumeCodeAndIssueWithRefresh` (aceleași funcții ca ramura legacy). */
    mintLegacyRefresh(payload: AuthCodePayload, access: TokenPayload): Promise<{ ok: true; refreshToken: string } | { ok: false }>;
  };
  newBrowserSession(): Promise<BrowserSession>;
  close(): Promise<void>;
}

// ────────────────────────────── pași + coduri ──────────────────────────────

export const STEP_IDS = [
  "E0a", "E0b", "E0c", "E0d", "E0e",
  "E1", "E2", "E2n", "E3", "E3n", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11", "E12",
  "E14_rpc", "E14_select", "E14_expiry", "E14_admin",
] as const;
export type StepId = typeof STEP_IDS[number];

export const STEP_DESC: Readonly<Record<StepId, string>> = Object.freeze({
  E0a:        "cale veche: client createOAuthClient autorizat temporar → client_credentials + apel valid",
  E0b:        "cale veche: autorizarea retrasă → același secret → 401 invalid_client, fără token",
  E0c:        "cale veche: tokenul de la E0a → 401",
  E0d:        "M2M admin autorizat → token + apel valid; rândul E0a neschimbat (status inclus)",
  E0e:        "refresh legacy (fixture, aceeași funcție ca ramura legacy) → 400 invalid_grant, neconsumat; client_credentials merge",
  E1:         "descoperire: 401 cu resource_metadata absolut + scope=read:basic; PRM resource; AS: CIMD, none, S256, fără DCR",
  E2:         "invitație + formularul /signup real (PKCE) + linkul capturat de hook → entitlement read:basic ≈ +14 zile, invitația răscumpărată",
  E2n:        "cont fără invitație → fără consimțământ utilizabil, fără cod, fără entitlement",
  E3:         "/authorize cu client_id CIMD + callback claude.ai + PKCE + resource → pagina de consimțământ",
  E3n:        "același client_id, redirect …/auth_callback/x și http://localhost/callback → eroare locală, fără redirect",
  E4:         "Approve → redirect spre claude.ai capturat și anulat; code + state + iss valide",
  E5:         "schimbul codului (form-urlencoded, fără secret) → access + refresh, scope read:basic",
  E6:         "initialize + tools/call tp_situation_report → apel valid (isError absent/false, structuredContent ok + outputSchema)",
  E7:         "refresh → pereche nouă; apel valid cu noul access",
  E8:         "revocare din dashboard (titularul) → grant-urile contului revoked",
  E9:         "tools/call cu ultimul access după revocare → 401",
  E10:        "refresh cu ultimul refresh după revocare → 400 invalid_grant, fără token",
  E11:        "alt cont invitat: flux complet + apel valid; access_expires_at în trecut → apel 401",
  E12:        "refresh pe contul expirat → 400 invalid_grant, fără token",
  E14_rpc:    "drepturi: rpc redeem_beta_invite (anon + authenticated) refuzat; control service-role 'redeemed'",
  E14_select: "drepturi: select beta_invites (anon + authenticated) refuzat; control service-role vede rândul",
  E14_expiry: "drepturi: update account_entitlements.access_expires_at (anon + authenticated) refuzat; control 1 rând",
  E14_admin:  "drepturi: update oauth_clients.admin_authorized_at (anon + authenticated) refuzat; control 1 rând",
});

type OrchCode =
  | "blocked" | "threw"
  | "user_create_failed" | "invite_create_failed" | "client_create_failed" | "client_read_failed"
  | "client_preauthorized" | "authorization_change_failed" | "browser_failed"
  | "invite_landing_unexpected" | "invite_cookie_missing" | "invite_cookie_not_cleared"
  | "signup_form_failed" | "pkce_verifier_missing" | "mail_capture_unavailable" | "callback_auth_failed"
  | "callback_rejected" | "session_not_established" | "db_unavailable" | "entitlement_missing" | "invite_missing"
  | "consent_not_rendered" | "approve_no_redirect" | "approve_failed" | "capture_missing" | "capture_multiple"
  | "rotation_missing" | "revoke_click_failed" | "revoke_ui_error" | "redis_not_bound" | "legacy_plan_rejected"
  | "legacy_mint_failed" | "legacy_refresh_consumed" | "expiry_update_failed" | "session_failed"
  | "output_schema_missing" | "snapshot_failed";

export type StepCode =
  | OrchCode | C.DiscoveryCode | C.PrmCode | C.AsMetaCode | C.ValidCallCode | C.McpFailCode | C.TokenRefusalCode
  | C.CcCode | C.UserTokenCode | C.CaptureCode | C.UnentitledCode | C.LocalRefusalCode | C.EntitlementCode
  | C.InviteCode | C.GrantsCode | C.LegacyStableCode | C.RightsCode | C.MailCaptureCode
  | "call_not_rejected" | "call_rejected_wrong_status";

export interface StepRow { id: StepId; status: "PASS" | "FAIL"; code: StepCode | null }

export type PreflightCode =
  | "health_unreachable" | "health_not_ready" | "cimd_unavailable" | "cimd_not_provisioned" | C.CimdRowCode
  | "mail_capture_hook_absent" | "mail_capture_unavailable" | "hook_check_failed" | Exclude<C.MailCaptureCode, "mail_capture_absent">;
export type SetupCode = "run_id_invalid" | "io_factory_threw" | "internal_error";

export interface CleanupCounter { attempted: number; removed: number; failed: number }
export interface CleanupSummary {
  ok:       boolean;
  sessions: CleanupCounter;
  mail:     CleanupCounter; // rândurile staging_auth_mail_capture ale emailurilor de test
  invites:  CleanupCounter;
  clients:  CleanupCounter;
  users:    CleanupCounter;
  residue:  number; // entitlement/grant-uri încă prezente pentru useri șterși (cascadă eșuată)
}

export type StagingReport =
  | { ok: false; stage: "isolation"; code: StagingVetCode | EnvBindingCode; steps: []; cleanup: null }
  | { ok: false; stage: "setup"; code: SetupCode; steps: StepRow[]; cleanup: CleanupSummary | null }
  | { ok: false; stage: "preflight"; code: PreflightCode; steps: []; cleanup: CleanupSummary | null }
  | { ok: boolean; stage: "steps"; code: null; steps: StepRow[]; cleanup: CleanupSummary };

type Outcome = { ok: true } | { ok: false; code: StepCode };
const PASS: Outcome = { ok: true };
const fail = (code: StepCode): Outcome => ({ ok: false, code });

// ────────────────────────────── constructori puri (exportați pentru teste) ──────────────────────────────

const RUN_ID_RE = /^[a-z0-9]{8,32}$/;

/** Emailul unui cont de test: `gate1-<runId>-<rol>@<domeniu>` (normalizat; nu se afișează niciodată). */
export function probeEmail(runId: string, role: string, domain: string): string {
  return `gate1-${runId}-${role}@${domain}`.toLowerCase();
}

/** URL-ul `/authorize` al clientului CIMD (PKCE S256 + resource + scope read:basic). */
export function buildAuthorizeUrl(t: StagingTargets, p: { redirectUri: string; state: string; challenge: string }): string {
  const q = new URLSearchParams({
    response_type: "code", client_id: t.cimdClientId, redirect_uri: p.redirectUri, scope: "read:basic",
    state: p.state, code_challenge: p.challenge, code_challenge_method: "S256", resource: t.resource,
  });
  return `${t.authorizeUrl}?${q.toString()}`;
}

/** Redirect-urile E3n (design §8): sub-cale a callback-ului + loopback http. */
export function e3nRedirects(t: StagingTargets): string[] {
  return [`${t.claudeRedirectUri}/x`, "http://localhost/callback"];
}

export const pg = {
  rpcRedeem: (args: Record<string, unknown>): PgRequest => ({ method: "POST", path: "rpc/redeem_beta_invite", body: args }),
  selectInviteId: (id: string): PgRequest => ({ method: "GET", path: `beta_invites?select=invite_id&invite_id=eq.${encodeURIComponent(id)}` }),
  snapshotInvite: (id: string): PgRequest => ({ method: "GET", path: `beta_invites?select=*&invite_id=eq.${encodeURIComponent(id)}` }),
  snapshotEntitlement: (uid: string): PgRequest => ({ method: "GET", path: `account_entitlements?select=*&user_id=eq.${encodeURIComponent(uid)}` }),
  patchEntitlementExpiry: (uid: string, value: unknown): PgRequest => ({
    method: "PATCH", path: `account_entitlements?user_id=eq.${encodeURIComponent(uid)}&select=user_id`,
    body: { access_expires_at: value }, returnRepresentation: true,
  }),
  snapshotClient: (cid: string): PgRequest => ({
    method: "GET",
    path: `oauth_clients?select=client_id,user_id,status,plan,scopes,secret_rotated_at,admin_authorized_at,admin_authorized_by&client_id=eq.${encodeURIComponent(cid)}`,
  }),
  patchClientAdminAuth: (cid: string, at: unknown, by: unknown): PgRequest => ({
    method: "PATCH", path: `oauth_clients?client_id=eq.${encodeURIComponent(cid)}&select=client_id`,
    body: { admin_authorized_at: at, admin_authorized_by: by }, returnRepresentation: true,
  }),
};

/** Valoarea pe care un atacator ar vrea s-o scrie pe `access_expires_at` (prelungire). */
export const E14_ATTACK_EXPIRY = "2099-01-01T00:00:00+00:00";

function toAdminRow(v: C.LegacyClientView): AdminClientRow {
  return {
    client_id: v.client_id, user_id: v.user_id, name: v.name, plan: v.plan, scopes: v.scopes, status: v.status,
    created_at: v.created_at, admin_authorized_at: v.admin_authorized_at, admin_authorized_by: v.admin_authorized_by,
  };
}

// ────────────────────────────── orchestrator ──────────────────────────────

export interface StagingRunOptions {
  runId:       string;             // [a-z0-9]{8,32}, crypto-random per rulare (generat de runner)
  processEnv?: Readonly<Record<string, string | undefined>>; // env-ul procesului (legătura cu bibliotecile de produs)
  now?:        () => number;
  /** Pauza dintre citirile tabelei de captură (implicit setTimeout); testele injectează un no-op. */
  sleep?:      (ms: number) => Promise<void>;
}

/** Poll-ul rândului capturat: MAIL_POLL_ATTEMPTS × MAIL_POLL_INTERVAL_MS ≈ 20 s, mărginit pe număr (nu pe ceas). */
export const MAIL_POLL_INTERVAL_MS = 500;
export const MAIL_POLL_ATTEMPTS = 40;

/**
 * Rulează proba. Izolarea (+ legătura cu env-ul procesului) e poarta zero; `makeIo` e invocată DOAR după ea. Nu aruncă.
 */
export async function runGate1Staging(
  cfg:    Partial<StagingProbeConfig> | null | undefined,
  makeIo: (targets: StagingTargets, secrets: StagingSecrets) => StagingProbeIo,
  opts:   StagingRunOptions,
): Promise<StagingReport> {
  const vet = vetStagingProbe(cfg);
  if (!vet.ok) return { ok: false, stage: "isolation", code: vet.code, steps: [], cleanup: null };
  if (opts.processEnv) {
    const b = vetProcessEnvBinding(opts.processEnv, vet.targets, vet.secrets);
    if (!b.ok) return { ok: false, stage: "isolation", code: b.code, steps: [], cleanup: null };
  }
  if (typeof opts.runId !== "string" || !RUN_ID_RE.test(opts.runId)) {
    return { ok: false, stage: "setup", code: "run_id_invalid", steps: [], cleanup: null };
  }
  let io: StagingProbeIo;
  try { io = makeIo(vet.targets, vet.secrets); }
  catch { return { ok: false, stage: "setup", code: "io_factory_threw", steps: [], cleanup: null }; }

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const run = new ProbeRun(io, vet.targets, opts.runId, opts.now ?? Date.now, sleep);
  try {
    return await run.execute();
  } catch {
    const cleanup = await run.cleanup();
    return { ok: false, stage: "setup", code: "internal_error", steps: run.rows(), cleanup };
  } finally {
    try { await io.close(); } catch { /* best-effort */ }
  }
}

interface InvitedAccount { email: string; userId: string; inviteId: string; session: BrowserSession; loginStartMs: number; loginEndMs: number }
type FormLogin = { ok: true; userId: string; loginStartMs: number; loginEndMs: number } | { ok: false; code: StepCode };
type Captured = { ok: true; mail: C.CapturedMail } | { ok: false; code: "signup_form_failed" | "pkce_verifier_missing" | "mail_capture_unavailable" | C.MailCaptureCode };
interface Tokens { access: string; refresh: string }

class ProbeRun {
  private readonly steps: StepRow[] = [];
  private readonly made = {
    invites: [] as string[], clients: [] as string[], users: [] as string[], sessions: [] as BrowserSession[],
    emails:  [] as string[],            // emailuri trimise prin formular (rânduri de captură + conturi create de GoTrue)
    emailUser: new Map<string, string>(), // email → user_id (din rândul capturat)
  };
  private readonly validate = C.makeSdkOutputSchemaValidator();
  private readonly mcpCfg: { mcpEndpoint: string };
  private readonly tokCfg: { tokenEndpoint: string; clientId: string; resource: string };
  private cleaned: CleanupSummary | null = null;

  constructor(
    private readonly io: StagingProbeIo,
    private readonly t: StagingTargets,
    private readonly runId: string,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {
    this.mcpCfg = { mcpEndpoint: t.mcpUrl };
    this.tokCfg = { tokenEndpoint: t.tokenUrl, clientId: t.cimdClientId, resource: t.resource };
  }

  rows(): StepRow[] { return this.steps.slice(); }

  private iso(offsetMs = 0): string { return new Date(this.now() + offsetMs).toISOString(); }
  private email(role: string): string { return probeEmail(this.runId, role, this.t.emailDomain); }

  /** Rulează un pas: blocat dacă precondiția a picat; un throw devine `threw`. Întoarce PASS-ul pasului. */
  private async step(id: StepId, prereq: boolean, fn: () => Promise<Outcome>): Promise<boolean> {
    if (!prereq) { this.steps.push({ id, status: "FAIL", code: "blocked" }); return false; }
    let o: Outcome;
    try { o = await fn(); } catch { o = fail("threw"); }
    this.steps.push(o.ok ? { id, status: "PASS", code: null } : { id, status: "FAIL", code: o.code });
    return o.ok;
  }

  async execute(): Promise<StagingReport> {
    // ── precondiții: readiness + rândul CIMD provizionat (S0). Nimic creat încă. ──
    const pre = await this.preflight();
    if (pre !== null) {
      const cleanup = await this.cleanup();
      return { ok: false, stage: "preflight", code: pre, steps: [], cleanup };
    }

    await this.chainLegacy();     // E0a–E0e
    await this.chainDiscovery();  // E1
    await this.chainInvited();    // E2, E2n, E3, E3n, E4–E10
    await this.chainExpiry();     // E11, E12
    await this.chainRights();     // E14

    const cleanup = await this.cleanup();
    const allPass = this.steps.length === STEP_IDS.length && this.steps.every((r) => r.status === "PASS");
    return { ok: allPass && cleanup.ok, stage: "steps", code: null, steps: this.rows(), cleanup };
  }

  private async preflight(): Promise<PreflightCode | null> {
    let health: C.RawHttp | null = null;
    try { health = await this.io.get(this.t.healthUrl); } catch { health = null; }
    if (!health) return "health_unreachable";
    const parsed = parseHealthReport(health.body);
    if (!parsed || !assertReadiness(parsed).ok) return "health_not_ready";
    let reg: ReadResult<Record<string, unknown>>;
    try { reg = await this.io.admin.readCimdRegistration(this.t.cimdClientId); } catch { reg = { status: "unavailable" }; }
    if (reg.status === "unavailable") return "cimd_unavailable";
    if (reg.status === "not_found") return "cimd_not_provisioned";
    const v = C.checkCimdRegistrationRow(reg.row, this.t.cimdClientId, this.t.claudeRedirectUri, this.now());
    if (!v.ok) return v.code;
    return this.hookCheck();
  }

  /**
   * Hook-ul de captură e activ? Un submit real al formularului pentru un cont dedicat („hook”) TREBUIE să producă un
   * rând bine format. Fără rând → `mail_capture_hook_absent` și STOP (fără fallback pe generateLink). Contul creat de
   * GoTrue intră în cleanup.
   */
  private async hookCheck(): Promise<PreflightCode | null> {
    let session: BrowserSession;
    try { session = await this.newSession(); } catch { return "hook_check_failed"; }
    const c = await this.submitAndCapture(session, this.email("hook"));
    if (c.ok) return null;
    if (c.code === "mail_capture_absent") return "mail_capture_hook_absent";
    if (c.code === "signup_form_failed" || c.code === "pkce_verifier_missing") return "hook_check_failed";
    return c.code;
  }

  // ── helpers comune ──

  private async validCall(accessToken: string): Promise<Outcome> {
    const init = await initializeMcp(this.io.postJson, this.mcpCfg, { accessToken });
    if (!init.ok) return fail(C.mapMcpFailure(init));
    const list = await listMcpTools(this.io.postJson, this.mcpCfg, { accessToken });
    if (!list.ok) return fail(C.mapMcpFailure(list));
    const schema = C.findToolOutputSchema(list.tools, PROBE_TOOL);
    if (!schema) return fail("output_schema_missing");
    const call = await callMcpTool(this.io.postJson, this.mcpCfg, { accessToken, tool: PROBE_TOOL });
    return C.checkValidToolCall(call, schema, this.validate);
  }

  private async callMustBe401(accessToken: string): Promise<Outcome> {
    return C.checkCallRejected401(await callMcpTool(this.io.postJson, this.mcpCfg, { accessToken, tool: PROBE_TOOL }));
  }

  private async postToken(form: Record<string, string>): Promise<{ status: number; body: string } | null> {
    try {
      const res = await this.io.postForm(this.t.tokenUrl, buildForm(form), {
        "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json",
      });
      return { status: res.status, body: await res.text().catch(() => "") };
    } catch {
      return null;
    }
  }

  private async clientCredentials(clientId: string, secret: string): Promise<{ status: number; body: string } | null> {
    return this.postToken({ grant_type: "client_credentials", client_id: clientId, client_secret: secret, resource: this.t.resource });
  }

  private async readClientView(clientId: string): Promise<C.LegacyClientView | null> {
    const r = await this.io.admin.readClient(clientId);
    return r.status === "found" ? C.parseLegacyClientView(r.row) : null;
  }

  private async changeAuthorization(clientId: string, kind: "authorize" | "unauthorize"): Promise<Outcome> {
    const view = await this.readClientView(clientId);
    if (!view) return fail("client_read_failed");
    const plan = planAccessChange(toAdminRow(view), kind === "authorize" ? { kind, by: PROBE_AUTH_NOTE } : { kind }, this.iso());
    if (plan.kind !== "apply") return fail("authorization_change_failed");
    const ok = await this.io.admin.patchClientAuthorization(clientId, plan.patch, plan.requireActive);
    return ok ? PASS : fail("authorization_change_failed");
  }

  private async createUser(role: string): Promise<{ email: string; userId: string } | null> {
    const email = this.email(role);
    const u = await this.io.admin.createUser(email);
    if (!u.ok) return null;
    this.made.users.push(u.userId);
    return { email, userId: u.userId };
  }

  private async newSession(): Promise<BrowserSession> {
    const s = await this.io.newBrowserSession();
    this.made.sessions.push(s);
    return s;
  }

  /**
   * Formularul real `/signup` → verifier PKCE în cookie-ul contextului → rândul PROASPĂT din tabela de captură (poll
   * mărginit) → validat (unul singur, token `pkce_`, tip de login, redirect = callback-ul produsului) → șters imediat.
   */
  private async submitAndCapture(session: BrowserSession, email: string): Promise<Captured> {
    this.made.emails.push(email);
    const before = await this.io.admin.readMailCaptures(email);
    if (before.status === "unavailable") return { ok: false, code: "mail_capture_unavailable" };
    const afterId = before.status === "found" ? C.maxCaptureId(before.row) : 0;
    if (afterId === null) return { ok: false, code: "mail_capture_shape" };
    if ((await session.submitSignup(email)) !== "sent") return { ok: false, code: "signup_form_failed" };
    if (!C.hasPkceVerifierCookie(await session.cookieNames(), this.t.supabaseRef)) return { ok: false, code: "pkce_verifier_missing" };
    let v: ReturnType<typeof C.checkCapturedMail> = { ok: false, code: "mail_capture_absent" };
    for (let attempt = 0; attempt < MAIL_POLL_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.sleep(MAIL_POLL_INTERVAL_MS);
      const r = await this.io.admin.readMailCaptures(email);
      if (r.status === "unavailable") return { ok: false, code: "mail_capture_unavailable" };
      v = C.checkCapturedMail(r.status === "found" ? r.row : [], { email, afterId, callbackUrl: this.t.callbackUrl });
      if (v.ok || v.code !== "mail_capture_absent") break;
    }
    if (!v.ok) return v;
    if (!this.made.users.includes(v.mail.user_id)) this.made.users.push(v.mail.user_id);
    this.made.emailUser.set(email, v.mail.user_id);
    try { await this.io.admin.deleteMailCaptures(email); } catch { /* reîncercat în cleanup */ }
    return v;
  }

  /** Login complet prin formular: captura → `/auth/v1/verify` în ACELAȘI context → /auth/callback?code → /dashboard. */
  private async formLogin(session: BrowserSession, email: string): Promise<FormLogin> {
    const c = await this.submitAndCapture(session, email);
    if (!c.ok) return { ok: false, code: c.code };
    const loginStartMs = this.now();
    const nav = await session.open(C.buildVerifyUrl(this.t.supabaseUrl, c.mail));
    if (C.landedOn(nav.finalUrl, this.t.origin, "/login")) return { ok: false, code: "callback_auth_failed" };
    if (!C.landedOn(nav.finalUrl, this.t.origin, "/dashboard")) return { ok: false, code: "callback_rejected" };
    if (!C.hasSessionCookie(await session.cookieNames(), this.t.supabaseRef)) return { ok: false, code: "session_not_established" };
    return { ok: true, userId: c.mail.user_id, loginStartMs, loginEndMs: this.now() };
  }

  /** Cont INVITAT: invitație (createBetaInvite) → linkul în browser (cookie) → formularul real în ACELAȘI context. */
  private async invitedLogin(role: string): Promise<{ ok: true; acct: InvitedAccount } | { ok: false; code: StepCode }> {
    const email = this.email(role);
    const inv = await this.io.admin.createInvite(email);
    if (!inv.ok) return { ok: false, code: "invite_create_failed" };
    this.made.invites.push(inv.inviteId);
    let session: BrowserSession;
    try { session = await this.newSession(); } catch { return { ok: false, code: "browser_failed" }; }
    const nav = await session.open(`${this.t.inviteUrl}?${new URLSearchParams({ token: inv.token }).toString()}`);
    if (!C.landedOn(nav.finalUrl, this.t.origin, "/signup")) return { ok: false, code: "invite_landing_unexpected" };
    if (!(await session.cookieNames()).includes(INVITE_COOKIE)) return { ok: false, code: "invite_cookie_missing" };
    const login = await this.formLogin(session, email);
    if (!login.ok) return login;
    if ((await session.cookieNames()).includes(INVITE_COOKIE)) return { ok: false, code: "invite_cookie_not_cleared" };
    return { ok: true, acct: { email, userId: login.userId, inviteId: inv.inviteId, session, loginStartMs: login.loginStartMs, loginEndMs: login.loginEndMs } };
  }

  /** E3: /authorize → pagina de consimțământ (buton Approve). Întoarce PKCE + state pentru E4/E5. */
  private async openConsent(session: BrowserSession): Promise<{ ok: true; state: string; verifier: string } | { ok: false; code: StepCode }> {
    const pkce = generatePkcePair();
    const state = generateState();
    const nav = await session.open(buildAuthorizeUrl(this.t, { redirectUri: this.t.claudeRedirectUri, state, challenge: pkce.challenge }));
    if (!C.landedOn(nav.finalUrl, this.t.origin, "/authorize") || !(await session.hasApproveButton())) {
      return { ok: false, code: "consent_not_rendered" };
    }
    return { ok: true, state, verifier: pkce.verifier };
  }

  /** E4: Approve → captura redirect-ului (o singură captură, nicio cerere plecată) → codul. */
  private async approveAndCapture(session: BrowserSession, state: string): Promise<{ ok: true; code: string } | { ok: false; code: StepCode }> {
    const before = session.offsiteCaptures().length;
    const a = await session.approveConsent();
    if (a.kind === "failed") return { ok: false, code: "approve_failed" };
    if (a.kind === "not_redirected") return { ok: false, code: "approve_no_redirect" };
    const extra = session.offsiteCaptures().slice(before);
    // Garda contextului poate prinde ACEEAȘI navigare (dacă redirect-ul a ajuns totuși la ea): o captură e acceptată
    // doar dacă e identică; orice altă cerere spre claude.ai/loopback = captură multiplă.
    if (extra.some((u) => u !== a.location)) return { ok: false, code: "capture_multiple" };
    const v = C.checkClaudeCallbackCapture(a.location, { redirectUri: this.t.claudeRedirectUri, expectedState: state, issuer: this.t.origin });
    return v.ok ? { ok: true, code: v.code } : { ok: false, code: v.code };
  }

  private async exchange(code: string, verifier: string): Promise<{ ok: true; tokens: Tokens } | { ok: false; code: StepCode }> {
    const r = await exchangeAuthCode(this.io.postForm, this.tokCfg, { code, redirectUri: this.t.claudeRedirectUri, codeVerifier: verifier });
    const v = C.checkUserToken(r);
    if (!v.ok) return { ok: false, code: v.code };
    if (!r.ok) return { ok: false, code: "token_malformed" }; // îngustare (checkUserToken a trecut ⇒ r.ok)
    return { ok: true, tokens: { access: r.accessToken, refresh: r.refreshToken } };
  }

  // ── L: E0a–E0e ──

  private async chainLegacy(): Promise<void> {
    const L = { clientId: "", secret: "", token: "", before: null as C.LegacyClientView | null, adminId: "", adminSecret: "", redisBound: false };

    const a = await this.step("E0a", true, async () => {
      const u = await this.createUser("e0legacy");
      if (!u) return fail("user_create_failed");
      const c = await this.io.admin.createLegacyClient({ userId: u.userId, model: "dashboard_free_trial", name: `gate1-probe-${this.runId}-legacy` });
      if (!c.ok) return fail("client_create_failed");
      this.made.clients.push(c.clientId);
      L.clientId = c.clientId; L.secret = c.secret;
      const view = await this.readClientView(c.clientId);
      if (!view) return fail("client_read_failed");
      if (view.admin_authorized_at !== null) return fail("client_preauthorized"); // un client nou TREBUIE să fie neautorizat
      L.before = view;
      const auth = await this.changeAuthorization(c.clientId, "authorize");
      if (!auth.ok) return auth;
      const cc = C.parseClientCredentialsResponse(await this.clientCredentials(c.clientId, c.secret));
      if (!cc.ok) return fail(cc.code);
      L.token = cc.accessToken;
      // Dovada de legare Redis (read-only): tokenul emis de SERVER există în Redis-ul probei → e Redis-ul staging-ului.
      L.redisBound = (await this.io.redis.exists(accessTokenKey(cc.accessToken))) === "present";
      return this.validCall(cc.accessToken);
    });

    const b = await this.step("E0b", a, async () => {
      const un = await this.changeAuthorization(L.clientId, "unauthorize");
      if (!un.ok) return un;
      return C.checkTokenRefusal(await this.clientCredentials(L.clientId, L.secret), { status: 401, error: "invalid_client" });
    });

    const c = await this.step("E0c", b, () => this.callMustBe401(L.token));

    const d = await this.step("E0d", c, async () => {
      const adm = await this.io.admin.createLegacyClient({ userId: null, model: "admin", name: `gate1-probe-${this.runId}-m2m` });
      if (!adm.ok) return fail("client_create_failed");
      this.made.clients.push(adm.clientId);
      L.adminId = adm.clientId; L.adminSecret = adm.secret;
      const auth = await this.changeAuthorization(adm.clientId, "authorize");
      if (!auth.ok) return auth;
      const cc = C.parseClientCredentialsResponse(await this.clientCredentials(adm.clientId, adm.secret));
      if (!cc.ok) return fail(cc.code);
      const call = await this.validCall(cc.accessToken);
      if (!call.ok) return call;
      const after = await this.readClientView(L.clientId);
      if (!after || !L.before) return fail("client_read_failed");
      return C.checkLegacyRowStable(L.before, after);
    });

    await this.step("E0e", d, async () => {
      if (!L.redisBound) return fail("redis_not_bound"); // nicio scriere în Redis fără dovada de legare
      const view = await this.readClientView(L.adminId);
      if (!view) return fail("client_read_failed");
      const pkce = generatePkcePair();
      const nowMs = this.now();
      const payload = C.buildLegacyFixtureAuthCode({ clientId: view.client_id, scopes: view.scopes, resource: this.t.resource, codeChallenge: pkce.challenge, nowMs });
      const plan = planAuthCodeTokenIssuance({
        payload, clientId: view.client_id, credentialVersion: view.secret_rotated_at,
        audience: this.t.resource, issuedAt: nowMs, rejectLegacy: false,
      });
      if (plan.kind !== "legacy") return fail("legacy_plan_rejected");
      const minted = await this.io.redis.mintLegacyRefresh(payload, plan.access);
      if (!minted.ok) return fail("legacy_mint_failed");
      const refused = C.checkTokenRefusal(
        await this.postToken({ grant_type: "refresh_token", refresh_token: minted.refreshToken, client_id: view.client_id }),
        { status: 400, error: "invalid_grant" },
      );
      if (!refused.ok) return refused;
      // §4.2: refuzul vine ÎNAINTE de rotație → refresh-ul vechi nu e consumat.
      if ((await this.io.redis.exists(refreshTokenKey(minted.refreshToken))) !== "present") return fail("legacy_refresh_consumed");
      const cc = C.parseClientCredentialsResponse(await this.clientCredentials(L.adminId, L.adminSecret));
      return cc.ok ? PASS : fail(cc.code);
    });
  }

  // ── D: E1 ──

  private async chainDiscovery(): Promise<void> {
    await this.step("E1", true, async () => {
      let res: C.RawHttp | null = null;
      try {
        const r = await this.io.postJson(this.t.mcpUrl, buildJsonRpcRequest(1, "initialize", {
          protocolVersion: MCP_PROBE_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "preflight-gate1-staging-probe", version: "1" },
        }), { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" });
        res = { status: r.status, headers: r.headers, body: await r.text().catch(() => "") };
      } catch { res = null; }
      const d = C.checkDiscovery401(res, this.t.origin);
      if (!d.ok) return d;
      const prm = C.checkPrm(await this.io.get(this.t.prmUrl), this.t.origin);
      if (!prm.ok) return prm;
      return C.checkAsMetadata(await this.io.get(this.t.asMetadataUrl), this.t.origin);
    });
  }

  // ── A + B: E2, E2n, E3, E3n, E4–E10 ──

  private async chainInvited(): Promise<void> {
    const A = { acct: null as InvitedAccount | null, state: "", verifier: "", code: "", first: null as Tokens | null, latest: null as Tokens | null };

    const e2 = await this.step("E2", true, async () => {
      const r = await this.invitedLogin("a");
      if (!r.ok) return fail(r.code);
      A.acct = r.acct;
      const ent = await this.io.admin.readEntitlement(r.acct.userId);
      if (ent.status === "unavailable") return fail("db_unavailable");
      if (ent.status === "not_found") return fail("entitlement_missing");
      const ev = C.checkRedeemedEntitlement(ent.row, r.acct.userId, r.acct.loginStartMs, r.acct.loginEndMs, BETA_ACCESS_DAYS);
      if (!ev.ok) return ev;
      const inv = await this.io.admin.readInvite(r.acct.inviteId);
      if (inv.status === "unavailable") return fail("db_unavailable");
      if (inv.status === "not_found") return fail("invite_missing");
      return C.checkInviteRedeemed(inv.row, r.acct.inviteId, r.acct.userId);
    });

    await this.step("E2n", true, async () => {
      // Înscriere simplă, FĂRĂ invitație: același formular real, același login PKCE.
      let s: BrowserSession;
      try { s = await this.newSession(); } catch { return fail("browser_failed"); }
      const login = await this.formLogin(s, this.email("b"));
      if (!login.ok) return fail(login.code);
      const u = { userId: login.userId };
      const pkce = generatePkcePair();
      const state = generateState();
      await s.open(buildAuthorizeUrl(this.t, { redirectUri: this.t.claudeRedirectUri, state, challenge: pkce.challenge }));
      const approveVisible = await s.hasApproveButton();
      const ent = await this.io.admin.readEntitlement(u.userId);
      if (ent.status === "unavailable") return fail("db_unavailable");
      return C.checkUnentitledRefusal({
        approveVisible, captures: s.offsiteCaptures(), entitlementFound: ent.status === "found",
        exp: { redirectUri: this.t.claudeRedirectUri, expectedState: state, issuer: this.t.origin },
      });
    });

    const e3 = await this.step("E3", e2, async () => {
      const o = await this.openConsent(A.acct!.session);
      if (!o.ok) return fail(o.code);
      A.state = o.state; A.verifier = o.verifier;
      return PASS;
    });

    const e3n = await this.step("E3n", e3, async () => {
      for (const redirectUri of e3nRedirects(this.t)) {
        const pkce = generatePkcePair();
        const before = A.acct!.session.offsiteCaptures().length;
        const r = await A.acct!.session.probeAuthorizeNoFollow(buildAuthorizeUrl(this.t, { redirectUri, state: generateState(), challenge: pkce.challenge }));
        const v = C.checkLocalRefusal({ ...r, offsiteCaptures: A.acct!.session.offsiteCaptures().length - before });
        if (!v.ok) return v;
      }
      return PASS;
    });

    const e4 = await this.step("E4", e3n, async () => {
      const r = await this.approveAndCapture(A.acct!.session, A.state);
      if (!r.ok) return fail(r.code);
      A.code = r.code;
      return PASS;
    });

    const e5 = await this.step("E5", e4, async () => {
      const r = await this.exchange(A.code, A.verifier);
      if (!r.ok) return fail(r.code);
      A.first = r.tokens; A.latest = r.tokens;
      return PASS;
    });

    const e6 = await this.step("E6", e5, () => this.validCall(A.first!.access));

    const e7 = await this.step("E7", e6, async () => {
      const r = await refreshToken(this.io.postForm, this.tokCfg, { refreshToken: A.first!.refresh });
      const v = C.checkUserToken(r);
      if (!v.ok) return v;
      if (!r.ok) return fail("token_malformed");
      if (r.accessToken === A.first!.access || r.refreshToken === A.first!.refresh) return fail("rotation_missing");
      A.latest = { access: r.accessToken, refresh: r.refreshToken };
      return this.validCall(r.accessToken);
    });

    const e8 = await this.step("E8", e7, async () => {
      const clicked = await A.acct!.session.clickRevoke();
      if (clicked === "missing") return fail("revoke_click_failed");
      if (clicked === "error") return fail("revoke_ui_error");
      const g = await this.io.admin.readGrants(A.acct!.userId);
      if (g.status !== "found") return fail("db_unavailable");
      return C.checkGrantsRevoked(g.row, this.t.cimdClientId);
    });

    const e9 = await this.step("E9", e8, () => this.callMustBe401(A.latest!.access));

    await this.step("E10", e9, async () => C.checkTokenRefusal(
      await this.postToken({ grant_type: "refresh_token", refresh_token: A.latest!.refresh, client_id: this.t.cimdClientId, resource: this.t.resource }),
      { status: 400, error: "invalid_grant" },
    ));
  }

  // ── X: E11, E12 ──

  private async chainExpiry(): Promise<void> {
    const X = { tokens: null as Tokens | null };
    const e11 = await this.step("E11", true, async () => {
      const r = await this.invitedLogin("c");
      if (!r.ok) return fail(r.code);
      const ent = await this.io.admin.readEntitlement(r.acct.userId);
      if (ent.status !== "found") return fail(ent.status === "unavailable" ? "db_unavailable" : "entitlement_missing");
      const o = await this.openConsent(r.acct.session);
      if (!o.ok) return fail(o.code);
      const cap = await this.approveAndCapture(r.acct.session, o.state);
      if (!cap.ok) return fail(cap.code);
      const ex = await this.exchange(cap.code, o.verifier);
      if (!ex.ok) return fail(ex.code);
      X.tokens = ex.tokens;
      const call = await this.validCall(ex.tokens.access);
      if (!call.ok) return call;
      if (!(await this.io.admin.setEntitlementExpiry(r.acct.userId, this.iso(-60 * 60 * 1000)))) return fail("expiry_update_failed");
      return this.callMustBe401(ex.tokens.access);
    });
    await this.step("E12", e11, async () => C.checkTokenRefusal(
      await this.postToken({ grant_type: "refresh_token", refresh_token: X.tokens!.refresh, client_id: this.t.cimdClientId, resource: this.t.resource }),
      { status: 400, error: "invalid_grant" },
    ));
  }

  // ── R: E14 ──

  private async snapshot(req: PgRequest): Promise<Record<string, unknown> | null> {
    return C.singleRowOf(await this.io.postgrest({ kind: "service" }, req));
  }

  private async negatives(jwt: string, req: PgRequest): Promise<{ anon: C.PgClass; user: C.PgClass }> {
    const anon = C.classifyPostgrestNegative(await this.io.postgrest({ kind: "anon" }, req));
    const user = C.classifyPostgrestNegative(await this.io.postgrest({ kind: "user", jwt }, req));
    return { anon, user };
  }

  private async chainRights(): Promise<void> {
    const R = { userId: "", email: "", inviteId: "", inviteToken: "", clientId: "", jwt: "" };

    const rpc = await this.step("E14_rpc", true, async () => {
      // Setup: cont D + invitație de unică folosință (controlul RPC o consumă) + client legacy al lui D + sesiune JWT.
      const u = await this.createUser("d");
      if (!u) return fail("user_create_failed");
      R.userId = u.userId; R.email = u.email;
      const inv = await this.io.admin.createInvite(u.email);
      if (!inv.ok) return fail("invite_create_failed");
      this.made.invites.push(inv.inviteId);
      R.inviteId = inv.inviteId; R.inviteToken = inv.token;
      const c = await this.io.admin.createLegacyClient({ userId: u.userId, model: "dashboard_free_trial", name: `gate1-probe-${this.runId}-rights` });
      if (!c.ok) return fail("client_create_failed");
      this.made.clients.push(c.clientId);
      R.clientId = c.clientId;
      const sess = await this.io.admin.userAccessToken(u.email);
      if (!sess.ok) return fail("session_failed");
      R.jwt = sess.jwt;

      const req = pg.rpcRedeem({
        p_token_hash: hashInviteToken(inv.token), p_user_id: u.userId, p_email_normalized: u.email,
        p_now: this.iso(), p_access_days: BETA_ACCESS_DAYS,
      });
      const control = C.checkRpcControl(await this.io.postgrest({ kind: "service" }, req));
      if (!control.ok) return control;
      const inv1 = await this.snapshot(pg.snapshotInvite(R.inviteId));
      const ent1 = await this.snapshot(pg.snapshotEntitlement(R.userId));
      if (!inv1 || !ent1) return fail("snapshot_failed");
      const n = await this.negatives(R.jwt, req);
      const inv2 = await this.snapshot(pg.snapshotInvite(R.inviteId));
      const ent2 = await this.snapshot(pg.snapshotEntitlement(R.userId));
      return C.decideRightsCase({ control, ...n, allowZeroRows: false, unchanged: C.sameJson(inv1, inv2) && C.sameJson(ent1, ent2) });
    });

    const sel = await this.step("E14_select", rpc, async () => {
      const req = pg.selectInviteId(R.inviteId);
      const control = C.checkSingleRowControl(await this.io.postgrest({ kind: "service" }, req), "invite_id", R.inviteId);
      if (!control.ok) return control;
      const s1 = await this.snapshot(pg.snapshotInvite(R.inviteId));
      if (!s1) return fail("snapshot_failed");
      const n = await this.negatives(R.jwt, req);
      const s2 = await this.snapshot(pg.snapshotInvite(R.inviteId));
      return C.decideRightsCase({ control, ...n, allowZeroRows: true, unchanged: C.sameJson(s1, s2) });
    });

    const exp = await this.step("E14_expiry", sel, async () => {
      const s0 = await this.snapshot(pg.snapshotEntitlement(R.userId));
      if (!s0) return fail("snapshot_failed");
      // Control: ACEEAȘI cerere (filtru + coloană), cu valoarea CURENTĂ → exact 1 rând, nicio schimbare de conținut.
      const control = C.checkSingleRowControl(
        await this.io.postgrest({ kind: "service" }, pg.patchEntitlementExpiry(R.userId, s0.access_expires_at)), "user_id", R.userId);
      if (!control.ok) return control;
      const s1 = await this.snapshot(pg.snapshotEntitlement(R.userId)); // după control (updated_at se poate atinge)
      if (!s1) return fail("snapshot_failed");
      const n = await this.negatives(R.jwt, pg.patchEntitlementExpiry(R.userId, E14_ATTACK_EXPIRY));
      const s2 = await this.snapshot(pg.snapshotEntitlement(R.userId));
      return C.decideRightsCase({ control, ...n, allowZeroRows: true, unchanged: C.sameJson(s1, s2) });
    });

    await this.step("E14_admin", exp, async () => {
      const s0 = await this.snapshot(pg.snapshotClient(R.clientId));
      if (!s0) return fail("snapshot_failed");
      const control = C.checkSingleRowControl(
        await this.io.postgrest({ kind: "service" }, pg.patchClientAdminAuth(R.clientId, s0.admin_authorized_at, s0.admin_authorized_by)), "client_id", R.clientId);
      if (!control.ok) return control;
      const s1 = await this.snapshot(pg.snapshotClient(R.clientId));
      if (!s1) return fail("snapshot_failed");
      const n = await this.negatives(R.jwt, pg.patchClientAdminAuth(R.clientId, this.iso(), "gate1-probe-negative"));
      const s2 = await this.snapshot(pg.snapshotClient(R.clientId));
      return C.decideRightsCase({ control, ...n, allowZeroRows: true, unchanged: C.sameJson(s1, s2) });
    });
  }

  // ── cleanup (MEREU; doar ce a creat rularea; best-effort; idempotent) ──

  async cleanup(): Promise<CleanupSummary> {
    if (this.cleaned) return this.cleaned;
    const counter = (): CleanupCounter => ({ attempted: 0, removed: 0, failed: 0 });
    const out = { sessions: counter(), mail: counter(), invites: counter(), clients: counter(), users: counter() };
    const del = async (c: CleanupCounter, fn: () => Promise<DeleteStatus>): Promise<void> => {
      c.attempted++;
      let s: DeleteStatus;
      try { s = await fn(); } catch { s = "unavailable"; }
      if (s === "unavailable") c.failed++; else c.removed++;
    };
    for (const s of this.made.sessions) {
      out.sessions.attempted++;
      try { await s.close(); out.sessions.removed++; } catch { out.sessions.failed++; }
    }
    let residue = 0;
    const emails = [...new Set(this.made.emails)];
    // Rândurile capturate (conțin token_hash-uri de unică folosință) — șterse oricum, chiar dacă au fost deja consumate.
    for (const e of emails) await del(out.mail, () => this.io.admin.deleteMailCaptures(e));
    // Conturi create de GoTrue la submit, dar al căror rând capturat n-a fost citit (hook lipsă / eșec la mijloc).
    for (const e of emails) {
      if (this.made.emailUser.has(e)) continue;
      try {
        const u = await this.io.admin.findUserIdByEmail(e);
        if (u.status === "found") { if (!this.made.users.includes(u.row)) this.made.users.push(u.row); }
        else if (u.status === "unavailable") residue++;
      } catch { residue++; }
    }
    for (const id of this.made.invites) await del(out.invites, () => this.io.admin.deleteInvite(id));
    for (const id of this.made.clients) await del(out.clients, () => this.io.admin.deleteClient(id));
    for (const id of this.made.users) await del(out.users, () => this.io.admin.deleteUser(id));
    // Reziduu: entitlement-urile / grant-urile cad prin cascadă (FK on delete cascade); verificăm.
    for (const id of this.made.users) {
      try {
        const e = await this.io.admin.readEntitlement(id);
        if (e.status !== "not_found") residue++;
        const g = await this.io.admin.readGrants(id);
        if (g.status !== "found" || g.row.length > 0) residue++;
      } catch { residue++; }
    }
    const failed = out.mail.failed + out.invites.failed + out.clients.failed + out.users.failed + out.sessions.failed;
    this.cleaned = { ok: failed === 0 && residue === 0, ...out, residue };
    return this.cleaned;
  }
}

// ────────────────────────────── raport ──────────────────────────────

const PREFLIGHT_MSG: Readonly<Record<PreflightCode, string>> = Object.freeze({
  health_unreachable:    "readiness: /api/health inaccesibil",
  health_not_ready:      "readiness: health malformat sau not-ready (web/Redis)",
  cimd_unavailable:      "rândul CIMD: Supabase indisponibil",
  cimd_not_provisioned:  "rândul CIMD lipsește — rulează întâi provisionCimdClient --apply (S0)",
  cimd_row_shape:        "rândul CIMD: formă neașteptată",
  cimd_not_public:       "rândul CIMD nu e public / none",
  cimd_inactive:         "rândul CIMD nu e activ",
  cimd_grant_types:      "rândul CIMD nu are authorization_code + refresh_token",
  cimd_redirect_missing: "rândul CIMD nu conține callback-ul claude.ai folosit de probă",
  cimd_expired:          "rândul CIMD a expirat",
  mail_capture_hook_absent: "Send Email Hook-ul de staging NU e activ: niciun rând în staging_auth_mail_capture după submit (aplică mcp/staging/auth_mail_capture.sql + Auth → Hooks)",
  mail_capture_unavailable: "tabela staging_auth_mail_capture inaccesibilă (lipsă / drepturi service_role)",
  hook_check_failed:        "verificarea hook-ului: browserul / formularul /signup a eșuat (sau lipsește verifier-ul PKCE)",
  mail_capture_multiple:    "verificarea hook-ului: mai multe rânduri proaspete pentru același email",
  mail_capture_shape:       "verificarea hook-ului: rând capturat malformat",
  mail_token_not_pkce:      "verificarea hook-ului: token_hash fără prefixul pkce_ (asumpția despre payload-ul GoTrue nu ține)",
  mail_action_unexpected:   "verificarea hook-ului: email_action_type neașteptat (cerut signup/magiclink)",
  mail_redirect_unexpected: "verificarea hook-ului: redirect_to ≠ <origin>/auth/callback (redirect allow list Supabase?)",
});

const SETUP_MSG: Readonly<Record<SetupCode, string>> = Object.freeze({
  run_id_invalid:   "runId invalid (cere [a-z0-9]{8,32})",
  io_factory_threw: "construirea adaptoarelor a aruncat (config/Playwright) — fail-closed",
  internal_error:   "eroare internă a orchestratorului — fail-closed (cleanup rulat)",
});

function counterText(c: CleanupCounter): string {
  return `${c.removed}/${c.attempted}${c.failed > 0 ? ` (eșuate ${c.failed})` : ""}`;
}

/** Liniile raportului: doar id-uri de pas, PASS/FAIL, coduri închise și descrieri statice. */
export function renderStagingReport(r: StagingReport): string[] {
  const out: string[] = [];
  if (r.stage === "isolation") {
    const msg = (STAGING_VET_MSG as Record<string, string>)[r.code] ?? (ENV_BINDING_MSG as Record<string, string>)[r.code] ?? "";
    out.push(`isolation FAIL ${r.code} — ${msg}`);
  } else if (r.stage === "setup") {
    out.push(`setup FAIL ${r.code} — ${SETUP_MSG[r.code]}`);
  } else if (r.stage === "preflight") {
    out.push(`preflight FAIL ${r.code} — ${PREFLIGHT_MSG[r.code]}`);
  }
  for (const s of r.steps) {
    out.push(`${s.id.padEnd(10)} ${s.status}${s.code ? ` ${s.code}` : ""} — ${STEP_DESC[s.id]}`);
  }
  if (r.cleanup) {
    const c = r.cleanup;
    out.push(`cleanup ${c.ok ? "ok" : "INCOMPLET"} — sesiuni ${counterText(c.sessions)}, invitații ${counterText(c.invites)}, ` +
      `clienți ${counterText(c.clients)}, useri ${counterText(c.users)}, capturi mail ${counterText(c.mail)}, reziduu ${c.residue}`);
  }
  const passed = r.steps.filter((s) => s.status === "PASS").length;
  out.push(r.ok ? `VERDE: ${passed}/${STEP_IDS.length} pași PASS + cleanup ok` : `ROȘU: ${passed}/${STEP_IDS.length} pași PASS (stage ${r.stage})`);
  return out;
}

/** 0 = tot verde; 2 = izolare refuzată (nimic atins); 1 = altfel. */
export function stagingExitCode(r: StagingReport): number {
  if (r.ok) return 0;
  return r.stage === "isolation" ? 2 : 1;
}
