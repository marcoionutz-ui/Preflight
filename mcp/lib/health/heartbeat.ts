/**
 * lib/health/heartbeat.ts — PH-12 slice 12.4 (liveness Indexer-EVM + Worker-Solana prin heartbeat Redis).
 *
 * CLASIFICATORUL (frunză pură, zero I/O) peste heartbeat-ul de serviciu. Formatul PE SÂRMĂ (ServiceRole /
 * HeartbeatPayload / serializeHeartbeat / parseHeartbeat) NU trăiește aici, ci în `@preflight/schema` — pachetul
 * partajat pe care îl importă DEOPOTRIVĂ publisherii (workers/indexer-evm, workers/solana) ȘI reader-ul (mcp).
 * Aici stau DOAR lucrurile pe care le folosește exclusiv reader-ul: stările, pragurile, `classifyHeartbeat` și
 * agregatul `foldServiceChecks` (împletit apoi în `computeLiveness`). Așa contractul e REALMENTE partajat, fără drift.
 *
 * ── Corecțiile lock-uite de Marco + review-ul cgpt (toate reflectate) ────────────────────────────────────────
 *  · Rol tipizat + payload versionat fail-closed + `serializeHeartbeat` care refuză `now` invalid → `@preflight/schema`.
 *  · 5 stări distincte: `disabled | ok | stale | missing | unavailable`.
 *  · `unavailable` (Redis necunoscut per-serviciu) NU produce niciodată un verdict „ok": intră în `degraded`
 *    (cgpt P1) — chiar dacă ping-ul global de Redis a reușit, dar citirea cheii serviciului a eșuat.
 *  · Praguri separate: interval 30s, fresh 90s, TTL 300s (banda `stale` [90,300) există înainte de expirare).
 *  · Future-skew MĂRGINIT (cgpt P2): un `updated_at` în viitor peste `FUTURE_SKEW` (30s) → `missing` (fail-closed),
 *    nu declarat fals „fresh". Skew mic (≤30s) → clamp la age=0 (ok).
 *  · Expirarea cheii (fără DEL la shutdown) ⇒ `raw === null` ⇒ `missing`.
 *  · BYTE-COMPAT: `foldServiceChecks` întoarce `undefined` când toate-s `disabled` ⇒ `computeLiveness` nu adaugă
 *    niciun câmp `services`/`checks.services` ⇒ output byte-identic cu dinainte de 12.4.
 */
import { parseHeartbeat, HEARTBEAT_TTL_SEC, type ServiceRole } from "@preflight/schema";

export type { ServiceRole } from "@preflight/schema";
// Contract PE SÂRMĂ + praguri de PROTOCOL trăiesc în @preflight/schema (partajate cu publisherii worker); re-exportate
// aici pt. conveniența consumatorilor de health (un singur punct de import pentru reader).
export {
  SERVICE_ROLES, serializeHeartbeat, parseHeartbeat, HEARTBEAT_VERSION,
  HEARTBEAT_INTERVAL_SEC, HEARTBEAT_TTL_SEC, type HeartbeatPayload,
} from "@preflight/schema";

// ── Stări distincte (Marco #5) ────────────────────────────────────────────────
export type ServiceHeartbeatState = "disabled" | "ok" | "stale" | "missing" | "unavailable";

// ── Politici de READER (rămân în mcp). Interval/TTL sunt de PROTOCOL → în @preflight/schema. ───────────────────
// Fresh (90s) ≪ TTL (300s) ⇒ banda `stale` [90,300) există real înainte de expirare.
export const HEALTH_HEARTBEAT_FRESH_SEC       = 90;  // age ≤ 90s → ok. 3× interval ⇒ un beat pierdut nu flappează
export const HEALTH_HEARTBEAT_FUTURE_SKEW_SEC = 30;  // toleranță de ceas; peste ea (viitor) → missing (fail-closed)

// ── Semnalul brut per serviciu (produs de readHealthSignals, leaf 4) ──────────
export interface ServiceHeartbeatSignal {
  role:           ServiceRole;
  expected:       boolean;        // din flag-ul env (leaf 2). false → `disabled`
  redisReachable: boolean;        // citirea cheii ACESTUI serviciu a reușit? false → `unavailable` (NU citim `raw`)
  raw:            string | null;  // valoarea cheii din Redis; null = cheie lipsă/expirată (→ missing)
}

// ── Verdictul clasificat per serviciu ─────────────────────────────────────────
export interface ServiceHeartbeatCheck {
  service: ServiceRole;
  state:   ServiceHeartbeatState;
  ageSec:  number | null;  // null când nu există un `updated_at` credibil (disabled/unavailable/missing)
  detail:  string;
}

