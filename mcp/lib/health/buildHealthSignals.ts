/**
 * lib/health/buildHealthSignals.ts — PH-13 (asamblarea PURĂ a semnalelor de liveness din Redis).
 *
 * FRUNZĂ testabilă: Redis (client-like), cheile și primitivele WS D1c (`resolveWsRuntime`/`classifyWsSubs`) sunt
 * INJECTATE, iar tipurile grele din health-freshness intră DOAR ca `import type` (erase la runtime), ca testul să
 * ruleze fără a atinge Redis-ul real. Din `@preflight/schema` importăm ȘI valoarea `SERVICE_ROLES` (o mică listă de
 * roluri + tipul `ServiceRole`) — pachet pur, zero I/O, safe la runtime; clasificatorul de heartbeat rămâne pur în
 * `./heartbeat`. Wiring-ul concret (client + chei + env) trăiește în `readHealthSignals.ts`; clasificarea finală în
 * `computeLiveness` (frunză pură).
 *
 * EDGE (cgpt): dacă lista de chain-uri AȘTEPTATE e goală, `MGET(...[])` ar fi o comandă Redis fără chei (poate arunca)
 * și am raporta FALS `redis unreachable/down`. Contractul cere: lista goală → `redisReachable:true` (verificat cu un
 * PING bounded) + `perChain:[]`, iar `computeLiveness` dă worker „degraded (no expected chains)", NU „down".
 */
import type { WsRuntimeRaw, WsSubMap, WsSubKind, WsRuntimeEntry } from "../mcp/health-freshness";
import { deriveWsState, type HealthSignals, type PerChainHealth, type WsRuntimeView } from "./liveness";
import { classifyHeartbeat, type ServiceHeartbeatCheck, type ServiceHeartbeatSignal } from "./heartbeat";
import { SERVICE_ROLES, type ServiceRole } from "@preflight/schema";

