/**
 * discovery/enrichQueue.ts — P1-5: coadă persistentă de re-enrichment metadata (Solana), Lua ATOMIC.
 *
 * PROBLEMA (varu, production-readiness): enrichment-ul metadata (symbol/decimals din Jupiter) rula
 * fire-and-forget:
 *   - pool-uri (`writeDiscoveredPool`): `Promise.all([resolveTokenMeta×2]).then(enrich).catch(log)` — ZERO
 *     retry. Jupiter jos / 429 / token neindexat încă → pool fără symbol PE VECI.
 *   - launch-uri (`enrichLaunchRecord`): 3 încercări ÎN MEMORIE (30s/2m/10m) apoi FAILED — un crash le
 *     pierde; după FAILED nu se mai reîncearcă niciodată, deși tokenul poate apărea pe Jupiter ore mai
 *     târziu.
 *
 * FIX: coadă DURABILĂ (inspirată din C2 al indexer-evm) — la insert, recordul e enqueue-uit; un scanner
 * background reîncearcă cu backoff până reușește SAU până recordul e prea vechi (terminal). Supraviețuiește
 * crash-urilor (reclaim lease expirat) și redeploy-urilor.
 *
 * ⚠️ DURABILITATE DUPĂ ACK (fix review cgpt R1): enqueue-ul NU e fire-and-forget separat — e făcut ÎN
 *    `writeSolanaPool`/`writeLaunchRecord`, AWAITED, pe „inserted" ȘI pe „exists" (idempotent NX). Dacă
 *    enqueue-ul pică, writer-ul întoarce "error" → drain-ul de discovery NU face ACK → candidatul e
 *    reîncercat (insert-ul e idempotent). Astfel o redelivery pe „exists" (dintr-un crash pre-enqueue) tot
 *    enqueue-uiește. Acoperă ȘI backfill-ul (același write path).
 *
 * Stări PENDING → PROCESSING → (terminal pe RECORD: ENRICHED/FAILED):
 *   preflight:indexer:enrich:pending:{chain}     ZSET  score = eligibleAt (ms)
 *   preflight:indexer:enrich:processing:{chain}  ZSET  score = leaseUntil (ms)
 *   preflight:indexer:enrich:attempts:{chain}    HASH  field = member, val = nr. încercări (pt. backoff)
 *
 * ⚠️ FĂRĂ set `dead` (fix review cgpt R1): terminalul REAL = status FAILED scris PE RECORD (age >= 24h din
 *    discoveredAt), scris ÎNAINTE ca jobul să fie scos din coadă (markEnrichDone). Un job iese din coadă
 *    DOAR după o scriere terminală confirmată (ENRICHED/FAILED) sau dacă recordul a dispărut — niciodată pe
 *    o scriere eșuată. Un `dead`-set separat (ca la EVM) ar bloca re-enqueue-ul (LUA_ENQUEUE îl respinge) și
 *    ar putea lăsa recordul veșnic PENDING dacă scrierea FAILED pică după dead-letter → eliminat aici.
 *
 * DIFERENȚE față de coada EVM (intenționate):
 *   1. Membru KIND-TAGGED `pool|<poolAddress>` / `launch|<mint>` — o singură coadă pt. ambele tipuri.
 *   2. Base58 CASE-PĂSTRAT — adresele Solana sunt case-sensitive; un `.toLowerCase()` ar corupe adresa.
 *   3. Fără dead-set; terminal = status pe record (vezi mai sus).
 *
 * Fiecare TRANZIȚIE e un singur EVAL Lua → CRASH-ATOMICĂ (Redis nu lasă alt client la mijloc).
 */

import type Redis from "ioredis";

// ── Config (env-overridable, cu default-uri) ────────────────────────────────────

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  if (!/^\d+$/.test(raw)) return def;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : def;
}

/** Cadența de retry (backoff exponential plafonat). Un token neindexat încă pe Jupiter → reîncercăm rar. */
export const ENRICH_BACKOFF_BASE_MS = intEnv("SOLANA_ENRICH_BACKOFF_BASE_MS", 300_000);   // 5 min
export const ENRICH_BACKOFF_MAX_MS  = intEnv("SOLANA_ENRICH_BACKOFF_MAX_MS", 3_600_000);  // 1 h
export const ENRICH_LEASE_MS        = intEnv("SOLANA_ENRICH_LEASE_MS", 120_000);           // > durata unui enrich
/** Întârziere inițială înainte de PRIMA încercare — tokenii proaspăt lansați apar pe Jupiter după ~1min. */
export const ENRICH_INITIAL_DELAY_MS = intEnv("SOLANA_ENRICH_INITIAL_DELAY_MS", 30_000);   // 30s
/** Vârsta după care renunțăm (terminal FAILED). Decisă din record.discoveredAt (vezi enrichAgeVerdict). */
export const ENRICH_MAX_AGE_MS      = intEnv("SOLANA_ENRICH_MAX_AGE_MS", 24 * 60 * 60_000); // 24h

