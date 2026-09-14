/**
 * lib/mcp/releaseGate.ts — PH-12 12.5a (nucleu PUR de release-gate, zero I/O).
 *
 * Primitivele pe care se sprijină cele două gate-uri de staging (12.5b auth-canary, 12.5c Base canary) + lanțul de
 * release complet. TOTUL e PUR: primește payload-uri deja citite (JSON de la `/api/health`, răspunsul endpoint-ului
 * `/token`, config-ul de canary) și întoarce verdicte discriminate — I/O-ul (fetch/spawn) trăiește în driver-ele
 * 12.5b/c. Așa logica de gate e tsx-testabilă fără infra, iar driver-ele rămân subțiri.
 *
 * DOCTRINĂ CHEIE — `assertCanaryIsolation` rulează ÎNAINTEA oricărui gate: refuză (fail-closed) domeniul MCP de
 * PRODUCȚIE, Supabase-ul de PRODUCȚIE și orice config ambiguă (URL lipsă/gol/neparsabil), ca un gate să NU poată
 * atinge din greșeală prod-ul. Plasa e un DENYLIST de prod + refuz pe ambiguitate — nu o listă albă fragilă.
 *
 * READINESS vs STRICT (nuanța 12.4/12.5): auth-canary rulează cu workerii OPRIȚI → `/api/health` e `degraded`
 * INTENȚIONAT; readiness cere DOAR web+Redis sănătoase (acceptă `degraded`, refuză `down`). Base canary cere
 * `/api/health?strict=1` COMPLET verde (worker fresh + WS + servicii), fiindcă acolo rulează Worker Base.
 */

// ── Identificatorii de PRODUCȚIE pe care canary-ul NU are voie să-i atingă (recon live 12.5, 2026-09-10) ──
// Domeniile MCP de prod + ref-ul proiectului Supabase de prod (`<ref>.supabase.co`). Orice gate care primește
// unul dintre acestea în config e REFUZAT înainte să ruleze — plasa care ține staging-ul departe de prod.
export const PROD_MCP_HOSTS: readonly string[] = ["preflight.jackspools.lol", "preflight.up.railway.app"];
export const PROD_SUPABASE_REFS: readonly string[] = ["ipeyogzfgqypfkujraxm"];

export interface GateResult {
  ok: boolean;
  reason: string;
}
const pass = (reason = "ok"): GateResult => ({ ok: true, reason });
const fail = (reason: string): GateResult => ({ ok: false, reason });

// ── Vederea normalizată a raportului de la `/api/health` (subset stabil, tolerant la câmpuri extra) ──
export type HealthStatus = "ok" | "degraded" | "down";
export interface HealthCheckView { ok: boolean; detail: string | null; }
export interface HealthServiceView { service: string; state: string; ageSec: number | null; }
export interface HealthReportView {
  status:     HealthStatus;
  httpStatus: number;
  scope:      string;
  checks:     { web: HealthCheckView; redis: HealthCheckView; worker: HealthCheckView; ws: HealthCheckView; services: HealthCheckView | null };
  services:   HealthServiceView[] | null;
  // PH-12 12.5c (fix cgpt P1 #1): completitudinea per-CHAIN a raportului. Fără astea, un `/api/health?strict=1` verde
  // pentru ALT chain (ex. arbitrum fresh, base absent) ar trece Gate 2 Base. Le păstrăm ca să cerem EXPLICIT base.
  // ⭐ fix cgpt P1/P2 #3: distingem ABSENT (`undefined`) de PREZENT-GOL (`[]`). Sub `requireChains`, absența unei
  // dovezi (staleChains/wsStaleSubs/... lipsă) e UNKNOWN → fail (nu „lista goală = curat"). Prezent-dar-malformat →
  // `parseHealthReport` întoarce null (corupt). Byte-compat: apelurile FĂRĂ `requireChains` nu ating aceste câmpuri.
  expectedChains:      string[] | undefined;
  observedChains:      string[] | undefined;
  staleChains:         string[] | undefined;
  wsStaleSubs:         string[] | undefined;  // "chain:kind"
  wsUnavailableChains: string[] | undefined;
  wsUnknownChains:     string[] | undefined;
  worstSnapshotAgeSec: number | null;         // null = absent SAU explicit null → sub requireChains ⇒ fail (nefresh)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asCheck(v: unknown): HealthCheckView | null {
  if (!isObj(v) || typeof v.ok !== "boolean") return null;
  return { ok: v.ok, detail: typeof v.detail === "string" ? v.detail : null };
}
/**
 * Câmp array-de-string din raport, cu 3 stări discriminate: `"absent"` (câmp lipsă), `"corrupt"` (prezent dar
 * non-array sau cu element non-string → tot raportul devine null), sau valoarea. ⭐ fix cgpt #3: absent ≠ `[]` — un
 * consumator cu `requireChains` tratează absența ca UNKNOWN (fail), nu ca „listă goală = curat".
 */