/**
 * Clasifică UN serviciu în cele 5 stări (PUR; `now` injectat). Ordinea contează:
 *   1. !expected                       → `disabled`    (nu penalizăm ce nu așteptăm)
 *   2. !redisReachable                 → `unavailable` (citire eșuată → NECUNOSCUT, nu fals „stale")
 *   3. parse null                      → `missing`     (cheie lipsă/expirată SAU payload corupt — fail-closed)
 *   4. viitor peste FUTURE_SKEW        → `missing`     (ceas stricat / payload nesincer — fail-closed, cgpt P2)
 *   5. age ≤ freshSec (skew mic → 0)   → `ok`
 *   6. altfel                          → `stale`       (prezent dar vechi; încă în banda [fresh, TTL))
 */
export function classifyHeartbeat(
  sig: ServiceHeartbeatSignal,
  now: number,
  opts: { freshSec?: number; futureSkewSec?: number } = {},
): ServiceHeartbeatCheck {
  const freshSec   = opts.freshSec ?? HEALTH_HEARTBEAT_FRESH_SEC;
  const skewSec    = opts.futureSkewSec ?? HEALTH_HEARTBEAT_FUTURE_SKEW_SEC;
  const role = sig.role;

  if (!sig.expected) {
    return { service: role, state: "disabled", ageSec: null, detail: "not expected (flag off)" };
  }
  if (!sig.redisReachable) {
    return { service: role, state: "unavailable", ageSec: null, detail: "unknown (redis read failed)" };
  }
  const hb = parseHeartbeat(sig.raw, role);
  if (hb === null) {
    return { service: role, state: "missing", ageSec: null, detail: "no valid heartbeat (missing/expired/corrupt)" };
  }

  const ageSecRaw = Math.floor((now - hb.updated_at) / 1000);
  if (ageSecRaw < -skewSec) {
    // updated_at prea departe în viitor → nu-l credem (fail-closed), NU „fresh".
    return { service: role, state: "missing", ageSec: null, detail: `heartbeat invalid (updated_at ${-ageSecRaw}s în viitor > skew ${skewSec}s)` };
  }
  const ageSec = ageSecRaw < 0 ? 0 : ageSecRaw; // skew mic (≤ skewSec) → clamp la 0 (o scriere foarte recentă)
  if (ageSec <= freshSec) {
    return { service: role, state: "ok", ageSec, detail: `heartbeat fresh (${ageSec}s ≤ ${freshSec}s)` };
  }
  return { service: role, state: "stale", ageSec, detail: `heartbeat stale (${ageSec}s > ${freshSec}s, ttl ${HEARTBEAT_TTL_SEC}s)` };
}

// ── Agregatul împletit în computeLiveness ─────────────────────────────────────
export interface HealthCheckLike { ok: boolean; detail: string; }

export interface ServiceHealthSection {
  services: ServiceHeartbeatCheck[]; // toate rolurile date (inclusiv `disabled`), ordine stabilă
  degraded: boolean;                 // vreun serviciu AȘTEPTAT în `stale`/`missing`/`unavailable` (nu-i „ok")
  check:    HealthCheckLike;         // slot-ul agregat pentru report.checks.services
}

/**
 * Pliază verdictele per-serviciu într-o secțiune pentru raport — SAU `undefined` când TOATE sunt `disabled`
 * (byte-compat: `computeLiveness` nu adaugă atunci niciun câmp). PUR.
 *
 * `degraded` (cgpt P1) se aprinde pe `stale`/`missing` DAR ȘI pe `unavailable`: un serviciu așteptat pe care NU-l
 * putem determina (citire de Redis eșuată) NU trebuie să treacă drept „ok". Când ÎNTREGUL Redis e jos,
 * `computeLiveness` întoarce oricum `down`/503 (Redis domină) — dar când doar cheia acestui serviciu a eșuat, iar
 * restul e sănătos, `degraded` e verdictul onest.
 */
export function foldServiceChecks(checks: ServiceHeartbeatCheck[]): ServiceHealthSection | undefined {
  if (checks.length === 0 || checks.every(c => c.state === "disabled")) return undefined;

  const problems    = checks.filter(c => c.state === "stale" || c.state === "missing");
  const unavailable = checks.filter(c => c.state === "unavailable");
  const okOnes      = checks.filter(c => c.state === "ok");
  const degraded    = problems.length > 0 || unavailable.length > 0;

  const check: HealthCheckLike = problems.length > 0
    ? { ok: false, detail: `service(s) unhealthy: ${problems.map(p => `${p.service}:${p.state}`).join(", ")}` }
    : unavailable.length > 0
      ? { ok: false, detail: `service(s) unavailable (redis read failed): ${unavailable.map(u => u.service).join(", ")}` }
      : { ok: true, detail: `service(s) ok: ${okOnes.map(o => o.service).join(", ") || "none active"}` };

  return { services: checks, degraded, check };
}

/**
 * Lista rolurilor MONITORIZATE (așteptate, ne-`disabled`) pentru extinderea `scope`-ului. PUR.
 * Gol când secțiunea lipsește (byte-compat) → caller-ul păstrează scope-ul de bază.
 */
export function monitoredServiceRoles(section: ServiceHealthSection | undefined): ServiceRole[] {
  if (!section) return [];
  return section.services.filter(s => s.state !== "disabled").map(s => s.service);
}