// ── Scanner / drain tuning ───────────────────────────────────────────────────────
export const ENRICH_DRAIN_BATCH       = intEnv("SOLANA_ENRICH_DRAIN_BATCH", 20);
export const ENRICH_DRAIN_CONCURRENCY = intEnv("SOLANA_ENRICH_DRAIN_CONCURRENCY", 4);
export const ENRICH_DRAIN_INTERVAL_MS = intEnv("SOLANA_ENRICH_DRAIN_INTERVAL_MS", 15_000);

function pendingKey(chain: string):    string { return `preflight:indexer:enrich:pending:${chain}`; }
function processingKey(chain: string): string { return `preflight:indexer:enrich:processing:${chain}`; }
function attemptsKey(chain: string):   string { return `preflight:indexer:enrich:attempts:${chain}`; }

// ── Membru kind-tagged + verdict de vârstă (PURE, testabile) ──────────────────────

export type EnrichKind = "pool" | "launch";

/** Rezultatul UNEI încercări de enrichment (întors de enrichPoolOnce / enrichLaunchOnce). */
export type EnrichOutcome =
  | "enriched"   // ENRICHED scris CU SUCCES → scoate din coadă (markEnrichDone)
  | "failed"     // prea vechi → FAILED scris CU SUCCES (terminal) → scoate din coadă
  | "retry"      // Jupiter încă nu știe tokenul (dar nu-i prea vechi) SAU o scriere a eșuat → reprogramează
  | "gone";      // recordul a dispărut / e corupt în Redis → scoate din coadă (nu mai are rost)

/** Encode `kind|id`. Base58 (Solana) n-are `|`; NU lowercase (case-sensitive). */
export function encodeEnrichMember(kind: EnrichKind, id: string): string {
  return `${kind}|${id}`;
}

/** Decode member → {kind, id}. null la format invalid (defensiv, nu aruncă). */
export function decodeEnrichMember(member: string): { kind: EnrichKind; id: string } | null {
  const i = member.indexOf("|");
  if (i <= 0) return null;
  const kind = member.slice(0, i);
  const id   = member.slice(i + 1);
  if (kind !== "pool" && kind !== "launch") return null;
  if (!id) return null;
  return { kind, id };
}

/** Backoff exponential cu cap (PUR, testabil). Aceeași formulă e replicată în LUA_RESCHEDULE. */
export function nextBackoffMs(attempts: number, base: number, max: number): number {
  const exp = base * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(exp, max);
}

/**
 * PUR: pe baza `discoveredAt` (ISO), decide dacă un record neenrichuit a depășit fereastra de retry.
 *   "terminal"      → prea vechi (age >= maxAgeMs) SAU discoveredAt neparseabil (nu putem aștepta la infinit).
 *   "within_window" → încă în fereastră (inclusiv un discoveredAt ușor în viitor — se rezolvă pe măsură ce
 *                     ceasul avansează). Boundary EXACT: age == maxAgeMs → terminal (>=).
 */
export function enrichAgeVerdict(
  discoveredAt: string, nowMs: number, maxAgeMs: number,
): "terminal" | "within_window" {
  const age = nowMs - Date.parse(discoveredAt);
  if (!Number.isFinite(age)) return "terminal"; // discoveredAt corupt → nu-l ținem veșnic PENDING
  return age >= maxAgeMs ? "terminal" : "within_window";
}

// ── Scripturi Lua (fiecare tranziție = 1 EVAL atomic) ───────────────────────────

/** -- enqueue  KEYS: pending, processing  ARGV: score, member → 1 dacă adăugat, 0 altfel (deja pending/processing) */
const LUA_ENQUEUE = `-- enqueue
if redis.call('ZSCORE', KEYS[2], ARGV[2]) then return 0 end
return redis.call('ZADD', KEYS[1], 'NX', ARGV[1], ARGV[2])`;

/** -- claim  KEYS: pending, processing  ARGV: now, leaseUntil, limit → listă membri revendicați */
const LUA_CLAIM = `-- claim
local items = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[3])
for _, m in ipairs(items) do
  redis.call('ZREM', KEYS[1], m)
  redis.call('ZADD', KEYS[2], ARGV[2], m)
end
return items`;

