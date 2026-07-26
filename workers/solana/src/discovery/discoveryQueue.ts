/**
 * discovery/discoveryQueue.ts — C6: coadă persistentă de discovery (Solana), tranziții ATOMICE (Lua).
 *
 * Problema (F5/#6): cursorul avansa la simpla OBSERVARE a log-ului WS, înainte de fetch/parse/write.
 * Un candidat (CreatePool / pumpfun Create) al cărui fetch/parse/write pică (RPC error, crash) era
 * ARUNCAT — pool pierdut permanent, fără retry, iar health raporta „OK" (cursor deja avansat).
 * Coada face candidatul DURABIL: enqueue ÎNAINTE de fire-and-forget → ack DOAR la scriere reușită →
 * retry cu backoff la eroare → dead-letter TERMINAL după MAX. Un pool observat nu se mai pierde.
 *
 * Stări PENDING → PROCESSING → OK (per chain):
 *   preflight:indexer:disc:pending:{chain}     ZSET  score = eligibleAt (ms)
 *   preflight:indexer:disc:processing:{chain}  ZSET  score = leaseUntil (ms)
 *   preflight:indexer:disc:attempts:{chain}    HASH  field = member, val = nr. încercări
 *   preflight:indexer:disc:dead:{chain}        ZSET  score = diedAt (ms)  [TERMINAL]
 *
 * Fiecare TRANZIȚIE e un singur EVAL Lua → CRASH-ATOMICĂ (doctrina C2 runda 3: ZREM+ZADD în două
 * apeluri NU e crash-atomic → un crash la mijloc ar pierde itemul). Membrul e SELF-CONTAINED
 * (`program|slot|signature`) → dispatch-ul nu are nevoie de un GET separat (fără problema GET-error
 * vs GET-null din C2).
 */

import type Redis from "ioredis";

// ── Program candidate (self-contained în member) ────────────────────────────────

export type DiscoveryProgram = "raydium_cpmm" | "raydium_clmm" | "raydium_amm_v4" | "pumpfun";

export interface DiscoveryCandidate {
  program:   DiscoveryProgram;
  slot:      number;
  signature: string;
}

/**
 * Encode member = `program|slot|signature`. Signature e base58 (fără `|`), program/slot n-au `|`
 * → delimitatorul e sigur, iar membrul e reversibil fără storage lateral.
 */
export function encodeCandidate(c: DiscoveryCandidate): string {
  return `${c.program}|${c.slot}|${c.signature}`;
}

/** Decode member → candidat. Întoarce null la format invalid (defensiv, nu aruncă). */
export function decodeCandidate(member: string): DiscoveryCandidate | null {
  const i1 = member.indexOf("|");
  if (i1 <= 0) return null;
  const i2 = member.indexOf("|", i1 + 1);
  if (i2 <= i1 + 1) return null;
  const program   = member.slice(0, i1);
  const slotStr   = member.slice(i1 + 1, i2);
  const signature = member.slice(i2 + 1);
  if (!signature) return null;
  if (program !== "raydium_cpmm" && program !== "raydium_clmm" && program !== "raydium_amm_v4" && program !== "pumpfun") return null;
  if (!/^\d+$/.test(slotStr)) return null;
  const slot = Number(slotStr);
  if (!Number.isSafeInteger(slot) || slot < 0) return null;
  return { program, slot, signature };
}

// ── Config (env-overridable, cu default-uri) ────────────────────────────────────

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  // strict: doar cifre + > 0 (evită "4abc"→4 și 0 — un 0 pe concurrency/batch/interval/lease
  // ar bloca drenajul: revendică itemi dar pornește zero workeri / lease instant-expirat).
  if (!/^\d+$/.test(raw)) return def;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : def;
}

export const DISC_MAX_ATTEMPTS    = intEnv("SOLANA_DISC_MAX_ATTEMPTS", 5);
export const DISC_BACKOFF_BASE_MS = intEnv("SOLANA_DISC_BACKOFF_BASE_MS", 5_000);
export const DISC_BACKOFF_MAX_MS  = intEnv("SOLANA_DISC_BACKOFF_MAX_MS", 300_000);
export const DISC_LEASE_MS        = intEnv("SOLANA_DISC_LEASE_MS", 180_000); // > durata unui fetch+write (headroom)
export const DISC_DRAIN_BATCH     = intEnv("SOLANA_DISC_DRAIN_BATCH", 20);
export const DISC_DRAIN_CONCURRENCY = intEnv("SOLANA_DISC_DRAIN_CONCURRENCY", 4);
export const DISC_DRAIN_INTERVAL_MS = intEnv("SOLANA_DISC_DRAIN_INTERVAL_MS", 5_000);