function chainField(v: unknown): string[] | "absent" | "corrupt" {
  if (v === undefined) return "absent";
  if (!Array.isArray(v)) return "corrupt";
  for (const e of v) if (typeof e !== "string") return "corrupt";
  return v as string[];
}
/** Egalitate de MULȚIME (ordine-insensibilă, dedup) între două liste de string — pt. `expectedChains === cerut`. */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a), sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * Parsează + validează raportul `/api/health` (string JSON SAU obiect deja parsat). Fail-closed la `null` pe orice
 * formă neașteptată (JSON stricat, `status` necunoscut, `httpStatus` ne-număr, `checks` incompleți) — un gate NU
 * trebuie să tragă concluzii dintr-un body corupt. Câmpurile extra sunt ignorate (forward-compat).
 */
export function parseHealthReport(raw: unknown): HealthReportView | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!isObj(obj)) return null;

  const status = obj.status;
  if (status !== "ok" && status !== "degraded" && status !== "down") return null;
  if (typeof obj.httpStatus !== "number" || !Number.isFinite(obj.httpStatus)) return null;
  if (typeof obj.scope !== "string") return null;
  if (!isObj(obj.checks)) return null;

  const web    = asCheck(obj.checks.web);
  const redis  = asCheck(obj.checks.redis);
  const worker = asCheck(obj.checks.worker);
  const ws     = asCheck(obj.checks.ws);
  if (!web || !redis || !worker || !ws) return null;                 // cei 4 de bază sunt OBLIGATORII
  const services = obj.checks.services === undefined ? null : asCheck(obj.checks.services);
  if (obj.checks.services !== undefined && services === null) return null; // prezent dar malformat → corupt

  let svcList: HealthServiceView[] | null = null;
  if (Array.isArray(obj.services)) {
    const mapped: HealthServiceView[] = [];
    for (const s of obj.services) {
      if (!isObj(s) || typeof s.service !== "string" || typeof s.state !== "string") return null;
      mapped.push({ service: s.service, state: s.state, ageSec: typeof s.ageSec === "number" ? s.ageSec : null });
    }
    svcList = mapped;
  } else if (obj.services !== undefined) {
    return null; // prezent dar non-array → corupt
  }

  // PH-12 12.5c: completitudinea per-chain. Corupt (prezent-invalid) → null pe tot raportul. Absent → `undefined`
  // (distinct de `[]`): sub requireChains ⇒ fail (unknown), NU „curat".
  const fields = {
    expectedChains:      chainField(obj.expectedChains),
    observedChains:      chainField(obj.observedChains),
    staleChains:         chainField(obj.staleChains),
    wsStaleSubs:         chainField(obj.wsStaleSubs),
    wsUnavailableChains: chainField(obj.wsUnavailableChains),
    wsUnknownChains:     chainField(obj.wsUnknownChains),
  };
  for (const f of Object.values(fields)) if (f === "corrupt") return null;
  const asOpt = (f: string[] | "absent" | "corrupt"): string[] | undefined => (f === "absent" ? undefined : f as string[]);

  let worstSnapshotAgeSec: number | null = null;
  if (obj.worstSnapshotAgeSec === null || obj.worstSnapshotAgeSec === undefined) worstSnapshotAgeSec = null;
  else if (typeof obj.worstSnapshotAgeSec === "number" && Number.isFinite(obj.worstSnapshotAgeSec)) worstSnapshotAgeSec = obj.worstSnapshotAgeSec;
  else return null; // prezent dar non-număr → corupt

  return {
    status, httpStatus: obj.httpStatus, scope: obj.scope,
    checks: { web, redis, worker, ws, services }, services: svcList,
    expectedChains:      asOpt(fields.expectedChains),
    observedChains:      asOpt(fields.observedChains),
    staleChains:         asOpt(fields.staleChains),
    wsStaleSubs:         asOpt(fields.wsStaleSubs),
    wsUnavailableChains: asOpt(fields.wsUnavailableChains),
    wsUnknownChains:     asOpt(fields.wsUnknownChains),
    worstSnapshotAgeSec,
  };
}

