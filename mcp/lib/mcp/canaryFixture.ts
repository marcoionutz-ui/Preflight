/**
 * lib/mcp/canaryFixture.ts — PH-12 12.5b-5 (fixtură de provisioning idempotent pentru Gate 1 auth-canary, PUR).
 *
 * Provizionează resursele DE CARE fluxul Gate 1 (12.5b-3) are nevoie ca să poată face login→consent→token:
 *   1) un UTILIZATOR Supabase CONFIRMAT (auth.users, email_confirm) — pe care browserul îl loghează în 12.5b-4b;
 *   2) un `account_entitlements` pentru acel user (plan/scopes/limite, status active) — sursa de entitlement a
 *      fluxurilor auth-code (PH-2);
 *   3) o înregistrare DCR PUBLICĂ (`oauth_client_registrations`): `client_type=public`,
 *      `token_endpoint_auth_method=none`, `grant_types={authorization_code,refresh_token}`, `redirect_uris=[redirectUri]`.
 *
 * ORDINEA REALĂ în 12.5b-4b (lock Marco): listener → redirect URI EXACT → provisioning → browser. Fixtura NU deschide
 * listenerul; primește `redirectUri` ca INPUT (lock #1) și îl înregistrează BYTE-EXACT (matching-ul OAuth de redirect e
 * exact-string — nicio normalizare).
 *
 * PUR / HERMETIC: toată logica (secvențiere, idempotență, comparare, manifest, cleanup) trăiește aici peste un PORT
 * injectat `FixtureStore` (coduri închise). Testele rulează cu un fake al portului, fără Supabase. Adaptorul REAL peste
 * `supabaseAdmin` (mapare port→client) se construiește în 12.5b-4b și DOAR după izolarea anti-prod
 * (`buildFixtureStoreAfterIsolation`) — un config care atinge prod nici nu ajunge să construiască adaptorul.
 *
 * IDEMPOTENȚĂ FAIL-CLOSED (lock #4): `create` întâi; pe CONFLICT (cheie unică existentă) se re-citește rândul și se
 * compară EXACT cu cel intenționat → coincide ⇒ ADOPTAT (idempotent, retry sigur al ACELUIAȘI run); diferă ⇒ EȘEC
 * fail-closed (NU suprascriem NIMIC). Identificatori UNICI per run (lock #3): derivați determinist din `runId` (pe care
 * apelantul îl generează crypto-random per run; retry-ul aceluiași run reia ACELAȘI runId → aceleași chei).
 *
 * MANIFEST + CLEANUP (lock #5,6,7): manifestul conține DOAR resursele CREATE în run-ul curent (nu și cele adoptate).
 * `cleanupGate1Fixture` șterge EXCLUSIV intrările din manifest, în ORDINEA INVERSĂ a dependențelor, best-effort (încearcă
 * toate, nu aruncă). `runWithGate1Fixture` rulează cleanup-ul în `finally` — inclusiv după provisioning PARȚIAL (eșec la
 * jumătate) sau după ce corpul aruncă. Resursele PREEXISTENTE (adoptate) NU sunt niciodată șterse.
 *
 * ANTI-DISTRUGERE (lock #8): fixtura șterge DOAR pe cheie specifică (userId / clientId) din manifest — niciodată un
 * `FLUSHDB`, un delete „broad" fără filtru sau vreun truncate. PORTUL nici nu expune un delete fără cheie.
 *
 * ANTI-LEAK (lock #8): pașii de port întorc CODURI dintr-un union ÎNCHIS, mapate AICI la mesaje STATICE (fără valori de
 * rând, fără email, fără chei). Nu există tokenuri în provisioning; adaptorul real (4b) NU va loga service-role key-ul.
 */

import { assertCanaryIsolation, type CanaryConfig } from "./releaseGate";
import { SERVER_SCOPE_CATALOG } from "../oauth/scopeCatalog";

// ────────────────────────────── rânduri intenționate (forma DB) ──────────────────────────────

