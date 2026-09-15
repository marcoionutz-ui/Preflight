/**
 * lib/mcp/canaryReleaseSteps.ts — PH-12 12.5c-4 (helper-e PURE ale runnerului compus, testabile hermetic).
 *
 * Runnerul `runReleaseGateLive.mjs` e .mjs opt-in (exclus din tsc/eslint/test) → orice logică non-trivială a lui trăiește
 * AICI, ca frunze PURE cu probe hermetice (cerință cgpt: „adăugate probe hermetice pentru env copil, status mismatch,
 * Mailpit/magic-link binding și generația post-spawn"). Runnerul devine doar cablaj peste aceste primitive.
 *
 * Patru griji:
 *  1. `assertMailpitLoopback` — sursa magic-link-ului (Mailpit) TREBUIE să fie o origine loopback curată (nu un host extern).
 *  2. `assertMagicLinkBoundToSupabase` — magic link-ul acceptat DOAR dacă are EXACT originea Supabase-ului VETAT, fără
 *     userinfo/#fragment și cu pathname EXACT `/auth/v1/verify` (altfel fluxul s-ar autentifica pe alt Supabase, ex. prod).
 *  3. `reconcileReadiness` — readiness-ul Gate 1 compară statusul HTTP REAL cu `httpStatus` din corp (anti-„status
 *     mismatch": un 503 cu corp care minte `httpStatus:200`, sau invers, → roșu). Aceeași doctrină ca `fetchHealth` Gate 2.
 *  4. `parseWorkerStamp` + `assertGenerationAdvanced` — bariera de GENERAȚIE post-spawn: dovadă că datele observate sunt
 *     scrise de procesul NOU, nu reziduuri. Pe timestampuri ABSOLUTE din Redis (`worker_runtime.updatedAt`,
 *     `worker_snapshot.savedAt`), NU pe `snapshotAgeSec` rotunjit. Fără pre-clean (nu alterăm starea observată).
 */

import { parseHealthReport, assertReadiness } from "./releaseGate";
// ⭐ fix cgpt P2: contract CANONIC — importăm tipul din canaryGate1 (type-only), NU un union duplicat local (care ar
// putea deriva). Așa `reconcileReadiness` e garantat compatibil cu ce mapează `runGate1`.
import type { ReadinessResult } from "./canaryGate1";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type StepCheck = { ok: true } | { ok: false; reason: string };

// ────────────────────────────── 1. Mailpit loopback (origine CANONICĂ) ──────────────────────────────

/**
 * Sursa magic-link-ului: origine http(s) LOOPBACK CURATĂ. Fix cgpt P2: runnerul concatenează `/api/v1/...`, deci
 * `MAILPIT_URL` TREBUIE să fie EXACT o origine — pathname `/` (sau gol), query GOL, fragment GOL, fără userinfo — altfel
 * ar produce endpointuri greșite/ambigue. Întoarce ORIGINEA canonică validată (`origin`), pe care runnerul o folosește
 * (NU valoarea brută din env). NU ecouă valoarea în reason.
 */
export function assertMailpitLoopback(url: unknown): { ok: true; origin: string } | { ok: false; reason: string } {
  if (typeof url !== "string" || url.trim() === "") return { ok: false, reason: "MAILPIT_URL lipsă/gol" };
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reason: "MAILPIT_URL neparsabil" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "MAILPIT_URL schemă non-http(s)" };
  if (u.username !== "" || u.password !== "")            return { ok: false, reason: "MAILPIT_URL conține userinfo" };
  if (u.pathname !== "/" && u.pathname !== "")           return { ok: false, reason: "MAILPIT_URL conține path (cere origine curată)" };
  if (u.search !== "")                                   return { ok: false, reason: "MAILPIT_URL conține query (cere origine curată)" };
  if (u.hash !== "")                                     return { ok: false, reason: "MAILPIT_URL conține #fragment" };
  if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase()))     return { ok: false, reason: "MAILPIT_URL non-loopback (refuz sursă externă)" };
  return { ok: true, origin: u.origin };
}

// ────────────────────────────── 2. magic-link ↔ Supabase vetat ──────────────────────────────

/**
 * Magic link-ul (din Mailpit) acceptat DOAR dacă: parsabil, http(s), FĂRĂ userinfo/#fragment, ORIGINE EXACT egală cu a
 * Supabase-ului VETAT, și pathname EXACT `/auth/v1/verify`. Altfel refuz (fluxul nu se autentifică pe alt Supabase).
 */