/**
 * READINESS (auth-canary): web + Redis sănătoase, iar endpoint-ul NU e `down`. Acceptă `degraded` — în auth-canary
 * workerii sunt OPRIȚI intenționat (fără worker → worker/WS degradate), dar web-ul servește și Redis răspunde.
 * Folosește `/api/health` simplu (NU `?strict=1`), care întoarce 200 pe ok/degraded și 503 pe down.
 */
export function assertReadiness(report: HealthReportView): GateResult {
  if (report.status === "down")     return fail("health down (Redis inaccesibil) — web-ul nu poate funcționa");
  if (!report.checks.redis.ok)      return fail("Redis check nu e ok (readiness cere Redis sănătos)");
  if (!report.checks.web.ok)        return fail("web check nu e ok");
  if (report.httpStatus !== 200)    return fail(`httpStatus ${report.httpStatus} (readiness pe /api/health simplu așteaptă 200)`);
  return pass(report.status === "degraded"
    ? "ready (degraded acceptat — workerii sunt opriți în auth-canary; web+Redis sănătoase)"
    : "ready (ok)");
}

/**
 * STRICT (Base canary): TOTUL verde. Cere `status === "ok"` + `httpStatus === 200` (pe `/api/health?strict=1`,
 * unde `degraded`→503) + toate cele 4 check-uri de bază ok. Dacă aștepți roluri de serviciu monitorizate
 * (`expectedServiceRoles`), cere ȘI `checks.services.ok` + fiecare rol prezent în `scope` (extins de 12.4).
 */