/** Rândul `account_entitlements` pe care-l inserăm (coloane byte-exact cu schema 0001). */
export interface EntitlementRow {
  user_id:               string;
  plan:                  string;
  scopes:                string[];
  rate_limit_per_minute: number;
  rate_limit_per_day:    number;
  status:                "active";
}

/** Rândul `oauth_client_registrations` (DCR public) pe care-l inserăm. */
export interface RegistrationRow {
  client_id:                  string;
  client_type:                "public";
  token_endpoint_auth_method: "none";
  grant_types:                string[]; // ["authorization_code","refresh_token"]
  redirect_uris:              string[]; // [redirectUri] EXACT
  client_name:                string;
  status:                     "active";
}

/** Snapshot-ul relevant pt. comparare la conflict (câmpurile pe care le impunem; ignorăm id/version/timestamps). */
export interface EntitlementSnapshot {
  plan:                  string;
  scopes:                string[];
  rate_limit_per_minute: number;
  rate_limit_per_day:    number;
  status:                string;
}
export interface RegistrationSnapshot {
  client_type:                string;
  token_endpoint_auth_method: string;
  grant_types:                string[];
  redirect_uris:              string[];
  client_name:                string | null;
  status:                     string;
}

// ────────────────────────────── PORT-ul injectat (coduri închise) ──────────────────────────────

export type UserCreateOutcome =
  | { status: "created"; userId: string }
  | { status: "conflict" }        // există deja un user cu acest email
  | { status: "unavailable" };
export type UserReadOutcome =
  | { status: "found"; userId: string; emailConfirmed: boolean }
  | { status: "not_found" }
  | { status: "unavailable" };

export type CreateOutcome =
  | { status: "created" }
  | { status: "conflict" }        // cheie unică deja prezentă
  | { status: "unavailable" };
export type EntitlementReadOutcome =
  | { status: "found"; snapshot: EntitlementSnapshot }
  | { status: "not_found" }
  | { status: "unavailable" };
export type RegistrationReadOutcome =
  | { status: "found"; snapshot: RegistrationSnapshot }
  | { status: "not_found" }
  | { status: "unavailable" };

/** Delete pe cheie SPECIFICĂ. `not_found` = deja dispărut (benign la cleanup). Niciun delete „broad" în port. */
export type DeleteOutcome = { status: "deleted" | "not_found" | "unavailable" };

/**
 * Portul de provisioning. Adaptorul real (4b) îl mapează pe `supabaseAdmin` (auth.admin + tabele), traducând erorile
 * clientului în aceste coduri ÎNCHISE fără a scurge valori. Fiecare metodă e IDEMPOTENT-friendly: `create*` semnalează
 * `conflict` pe cheie unică (nu aruncă), `read*` re-citește pt. comparare, `delete*` țintește O cheie.
 */
export interface FixtureStore {
  createUser(input: { email: string }): Promise<UserCreateOutcome>;
  readUserByEmail(email: string): Promise<UserReadOutcome>;
  deleteUser(userId: string): Promise<DeleteOutcome>;

  createEntitlement(row: EntitlementRow): Promise<CreateOutcome>;
  readEntitlement(userId: string): Promise<EntitlementReadOutcome>;
  deleteEntitlement(userId: string): Promise<DeleteOutcome>;

  createRegistration(row: RegistrationRow): Promise<CreateOutcome>;
  readRegistrationByClientId(clientId: string): Promise<RegistrationReadOutcome>;
  deleteRegistration(clientId: string): Promise<DeleteOutcome>;
}

// ────────────────────────────── spec + handle + manifest ──────────────────────────────

export interface FixtureSpec {
  /** Redirect URI EXACT (din listenerul loopback din 4b). Înregistrat byte-exact, fără normalizare. */
  redirectUri: string;
  /** Identificator UNIC per run (apelantul îl generează crypto-random; retry-ul aceluiași run reia același runId). */
  runId: string;
  // ── opționale (au default-uri sănătoase pt. canary) ──
  plan?:               string;            // default "canary"
  scopes?:             readonly string[]; // default DEFAULT_FIXTURE_SCOPES
  rateLimitPerMinute?: number;            // default 60
  rateLimitPerDay?:    number;            // default 5000
  clientName?:         string;            // default "Preflight Canary DCR"
  emailDomain?:        string;            // default "canary.local"
}