/** Subsetul de client Redis de care avem nevoie (ioredis îl satisface structural). */
export interface HealthRedisLike {
  ping(): Promise<unknown>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

export interface BuildHealthDeps {
  redis:       HealthRedisLike | null;
  chains:      string[];
  wsExpected:  boolean;
  now:         number;
  snapshotKey: (chain: string) => string;
  runtimeKey:  (chain: string) => string;
  // Primitivele PURE D1c injectate (semnături identice cu cele din health-freshness):
  resolveWsRuntime: (raw: WsRuntimeRaw, keyChain: string, now: number, opts: { maxAgeMs: number; futureSkewMs: number; normalizeChain: (s: string) => string }) => WsRuntimeEntry | null;
  classifyWsSubs:   (subs: WsSubMap | null, opts: { staleSec: number }) => { suspectedStaleKinds: WsSubKind[] };
  normalizeChain:   (s: string) => string;
  wsStaleSec:       number;
  runtimeMaxAgeMs:  number;
  futureSkewMs:     number;
  pingTimeoutMs:    number;
  // PH-12 12.4 leaf 4: liveness de SERVICIU (indexer-evm / solana). AȘTEPTAREA per rol (din env, `resolveServiceExpectations`)
  // + cheia Redis (`serviceHeartbeatKey`) sunt INJECTATE, la fel ca restul (chei/chain-uri). Clasificatorul e pur (./heartbeat).
  serviceExpectations: Record<ServiceRole, boolean>;
  serviceHeartbeatKey: (role: ServiceRole) => string;
}

/**
 * Clasifică AMBELE roluri de serviciu în `ServiceHeartbeatCheck[]` (ordine stabilă din `SERVICE_ROLES`). PUR.
 * `reachable` = a reușit citirea cheilor de heartbeat (relevant DOAR pt. rolurile așteptate); `rawByRole` = valorile
 * citite (sau null = cheie absentă/expirată). Un rol NE-așteptat → `disabled` (nu citim, nu penalizăm). Când toate-s
 * `disabled`, `computeLiveness`/`foldServiceChecks` NU adaugă câmpul `services` → output byte-identic cu dinainte de 12.4.
 */
function classifyServices(
  deps: BuildHealthDeps,
  now: number,
  reachable: boolean,
  rawByRole: Map<ServiceRole, string | null> | null,
): ServiceHeartbeatCheck[] {
  return [...SERVICE_ROLES].map((role) => {
    const expected = deps.serviceExpectations[role];
    const sig: ServiceHeartbeatSignal = {
      role,
      expected,
      redisReachable: expected ? reachable : true,          // irelevant când !expected
      raw:            expected ? (rawByRole?.get(role) ?? null) : null,
    };
    return classifyHeartbeat(sig, now);
  });
}

/**
 * Citește heartbeat-urile rolurilor AȘTEPTATE (un MGET separat, doar pe cheile lor) și le clasifică. Dacă acel MGET
 * eșuează DAR citirile de chain au reușit (Redis global sus), marcăm rolurile așteptate `unavailable` (necunoscut ≠ ok
 * → `degraded`), NU „down" global. Fără rol așteptat → toate `disabled` fără vreo comandă Redis.
 */
async function readServiceHeartbeats(redis: HealthRedisLike, deps: BuildHealthDeps, now: number): Promise<ServiceHeartbeatCheck[]> {
  const expectedRoles = [...SERVICE_ROLES].filter((r) => deps.serviceExpectations[r]);
  if (expectedRoles.length === 0) return classifyServices(deps, now, true, null);
  try {
    const raws = await redis.mget(...expectedRoles.map(deps.serviceHeartbeatKey));
    const rawByRole = new Map<ServiceRole, string | null>();
    expectedRoles.forEach((r, i) => rawByRole.set(r, raws[i] ?? null));
    return classifyServices(deps, now, true, rawByRole);
  } catch {
    return classifyServices(deps, now, false, null);
  }
}

/** Promisiune cu deadline dur: dacă `p` nu se rezolvă în `ms`, respinge (PING bounded — nu atârnăm pe un Redis mort). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/**
 * Vârsta snapshot-ului worker în secunde, pt. un chain AȘTEPTAT. `null` = cheie absentă SAU fără `savedAt` valid / în
 * viitor → tratat ca STALE (nu „proaspăt", nu sărit). `hadKey` = a existat vreo cheie de snapshot (pt. `observed`).
 */
function snapshotAge(raw: string | null, now: number): { ageSec: number | null; hadKey: boolean } {
  if (raw == null) return { ageSec: null, hadKey: false };
  try {
    const o  = JSON.parse(raw) as { savedAt?: unknown };
    const sv = Number(o?.savedAt);
    if (!Number.isFinite(sv)) return { ageSec: null, hadKey: true };
    const age = Math.round((now - sv) / 1000);
    return { ageSec: age < 0 ? null : age, hadKey: true };
  } catch {
    return { ageSec: null, hadKey: true };
  }
}

export async function buildHealthSignals(deps: BuildHealthDeps): Promise<HealthSignals> {
  const { redis, chains, wsExpected, now } = deps;
  if (!redis) return { redisReachable: false, wsExpected, expectedChains: chains, observedChains: [], perChain: [], services: classifyServices(deps, now, false, null) };

  // ── EDGE: nicio cheie de chain așteptat → NU rulăm MGET fără chei. Verificăm Redis cu PING bounded. ──
  if (chains.length === 0) {
    try {
      await withTimeout(redis.ping(), deps.pingTimeoutMs);
      // Chain-uri zero, DAR un serviciu poate fi așteptat → tot îl citim + raportăm (PING a dovedit Redis viu).
      return { redisReachable: true, wsExpected, expectedChains: [], observedChains: [], perChain: [], services: await readServiceHeartbeats(redis, deps, now) };
    } catch {
      return { redisReachable: false, wsExpected, expectedChains: [], observedChains: [], perChain: [], services: classifyServices(deps, now, false, null) };
    }
  }

  try {
    const [snapRaws, rtRaws] = await Promise.all([
      redis.mget(...chains.map(deps.snapshotKey)),
      redis.mget(...chains.map(deps.runtimeKey)),
    ]);

    const perChain:       PerChainHealth[] = [];
    const observedChains: string[]         = [];

    for (let i = 0; i < chains.length; i++) {
      const c = chains[i];
      const { ageSec, hadKey: hasSnap } = snapshotAge(snapRaws[i] ?? null, now);

      let wsrt: WsRuntimeEntry | null = null;
      const rtRaw = rtRaws[i];
      if (rtRaw != null) {
        try {
          const parsed = JSON.parse(rtRaw) as WsRuntimeRaw;
          wsrt = deps.resolveWsRuntime(parsed, c, now, { maxAgeMs: deps.runtimeMaxAgeMs, futureSkewMs: deps.futureSkewMs, normalizeChain: deps.normalizeChain });
        } catch { wsrt = null; }
      }
      const hasRt = wsrt !== null;

      const staleKinds = wsrt?.subs ? deps.classifyWsSubs(wsrt.subs, { staleSec: deps.wsStaleSec }).suspectedStaleKinds : [];
      const view: WsRuntimeView = {
        present:             hasRt,
        wsConnected:         wsrt?.wsConnected ?? false,
        lastPongAgeSec:      wsrt?.lastPongAgeSec ?? null,
        suspectedStaleKinds: staleKinds,
      };
      const ws = deriveWsState(view, wsExpected);

      const observed = hasSnap || hasRt;
      if (observed) observedChains.push(c);

      perChain.push({
        chain:          c,
        expected:       true,
        observed,
        snapshotAgeSec: ageSec,
        wsState:        ws.state,
        wsStaleKinds:   ws.staleKinds,
      });
    }

    return { redisReachable: true, wsExpected, expectedChains: chains, observedChains, perChain, services: await readServiceHeartbeats(redis, deps, now) };
  } catch {
    // Orice eroare Redis → fail-closed: inaccesibil → down/503.
    return { redisReachable: false, wsExpected, expectedChains: chains, observedChains: [], perChain: [], services: classifyServices(deps, now, false, null) };
  }
}