function pendingKey(chain: string):    string { return `preflight:indexer:disc:pending:${chain}`; }
function processingKey(chain: string): string { return `preflight:indexer:disc:processing:${chain}`; }
function attemptsKey(chain: string):   string { return `preflight:indexer:disc:attempts:${chain}`; }
function deadKey(chain: string):       string { return `preflight:indexer:disc:dead:${chain}`; }
/** NF3/D4c: quarantine durabil pt. orice candidat de discovery cu layout necunoscut (pump.fun create nou SAU
 *  AMM V4 Initialize2 cu layout schimbat — posibilă variantă reală, nu o arunca). Generic peste programe. HASH:
 *  field = `program|slot|signature` (NU doar signature — aceeași tx poate invoca DOUĂ programe urmărite, ex.
 *  pumpfun + raydium_amm_v4; keyed doar pe signature, a doua o suprascrie pe prima = pierdere de dovadă),
 *  value = JSON {program, slot, accountCounts, detectedAt}. NON-degrading (nu atinge health). */
function unsupportedKey(chain: string): string { return `preflight:indexer:disc:unsupported:${chain}`; }

/** Backoff exponential cu cap (PUR, testabil). Aceeași formulă e replicată în LUA_FAILED. */
export function nextBackoffMs(attempts: number, base: number, max: number): number {
  const exp = base * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(exp, max);
}

// ── NF3: politica de coadă (PURĂ, testabilă) ─────────────────────────────────────
// Rezultatul procesării unui candidat → acțiunea pe coada durabilă. Separat de I/O ca să aibă regression
// protection (partea cea mai importantă a NF3 e ce se întâmplă cu coada, nu doar ce întoarce fetcher-ul).

export type CandidateOutcome =
  | { kind: "written" }
  | { kind: "retry" }
  | { kind: "invalid" }
  | { kind: "unsupported"; accountCounts: number[]; reason: string };

/** Ce facem pe coadă pt. fiecare outcome. `ack`=scoate; `ack_advance`=scoate+avansează processedSlot;
 *  `fail`=markFailed (backoff→dead pe MAX); `quarantine_ack`=scrie în quarantine + scoate. */
export type QueueAction = "ack" | "ack_advance" | "fail" | "quarantine_ack";

export function queueActionFor(o: CandidateOutcome): QueueAction {
  switch (o.kind) {
    case "written":     return "ack_advance"; // record durabil scris → avansează cursorul
    case "retry":       return "fail";        // tranzitoriu (RPC/scriere) → backoff → dead pe MAX
    case "invalid":     return "ack";         // sigur nu-i o creare → scoate din coadă (nu-i pierdere)
    case "unsupported": return "quarantine_ack"; // variantă necunoscută → păstrează dovada + scoate din coadă
  }
}

/** NF3 reconcile: ce facem cu un membru DEAD deja existent, după re-fetch. */
export type ReconcileAction = "requeue" | "drop" | "quarantine" | "leave";