/**
 * P1 (fix cgpt): scopurile fixturii TREBUIE să existe în `SERVER_SCOPE_CATALOG` (sursa unică pe care serverul o consultă
 * prin apartenență CONCRETĂ la emiterea grantului + clamp la refresh). Scope-uri inventate (`mcp:read`) s-ar clamp-a la
 * GOL tăcut → grant fără scope → fluxul real EȘUEAZĂ. Default = catalogul COMPLET (contul de canary e îndreptățit la tot
 * ce oferă serverul, deci orice tool-call trece). Derivat din catalog → nu poate deriva de contract.
 */
export const DEFAULT_FIXTURE_SCOPES: readonly string[] = [...SERVER_SCOPE_CATALOG];
const SCOPE_CATALOG_SET = new Set(SERVER_SCOPE_CATALOG);

export type FixtureResourceKind = "user" | "entitlement" | "registration";

/** O intrare de manifest = o resursă CREATĂ în run-ul curent (deci ștergibilă la cleanup). `key` = userId sau clientId. */
export interface FixtureManifestEntry {
  kind: FixtureResourceKind;
  key:  string;
}

export interface Gate1FixtureHandle {
  runId:       string;
  userId:      string;
  email:       string;
  clientId:    string;
  redirectUri: string;             // EXACT (pass-through)
  scopes:      readonly string[];  // scopurile entitlement-ului (ce poate cere fluxul)
  manifest:    readonly FixtureManifestEntry[]; // DOAR create-this-run
}

export type FixtureStage = "spec" | "user" | "entitlement" | "registration";

export type ProvisionResult =
  | { ok: true;  handle: Gate1FixtureHandle; manifest: readonly FixtureManifestEntry[] }
  | { ok: false; stage: FixtureStage; reason: string; manifest: readonly FixtureManifestEntry[] };

// ────────────────────────────── derivare identificatori + validare spec ──────────────────────────────

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/; // 8..64, alnum/_/-, start alnum → email/client_id-safe
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** email-ul derivat determinist din runId (unic per run fiindcă runId e unic per run). */
export function fixtureEmail(runId: string, emailDomain = "canary.local"): string {
  return `canary-${runId}@${emailDomain}`.toLowerCase();
}
/** client_id-ul DCR derivat determinist din runId. */
export function fixtureClientId(runId: string): string {
  return `canary-dcr-${runId}`;
}

/**
 * Validează redirectUri fără să-l MODIFICE: parseabil, http/https, host LOOPBACK, fără credențiale, fără fragment.
 * Întoarce string-ul ORIGINAL (nu `URL.href`, care ar putea re-serializa/normaliza) pt. înregistrare exactă.
 */
function validateRedirectUri(raw: string): { ok: true; exact: string } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) return { ok: false, reason: "spec: redirectUri lipsă/gol (fail-closed)" };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: "spec: redirectUri neparsabil (fail-closed)" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "spec: redirectUri cu schemă non-http(s) (fail-closed)" };
  if (u.username !== "" || u.password !== "")            return { ok: false, reason: "spec: redirectUri conține credențiale (fail-closed)" };
  if (u.hash !== "")                                     return { ok: false, reason: "spec: redirectUri conține fragment (invalid ca redirect OAuth)" };
  if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase()))     return { ok: false, reason: "spec: redirectUri non-loopback (canary Gate 1 e local) — fail-closed" };
  return { ok: true, exact: raw }; // ← ORIGINALUL, nu u.href
}

interface DerivedSpec {
  runId:       string;
  email:       string;
  clientId:    string;
  redirectUri: string; // exact
  entitlement: EntitlementRow;   // fără user_id (completat după ce știm userId)
  registration: RegistrationRow;
  scopes:      readonly string[];
}