export function assertStrictHealthy(
  report: HealthReportView,
  opts: { expectedServiceRoles?: readonly string[]; requireChains?: readonly string[]; maxSnapshotAgeSec?: number } = {},
): GateResult {
  if (report.status !== "ok")    return fail(`status ${report.status} (strict cere ok — worker/WS/servicii toate sănătoase)`);
  if (report.httpStatus !== 200) return fail(`httpStatus ${report.httpStatus} (strict-ok așteaptă 200)`);
  for (const [name, chk] of [["web", report.checks.web], ["redis", report.checks.redis], ["worker", report.checks.worker], ["ws", report.checks.ws]] as const) {
    if (!chk.ok) return fail(`check ${name} nu e ok`);
  }
  const roles = opts.expectedServiceRoles ?? [];
  if (roles.length > 0) {
    if (!report.checks.services || !report.checks.services.ok) return fail("checks.services lipsă/ne-ok deși aștepți roluri de serviciu");
    const svc = report.services ?? [];
    // scope-ul e "mcp-web + evm-worker + <rol>" → tokenizăm pe „+" (NU substring: „not-indexer-evm" ≠ token „indexer-evm").
    const scopeTokens = report.scope.split("+").map((s) => s.trim());
    for (const role of roles) {
      // Rolul trebuie confirmat DE DOUĂ ori: (1) token exact în scope; (2) intrare `state:ok` în services[] (autoritar).
      if (!scopeTokens.includes(role)) return fail(`scope nu listează rolul '${role}' ca token (health nu-l declară monitorizat)`);
      const entry = svc.find((s) => s.service === role);
      if (!entry)               return fail(`serviciul așteptat '${role}' NU e în report.services (health nu-l monitorizează)`);
      if (entry.state !== "ok") return fail(`serviciul '${role}' e '${entry.state}' (așteptat 'ok')`);
    }
  }
  // PH-12 12.5c (fix cgpt P1 #1): pentru Base canary NU e destul „status ok" — un health verde pentru ALT chain ar
  // trece. Cerem EXPLICIT ca lista AȘTEPTATĂ să fie EXACT `requireChains` (nici mai mult — un `arbitrum` în plus ar
  // cere alt worker) și, pentru FIECARE chain cerut: observat (amprentă worker), NU stale (snapshot fresh), și fără
  // problemă WS (sub suspected-stale/disconnected/unknown → dovedit pe acel chain, nu doar global). Plus snapshot
  // efectiv proaspăt (`worstSnapshotAgeSec < maxSnapshotAgeSec`). Astea sunt SPECIFICE pe chain, peste `checks.ws.ok`.
  const need = opts.requireChains ?? [];
  if (need.length > 0) {
    const maxAge = opts.maxSnapshotAgeSec ?? 300;
    if (!Number.isFinite(maxAge) || maxAge <= 0) return fail(`maxSnapshotAgeSec invalid (${maxAge}) — cere finit > 0`);
    // ⭐ fix cgpt #3: ABSENȚA oricărei dovezi per-chain = UNKNOWN → fail (nu „listă goală = curat"). `[]` prezent e OK.
    if (report.expectedChains      === undefined) return fail("raport fără expectedChains (dovadă absentă) — nu pot verifica chain-ul");
    if (report.observedChains      === undefined) return fail("raport fără observedChains (dovadă absentă)");
    if (report.staleChains         === undefined) return fail("raport fără staleChains (nu pot dovedi non-stale)");
    if (report.wsStaleSubs         === undefined) return fail("raport fără wsStaleSubs (nu pot dovedi WS non-stale)");
    if (report.wsUnavailableChains === undefined) return fail("raport fără wsUnavailableChains (nu pot dovedi WS conectat)");
    if (report.wsUnknownChains     === undefined) return fail("raport fără wsUnknownChains (nu pot dovedi WS cunoscut)");
    const expected = report.expectedChains, observed = report.observedChains, stale = report.staleChains;
    const wsStale = report.wsStaleSubs, wsUnavail = report.wsUnavailableChains, wsUnknown = report.wsUnknownChains;

    if (!sameStringSet(expected, need)) {
      return fail(`expectedChains ${JSON.stringify(expected)} ≠ cerut ${JSON.stringify([...need])} (health monitorizează alte chain-uri)`);
    }
    for (const c of need) {
      if (!observed.includes(c))                    return fail(`chain '${c}' nu e în observedChains (worker fără amprentă)`);
      if (stale.includes(c))                        return fail(`chain '${c}' e stale (snapshot lipsă/prea vechi)`);
      if (wsStale.some((s) => s.startsWith(`${c}:`))) return fail(`chain '${c}' are subscripții WS suspected-stale`);
      if (wsUnavail.includes(c))                    return fail(`chain '${c}' WS disconnected`);
      if (wsUnknown.includes(c))                    return fail(`chain '${c}' WS unknown (runtime lipsă/expirat)`);
    }
    if (report.worstSnapshotAgeSec === null)      return fail("worstSnapshotAgeSec null/absent (snapshot necunoscut) — strict cere snapshot fresh");
    if (report.worstSnapshotAgeSec < 0)           return fail(`worstSnapshotAgeSec ${report.worstSnapshotAgeSec} negativ (skew)`);
    if (report.worstSnapshotAgeSec >= maxAge)     return fail(`worstSnapshotAgeSec ${report.worstSnapshotAgeSec}s ≥ ${maxAge}s (snapshot stale)`);
  }
  return pass("strict healthy");
}