export function assertMagicLinkBoundToSupabase(link: unknown, supabaseUrl: unknown): StepCheck {
  if (typeof link !== "string" || link.trim() === "") return { ok: false, reason: "magic link lipsă/gol" };
  if (typeof supabaseUrl !== "string" || supabaseUrl.trim() === "") return { ok: false, reason: "supabaseUrl vetat lipsă" };
  let want: URL, got: URL;
  try { want = new URL(supabaseUrl); } catch { return { ok: false, reason: "supabaseUrl vetat neparsabil" }; }
  try { got  = new URL(link); }        catch { return { ok: false, reason: "magic link neparsabil" }; }
  if (got.protocol !== "http:" && got.protocol !== "https:") return { ok: false, reason: "magic link schemă non-http(s)" };
  if (got.username !== "" || got.password !== "")            return { ok: false, reason: "magic link conține userinfo" };
  if (got.hash !== "")                                       return { ok: false, reason: "magic link conține #fragment" };
  if (got.origin !== want.origin)                            return { ok: false, reason: "magic link NU e pe originea Supabase vetată (posibil alt Supabase)" };
  if (got.pathname !== "/auth/v1/verify")                    return { ok: false, reason: "magic link pathname ≠ /auth/v1/verify" };
  return { ok: true };
}

// ────────────────────────────── 3. readiness cu concordanță de status ──────────────────────────────

/**
 * Readiness Gate 1 fail-closed pe STATUS: `transportStatus` (codul HTTP real) trebuie să fie EXACT `body.httpStatus`.
 * Un `503`/corp `200` sau `200`/corp `503` → `bad_status` (NU alegem un câștigător — un readiness fals verde ar lăsa
 * Gate 1 să treacă pe un web nesănătos). Apoi `assertReadiness` normal. Corp malformat → `malformed`. Tipul de RETUR e
 * `ReadinessResult` CANONIC din `canaryGate1.ts` (codurile ⊂ `ReadinessCode` → `runGate1` le mapează la reason static).
 */
export function reconcileReadiness(transportStatus: number, body: unknown): ReadinessResult {
  const report = parseHealthReport(body);
  if (report === null) return { ok: false, code: "malformed" };
  if (report.httpStatus !== transportStatus) return { ok: false, code: "bad_status" };
  return assertReadiness(report).ok ? { ok: true } : { ok: false, code: "not_ready" };
}

// ────────────────────────────── 4. bariera de generație post-spawn ──────────────────────────────

/** Un timestamp de generație citit dintr-o cheie Redis: valid (ms>0), absent (cheie lipsă), corupt, sau necitibil. */
export type GenStamp = { kind: "value"; ms: number } | { kind: "absent" } | { kind: "invalid" } | { kind: "unavailable" };

/**
 * Parsează valoarea unei chei Redis (`worker_runtime`/`worker_snapshot`) și extrage timestampul ABSOLUT (`field` =
 * `updatedAt`/`savedAt`). `null` (GET a întors nil) → absent; non-JSON / non-obiect / câmp ne-număr-finit-pozitiv →
 * invalid. Runnerul setează `unavailable` separat când GET-ul ARUNCĂ. Fail-closed.
 */
export function parseWorkerStamp(raw: string | null, field: string): GenStamp {
  if (raw === null) return { kind: "absent" };
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return { kind: "invalid" }; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { kind: "invalid" };
  const v = (obj as Record<string, unknown>)[field];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return { kind: "invalid" };
  return { kind: "value", ms: v };
}

export interface GenPair { runtime: GenStamp; snapshot: GenStamp; }

/**
 * Dovada de generație post-spawn: pentru AMBELE (worker_runtime.updatedAt ȘI worker_snapshot.savedAt) —
 *   - OBSERVAT (post-Gate2) TREBUIE să fie un timestamp VALID (altfel: absent/invalid/unavailable → roșu);
 *   - dacă BASELINE (pre-spawn) era VALID → observat trebuie STRICT mai mare (procesul nou a scris) — un timestamp
 *     neavansat = reziduu pre-spawn → roșu;
 *   - dacă baseline era ABSENT (cheie lipsă = tablă curată) → observat valid e suficient (a apărut post-spawn);
 *   - dacă baseline era INVALID (payload corupt) SAU UNAVAILABLE (GET pre-spawn a eșuat) → roșu (fix cgpt: nu pot
 *     stabili un prag de încredere dintr-un baseline corupt/necitibil — FAIL-CLOSED).
 * Comparație pe timestampuri ABSOLUTE (ms), NU pe age rotunjit. NU ștergem nimic (pre-clean-ul ar altera ce observăm).
 */