/** Validează + derivă tot ce ține de spec (pur, fără I/O). Fail-closed pe runId/redirectUri invalid. */
function deriveSpec(spec: FixtureSpec): { ok: true; d: DerivedSpec } | { ok: false; reason: string } {
  if (!spec || typeof spec.runId !== "string" || !RUN_ID_RE.test(spec.runId)) {
    return { ok: false, reason: "spec: runId invalid (cere 8..64 alnum/_/-, start alnum) — fail-closed" };
  }
  const ru = validateRedirectUri(spec.redirectUri);
  if (!ru.ok) return { ok: false, reason: ru.reason };

  // P1 (fix cgpt): distinge ABSENT (undefined → foloseș­te defaultul) de EXPLICIT GOL (`[]` → fail-closed). Un `[] →
  // default` ar ESCALADA tăcut la TOATE scope-urile catalogului (footgun) — un apelant care cere „niciun scope" ar primi
  // tot. Deci `[]` e refuzat, nu completat cu defaultul.
  const scopes = spec.scopes === undefined ? [...DEFAULT_FIXTURE_SCOPES] : [...spec.scopes];
  if (scopes.length === 0) {
    return { ok: false, reason: "spec: scopes gol (`[]`) — fail-closed (NU escaladăm la default)" };
  }
  if (!scopes.every(s => typeof s === "string" && s.trim() !== "")) {
    return { ok: false, reason: "spec: scopes conține valori goale/whitespace (constraint arr_clean) — fail-closed" };
  }
  // P1 (fix cgpt): fiecare scope TREBUIE să existe în catalogul serverului — altfel entitlement-ul ar avea scope-uri pe
  // care /authorize le clamp-ează la GOL → grant fără scope → fluxul real eșuează. Fail-closed (nu inventăm scope-uri).
  if (!scopes.every(s => SCOPE_CATALOG_SET.has(s))) {
    return { ok: false, reason: "spec: scopes în afara SERVER_SCOPE_CATALOG (fluxul real le-ar clamp-a la gol) — fail-closed" };
  }
  const plan = spec.plan ?? "canary";
  if (plan.trim() === "") return { ok: false, reason: "spec: plan gol (constraint plan_nonempty) — fail-closed" };
  const rlm = spec.rateLimitPerMinute ?? 60;
  const rld = spec.rateLimitPerDay ?? 5000;
  if (!Number.isInteger(rlm) || rlm < -1) return { ok: false, reason: "spec: rateLimitPerMinute invalid (întreg ≥ -1) — fail-closed" };
  if (!Number.isInteger(rld) || rld < -1) return { ok: false, reason: "spec: rateLimitPerDay invalid (întreg ≥ -1) — fail-closed" };
  const clientName = spec.clientName ?? "Preflight Canary DCR";
  const emailDomain = spec.emailDomain ?? "canary.local";

  const email    = fixtureEmail(spec.runId, emailDomain);
  const clientId = fixtureClientId(spec.runId);

  return {
    ok: true,
    d: {
      runId: spec.runId,
      email,
      clientId,
      redirectUri: ru.exact,
      scopes,
      entitlement: {
        user_id: "", // completat după crearea/adoptarea userului
        plan,
        scopes: [...scopes],
        rate_limit_per_minute: rlm,
        rate_limit_per_day: rld,
        status: "active",
      },
      registration: {
        client_id: clientId,
        client_type: "public",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [ru.exact],
        client_name: clientName,
        status: "active",
      },
    },
  };
}

// ────────────────────────────── comparare exactă (idempotență) ──────────────────────────────

