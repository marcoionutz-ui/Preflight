/**
 * discovery/registryWrite.ts — C1: scrieri de registry ATOMICE pentru indexer-solana.
 *
 * (1) `insertRecordAndIndex` — SET NX blob + 2×ZADD într-un SINGUR EVAL Lua. Înainte era SET NX +
 *     `pipeline(ZADD, ZADD)`; pipeline-ul NU e atomic (comenzile rulează secvențial, alt client se
 *     poate intercala, iar o eroare la mijloc lasă stare parțială) → record în registry dar INVIZIBIL
 *     în ZSET (root-cause #3/#7/#11). Acum: totul-sau-nimic. Idempotent pe replay (SET NX).
 *
 * (2) `casUpdateJson` — read-modify-write ATOMIC prin compare-and-swap Lua pe valoarea EXACTĂ a
 *     blob-ului. Înlocuiește GET→modify→SET neatomic (linkLaunchToPool + enrichLaunchRecord se puteau
 *     suprascrie reciproc). Merge-ul rămâne în JS (fără `cjson` → fără riscul array-gol→obiect pe
 *     schema complexă a launch-ului). Re-încearcă la conflict (blob schimbat între GET și CAS).
 */

import type Redis from "ioredis";

/**
 * -- insert+index  KEYS: jsonKey, zsetA, zsetB  ARGV: blob, member, scoreA, scoreB → 1 inserat / 0 există
 *
 * ATOMIC „totul-sau-nimic" REAL: un script Lua e atomic (alți clienți nu se intercalează) dar Redis NU
 * face ROLLBACK dacă o comandă ulterioară dă runtime error — un `SET` reușit urmat de un `ZADD` care
 * aruncă (ex. ZSET-ul e din greșeală un STRING → WRONGTYPE) ar lăsa blob-ul scris FĂRĂ index (exact
 * starea parțială pe care C1 o elimină). Fix (review varu): VALIDĂM tot ce poate eșua ÎNAINTE de primul
 * write — scoruri finite + tipul cheilor ZSET (none|zset). EXISTS+SET înlocuiește SET NX (în script
 * nimeni nu se intercalează între EXISTS și SET, deci e echivalent, dar ne lasă să validăm întâi).
 */
const LUA_INSERT_INDEXED = `-- insert+index (validate-before-write)
local scoreA = tonumber(ARGV[3])
local scoreB = tonumber(ARGV[4])
if not scoreA or scoreA ~= scoreA or scoreA == math.huge or scoreA == -math.huge then
  return redis.error_reply('ERR invalid scoreA')
end
if not scoreB or scoreB ~= scoreB or scoreB == math.huge or scoreB == -math.huge then
  return redis.error_reply('ERR invalid scoreB')
end
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local typeA = redis.call('TYPE', KEYS[2]).ok
local typeB = redis.call('TYPE', KEYS[3]).ok
if typeA ~= 'none' and typeA ~= 'zset' then return redis.error_reply('WRONGTYPE zsetA') end
if typeB ~= 'none' and typeB ~= 'zset' then return redis.error_reply('WRONGTYPE zsetB') end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], scoreA, ARGV[2])
redis.call('ZADD', KEYS[3], scoreB, ARGV[2])
return 1`;

/** -- cas  KEYS: key  ARGV: expectedBlob, newBlob → 1 dacă valoarea era exact expectedBlob (și a scris) / 0 */
const LUA_CAS = `-- cas
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0`;

/**
 * Insert ATOMIC: SET NX blob + ZADD în două ZSET-uri (index poziție + index timp). true = inserat nou,
 * false = exista deja (SET NX a picat → ZADD-urile NU rulează).
 */
export async function insertRecordAndIndex(
  r: Redis,
  args: {
    jsonKey: string; blob: string; member: string;
    zsetA: string; scoreA: number;
    zsetB: string; scoreB: number;
  },
): Promise<boolean> {
  const res = await r.eval(
    LUA_INSERT_INDEXED, 3,
    args.jsonKey, args.zsetA, args.zsetB,
    args.blob, args.member, String(args.scoreA), String(args.scoreB),
  );
  return Number(res) === 1;
}

export type CasResult = "ok" | "noop" | "absent" | "corrupt" | "conflict";

/**
 * Read-modify-write ATOMIC prin CAS pe blob. `mutate` primește obiectul curent și întoarce noul obiect
 * de scris, sau `null` pentru no-op idempotent. Re-încearcă la conflict (blob schimbat între GET și
 * CAS) până la `maxRetries` — fiecare retry re-citește starea proaspătă și re-aplică mutația, deci
 * două update-uri concurente pe câmpuri diferite se MERGE-uiesc, nu se pierd.
 *   "ok"       — scris efectiv
 *   "noop"     — mutate a întors null (skip idempotent — nimic de scris)
 *   "absent"   — cheia nu există (record dispărut)
 *   "corrupt"  — JSON invalid în Redis
 *   "conflict" — prea multe conflicte consecutive (foarte improbabil la frecvența launch-urilor)
 */
export async function casUpdateJson<T>(
  r: Redis, key: string,
  mutate: (current: T) => T | null,
  maxRetries = 5,
): Promise<CasResult> {
  for (let i = 0; i < maxRetries; i++) {
    const raw = await r.get(key);
    if (raw === null) return "absent";
    let current: T;
    try { current = JSON.parse(raw) as T; } catch { return "corrupt"; }
    const next = mutate(current);
    if (next === null) return "noop"; // idempotent skip — nimic de scris
    const res = await r.eval(LUA_CAS, 1, key, raw, JSON.stringify(next));
    if (Number(res) === 1) return "ok";
    // res === 0 → blob schimbat între GET și CAS → re-citește și re-aplică
  }
  return "conflict";
}
