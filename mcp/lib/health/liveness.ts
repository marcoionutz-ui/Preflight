/**
 * lib/health/liveness.ts — PH-13 (endpoint extern de liveness/health).
 *
 * Clasificator PUR (frunză, zero I/O) peste semnalele deja citite din Redis. Wiring-ul Redis (`readHealthSignals`)
 * + ruta HTTP (`app/api/health/route.ts`) sunt separate.
 *
 * SCOPE (cgpt #6, extins 12.4): baza acoperă serviciul web `mcp` + worker-ul `evm`. Din 12.4, când sunt AȘTEPTATE
 * explicit (flag), health-ul acoperă CONDIȚIONAL și `indexer-evm` / `solana-worker` prin heartbeat Redis — iar
 * `scope` (expus în body + runbook) se EXTINDE ca să numească exact serviciile monitorizate. Fără servicii așteptate,
 * `scope` rămâne `mcp-web + evm-worker` (byte-compat). NU raportează implicit tot produsul multichain: doar ce e în scope.
 *
 * SEMANTICA CODULUI HTTP:
 *   - `GET /api/health`          → ținta Railway healthcheck: 200 cât timp web + Redis sunt ok; worker/WS-stale =
 *                                  `degraded` DAR tot 200 (nu repornim un web sănătos pt. alt serviciu).
 *   - `GET /api/health?strict=1` → ținta monitorului extern: 503 ȘI pe `degraded`.
 *   - Redis inaccesibil → 503 pe ambele.
 *
 * CHAIN COMPLETENESS (cgpt #1): raportăm pe lista de chain-uri AȘTEPTATE (din config/env), NU doar pe ce a
 * supraviețuit în Redis. Un chain așteptat care și-a pierdut ambele chei → `degraded`, niciodată sărit.
 * WS TRUTHFULNESS (cgpt #2): `wsState` per chain modelează onest disconnected / unknown / suspected_stale /
 * healthy / disabled — nu doar subscripțiile cross-kind.
 */

import {
  foldServiceChecks,
  monitoredServiceRoles,
  type ServiceHeartbeatCheck,
  type ServiceHealthSection,
} from "./heartbeat";

export const HEALTH_SCOPE = "mcp-web + evm-worker"; // scope de BAZĂ; 12.4 îl EXTINDE cu serviciile monitorizate

/**
 * Extinde scope-ul de bază cu serviciile REALMENTE monitorizate (indexer-evm / solana-worker când sunt așteptate).
 * Fără secțiune de servicii (sau toate `disabled`) → scope-ul de bază neschimbat (byte-compat). PUR.
 */
function extendScope(base: string, section: ServiceHealthSection | undefined): string {
  const roles = monitoredServiceRoles(section);
  return roles.length ? `${base} + ${roles.join(" + ")}` : base;
}
export const HEALTH_WORKER_FRESH_SEC = 300;         // snapshot mai vechi pe un chain așteptat → stale
export const HEALTH_WS_PONG_FRESH_SEC = 120;        // pong mai vechi (sau necunoscut) pe un socket „conectat" → suspect

export type HealthStatus = "ok" | "degraded" | "down";
export type WsState = "healthy" | "suspected_stale" | "disconnected" | "unknown" | "disabled";

// ── Chain-uri așteptate (config/env), PUR ─────────────────────────────────────
/**
 * Parsează lista de chain-uri AȘTEPTATE dintr-un string env (ex. `ENABLED_CHAINS`), normalizată + validată contra
 * chain-urilor cunoscute. Dedup, ordine stabilă. Gol/invalid → `[]` (caller decide fallback-ul). Pur (normalize +
 * validChains injectate → testabil fără @preflight/schema).
 */