function arrEqExact(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
export function entitlementMatches(intended: EntitlementRow, existing: EntitlementSnapshot): boolean {
  return existing.plan === intended.plan
    && arrEqExact(existing.scopes, intended.scopes)
    && existing.rate_limit_per_minute === intended.rate_limit_per_minute
    && existing.rate_limit_per_day === intended.rate_limit_per_day
    && existing.status === intended.status;
}
export function registrationMatches(intended: RegistrationRow, existing: RegistrationSnapshot): boolean {
  return existing.client_type === intended.client_type
    && existing.token_endpoint_auth_method === intended.token_endpoint_auth_method
    && arrEqExact(existing.grant_types, intended.grant_types)
    && arrEqExact(existing.redirect_uris, intended.redirect_uris)
    && existing.client_name === intended.client_name
    && existing.status === intended.status;
}

// ────────────────────────────── mesaje statice (fără valori de rând) ──────────────────────────────

type ResourceFailCode = "conflict_differs" | "inconsistent" | "unavailable";
function resourceFailMsg(stage: Exclude<FixtureStage, "spec">, code: ResourceFailCode): string {
  const label =
    stage === "user"         ? "user"
    : stage === "entitlement" ? "entitlement"
    : "registration (DCR)";
  switch (code) {
    case "conflict_differs": return `${label}: rând existent pe aceeași cheie DIFERĂ de cel intenționat — fail-closed (nu suprascriu)`;
    case "inconsistent":     return `${label}: conflict la creare dar re-citirea nu confirmă rândul (inconsistent) — fail-closed`;
    case "unavailable":      return `${label}: backend Supabase indisponibil — fail-closed`;
  }
}

// ────────────────────────────── secvențierea unui pas de resursă ──────────────────────────────

type StepResult =
  | { kind: "created" }   // → intră în manifest
  | { kind: "adopted" }   // există + coincide EXACT → nu intră în manifest (preexistent, nu-l ștergem)
  | { kind: "fail"; code: ResourceFailCode };

/** Prinde un apel de port care aruncă → tratat ca `unavailable` (fail-closed). Portul NU ar trebui să arunce, dar
 *  garantăm că provisioning-ul nu propagă niciodată o excepție (manifestul rămâne întotdeauna disponibil pt. cleanup). */
async function safe<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try { return { ok: true, value: await fn() }; } catch { return { ok: false }; }
}

// ────────────────────────────── provisioning ──────────────────────────────

/**
 * Provizionează user → entitlement → registration, IDEMPOTENT + fail-closed. Întoarce ÎNTOTDEAUNA `manifest`
 * (resursele CREATE până în acel punct) — inclusiv pe eșec parțial — ca `runWithGate1Fixture` să poată face cleanup.
 * NU aruncă niciodată (orice throw de port → `unavailable`).
 */
export async function provisionGate1Fixture(store: FixtureStore, spec: FixtureSpec): Promise<ProvisionResult> {
  const manifest: FixtureManifestEntry[] = [];

  // 0. SPEC (pur)
  const der = deriveSpec(spec);
  if (!der.ok) return { ok: false, stage: "spec", reason: der.reason, manifest };
  const d = der.d;

  // 1. USER (auth.users, confirmat)
  const cu = await safe(() => store.createUser({ email: d.email }));
  if (!cu.ok) return { ok: false, stage: "user", reason: resourceFailMsg("user", "unavailable"), manifest };
  let userId: string;
  if (cu.value.status === "created") {
    userId = cu.value.userId;
    manifest.push({ kind: "user", key: userId });
  } else if (cu.value.status === "conflict") {
    const ru = await safe(() => store.readUserByEmail(d.email));
    if (!ru.ok || ru.value.status === "unavailable") return { ok: false, stage: "user", reason: resourceFailMsg("user", "unavailable"), manifest };
    if (ru.value.status === "not_found")             return { ok: false, stage: "user", reason: resourceFailMsg("user", "inconsistent"), manifest };
    if (!ru.value.emailConfirmed)                    return { ok: false, stage: "user", reason: resourceFailMsg("user", "conflict_differs"), manifest };
    userId = ru.value.userId; // ADOPTAT (preexistent, confirmat) — NU în manifest
  } else {
    return { ok: false, stage: "user", reason: resourceFailMsg("user", "unavailable"), manifest };
  }

  // 2. ENTITLEMENT (account_entitlements)
  const entRow: EntitlementRow = { ...d.entitlement, user_id: userId };
  const ce = await stepCreateOrAdopt(
    () => store.createEntitlement(entRow),
    () => store.readEntitlement(userId),
    (snap) => entitlementMatches(entRow, snap),
  );
  if (ce.kind === "fail") return { ok: false, stage: "entitlement", reason: resourceFailMsg("entitlement", ce.code), manifest };
  if (ce.kind === "created") manifest.push({ kind: "entitlement", key: userId });

  // 3. REGISTRATION (oauth_client_registrations, DCR public)
  const cr = await stepCreateOrAdopt(
    () => store.createRegistration(d.registration),
    () => store.readRegistrationByClientId(d.clientId),
    (snap) => registrationMatches(d.registration, snap),
  );
  if (cr.kind === "fail") return { ok: false, stage: "registration", reason: resourceFailMsg("registration", cr.code), manifest };
  if (cr.kind === "created") manifest.push({ kind: "registration", key: d.clientId });

  const handle: Gate1FixtureHandle = {
    runId:       d.runId,
    userId,
    email:       d.email,
    clientId:    d.clientId,
    redirectUri: d.redirectUri,
    scopes:      d.scopes,
    manifest:    manifest.slice(),
  };
  return { ok: true, handle, manifest: manifest.slice() };
}

