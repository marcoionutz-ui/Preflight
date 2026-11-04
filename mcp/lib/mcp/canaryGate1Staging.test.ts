/**
 * lib/mcp/canaryGate1Staging.test.ts — lotul OAuth staging, partea C: orchestratorul probei, cu o „lume” de staging
 * SIMULATĂ (fake-uri pentru /token, /api/mcp, Supabase admin, PostgREST, Redis, browser). Stilul canaryGate1.test.ts.
 *
 * Lumea fake implementează comportamentul CORECT al lotului (invitație → entitlement, CIMD + callback exact, revocare,
 * expirare, refuzul refresh-ului legacy, drepturi PostgREST); fiecare test injectează un defect și cere ca exact pasul
 * corespunzător să pice cu codul închis așteptat.
 */
import {
  runGate1Staging, renderStagingReport, stagingExitCode, STEP_IDS, PROBE_TOOL,
  type StagingProbeIo, type BrowserSession, type PgRole, type PgRequest, type StagingReport, type StepRow,
} from "./canaryGate1Staging";
import type { StagingProbeConfig } from "./canaryGate1StagingTargets";
import type { HttpResponse } from "./canaryTokenClient";
import type { McpHttpResponse } from "./canaryMcpClient";
import { accessTokenKey, refreshTokenKey } from "../db/oauthStorageKeys";
import { hashInviteToken } from "../oauth/inviteRedeem";
import { deriveS256Challenge } from "../oauth/pkce";
import { mcpResponse, mcpErr, ERR, PREFLIGHT_OUTPUT_SCHEMA } from "./errors";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

console.log("lot OAuth staging C — canaryGate1Staging (orchestrator, lume de staging simulată)");

const REF = "abcdefghijklmnopqrst";
const O = "https://preflight-staging.up.railway.app";
const CB = "https://claude.ai/api/mcp/auth_callback";
const CIMD = "https://claude.ai/oauth/claude-mcp-client-metadata";
const jwt = (claims: Record<string, unknown>): string =>
  `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;
const CFG: StagingProbeConfig = {
  mcpBaseUrl: O, supabaseUrl: `https://${REF}.supabase.co`,
  supabaseAnonKey: jwt({ role: "anon", ref: REF }), supabaseServiceKey: jwt({ role: "service_role", ref: REF }),
  expectSupabaseRef: REF, redisUrl: "rediss://default:pw@staging.proxy.rlwy.net:1234", expectRedisHost: "staging.proxy.rlwy.net",
  cimdClientId: CIMD,
};
const ENV = { NEXT_PUBLIC_SUPABASE_URL: CFG.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: CFG.supabaseServiceKey, REDIS_URL: CFG.redisUrl };
const RUN_ID = "abcd1234ef";
const VERIFIER = `sb-${REF}-auth-token-code-verifier`;
const SCHEMA = toJsonSchemaCompat(PREFLIGHT_OUTPUT_SCHEMA, { strictUnions: true, pipeStrategy: "output" });

// ────────────────────────────── lumea fake ──────────────────────────────

interface Bugs {
  noCimd?: boolean; healthDown?: boolean;
  legacyRefreshAccepted?: boolean;   // flag PH2_REJECT_LEGACY_AUTHCODE oprit
  unauthorizedSecretWorks?: boolean; // 0002 neaplicat
  wwwAuthRelative?: boolean;
  asHasRegistration?: boolean;
  inviteNotRedeemed?: boolean;
  unentitledConsent?: boolean;
  e3nRedirects?: boolean;
  revokeIneffective?: boolean;
  toolIsError?: boolean;
  expiryIgnored?: boolean;
  anonCanSelectInvites?: boolean;
  userCanPatchExpiry?: boolean;
  rpcControlBroken?: boolean;
  redisNotBound?: boolean;
  deleteUserFails?: boolean;
  approveThrows?: boolean;
  // login PKCE prin formular + Send Email Hook
  hookAbsent?: boolean;          // hook-ul neactivat: GoTrue creează userul, dar nu apare niciun rând
  tokenNotPkce?: boolean;        // token_hash fără prefixul pkce_
  redirectToSiteUrl?: boolean;   // redirect_to necomis în allow list → Site URL
  duplicateCapture?: boolean;    // două rânduri proaspete pentru același submit
  codeExchangeFails?: boolean;   // /auth/callback nu poate schimba codul (verifier pierdut)
}

interface Client { row: Record<string, unknown>; secret: string }
interface Grant { grant_id: string; user_id: string; client_id: string; status: string }
type Access = { kind: "cc"; clientId: string } | { kind: "user"; userId: string; grantId: string };
type Refresh = { kind: "user"; userId: string; grantId: string; used: boolean } | { kind: "legacy" };