export function assertGenerationAdvanced(baseline: GenPair, observed: GenPair): StepCheck {
  for (const which of ["runtime", "snapshot"] as const) {
    const b = baseline[which], o = observed[which];
    if (o.kind !== "value") return { ok: false, reason: `${which}: observat post-spawn '${o.kind}' (cere timestamp valid)` };
    if (b.kind === "unavailable" || b.kind === "invalid") return { ok: false, reason: `${which}: baseline pre-spawn '${b.kind}' (nu pot stabili pragul) — fail-closed` };
    if (b.kind === "value" && !(o.ms > b.ms)) return { ok: false, reason: `${which}: timestamp neavansat (${o.ms} ≤ ${b.ms}) — posibil reziduu pre-spawn` };
  }
  return { ok: true };
}

// ────────────────────────────── 5. identitatea runului (marker post-spawn) ──────────────────────────────
//
// ⭐ fix cgpt P1 (rev4): avansarea timestampurilor NU identifică PROCESUL. Un writer STRĂIN (worker real orfan, reziduu
// dintr-un alt run) poate avansa `worker_runtime.updatedAt`/`worker_snapshot.savedAt` fără să fie procesul pe care ACEST
// run l-a pornit — probe verzi + timestamp avansat ar trece bariera vechi, fals. Fix: runnerul injectează în worker un
// `canaryRunId` PROASPĂT (config ÎNCHIS, ne-logat, ne-moștenit din baseEnv). Procesul îl publică în heartbeat-ul
// `worker_runtime` (ciclul de publicare validat, la fiecare scan). Bariera cere EXACT acel id → dovadă că heartbeat-ul
// avansat e al procesului NOSTRU, nu al unui writer străin. Id-ul e imposibil de ghicit → nespoofabil.

/** Markerul de identitate extras din `worker_runtime` (câmpul `canaryRunId`). `absent` = heartbeat fără marker (writer străin/non-canary). */
export type RunMarker = { kind: "value"; runId: string } | { kind: "absent" } | { kind: "invalid" };

/**
 * Extrage `canaryRunId` din payload-ul brut `worker_runtime`. `null` (cheie lipsă) sau lipsa câmpului (writer străin care
 * nu cunoaște id-ul) → `absent`; non-JSON / non-obiect → `invalid`. NU ecouă valoarea id-ului. Fail-closed.
 */
export function parseRunMarker(raw: string | null): RunMarker {
  if (raw === null) return { kind: "absent" };
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return { kind: "invalid" }; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { kind: "invalid" };
  const v = (obj as Record<string, unknown>).canaryRunId;
  if (typeof v !== "string" || v === "") return { kind: "absent" }; // heartbeat REAL dar fără marker → writer străin
  return { kind: "value", runId: v };
}

/**
 * Identitatea runului: heartbeat-ul `worker_runtime` OBSERVAT trebuie să poarte EXACT `canaryRunId`-ul injectat în procesul
 * pe care ACEST run l-a pornit. `expectedRunId` gol = config barieră invalidă → roșu (fail-closed, nu accept „orice id");
 * marker absent/invalid (writer străin/reziduu) → roșu; id diferit (alt proces) → roșu. NU ecouă id-urile.
 */
export function assertRunIdentity(expectedRunId: string, marker: RunMarker): StepCheck {
  if (typeof expectedRunId !== "string" || expectedRunId === "") return { ok: false, reason: "runId așteptat gol (config barieră invalidă) — fail-closed" };
  if (marker.kind !== "value") return { ok: false, reason: `worker_runtime fără marker de run ('${marker.kind}') — writer străin/reziduu, nu procesul acestui run` };
  if (marker.runId !== expectedRunId) return { ok: false, reason: "worker_runtime poartă alt runId (heartbeat de la alt proces) — fail-closed" };
  return { ok: true };
}

/**
 * Bariera COMPLETĂ de generație = IDENTITATE (pe AMBELE payloaduri) + AVANSARE. Identitatea PRIMA (cea mai specifică:
 * dovedește CINE scrie), apoi prospețimea (dovedește CÂND).
 *
 * ⭐ fix cgpt P1 (rev5): `worker_runtime` și `worker_snapshot` sunt citite SECVENȚIAL și pot fi scrise de PROCESE DIFERITE.
 *   Autentificând DOAR runtime-ul, un worker vechi/orfan putea avansa `worker_snapshot.savedAt` în timp ce procesul nou
 *   scria runtime-ul cu id-ul corect → marker corect + ambele timestampuri avansate → verde FALS. Fix: AMBII markeri
 *   (runtime ȘI snapshot) trebuie să fie EXACT `expectedRunId` — nu doar egali între ei, ci egali cu id-ul generat de
 *   runner (un writer străin care ar publica AMBELE cu ACELAȘI alt id ar pica tot, pentru că nu cunoaște `expectedRunId`).
 */
