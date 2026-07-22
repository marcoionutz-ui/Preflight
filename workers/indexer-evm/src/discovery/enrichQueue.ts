/**
 * discovery/enrichQueue.ts — C2: coadă persistentă de enrichment (EVM), tranziții ATOMICE (Lua).
 *
 * Problema (H7/#4): la limita de concurență, enrichment-ul era logat și ARUNCAT → pereche descoperită
 * dar neenrichuită nu era servită niciodată (priceStatus != OK) → permanent necitită. Coada AMÂNĂ.
 *
 * Stări PENDING → PROCESSING → OK (per chain):
 *   preflight:indexer:enrich:pending:{chain}     ZSET  score = eligibleAt (ms)
 *   preflight:indexer:enrich:processing:{chain}  ZSET  score = leaseUntil (ms)
 *   preflight:indexer:enrich:attempts:{chain}    HASH  field = addr, val = nr. încercări
 *   preflight:indexer:enrich:dead:{chain}        ZSET  score = diedAt (ms)  [TERMINAL]
 *
 * Fiecare TRANZIȚIE e un singur EVAL Lua → CRASH-ATOMICĂ (Redis nu lasă alt client la mijloc).
 * Astfel un crash între „scos din pending" și „pus în processing" nu poate exista (fix review C2 runda 3).
 * Multi-replică: la fel sigur (scriptul rulează izolat). Succesul e semnalat EXPLICIT de enrichment.
 */

import type Redis from "ioredis";
import { intEnv } from "../config/env";

export const ENRICH_MAX_ATTEMPTS    = intEnv("INDEXER_ENRICH_MAX_ATTEMPTS", 5);
export const ENRICH_BACKOFF_BASE_MS = intEnv("INDEXER_ENRICH_BACKOFF_BASE_MS", 5_000);
export const ENRICH_BACKOFF_MAX_MS  = intEnv("INDEXER_ENRICH_BACKOFF_MAX_MS", 300_000);
export const ENRICH_LEASE_MS        = intEnv("INDEXER_ENRICH_LEASE_MS", 180_000); // > durata unui enrich (headroom)

function pendingKey(chain: string):    string { return `preflight:indexer:enrich:pending:${chain}`; }
function processingKey(chain: string): string { return `preflight:indexer:enrich:processing:${chain}`; }
function attemptsKey(chain: string):   string { return `preflight:indexer:enrich:attempts:${chain}`; }
function deadKey(chain: string):       string { return `preflight:indexer:enrich:dead:${chain}`; }

/** Backoff exponential cu cap (PUR, testabil). Aceeași formulă e replicată în LUA_FAILED. */
export function nextBackoffMs(attempts: number, base: number, max: number): number {
  const exp = base * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(exp, max);
}

// ── Scripturi Lua (fiecare tranziție = 1 EVAL atomic) ───────────────────────────

/** -- enqueue  KEYS: pending, processing, dead  ARGV: score, member → 1 dacă adăugat, 0 altfel */
const LUA_ENQUEUE = `-- enqueue
if redis.call('ZSCORE', KEYS[3], ARGV[2]) then return 0 end
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

/** -- done  KEYS: processing, attempts  ARGV: member → 1 */
const LUA_DONE = `-- done
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1`;

/** -- failed  KEYS: processing, pending, attempts, dead  ARGV: member, max, now, base, maxBackoff → 'dead'|'retry' */
const LUA_FAILED = `-- failed
redis.call('ZREM', KEYS[1], ARGV[1])
local n = redis.call('HINCRBY', KEYS[3], ARGV[1], 1)
if n >= tonumber(ARGV[2]) then
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('HDEL', KEYS[3], ARGV[1])
  redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
  return 'dead'
end
local backoff = tonumber(ARGV[4]) * (2 ^ (n - 1))
local maxb = tonumber(ARGV[5])
if backoff > maxb then backoff = maxb end
redis.call('ZADD', KEYS[2], tonumber(ARGV[3]) + backoff, ARGV[1])
return 'retry'`;

// ── API (thin wrappers peste EVAL) ──────────────────────────────────────────────

/** Adaugă în coadă dacă NU e deja acolo / în procesare / dead-letter (atomic). true dacă adăugat. */
export async function enqueueEnrich(
  r: Redis, chain: string, addr: string, eligibleAtMs: number = Date.now(),
): Promise<boolean> {
  const a = addr.toLowerCase();
  const res = await r.eval(LUA_ENQUEUE, 3, pendingKey(chain), processingKey(chain), deadKey(chain), String(eligibleAtMs), a);
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

/** Succes: scoate din processing + resetează attempts (atomic). */
export async function markEnrichDone(r: Redis, chain: string, addr: string): Promise<void> {
  await r.eval(LUA_DONE, 2, processingKey(chain), attemptsKey(chain), addr.toLowerCase());
}

/**
 * Eșec (atomic): scoate din processing; incrementează attempts; dead-letter TERMINAL la MAX
 * (scos din pending+processing, mutat în dead) SAU reprogramare în pending cu backoff. → "dead"|"retry".
 */
export async function markEnrichFailed(
  r: Redis, chain: string, addr: string, now: number = Date.now(),
): Promise<"dead" | "retry"> {
  const res = await r.eval(
    LUA_FAILED, 4,
    processingKey(chain), pendingKey(chain), attemptsKey(chain), deadKey(chain),
    addr.toLowerCase(), String(ENRICH_MAX_ATTEMPTS), String(now),
    String(ENRICH_BACKOFF_BASE_MS), String(ENRICH_BACKOFF_MAX_MS),
  );
  return res === "dead" ? "dead" : "retry";
}

/** Câte perechi în pending / processing (pt. logging/health). */
export async function pendingEnrichCount(r: Redis, chain: string): Promise<number> {
  return r.zcard(pendingKey(chain));
}
export async function processingEnrichCount(r: Redis, chain: string): Promise<number> {
  return r.zcard(processingKey(chain));
}