/** create → pe conflict re-citește + compară EXACT. `created` | `adopted` | `fail(code)`. Generic pt. entitlement+registration. */
async function stepCreateOrAdopt<Snap>(
  create: () => Promise<CreateOutcome>,
  read:   () => Promise<{ status: "found"; snapshot: Snap } | { status: "not_found" } | { status: "unavailable" }>,
  matches: (snap: Snap) => boolean,
): Promise<StepResult> {
  const c = await safe(create);
  if (!c.ok) return { kind: "fail", code: "unavailable" };
  if (c.value.status === "created")     return { kind: "created" };
  if (c.value.status === "unavailable") return { kind: "fail", code: "unavailable" };
  // conflict → re-citește + compară exact
  const r = await safe(read);
  if (!r.ok || r.value.status === "unavailable") return { kind: "fail", code: "unavailable" };
  if (r.value.status === "not_found")            return { kind: "fail", code: "inconsistent" };
  return matches(r.value.snapshot) ? { kind: "adopted" } : { kind: "fail", code: "conflict_differs" };
}

// ────────────────────────────── cleanup (best-effort, doar din manifest, ordine inversă) ──────────────────────────────

export interface CleanupReport {
  ok:      boolean;
  deleted: number;
  errors:  { kind: FixtureResourceKind; code: "unavailable" | "threw" }[];
}

/**
 * Șterge EXCLUSIV resursele din manifest (create-this-run), în ORDINEA INVERSĂ a dependențelor. Best-effort: încearcă
 * TOATE intrările chiar dacă una eșuează (o registrare care nu se poate șterge NU trebuie să lase userul orfan), NU
 * aruncă, întoarce un raport. `not_found` = deja dispărut = succes benign. Resursele PREEXISTENTE (adoptate) nu sunt în
 * manifest → nu sunt atinse. Niciun delete „broad" — doar pe cheie specifică.
 */
export async function cleanupGate1Fixture(store: FixtureStore, manifest: readonly FixtureManifestEntry[]): Promise<CleanupReport> {
  const errors: CleanupReport["errors"] = [];
  let deleted = 0;
  for (const entry of [...manifest].reverse()) {
    let out: DeleteOutcome | null = null;
    try {
      if (entry.kind === "registration")     out = await store.deleteRegistration(entry.key);
      else if (entry.kind === "entitlement") out = await store.deleteEntitlement(entry.key);
      else                                    out = await store.deleteUser(entry.key);
    } catch {
      errors.push({ kind: entry.kind, code: "threw" });
      continue;
    }
    if (out.status === "unavailable") errors.push({ kind: entry.kind, code: "unavailable" });
    else deleted++; // "deleted" sau "not_found" (deja dispărut) = benign
  }
  return { ok: errors.length === 0, deleted, errors };
}

// ────────────────────────────── wrapper cu cleanup în finally ──────────────────────────────