export function parseExpectedChains(raw: string | undefined, validChains: readonly string[], normalize: (s: string) => string): string[] {
  if (!raw) return [];
  const valid = new Set(validChains.map(c => normalize(c)));
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const c = normalize(part.trim().toLowerCase());
    if (c && valid.has(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

// ── Derivarea stării WS per chain, PUR ────────────────────────────────────────
export interface WsRuntimeView {
  present:             boolean;        // runtime valid rezolvat (resolveWsRuntime !== null)
  wsConnected:         boolean;
  lastPongAgeSec:      number | null;  // null = necunoscut
  suspectedStaleKinds: string[];       // din classifyWsSubs (cross-kind)
}

/**
 * Starea WS onestă pentru un chain unde WS e AȘTEPTAT (cgpt #2). Reguli:
 *   - !wsExpected                                   → `disabled` (nu penalizăm)
 *   - runtime absent/invalid/expirat (!present)     → `unknown`  (NU „healthy" fără dovadă)
 *   - !wsConnected                                  → `disconnected`
 *   - conectat + cross-kind SUSPECTED_STALE         → `suspected_stale` (+ staleKinds → wsStaleSubs)
 *   - conectat + pong expirat/necunoscut            → `suspected_stale` (transport nedovedit; fără staleKinds)
 *   - conectat + pong proaspăt + fără subs stale    → `healthy`
 * `QUIET_OR_UNKNOWN` NU e transformat artificial în zombie: dacă nu-s `suspectedStaleKinds` și pong-ul e proaspăt,
 * rămâne `healthy` (piață liniștită ≠ socket mort).
 */
export function deriveWsState(
  rt: WsRuntimeView | null,
  wsExpected: boolean,
  opts: { pongFreshSec?: number } = {},
): { state: WsState; staleKinds: string[] } {
  if (!wsExpected)           return { state: "disabled", staleKinds: [] };
  if (!rt || !rt.present)    return { state: "unknown", staleKinds: [] };
  if (!rt.wsConnected)       return { state: "disconnected", staleKinds: [] };
  if (rt.suspectedStaleKinds.length > 0) return { state: "suspected_stale", staleKinds: rt.suspectedStaleKinds };
  const pongFresh = opts.pongFreshSec ?? HEALTH_WS_PONG_FRESH_SEC;
  if (rt.lastPongAgeSec === null || rt.lastPongAgeSec > pongFresh) return { state: "suspected_stale", staleKinds: [] };
  return { state: "healthy", staleKinds: [] };
}

// ── Semnale (produse de readHealthSignals) ────────────────────────────────────
export interface PerChainHealth {
  chain:          string;
  expected:       boolean;
  observed:       boolean;            // a avut vreo amprentă în Redis (snapshot sau runtime)
  snapshotAgeSec: number | null;      // null = snapshot lipsă/invalid pt. un chain așteptat → stale
  wsState:        WsState;
  wsStaleKinds:   string[];           // "v2"… (cross-kind) → devin "chain:kind" în wsStaleSubs
}

export interface HealthSignals {
  redisReachable: boolean;
  wsExpected:     boolean;
  expectedChains: string[];
  observedChains: string[];
  perChain:       PerChainHealth[];   // câte una per chain AȘTEPTAT
  /**
   * PH-12 12.4 — verdictele de heartbeat per serviciu (indexer-evm / solana-worker), deja clasificate de
   * `readHealthSignals` (leaf 4) prin `classifyHeartbeat`. OPȚIONAL: caller-ii dinainte de 12.4 nu-l trimit →
   * `computeLiveness` nu adaugă nimic (byte-compat). Când toate-s `disabled`, `foldServiceChecks` întoarce
   * `undefined` → tot byte-compat (dublă siguranță).
   */
  services?:      ServiceHeartbeatCheck[];
}

export interface HealthCheck { ok: boolean; detail: string; }

export interface HealthReport {
  status:     HealthStatus;
  httpStatus: number;
  scope:      string;
  checks:     { web: HealthCheck; redis: HealthCheck; worker: HealthCheck; ws: HealthCheck; services?: HealthCheck };
  worstSnapshotAgeSec:  number | null;
  expectedChains:       string[];
  observedChains:       string[];
  staleChains:          string[];  // chain-uri așteptate cu snapshot lipsă/prea vechi
  wsStaleSubs:          string[];  // "chain:kind" suspected-stale (zombie subscription)
  wsUnavailableChains:  string[];  // wsState = disconnected (≠ zombie)
  wsUnknownChains:      string[];  // wsState = unknown (runtime lipsă/expirat)
  /**
   * PH-12 12.4 — starea per serviciu (indexer-evm / solana-worker). ABSENT (nu `[]`) când ambele-s explicit
   * ne-așteptate → JSON byte-identic cu dinainte de 12.4. Prezent doar când ≥1 serviciu e așteptat.
   */
  services?:            ServiceHeartbeatCheck[];
}

export interface LivenessOpts { strict?: boolean; freshSec?: number; }

export function computeLiveness(sig: HealthSignals, opts: LivenessOpts = {}): HealthReport {
  const freshSec = opts.freshSec ?? HEALTH_WORKER_FRESH_SEC;

  // Secțiunea de servicii (12.4): pliem verdictele deja clasificate. `undefined` când lipsesc / toate `disabled`
  // → nu adăugăm nimic (byte-compat). Pe Redis-down serviciile așteptate vin `unavailable`; verdictul rămâne `down`.
  const svc = sig.services ? foldServiceChecks(sig.services) : undefined;
  const scope = extendScope(HEALTH_SCOPE, svc); // byte-compat: rămâne HEALTH_SCOPE când nu-s servicii monitorizate

  if (!sig.redisReachable) {
    const report: HealthReport = {
      status: "down", httpStatus: 503, scope,
      checks: {
        web:    { ok: true,  detail: "web process responding" },
        redis:  { ok: false, detail: "redis unreachable" },
        worker: { ok: false, detail: "unknown (redis unreachable)" },
        ws:     { ok: false, detail: "unknown (redis unreachable)" },
      },
      worstSnapshotAgeSec: null, expectedChains: sig.expectedChains, observedChains: sig.observedChains,
      staleChains: [], wsStaleSubs: [], wsUnavailableChains: [], wsUnknownChains: [],
    };
    if (svc) { report.checks.services = svc.check as HealthCheck; report.services = svc.services; }
    return report;
  }

  // Worker freshness pe chain-urile AȘTEPTATE (un chain fără snapshot = stale, nu sărit).
  const staleChains: string[] = [];
  let worstAge: number | null = null;
  for (const c of sig.perChain) {
    const age = c.snapshotAgeSec;
    if (age === null) { staleChains.push(c.chain); continue; }   // lipsă/invalid → stale
    if (worstAge === null || age > worstAge) worstAge = age;
    if (age >= freshSec) staleChains.push(c.chain);
  }
  const noExpected  = sig.expectedChains.length === 0;
  const workerStale = noExpected || staleChains.length > 0;

  // WS onest (doar dacă WS e așteptat).
  const wsStaleSubs: string[] = [];
  const wsUnavailableChains: string[] = [];
  const wsUnknownChains: string[] = [];
  if (sig.wsExpected) {
    for (const c of sig.perChain) {
      if (c.wsState === "suspected_stale") for (const k of c.wsStaleKinds) wsStaleSubs.push(`${c.chain}:${k}`);
      if (c.wsState === "disconnected") wsUnavailableChains.push(c.chain);
      if (c.wsState === "unknown")      wsUnknownChains.push(c.chain);
    }
  }
  const wsProblem = sig.wsExpected &&
    (wsStaleSubs.length > 0 || wsUnavailableChains.length > 0 || wsUnknownChains.length > 0 ||
     sig.perChain.some(c => c.wsState === "suspected_stale"));

  const workerCheck: HealthCheck = {
    ok: !workerStale,
    detail: noExpected ? "no expected chains configured"
      : workerStale ? `worker stale on: ${staleChains.join(", ")}`
      : `worker fresh (worst ${worstAge}s < ${freshSec}s) on ${sig.expectedChains.join(", ")}`,
  };
  const wsProblemChains = [...new Set([
    ...sig.perChain.filter(c => c.wsState === "suspected_stale").map(c => c.chain),
    ...wsUnavailableChains, ...wsUnknownChains,
  ])];
  const wsCheck: HealthCheck = !sig.wsExpected
    ? { ok: true, detail: "ws not expected (disabled)" }
    : noExpected
      ? { ok: true, detail: "no expected chains configured" }   // fără chain-uri nu putem evalua WS; worker check semnalează degraded
      : wsProblem
        ? { ok: false, detail: `ws unhealthy on: ${wsProblemChains.join(", ")}` }
        : { ok: true, detail: `ws healthy on ${sig.expectedChains.join(", ")}` };

  // 12.4: un serviciu așteptat `stale`/`missing` contribuie la `degraded` (nu 503 pe healthcheck-ul web decât în
  // strict — aceeași politică: nu repornim un web sănătos pentru alt serviciu). `unavailable` NU ajunge aici (Redis-jos
  // s-a întors deja `down` mai sus).
  const svcDegraded = svc?.degraded ?? false;

  const degraded   = workerStale || wsProblem || svcDegraded;
  const status: HealthStatus = degraded ? "degraded" : "ok";
  const httpStatus = status === "ok" ? 200 : (opts.strict ? 503 : 200);

  const report: HealthReport = {
    status, httpStatus, scope,
    checks: {
      web:    { ok: true, detail: "web process responding" },
      redis:  { ok: true, detail: "redis reachable" },
      worker: workerCheck,
      ws:     wsCheck,
    },
    worstSnapshotAgeSec: worstAge,
    expectedChains: sig.expectedChains,
    observedChains: sig.observedChains,
    staleChains, wsStaleSubs, wsUnavailableChains, wsUnknownChains,
  };
  if (svc) { report.checks.services = svc.check as HealthCheck; report.services = svc.services; }
  return report;
}