class World {
  n = 0;
  secrets: string[] = [];
  users = new Map<string, string>();               // userId → email
  invites = new Map<string, { invite_id: string; email_normalized: string; token_hash: string; expires_at: string; redeemed_at: string | null; redeemed_by: string | null }>();
  entitlements = new Map<string, Record<string, unknown>>();
  clients = new Map<string, Client>();
  grants: Grant[] = [];
  mail: Array<Record<string, unknown>> = [];       // public.staging_auth_mail_capture
  mailSeq = 0;
  linkTokens = new Map<string, string>();          // token_hash (pkce_…) → email
  access = new Map<string, Access>();
  refresh = new Map<string, Refresh>();
  codes = new Map<string, { userId: string; grantId: string; challenge: string }>();
  sessionsClosed = 0;
  mintCalls = 0;
  makeIoCalls = 0;
  jwtCalls = 0;
  constructor(public bugs: Bugs = {}) {}

  id(p: string): string { this.n++; return `${p}-${this.n}`; }
  uuid(): string { this.n++; return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, "0")}`; }
  userByEmail(email: string): string | null { return [...this.users.entries()].find(([, e]) => e === email)?.[0] ?? null; }
  secret(p: string): string { const s = `${p}SECRET${this.n++}x`; this.secrets.push(s); return s; }

  accessValid(tok: string): boolean {
    const a = this.access.get(tok);
    if (!a) return false;
    if (a.kind === "cc") {
      const c = this.clients.get(a.clientId);
      return !!c && c.row.status === "active" && (c.row.admin_authorized_at !== null || this.bugs.unauthorizedSecretWorks === true);
    }
    const g = this.grants.find((x) => x.grant_id === a.grantId);
    return !!g && g.status === "active" && this.entitled(a.userId);
  }
  entitled(userId: string): boolean {
    const e = this.entitlements.get(userId);
    if (!e) return false;
    if (this.bugs.expiryIgnored) return true;
    return e.access_expires_at === null || Date.parse(String(e.access_expires_at)) > Date.now();
  }
  issuePair(userId: string, grantId: string): { access: string; refresh: string } {
    const access = this.secret("AT"), refresh = this.secret("RT");
    this.access.set(access, { kind: "user", userId, grantId });
    this.refresh.set(refresh, { kind: "user", userId, grantId, used: false });
    return { access, refresh };
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): McpHttpResponse =>
  ({ status, headers: { "content-type": "application/json", ...headers }, text: async () => JSON.stringify(body) });
const form = (status: number, body: unknown): HttpResponse => ({ status, text: async () => JSON.stringify(body) });

function makeSession(w: World): BrowserSession {
  const cookies = new Set<string>();
  let inviteToken: string | null = null;
  let user: string | null = null;
  let approve = false;
  let last: { state: string; challenge: string; redirect: string } | null = null;
  return {
    async open(url) {
      const u = new URL(url);
      if (u.pathname === "/signup/invite") { inviteToken = u.searchParams.get("token"); cookies.add("pf_invite"); return { finalUrl: `${O}/signup` }; }
      if (u.origin === CFG.supabaseUrl && u.pathname === "/auth/v1/verify") {
        // GoTrue: token PKCE → redirect_to?code=… ; produsul schimbă codul cu verifier-ul ACESTUI context.
        const email = w.linkTokens.get(u.searchParams.get("token") ?? "");
        if (!email || u.searchParams.get("redirect_to") !== `${O}/auth/callback`) return { finalUrl: `${CFG.supabaseUrl}/auth/v1/verify` };
        w.linkTokens.delete(u.searchParams.get("token") ?? "");
        if (!cookies.has(VERIFIER) || w.bugs.codeExchangeFails) return { finalUrl: `${O}/login?error=auth_failed` };
        cookies.delete(VERIFIER);
        cookies.add(`sb-${REF}-auth-token`);
        user = w.userByEmail(email);
        if (cookies.has("pf_invite") && inviteToken && user) {
          cookies.delete("pf_invite");
          const inv = [...w.invites.values()].find((i) => i.token_hash === hashInviteToken(inviteToken!));
          if (inv && !inv.redeemed_at && inv.email_normalized === email && !w.bugs.inviteNotRedeemed) {
            inv.redeemed_at = new Date().toISOString(); inv.redeemed_by = user;
            w.entitlements.set(user, { user_id: user, plan: "free_trial", scopes: ["read:basic"], rate_limit_per_minute: 10, rate_limit_per_day: 500, status: "active", access_expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString() });
          }
        }
        return { finalUrl: `${O}/dashboard` };
      }
      if (u.pathname === "/authorize") {
        if (!user) return { finalUrl: `${O}/login` };
        if (u.searchParams.get("client_id") !== CIMD || u.searchParams.get("redirect_uri") !== CB) return { finalUrl: `${O}/api/oauth/authorize/start` };
        last = { state: u.searchParams.get("state") ?? "", challenge: u.searchParams.get("code_challenge") ?? "", redirect: CB };
        approve = w.entitled(user) || w.bugs.unentitledConsent === true;
        return { finalUrl: `${O}/authorize?txn_id=t${w.n++}` };
      }
      return { finalUrl: url };
    },
    async submitSignup(email) {
      // Formularul real: signInWithOtp (PKCE) → GoTrue creează userul (dacă lipsește) → Send Email Hook → rând capturat.
      const existing = w.userByEmail(email);
      const userId = existing ?? w.uuid();
      if (!existing) w.users.set(userId, email);
      cookies.add(VERIFIER);
      if (w.bugs.hookAbsent) return "sent";
      const copies = w.bugs.duplicateCapture ? 2 : 1;
      for (let i = 0; i < copies; i++) {
        const token = `${w.bugs.tokenNotPkce ? "" : "pkce_"}${w.secret("LINK")}`;
        w.linkTokens.set(token, email);
        w.mail.push({
          id: ++w.mailSeq, user_id: userId, email, email_action_type: existing ? "magiclink" : "signup", token_hash: token,
          redirect_to: w.bugs.redirectToSiteUrl ? `${O}/` : `${O}/auth/callback`, site_url: O,
        });
      }
      return "sent";
    },
    async cookieNames() { return [...cookies]; },
    async hasApproveButton() { return approve; },
    async approveConsent() {
      if (w.bugs.approveThrows) throw new Error("SECRET-boom-approve");
      if (!approve || !user || !last) return { kind: "failed" };
      const grant: Grant = { grant_id: w.id("g"), user_id: user, client_id: CIMD, status: "active" };
      w.grants.push(grant);
      const code = w.secret("CODE");
      w.codes.set(code, { userId: user, grantId: grant.grant_id, challenge: last.challenge });
      const loc = `${last.redirect}?${new URLSearchParams({ code, state: last.state, iss: O }).toString()}`;
      return { kind: "captured", location: loc };
    },
    async probeAuthorizeNoFollow(url) {
      const r = new URL(url).searchParams.get("redirect_uri") ?? "";
      if (w.bugs.e3nRedirects) return { startStatus: null, redirectLocation: `${r}?error=invalid_request`, approveVisible: false };
      return { startStatus: 400, redirectLocation: null, approveVisible: false };
    },
    async clickRevoke() {
      if (!user) return "missing";
      if (!w.bugs.revokeIneffective) for (const g of w.grants) if (g.user_id === user) g.status = "revoked";
      return "ok";
    },
    offsiteCaptures() { return []; },
    async close() { w.sessionsClosed++; },
  };
}

function filterOf(path: string, col: string): string | null {
  const q = new URLSearchParams(path.split("?")[1] ?? "");
  const v = q.get(col);
  return v && v.startsWith("eq.") ? v.slice(3) : null;
}

function makeIo(w: World): StagingProbeIo {
  w.makeIoCalls++;
  const asMeta: Record<string, unknown> = {
    issuer: O, authorization_endpoint: `${O}/authorize`, token_endpoint: `${O}/api/oauth/token`,
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"], code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
  };
  if (w.bugs.asHasRegistration) asMeta.registration_endpoint = `${O}/register`;
  const www = w.bugs.wwwAuthRelative
    ? 'Bearer resource_metadata="/.well-known/oauth-protected-resource"'
    : `Bearer resource_metadata="${O}/.well-known/oauth-protected-resource", scope="read:basic"`;

  return {
    postJson: async (_url, body, headers) => {
      const auth = headers["Authorization"];
      if (!auth) return json(401, { ok: false, error: { code: "UNAUTHORIZED", message: "x" } }, { "www-authenticate": www });
      if (!w.accessValid(auth.replace(/^Bearer /, ""))) return json(401, { ok: false, error: { code: "INVALID_TOKEN", message: "x" } }, { "www-authenticate": www });
      const req = JSON.parse(body) as { id: number; method: string };
      if (req.method === "initialize") return json(200, { jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "p", version: "1" } } });
      if (req.method === "tools/list") return json(200, { jsonrpc: "2.0", id: req.id, result: { tools: [{ name: PROBE_TOOL, inputSchema: { type: "object" }, outputSchema: SCHEMA }] } });
      if (w.bugs.toolIsError) return json(200, { jsonrpc: "2.0", id: req.id, result: mcpErr(ERR.REDIS_DOWN, "Redis not connected") });
      return json(200, { jsonrpc: "2.0", id: req.id, result: mcpResponse({ text: "STATUS: Pipeline empty.", freshnessSec: null, confidence: "LOW", warnings: ["w"], dataQuality: { wsFlow: "absent" }, evidence: { trackedPairs: 0 } }) });
    },

    postForm: async (_url, body) => {
      const f = new URLSearchParams(body);
      const gt = f.get("grant_type");
      if (gt === "client_credentials") {
        const c = w.clients.get(f.get("client_id") ?? "");
        const authorized = !!c && (c.row.admin_authorized_at !== null || w.bugs.unauthorizedSecretWorks === true);
        if (!c || c.secret !== f.get("client_secret") || !authorized || c.row.status !== "active") return form(401, { error: "invalid_client" });
        const at = w.secret("ATCC");
        w.access.set(at, { kind: "cc", clientId: String(c.row.client_id) });
        return form(200, { access_token: at, token_type: "Bearer", expires_in: 86400, scope: (c.row.scopes as string[]).join(" ") });
      }
      if (gt === "authorization_code") {
        const code = w.codes.get(f.get("code") ?? "");
        if (!code || f.get("client_id") !== CIMD || f.get("redirect_uri") !== CB || deriveS256Challenge(f.get("code_verifier") ?? "") !== code.challenge) return form(400, { error: "invalid_grant" });
        w.codes.delete(f.get("code") ?? "");
        const p = w.issuePair(code.userId, code.grantId);
        return form(200, { access_token: p.access, token_type: "Bearer", expires_in: 86400, refresh_token: p.refresh, scope: "read:basic" });
      }
      if (gt === "refresh_token") {
        const r = w.refresh.get(f.get("refresh_token") ?? "");
        if (!r) return form(400, { error: "invalid_grant" });
        if (r.kind === "legacy") {
          if (!w.bugs.legacyRefreshAccepted) return form(400, { error: "invalid_grant", error_description: "Legacy refresh tokens are no longer accepted" });
          return form(200, { access_token: w.secret("ATL"), token_type: "Bearer", expires_in: 86400, refresh_token: w.secret("RTL"), scope: "read:all" });
        }
        const g = w.grants.find((x) => x.grant_id === r.grantId);
        if (r.used || !g || g.status !== "active" || !w.entitled(r.userId)) return form(400, { error: "invalid_grant" });
        r.used = true;
        const p = w.issuePair(r.userId, r.grantId);
        return form(200, { access_token: p.access, token_type: "Bearer", expires_in: 86400, refresh_token: p.refresh, scope: "read:basic" });
      }
      return form(400, { error: "unsupported_grant_type" });
    },

    async get(url) {
      if (url === `${O}/api/health`) {
        const status = w.bugs.healthDown ? "down" : "degraded";
        return { status: 200, headers: {}, body: JSON.stringify({ status, httpStatus: 200, scope: "mcp-web", checks: { web: { ok: true }, redis: { ok: !w.bugs.healthDown }, worker: { ok: false }, ws: { ok: false } } }) };
      }
      if (url === `${O}/.well-known/oauth-protected-resource`) return { status: 200, headers: {}, body: JSON.stringify({ resource: `${O}/api/mcp`, authorization_servers: [O] }) };
      if (url === `${O}/.well-known/oauth-authorization-server`) return { status: 200, headers: {}, body: JSON.stringify(asMeta) };
      return { status: 404, headers: {}, body: "" };
    },

    admin: {
      async readCimdRegistration(clientId) {
        if (w.bugs.noCimd || clientId !== CIMD) return { status: "not_found" };
        return { status: "found", row: { client_id: CIMD, client_type: "public", token_endpoint_auth_method: "none", status: "active", grant_types: ["authorization_code", "refresh_token"], redirect_uris: [CB], expires_at: null } };
      },
      async createUser(email) { const id = w.uuid(); w.users.set(id, email); return { ok: true, userId: id }; },
      async deleteUser(userId) {
        if (w.bugs.deleteUserFails) return "unavailable";
        if (!w.users.delete(userId)) return "not_found";
        w.entitlements.delete(userId);
        w.grants = w.grants.filter((g) => g.user_id !== userId);
        return "deleted";
      },
      async findUserIdByEmail(email) { const id = w.userByEmail(email); return id ? { status: "found", row: id } : { status: "not_found" }; },
      async readMailCaptures(email) { return { status: "found", row: w.mail.filter((m) => m.email === email).map((m) => ({ ...m })) }; },
      async deleteMailCaptures(email) {
        const before = w.mail.length;
        w.mail = w.mail.filter((m) => m.email !== email);
        return w.mail.length < before ? "deleted" : "not_found";
      },
      async userAccessToken() { w.jwtCalls++; return { ok: true, jwt: w.secret("JWT") }; },
      async createInvite(email) {
        const token = w.secret("INV"); const id = w.id("inv");
        w.invites.set(id, { invite_id: id, email_normalized: email, token_hash: hashInviteToken(token), expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), redeemed_at: null, redeemed_by: null });
        return { ok: true, inviteId: id, token };
      },
      async deleteInvite(id) { return w.invites.delete(id) ? "deleted" : "not_found"; },
      async readInvite(id) { const r = w.invites.get(id); return r ? { status: "found", row: { ...r } } : { status: "not_found" }; },
      async readEntitlement(uid) { const r = w.entitlements.get(uid); return r ? { status: "found", row: { ...r } } : { status: "not_found" }; },
      async setEntitlementExpiry(uid, iso) { const r = w.entitlements.get(uid); if (!r) return false; r.access_expires_at = iso; return true; },
      async createLegacyClient(spec) {
        const clientId = w.id("tp"); const secret = w.secret("CS");
        const free = spec.model === "dashboard_free_trial";
        w.clients.set(clientId, { secret, row: {
          client_id: clientId, user_id: spec.userId, name: spec.name, plan: free ? "free_trial" : "starter", scopes: free ? ["read:basic"] : ["read:all"],
          status: "active", created_at: "2026-11-03T00:00:00Z", admin_authorized_at: null, admin_authorized_by: null, secret_rotated_at: "2026-11-03T00:00:00Z",
        } });
        return { ok: true, clientId, secret };
      },
      async readClient(id) { const c = w.clients.get(id); return c ? { status: "found", row: { ...c.row } } : { status: "not_found" }; },
      async patchClientAuthorization(id, patch, requireActive) {
        const c = w.clients.get(id);
        if (!c || (requireActive && c.row.status !== "active")) return false;
        Object.assign(c.row, patch);
        return true;
      },
      async deleteClient(id) { return w.clients.delete(id) ? "deleted" : "not_found"; },
      async readGrants(uid) { return { status: "found", row: w.grants.filter((g) => g.user_id === uid).map((g) => ({ ...g })) }; },
    },

    async postgrest(role: PgRole, req: PgRequest) {
      const table = req.path.split("?")[0];
      if (role.kind !== "service") {
        if (w.bugs.anonCanSelectInvites && role.kind === "anon" && req.method === "GET" && table === "beta_invites") {
          return { status: 200, body: JSON.stringify([{ invite_id: filterOf(req.path, "invite_id") }]) };
        }
        if (w.bugs.userCanPatchExpiry && role.kind === "user" && req.method === "PATCH" && table === "account_entitlements") {
          const uid = filterOf(req.path, "user_id") ?? "";
          const e = w.entitlements.get(uid);
          if (e) Object.assign(e, req.body as Record<string, unknown>);
          return { status: 200, body: JSON.stringify(e ? [{ user_id: uid }] : []) };
        }
        return { status: role.kind === "anon" ? 401 : 403, body: '{"code":"42501","message":"permission denied"}' };
      }
      if (table === "rpc/redeem_beta_invite") {
        const a = req.body as Record<string, unknown>;
        const inv = [...w.invites.values()].find((i) => i.token_hash === a.p_token_hash);
        if (w.bugs.rpcControlBroken || !inv) return { status: 200, body: '"not_found"' };
        if (inv.redeemed_at) return { status: 200, body: '"already_redeemed"' };
        const uid = String(a.p_user_id);
        inv.redeemed_at = String(a.p_now); inv.redeemed_by = uid;
        w.entitlements.set(uid, { user_id: uid, plan: "free_trial", scopes: ["read:basic"], rate_limit_per_minute: 10, rate_limit_per_day: 500, status: "active", access_expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(), updated_at: "t0" });
        return { status: 200, body: '"redeemed"' };
      }
      if (table === "beta_invites" && req.method === "GET") {
        const r = w.invites.get(filterOf(req.path, "invite_id") ?? "");
        return { status: 200, body: JSON.stringify(r ? [req.path.includes("select=invite_id&") ? { invite_id: r.invite_id } : { ...r }] : []) };
      }
      if (table === "account_entitlements") {
        const uid = filterOf(req.path, "user_id") ?? "";
        const e = w.entitlements.get(uid);
        if (req.method === "GET") return { status: 200, body: JSON.stringify(e ? [{ ...e }] : []) };
        if (e) { Object.assign(e, req.body as Record<string, unknown>, { updated_at: `t${w.n++}` }); }
        return { status: 200, body: JSON.stringify(e ? [{ user_id: uid }] : []) };
      }
      if (table === "oauth_clients") {
        const c = w.clients.get(filterOf(req.path, "client_id") ?? "");
        if (req.method === "GET") return { status: 200, body: JSON.stringify(c ? [{ client_id: c.row.client_id, user_id: c.row.user_id, status: c.row.status, admin_authorized_at: c.row.admin_authorized_at, admin_authorized_by: c.row.admin_authorized_by }] : []) };
        if (c) Object.assign(c.row, req.body as Record<string, unknown>);
        return { status: 200, body: JSON.stringify(c ? [{ client_id: c.row.client_id }] : []) };
      }
      return { status: 404, body: '{"code":"PGRST205"}' };
    },

    redis: {
      async exists(key) {
        if (w.bugs.redisNotBound) return "absent";
        for (const t of w.access.keys()) if (accessTokenKey(t) === key) return "present";
        for (const t of w.refresh.keys()) if (refreshTokenKey(t) === key) return "present";
        return "absent";
      },
      async mintLegacyRefresh(payload, access) {
        w.mintCalls++;
        if (payload.user_id !== undefined || access.client_id !== payload.client_id) return { ok: false };
        const rt = w.secret("RTLEG");
        w.refresh.set(rt, { kind: "legacy" });
        return { ok: true, refreshToken: rt };
      },
    },

    newBrowserSession: async () => makeSession(w),
    async close() { /* nimic */ },
  };
}

async function run(bugs: Bugs = {}, cfg: Partial<StagingProbeConfig> | null = CFG, env: Record<string, string | undefined> = ENV): Promise<{ r: StagingReport; w: World }> {
  const w = new World(bugs);
  const r = await runGate1Staging(cfg, () => makeIo(w), { runId: RUN_ID, processEnv: env, sleep: async () => {} });
  return { r, w };
}
const row = (r: StagingReport, id: string): StepRow | undefined => r.steps.find((s) => s.id === id);
const failedIds = (r: StagingReport): string[] => r.steps.filter((s) => s.status === "FAIL").map((s) => s.id);

async function main(): Promise<void> {
  // ── happy ──
  {
    const { r, w } = await run();
    check("1. ⭐⭐⭐ lume corectă → toți pașii PASS, cleanup ok, ok:true, exit 0", r.ok === true && r.stage === "steps" && failedIds(r).length === 0 && stagingExitCode(r) === 0);
    check("2. ⭐⭐⭐ ordinea pașilor = E0a–E0e, E1–E12, E14 (STEP_IDS)", r.steps.map((s) => s.id).join(",") === STEP_IDS.join(","));
    check("3. ⭐⭐⭐ cleanup: toate sesiunile închise, invitațiile/clienții/userii creați șterși, reziduu 0",
      r.cleanup !== null && r.cleanup.ok && w.users.size === 0 && w.clients.size === 0 && w.invites.size === 0 && w.sessionsClosed === r.cleanup.sessions.attempted && r.cleanup.residue === 0
      && r.cleanup.users.attempted === 6 && r.cleanup.invites.attempted === 3 && r.cleanup.clients.attempted === 3
      && r.cleanup.sessions.attempted === 4 && r.cleanup.mail.attempted === 4);
    check("3b. ⭐⭐⭐ rândurile capturate (token_hash-uri de login) șterse; JWT-ul Node folosit DOAR pentru E14",
      w.mail.length === 0 && w.jwtCalls === 1);
    const text = renderStagingReport(r).join("\n");
    const leaked = w.secrets.filter((s) => text.includes(s));
    check("4. ⭐⭐⭐ ANTI-LEAK: niciun token/cod/secret/invitație/JWT în raport", leaked.length === 0 && w.secrets.length > 20);
    check("5. ⭐⭐⭐ ANTI-LEAK: niciun email de test în raport", !/@/.test(text) && !text.includes(RUN_ID));
    check("6. ⭐⭐ raport: o linie per pas + cleanup + verdict VERDE", text.split("\n").length === STEP_IDS.length + 2 && /VERDE/.test(text));
    check("7. ⭐⭐⭐ fixture-ul legacy minted o singură dată (doar după dovada Redis)", w.mintCalls === 1);
  }

  // ── izolare = poarta zero (makeIo NU e invocată) ──
  {
    const { r, w } = await run({}, { ...CFG, mcpBaseUrl: "https://preflight.jackspools.lol" });
    check("8. ⭐⭐⭐ MCP de producție → stage isolation, makeIo neinvocată, exit 2", r.stage === "isolation" && w.makeIoCalls === 0 && stagingExitCode(r) === 2);
  }
  {
    const { r, w } = await run({}, { ...CFG, supabaseUrl: "https://ipeyogzfgqypfkujraxm.supabase.co", expectSupabaseRef: "ipeyogzfgqypfkujraxm" });
    check("9. ⭐⭐⭐ Supabase de producție → stage isolation, makeIo neinvocată", r.stage === "isolation" && w.makeIoCalls === 0);
  }
  {
    const { r, w } = await run({}, CFG, { ...ENV, REDIS_URL: "redis://prod-redis:6379" });
    check("10. ⭐⭐⭐ env-ul procesului ≠ vetat (bibliotecile de produs ar lovi altceva) → isolation, makeIo neinvocată",
      r.stage === "isolation" && r.code === "env_redis_url_mismatch" && w.makeIoCalls === 0);
  }
  {
    const w = new World();
    const r = await runGate1Staging(CFG, () => { w.makeIoCalls++; throw new Error("SECRET-setup"); }, { runId: RUN_ID, processEnv: ENV });
    check("11. ⭐⭐ makeIo aruncă → stage setup generic, fără mesajul excepției", r.stage === "setup" && r.code === "io_factory_threw" && !renderStagingReport(r).join("").includes("SECRET"));
  }
  {
    const w = new World();
    const r = await runGate1Staging(CFG, () => makeIo(w), { runId: "BAD ID", processEnv: ENV });
    check("12. ⭐ runId invalid → setup run_id_invalid, makeIo neinvocată", r.stage === "setup" && r.code === "run_id_invalid" && w.makeIoCalls === 0);
  }

  // ── precondiții ──
  {
    const { r, w } = await run({ noCimd: true });
    check("13. ⭐⭐⭐ rând CIMD lipsă → preflight cimd_not_provisioned, NIMIC creat", r.stage === "preflight" && r.code === "cimd_not_provisioned" && w.n === 0 && w.users.size === 0);
  }
  {
    const { r } = await run({ healthDown: true });
    check("14. ⭐⭐ health down → preflight health_not_ready", r.stage === "preflight" && r.code === "health_not_ready");
  }

  // ── defecte injectate → exact pasul așteptat pică ──
  {
    const { r } = await run({ legacyRefreshAccepted: true });
    check("15. ⭐⭐⭐ refresh legacy acceptat (flag oprit) → E0e FAIL refusal_body_has_token; restul PASS",
      row(r, "E0e")?.code === "refusal_body_has_token" && failedIds(r).join(",") === "E0e" && !r.ok);
  }
  {
    const { r } = await run({ unauthorizedSecretWorks: true });
    check("16. ⭐⭐⭐ secret neautorizat încă emite token → E0b FAIL refusal_body_has_token; E0c–E0e blocked",
      row(r, "E0b")?.code === "refusal_body_has_token" && row(r, "E0c")?.code === "blocked" && row(r, "E0e")?.code === "blocked" && row(r, "E1")?.status === "PASS");
  }
  {
    const { r } = await run({ wwwAuthRelative: true });
    check("17. ⭐⭐⭐ resource_metadata relativ → E1 FAIL discovery_resource_metadata_mismatch", row(r, "E1")?.code === "discovery_resource_metadata_mismatch" && failedIds(r).join(",") === "E1");
  }
  {
    const { r } = await run({ asHasRegistration: true });
    check("18. ⭐⭐ AS cu registration_endpoint → E1 FAIL as_registration_endpoint_present", row(r, "E1")?.code === "as_registration_endpoint_present");
  }
  {
    const { r } = await run({ inviteNotRedeemed: true });
    check("19. ⭐⭐⭐ invitația nu se răscumpără → E2 FAIL entitlement_missing; E3–E10 blocked; E11 FAIL",
      row(r, "E2")?.code === "entitlement_missing" && row(r, "E10")?.code === "blocked" && row(r, "E11")?.status === "FAIL" && row(r, "E2n")?.status === "PASS");
  }
  {
    const { r } = await run({ unentitledConsent: true });
    check("20. ⭐⭐⭐ cont fără invitație vede consimțământul → E2n FAIL unentitled_consent_rendered", row(r, "E2n")?.code === "unentitled_consent_rendered" && failedIds(r).join(",") === "E2n");
  }
  {
    const { r } = await run({ e3nRedirects: true });
    check("21. ⭐⭐⭐ redirect neînregistrat redirecționat → E3n FAIL refusal_redirected; E4+ blocked",
      row(r, "E3n")?.code === "refusal_redirected" && row(r, "E4")?.code === "blocked" && row(r, "E11")?.status === "PASS");
  }
  {
    const { r } = await run({ revokeIneffective: true });
    check("22. ⭐⭐⭐ revocarea nu atinge grant-ul → E8 FAIL grant_still_active; E9/E10 blocked",
      row(r, "E8")?.code === "grant_still_active" && row(r, "E9")?.code === "blocked" && row(r, "E10")?.code === "blocked");
  }
  {
    const { r } = await run({ toolIsError: true });
    check("23. ⭐⭐⭐ tool cu isError:true (HTTP 200) → E0a/E6/E11 FAIL call_is_error",
      row(r, "E0a")?.code === "call_is_error" && row(r, "E6")?.code === "call_is_error" && row(r, "E11")?.code === "call_is_error");
  }
  {
    const { r } = await run({ expiryIgnored: true });
    check("24. ⭐⭐⭐ expirarea ignorată → E11 FAIL call_not_rejected; E12 blocked", row(r, "E11")?.code === "call_not_rejected" && row(r, "E12")?.code === "blocked");
  }
  {
    const { r } = await run({ anonCanSelectInvites: true });
    check("25. ⭐⭐⭐ anon poate citi beta_invites → E14_select FAIL anon_not_denied", row(r, "E14_select")?.code === "anon_not_denied" && row(r, "E14_expiry")?.code === "blocked");
  }
  {
    const { r } = await run({ userCanPatchExpiry: true });
    check("26. ⭐⭐⭐ authenticated poate prelungi access_expires_at → E14_expiry FAIL user_not_denied", row(r, "E14_expiry")?.code === "user_not_denied");
  }
  {
    const { r } = await run({ rpcControlBroken: true });
    check("27. ⭐⭐⭐ controlul pozitiv RPC nu dă 'redeemed' → E14_rpc FAIL control_failed (negativele NU pot trece singure)",
      row(r, "E14_rpc")?.code === "control_failed" && row(r, "E14_admin")?.code === "blocked");
  }
  {
    const { r, w } = await run({ redisNotBound: true });
    check("28. ⭐⭐⭐ Redis-ul probei ≠ Redis-ul staging-ului → E0e FAIL redis_not_bound, NICIO scriere în Redis",
      row(r, "E0e")?.code === "redis_not_bound" && w.mintCalls === 0);
  }
  {
    const { r, w } = await run({ approveThrows: true });
    check("29. ⭐⭐⭐ un pas aruncă → FAIL threw (fără mesaj), cleanup tot rulează",
      row(r, "E4")?.code === "threw" && row(r, "E11")?.code === "threw" && w.users.size === 0 && !renderStagingReport(r).join("").includes("SECRET"));
  }
  {
    const { r } = await run({ deleteUserFails: true });
    check("30. ⭐⭐⭐ cleanup incomplet → ok:false chiar dacă toți pașii PASS (fail-closed pe reziduu)",
      failedIds(r).length === 0 && r.cleanup !== null && !r.cleanup.ok && !r.ok && stagingExitCode(r) === 1 && /INCOMPLET/.test(renderStagingReport(r).join("\n")));
  }

  // ── login PKCE prin formular + Send Email Hook ──
  {
    const { r, w } = await run({ hookAbsent: true });
    check("31. ⭐⭐⭐ hook neactivat → preflight mail_capture_hook_absent, niciun pas; contul creat de GoTrue găsit după email și șters",
      r.stage === "preflight" && r.code === "mail_capture_hook_absent" && r.steps.length === 0 && r.cleanup !== null && r.cleanup.ok && w.users.size === 0);
  }
  {
    const { r, w } = await run({ tokenNotPkce: true });
    check("32. ⭐⭐⭐ token_hash fără pkce_ → preflight mail_token_not_pkce (asumpția verificată fail-closed)", r.stage === "preflight" && r.code === "mail_token_not_pkce" && w.mail.length === 0);
  }
  {
    const { r } = await run({ redirectToSiteUrl: true });
    check("33. ⭐⭐ redirect_to = Site URL (nu callback-ul) → preflight mail_redirect_unexpected", r.stage === "preflight" && r.code === "mail_redirect_unexpected");
  }
  {
    const { r } = await run({ duplicateCapture: true });
    check("34. ⭐⭐ două rânduri proaspete → preflight mail_capture_multiple", r.stage === "preflight" && r.code === "mail_capture_multiple");
  }
  {
    const { r, w } = await run({ codeExchangeFails: true });
    check("35. ⭐⭐⭐ callback-ul nu schimbă codul → E2/E2n/E11 FAIL callback_auth_failed; restul lanțurilor neatinse; cleanup complet",
      row(r, "E2")?.code === "callback_auth_failed" && row(r, "E2n")?.code === "callback_auth_failed" && row(r, "E11")?.code === "callback_auth_failed"
      && row(r, "E0e")?.status === "PASS" && row(r, "E14_admin")?.status === "PASS" && w.users.size === 0 && w.mail.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("test crashed:", e); process.exit(1); });