export function reconcileActionFor(status: "ok" | "invalid" | "unsupported" | "unavailable"): ReconcileAction {
  switch (status) {
    case "ok":          return "requeue";    // e chiar o creare validă (fals dead-letter din vechiul null) → reprocesează
    case "invalid":     return "drop";       // sigur nu-i creare → scoate din dead (curăță health-ul)
    case "unsupported": return "quarantine"; // variantă nouă → mută în quarantine + scoate din dead
    case "unavailable": return "leave";      // RPC tot nu servește → lasă în dead (nu inventăm o decizie)
  }
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

/** -- requeue-dead (NF3 reconcile)  KEYS: dead, pending, processing, attempts  ARGV: member, eligibleAt
 *  → 1 dacă mutat din dead în pending, 0 dacă nu era în dead. ATOMIC (fără fereastra remove-apoi-enqueue). */
const LUA_REQUEUE_DEAD = `-- requeue-dead
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[4], ARGV[1])
if not redis.call('ZSCORE', KEYS[3], ARGV[1]) then
  redis.call('ZADD', KEYS[2], 'NX', ARGV[2], ARGV[1])
end
return 1`;

// ── API (thin wrappers peste EVAL) ──────────────────────────────────────────────

/** Adaugă candidatul în coadă dacă NU e deja acolo / în procesare / dead-letter (atomic). true dacă adăugat. */
export async function enqueueCandidate(
  r: Redis, chain: string, candidate: DiscoveryCandidate, eligibleAtMs: number = Date.now(),
): Promise<boolean> {
  const member = encodeCandidate(candidate);
  const res = await r.eval(LUA_ENQUEUE, 3, pendingKey(chain), processingKey(chain), deadKey(chain), String(eligibleAtMs), member);
  return Number(res) === 1;
}

/** Claim ATOMIC: mută până la `limit` due din pending → processing cu lease. Întoarce membrii revendicați. */
export async function claimDueCandidates(
  r: Redis, chain: string, now: number, leaseMs: number, limit: number,
): Promise<string[]> {
  const res = await r.eval(LUA_CLAIM, 2, pendingKey(chain), processingKey(chain), String(now), String(now + leaseMs), String(limit));
  return (res as string[]) ?? [];
}

/** Recuperare crash: lease-uri expirate din processing → pending (atomic). Întoarce nr. recuperate. */
export async function reclaimExpiredCandidates(r: Redis, chain: string, now: number): Promise<number> {
  const res = await r.eval(LUA_RECLAIM, 2, processingKey(chain), pendingKey(chain), String(now));
  return Number(res) || 0;
}

/** Succes: scoate din processing + resetează attempts (atomic). */
export async function markCandidateDone(r: Redis, chain: string, member: string): Promise<void> {
  await r.eval(LUA_DONE, 2, processingKey(chain), attemptsKey(chain), member);
}

/**
 * Eșec (atomic): scoate din processing; incrementează attempts; dead-letter TERMINAL la MAX
 * (scos din pending+processing, mutat în dead) SAU reprogramare în pending cu backoff. → "dead"|"retry".
 */
export async function markCandidateFailed(
  r: Redis, chain: string, member: string, now: number = Date.now(),
): Promise<"dead" | "retry"> {
  const res = await r.eval(
    LUA_FAILED, 4,
    processingKey(chain), pendingKey(chain), attemptsKey(chain), deadKey(chain),
    member, String(DISC_MAX_ATTEMPTS), String(now),
    String(DISC_BACKOFF_BASE_MS), String(DISC_BACKOFF_MAX_MS),
  );
  return res === "dead" ? "dead" : "retry";
}

// ── NF3: quarantine + primitive dead-set (pt. reconcile) ─────────────────────────

/** Scrie un candidat cu layout necunoscut în quarantine durabil (HASH field = `program|slot|signature`,
 *  ca DOUĂ programe pe aceeași tx să NU se suprascrie). Idempotent. */
export async function quarantineUnsupported(
  r: Redis, chain: string, candidate: DiscoveryCandidate, accountCounts: number[], reason: string, now: number = Date.now(),
): Promise<void> {
  const payload = JSON.stringify({
    program:      candidate.program,
    slot:         candidate.slot,
    signature:    candidate.signature,
    accountCounts,
    reason,
    detectedAt:   new Date(now).toISOString(),
  });
  await r.hset(unsupportedKey(chain), encodeCandidate(candidate), payload);
}

export async function quarantineCount(r: Redis, chain: string): Promise<number> {
  return r.hlen(unsupportedKey(chain));
}

/** Toți membrii din dead-set (pt. reconcile one-time). */
export async function readDeadMembers(r: Redis, chain: string): Promise<string[]> {
  return (await r.zrange(deadKey(chain), 0, -1)) as string[];
}

/** Scoate un membru din dead-set (reconcile: drop / după quarantine). Single ZREM = atomic. */
export async function removeFromDead(r: Redis, chain: string, member: string): Promise<void> {
  await r.zrem(deadKey(chain), member);
}

/**
 * NF3 reconcile ATOMIC: mută un membru din dead → pending (scoate din dead, curăță attempts, adaugă în pending
 * dacă nu-i deja în processing). Un singur EVAL → fără fereastra „scos din dead, dar necrash-uit în pending"
 * (remove+enqueue în două apeluri ar pierde membrul la crash între ele). Idempotent: a doua oară → 0 (nu-i în dead).
 */
export async function requeueDeadCandidate(
  r: Redis, chain: string, member: string, eligibleAtMs: number = Date.now(),
): Promise<boolean> {
  const res = await r.eval(
    LUA_REQUEUE_DEAD, 4,
    deadKey(chain), pendingKey(chain), processingKey(chain), attemptsKey(chain),
    member, String(eligibleAtMs),
  );
  return Number(res) === 1;
}

export async function pendingCandidateCount(r: Redis, chain: string): Promise<number> {
  return r.zcard(pendingKey(chain));
}
export async function processingCandidateCount(r: Redis, chain: string): Promise<number> {
  return r.zcard(processingKey(chain));
}
export async function deadCandidateCount(r: Redis, chain: string): Promise<number> {
  return r.zcard(deadKey(chain));
}

/**
 * Snapshot pentru health: numărul de itemi în fiecare stare + vârsta celui mai vechi pending
 * (eligibleAt cel mai mic). `oldestPendingAgeMs` = null dacă pending e gol. Un backlog cu pending
 * vechi = drain-ul nu ține pasul / e blocat → semnal onest de degradare.
 */
export async function discoveryQueueStats(
  r: Redis, chain: string, now: number = Date.now(),
): Promise<{ pending: number; processing: number; dead: number; oldestPendingAgeMs: number | null }> {
  const [pending, processing, dead, oldest] = await Promise.all([
    r.zcard(pendingKey(chain)),
    r.zcard(processingKey(chain)),
    r.zcard(deadKey(chain)),
    r.zrange(pendingKey(chain), 0, 0, "WITHSCORES"),
  ]);
  let oldestPendingAgeMs: number | null = null;
  if (oldest.length >= 2) {
    const score = Number(oldest[1]);
    if (Number.isFinite(score)) oldestPendingAgeMs = Math.max(0, now - score);
  }
  return { pending, processing, dead, oldestPendingAgeMs };
}