export function assertGenerationBarrier(
  expectedRunId:  string,
  runtimeMarker:  RunMarker,
  snapshotMarker: RunMarker,
  baseline:       GenPair,
  observed:       GenPair,
): StepCheck {
  const idR = assertRunIdentity(expectedRunId, runtimeMarker);
  if (!idR.ok) return { ok: false, reason: `worker_runtime → ${idR.reason}` };
  const idS = assertRunIdentity(expectedRunId, snapshotMarker);
  if (!idS.ok) return { ok: false, reason: `worker_snapshot → ${idS.reason}` };
  return assertGenerationAdvanced(baseline, observed);
}

/**
 * ⭐ fix cgpt P1 (rev5): baseline-ul PRE-spawn trebuie ADMISIBIL înainte de a porni consumatorul Alchemy WS-live. `absent`
 * (tablă curată) și `value` (prag stabil) sunt OK; `invalid` (payload corupt) sau `unavailable` (GET pre-spawn a eșuat)
 * → bariera n-ar putea deveni NICIODATĂ verde (nu pot stabili pragul), deci a porni workerul ar arde Alchemy degeaba până
 * la expirarea warm-up-ului. Fail-closed: refuz spawn-ul. Verificat pe AMBELE componente.
 */
export function assertBaselineAdmissible(baseline: GenPair): StepCheck {
  for (const which of ["runtime", "snapshot"] as const) {
    const b = baseline[which];
    if (b.kind === "invalid" || b.kind === "unavailable")
      return { ok: false, reason: `${which}: baseline pre-spawn '${b.kind}' — NU pornesc workerul (bariera n-ar deveni verde) — fail-closed` };
  }
  return { ok: true };
}

// ────────────────────────────── 6. citire Redis MĂRGINITĂ (deadline + abort care TERMINĂ op-ul) ──────────────────────────────
//
// ⭐ fix cgpt P2 (rev4): `checkGeneration` din poll-ul Gate 2 primește semnalul orchestratorului; citirea Redis a generației
// TREBUIE să-l onoreze ȘI să fie mărginită de un deadline propriu (< `graceMs`). Un `GET` care nu se rezolvă (Redis lent/
// atârnat) NU trebuie să blocheze poll-ul dincolo de deadline, iar la ABORT-ul Gate 2 op-ul trebuie TERMINAT (conexiune
// dedicată închisă), nu doar abandonat printr-un `Promise.race` (care ar lăsa cererea vie în fundal, peste stop/cleanup).

/** Conexiune Redis minimală injectabilă (dedicată barierei) — testabilă hermetic cu un stub. */
export interface GenConn {
  get(key: string): Promise<string | null>;
  disconnect(): void;
}

/**
 * `GET key` mărginit: se rezolvă cu valoarea, SAU respinge la (a) `commandTimeoutMs` scurs — respinge FĂRĂ `disconnect`
 * (conexiunea dedicată supraviețuiește pt. tick-ul următor al poll-ului), SAU (b) `signal` abortat — `disconnect()` ÎNCHIDE
 * conexiunea (TERMINĂ op-ul în zbor, nu-l abandonează) apoi respinge. Un singur settle (idempotent). Fără `Promise.race`.
 */
export function boundedGet(conn: GenConn, key: string, signal: AbortSignal, commandTimeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
    const settle = (fn: () => void) => { if (settled) return; settled = true; cleanup(); fn(); };
    const timer = setTimeout(() => settle(() => reject(new Error("gen_read_timeout"))), commandTimeoutMs);
    const onAbort = () => settle(() => { try { conn.disconnect(); } catch { /* best-effort */ } reject(new Error("gen_read_abort")); });
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    conn.get(key).then(
      (v) => settle(() => resolve(v)),
      (e) => settle(() => reject(e instanceof Error ? e : new Error("gen_read_failed"))),
    );
  });
}

export interface GenerationBarrierConfig {
  expectedRunId:    string;
  baseline:         GenPair;
  conn:             GenConn;
  runtimeKey:       string;
  snapshotKey:      string;
  commandTimeoutMs: number; // < graceMs Gate 2
}