export type RunWithFixtureResult<T> =
  | { ok: true;  result: T; handle: Gate1FixtureHandle; cleanup: CleanupReport }
  | { ok: false; phase: "provision"; stage: FixtureStage; reason: string; cleanup: CleanupReport }
  // P2 (fix cgpt): body OK dar cleanup a LĂSAT resurse → NU e `ok:true` (altfel un leak de canary trece drept succes).
  // `result` rămâne expus (corpul a reușit), dar rezultatul global e fail-closed pe reziduu.
  | { ok: false; phase: "cleanup"; reason: string; result: T; handle: Gate1FixtureHandle; cleanup: CleanupReport };

/**
 * Provizionează → rulează `body(handle)` → CLEANUP în `finally` (indiferent de succes/eșec/throw al corpului SAU al
 * provisioning-ului parțial). Manifestul e capturat imediat după `provisionGate1Fixture` (care nu aruncă niciodată), deci
 * `finally` are mereu lista corectă de resurse-de-șters. Dacă `body` aruncă, cleanup-ul tot rulează, apoi excepția se
 * re-propagă (fixtura nu ascunde erori de test).
 */
export async function runWithGate1Fixture<T>(
  store: FixtureStore,
  spec:  FixtureSpec,
  body:  (handle: Gate1FixtureHandle) => Promise<T>,
): Promise<RunWithFixtureResult<T>> {
  let manifest: readonly FixtureManifestEntry[] = [];
  try {
    const prov = await provisionGate1Fixture(store, spec);
    manifest = prov.manifest;
    if (!prov.ok) {
      const cleanup = await cleanupGate1Fixture(store, manifest);
      return { ok: false, phase: "provision", stage: prov.stage, reason: prov.reason, cleanup };
    }
    const result = await body(prov.handle);
    const cleanup = await cleanupGate1Fixture(store, manifest);
    if (!cleanup.ok) {
      return { ok: false, phase: "cleanup", reason: "cleanup a lăsat resurse (vezi cleanup.errors) — fail-closed pe reziduu", result, handle: prov.handle, cleanup };
    }
    return { ok: true, result, handle: prov.handle, cleanup };
  } catch (e) {
    // corpul a aruncat → cleanup pe manifestul capturat, apoi re-propagă (nu înghițim eroarea de test)
    await cleanupGate1Fixture(store, manifest);
    throw e;
  }
}

// ────────────────────────────── builder gated pe izolarea anti-prod ──────────────────────────────

export type BuildStoreResult<S> =
  | { ok: true; store: S }
  | { ok: false; reason: string };

/**
 * Lock #9: adaptorul REAL de provisioning (peste `supabaseAdmin`) se construiește NUMAI după ce `assertCanaryIsolation`
 * trece. Poarta rulează izolarea (refuză prod/ambiguu/credențiale/schemă) și DOAR apoi cheamă `build(vettedSupabaseUrl)`
 * — pe un config care atinge producția, `build` nici nu e invocat, deci niciun client nu se leagă la prod. `build`
 * primește URL-ul Supabase VETAT; cheia service-role o citește build-ul din env (și NU o loghează).
 */
export function buildFixtureStoreAfterIsolation<S>(
  cfg:   Partial<CanaryConfig> | null | undefined,
  build: (vettedSupabaseUrl: string) => S,
): BuildStoreResult<S> {
  const iso = assertCanaryIsolation(cfg);
  if (!iso.ok) return { ok: false, reason: iso.reason };
  // izolarea garantează supabaseUrl string http(s) non-prod fără credențiale
  const supabaseUrl = (cfg as CanaryConfig).supabaseUrl;
  // P2 (fix cgpt): construirea adaptorului real (createClient / citire env) POATE arunca → prinsă → eșec GENERIC
  // fail-closed (fără Error.message, care ar putea purta URL/cheie). Poarta nu propagă niciodată o excepție.
  try {
    return { ok: true, store: build(supabaseUrl) };
  } catch {
    return { ok: false, reason: "construirea adaptorului de fixtură a aruncat (config/env) — fail-closed" };
  }
}