// ── Răspunsul endpoint-ului `/token` (formă externă OAuth, nu payload-ul intern din Redis) ──
export interface TokenResponseView {
  access_token:  string;
  token_type:    string;
  expires_in:    number;
  scope:         string | null;
  refresh_token: string | null;
}

/**
 * Validează FORMA răspunsului `/token` (RFC 6749 §5.1) — tokenurile sunt opace la client (referință în Redis), deci
 * NU decodăm payload-ul intern; validăm doar plicul: `access_token` ne-gol, `token_type` Bearer, `expires_in` > 0,
 * `scope` prezent, iar dacă aștepți refresh (fluxul user/auth-code) `refresh_token` ne-gol. Fail-closed → null.
 */
/** String ne-gol DUPĂ trim (whitespace-only tratat ca absent) → valoarea originală; altfel null. */
function neStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}
export function parseTokenResponse(raw: unknown): TokenResponseView | null {
  let obj: unknown = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch { return null; } }
  if (!isObj(obj)) return null;
  const access = neStr(obj.access_token);                                   // ne-gol după trim
  if (access === null) return null;
  if (typeof obj.token_type !== "string") return null;
  if (typeof obj.expires_in !== "number" || !Number.isFinite(obj.expires_in)) return null;
  const scope = neStr(obj.scope);                                           // whitespace-only → null
  const refresh = neStr(obj.refresh_token);                                 // whitespace-only → null
  return { access_token: access, token_type: obj.token_type, expires_in: obj.expires_in, scope, refresh_token: refresh };
}

export function assertTokenResponse(raw: unknown, opts: { expectRefresh: boolean } = { expectRefresh: true }): GateResult {
  const t = parseTokenResponse(raw);
  if (t === null)                                        return fail("răspuns /token malformat (fail-closed)");
  if (t.token_type.trim().toLowerCase() !== "bearer")    return fail("token_type invalid (așteptat Bearer)"); // NU ecoua valoarea (necontrolată — anti-leak, cgpt 12.5b-1)
  if (!Number.isInteger(t.expires_in) || t.expires_in <= 0) return fail(`expires_in ${t.expires_in} (așteptat întreg pozitiv)`);
  if (t.scope === null)                                  return fail("scope lipsă/gol în răspunsul /token");
  if (opts.expectRefresh && t.refresh_token === null)    return fail("refresh_token lipsă (fluxul user/auth-code trebuie să emită refresh)");
  return pass(opts.expectRefresh ? "token + refresh valizi" : "token valid");
}

/**
 * Rotația refresh (RFC 6749 §6 + reuse-detection PH-4): a doua emitere trebuie să ROTEASCĂ atât access cât și refresh
 * (fără reuse). Cere: ambele răspunsuri valide + refresh prezent în ambele + access-ul DIFERĂ + refresh-ul DIFERĂ.
 * Un refresh IDENTIC ar însemna că lanțul nu s-a rotit (reuse-detection nu s-ar declanșa) → fail.
 */
export function assertRefreshRotation(firstRaw: unknown, secondRaw: unknown): GateResult {
  // Ambele plicuri trebuie să fie MAI ÎNTÂI token-response-uri VALIDE (Bearer + expires_in întreg>0 + scope + refresh)
  // — altfel „rotația" ar accepta un plic invalid (token_type mac / expires_in 0 / scope gol) doar fiindcă string-urile
  // diferă. Validăm complet, apoi comparăm rotația.
  const va = assertTokenResponse(firstRaw, { expectRefresh: true });
  if (!va.ok) return fail(`primul răspuns /token invalid: ${va.reason}`);
  const vb = assertTokenResponse(secondRaw, { expectRefresh: true });
  if (!vb.ok) return fail(`răspunsul de refresh invalid: ${vb.reason}`);
  const a = parseTokenResponse(firstRaw)!, b = parseTokenResponse(secondRaw)!; // garantat non-null de assert-urile de sus
  if (a.access_token === b.access_token)   return fail("access_token NEschimbat după refresh (lanțul nu s-a rotit)");
  if (a.refresh_token === b.refresh_token) return fail("refresh_token NEschimbat (rotație absentă → reuse-detection nu s-ar declanșa)");
  return pass("refresh rotit (access + refresh noi)");
}