/**
 * Citește baseline-ul PRE-spawn (runtime.updatedAt + snapshot.savedAt) prin conexiunea mărginită, cu un semnal care NU se
 * abortează (baseline e o citire one-shot, în afara ferestrei de poll a Gate 2). O citire eșuată (timeout/eroare) →
 * `unavailable` → `assertGenerationAdvanced` va cădea fail-closed (nu pot stabili pragul dintr-un baseline necitibil).
 */
export async function readGenBaseline(conn: GenConn, runtimeKey: string, snapshotKey: string, commandTimeoutMs: number): Promise<GenPair> {
  const never = new AbortController().signal;
  const read = async (key: string, field: string): Promise<GenStamp> => {
    try { return parseWorkerStamp(await boundedGet(conn, key, never, commandTimeoutMs), field); }
    catch { return { kind: "unavailable" }; }
  };
  return { runtime: await read(runtimeKey, "updatedAt"), snapshot: await read(snapshotKey, "savedAt") };
}

/**
 * Construiește `checkGeneration` pt. poll-ul Gate 2: la fiecare tick citește (mărginit + abort-aware) `worker_runtime`
 * (stamp `updatedAt` + marker `canaryRunId`) și `worker_snapshot` (stamp `savedAt`), apoi aplică bariera COMPLETĂ
 * (identitate + avansare). O citire care nu se încadrează în deadline → roșu (fail-closed), NU verde tăcut. Semnalul deja
 * abortat → roșu imediat + `disconnect` (nu mai pornim un GET nou într-o fereastră închisă). Întoarce `StepCheck`.
 */
export function makeGenerationBarrier(cfg: GenerationBarrierConfig): (signal: AbortSignal) => Promise<StepCheck> {
  return async (signal: AbortSignal): Promise<StepCheck> => {
    if (signal.aborted) { try { cfg.conn.disconnect(); } catch { /* */ } return { ok: false, reason: "barieră generație: fereastra Gate 2 e deja abortată" }; }
    let runtimeRaw: string | null;
    let snapshotRaw: string | null;
    try { runtimeRaw = await boundedGet(cfg.conn, cfg.runtimeKey, signal, cfg.commandTimeoutMs); }
    catch { return { ok: false, reason: "worker_runtime necitibil sub deadline (Redis lent/jos/abort) — fail-closed" }; }
    try { snapshotRaw = await boundedGet(cfg.conn, cfg.snapshotKey, signal, cfg.commandTimeoutMs); }
    catch { return { ok: false, reason: "worker_snapshot necitibil sub deadline (Redis lent/jos/abort) — fail-closed" }; }
    const runtimeMarker  = parseRunMarker(runtimeRaw);
    const snapshotMarker = parseRunMarker(snapshotRaw); // ⭐ fix cgpt P1 (rev5): și snapshotul trebuie legat de PROCESUL nostru
    const observed: GenPair = {
      runtime:  parseWorkerStamp(runtimeRaw, "updatedAt"),
      snapshot: parseWorkerStamp(snapshotRaw, "savedAt"),
    };
    return assertGenerationBarrier(cfg.expectedRunId, runtimeMarker, snapshotMarker, cfg.baseline, observed);
  };
}

// ────────────────────────────── 7. poartă de admisibilitate a baseline-ului (anti-cost pre-spawn) ──────────────────────────────

/** Rezultatul porții pre-spawn: `ok` → runnerul pornește Gate 2; altfel un cod ÎNCHIS + reason (Gate 2 roșu, ZERO spawn). */
export type BaselineGateOutcome<T> = { started: true; result: T } | { started: false; code: "generation_baseline"; reason: string };

/**
 * ⭐ fix cgpt P1 (rev5): poarta care leagă admisibilitatea baseline-ului de DECIZIA de spawn. Dacă baseline-ul e
 * inadmisibil (`invalid`/`unavailable` pe orice componentă), NU cheamă `start` (deci nici `makeSteps`, nici spawn-ul
 * consumatorului Alchemy) — întoarce direct un rezultat ÎNCHIS roșu. Altfel rulează `start` (= `runGate2` real). Seam PUR
 * (start injectat) → testabil hermetic că un baseline inadmisibil produce ZERO spawn.
 */
export async function startGate2IfBaselineAdmissible<T>(
  baseline: GenPair,
  start:    () => Promise<T>,
): Promise<BaselineGateOutcome<T>> {
  const adm = assertBaselineAdmissible(baseline);
  if (!adm.ok) return { started: false, code: "generation_baseline", reason: adm.reason };
  return { started: true, result: await start() };
}