/** -- reclaim  KEYS: processing, pending  ARGV: now → nr. recuperate (lease expirat → pending) */
const LUA_RECLAIM = `-- reclaim
local items = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, m in ipairs(items) do
  redis.call('ZREM', KEYS[1], m)
  redis.call('ZADD', KEYS[2], 'NX', ARGV[1], m)
end
return #items`;

/** -- done  KEYS: processing, attempts  ARGV: member → 1. Scoate din coadă + resetează attempts. */
const LUA_DONE = `-- done
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1`;

/**
 * -- reschedule  KEYS: processing, pending, attempts  ARGV: member, now, base, maxBackoff → nr. încercări (n)
 * Scoate din processing, incrementează attempts, reprogramează în pending cu backoff. NU dead-letter:
 * jobul rămâne MEREU în coadă (pending) până la o scriere terminală confirmată (markEnrichDone).
 */
const LUA_RESCHEDULE = `-- reschedule
redis.call('ZREM', KEYS[1], ARGV[1])
local n = redis.call('HINCRBY', KEYS[3], ARGV[1], 1)
local backoff = tonumber(ARGV[3]) * (2 ^ (n - 1))
local maxb = tonumber(ARGV[4])
if backoff > maxb then backoff = maxb end
redis.call('ZADD', KEYS[2], tonumber(ARGV[2]) + backoff, ARGV[1])
return n`;

// ── API (thin wrappers peste EVAL) ──────────────────────────────────────────────

/** Adaugă `kind|id` în coadă dacă NU e deja în pending/processing (atomic). true dacă adăugat.
 *  Base58 NU e lowercased (case-sensitive). */
export async function enqueueEnrich(
  r: Redis, chain: string, kind: EnrichKind, id: string, eligibleAtMs: number = Date.now(),
): Promise<boolean> {
  const member = encodeEnrichMember(kind, id);
  const res = await r.eval(LUA_ENQUEUE, 2, pendingKey(chain), processingKey(chain), String(eligibleAtMs), member);
  return Number(res) === 1;
}

/** Claim ATOMIC: mută până la `limit` due din pending → processing cu lease. Întoarce membrii revendicați. */
export async function claimDueEnrich(
  r: Redis, chain: string, now: number, leaseMs: number, limit: number,
): Promise<string[]> {
  const res = await r.eval(LUA_CLAIM, 2, pendingKey(chain), processingKey(chain), String(now), String(now + leaseMs), String(limit));
  return (res as string[]) ?? [];
}

/** Recuperare crash: lease-uri expirate din processing → pending (atomic). Întoarce nr. recuperate. */
export async function reclaimExpiredEnrich(r: Redis, chain: string, now: number): Promise<number> {
  const res = await r.eval(LUA_RECLAIM, 2, processingKey(chain), pendingKey(chain), String(now));
  return Number(res) || 0;
}

/** Terminal CONFIRMAT (enriched/failed) sau record dispărut: scoate din coadă + resetează attempts. */
export async function markEnrichDone(r: Redis, chain: string, member: string): Promise<void> {
  await r.eval(LUA_DONE, 2, processingKey(chain), attemptsKey(chain), member);
}

/**
 * Încercare eșuată (token încă neindexat, sau scriere ratată): reprogramează în pending cu backoff.
 * NU scoate niciodată din coadă — jobul iese doar prin markEnrichDone (după terminal confirmat). → nr. încercări.
 */
export async function markEnrichReschedule(
  r: Redis, chain: string, member: string, now: number = Date.now(),
): Promise<number> {
  const res = await r.eval(
    LUA_RESCHEDULE, 3,
    processingKey(chain), pendingKey(chain), attemptsKey(chain),
    member, String(now), String(ENRICH_BACKOFF_BASE_MS), String(ENRICH_BACKOFF_MAX_MS),
  );
  return Number(res) || 0;
}

// ── Stats (pt. logging/health) ────────────────────────────────────────────────────

export async function pendingEnrichCount(r: Redis, chain: string): Promise<number> {
  return r.zcard(pendingKey(chain));
}
export async function processingEnrichCount(r: Redis, chain: string): Promise<number> {
  return r.zcard(processingKey(chain));
}

/** Snapshot compact pentru logStats. */
export async function enrichQueueStats(
  r: Redis, chain: string,
): Promise<{ pending: number; processing: number }> {
  const [pending, processing] = await Promise.all([
    r.zcard(pendingKey(chain)),
    r.zcard(processingKey(chain)),
  ]);
  return { pending, processing };
}