// ── Config-ul unui gate + plasa de izolare ────────────────────────────────────
export interface CanaryConfig {
  mcpBaseUrl:  string; // originea MCP-ului de canary (ex. https://preflight-staging.up.railway.app)
  supabaseUrl: string; // Supabase-ul de canary (ex. https://<staging-ref>.supabase.co)
}

/** Parsează + impune contract de URL de canary: DOAR http/https, FĂRĂ credențiale. Întoarce hostname-ul (fără port,
 * lowercased) sau un motiv de refuz. Fail-closed pe orice (neparsabil / schemă greșită / userinfo). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function canaryHostname(url: string): { host: string } | { reject: string } {
  let u: URL;
  try { u = new URL(url); } catch { return { reject: "neparsabil" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { reject: `schemă '${u.protocol}' (doar http/https)` };
  if (u.username !== "" || u.password !== "")            return { reject: "conține credențiale în URL (user:pass@) — refuz" };
  const host = u.hostname.toLowerCase();  // hostname EXCLUDE portul → prod-ul cu `:443` nu mai scapă
  // FQDN cu punct final (`host.tld.`) rezolvă la ACELAȘI domeniu, dar `!==` string-ul din allowlist → ar ocoli plasa
  // de prod. Refuz orice hostname necanonic cu `.` final (fail-closed) — nu-l normalizez tăcut.
  if (host.endsWith(".")) return { reject: "hostname necanonic (punct final) — refuz" };
  // HTTP clar (necriptat) permis DOAR pe loopback (Gate 1 complet local); orice host extern pe http → refuz (doar https).
  if (u.protocol === "http:" && !LOOPBACK_HOSTS.has(host)) return { reject: `HTTP clar pe host non-loopback (${host}) — în afara loopback cere https` };
  return { host };
}

/**
 * PLASA (rulează ÎNAINTEA oricărui gate): refuză un config care ar atinge PRODUCȚIA sau e ambiguu. Fail-closed pe:
 * URL lipsă/gol/neparsabil, schemă non-http(s) (`file:`/`ftp:`), credențiale în URL; hostname MCP == un domeniu de
 * prod (compar pe HOSTNAME, deci portul explicit `:443` NU ocolește); hostname Supabase == `<prod-ref>.supabase.co`.
 * Doar un config curat + ambele URL-uri http(s) parsabile fără credențiale trece. Un gate NU pornește fără `ok`.
 */
export function assertCanaryIsolation(cfg: Partial<CanaryConfig> | null | undefined): GateResult {
  if (!cfg) return fail("config de canary absent (fail-closed)");
  const { mcpBaseUrl, supabaseUrl } = cfg;
  if (typeof mcpBaseUrl !== "string" || mcpBaseUrl.trim().length === 0)   return fail("mcpBaseUrl lipsă/gol (ambiguu → fail-closed)");
  if (typeof supabaseUrl !== "string" || supabaseUrl.trim().length === 0) return fail("supabaseUrl lipsă/gol (ambiguu → fail-closed)");

  const mcp = canaryHostname(mcpBaseUrl);
  if ("reject" in mcp) return fail(`mcpBaseUrl ${mcp.reject}`);
  if (PROD_MCP_HOSTS.includes(mcp.host)) return fail(`mcpBaseUrl e domeniul MCP de PRODUCȚIE (${mcp.host}) — refuz`);

  const sb = canaryHostname(supabaseUrl);
  if ("reject" in sb) return fail(`supabaseUrl ${sb.reject}`);
  for (const ref of PROD_SUPABASE_REFS) {
    if (sb.host === `${ref}.supabase.co` || sb.host.startsWith(`${ref}.`)) {
      return fail(`supabaseUrl e Supabase-ul de PRODUCȚIE (ref ${ref}) — refuz`);
    }
  }
  return pass("izolat de prod (http/https, fără credențiale, niciun marker de producție)");
}
