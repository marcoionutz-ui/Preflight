/**
 * discovery/priceHistory.ts — E17 (ring buffer 60 taia history-ul sub 1h pe pool-urile hot).
 *
 * Bug: `recordPriceSnapshot` scria un punct in ring buffer la FIECARE swap (`lpush` + `ltrim 0,59`). Un pool
 * hot (multe swap-uri/minut) umplea toate 60 sloturile in cateva minute → cel mai vechi sample avea doar
 * cateva minute → `moversTracker` nu mai gasea niciun sample langa `now - 1h` (toleranta ±15m) → `priceChange1hPct`
 * era STRUCTURAL imposibil EXACT pe cele mai active pool-uri, iar `historyStatus` ramanea blocat pe `PARTIAL`
 * (oldest < 55m). Ironie de reporting: cu cat pool-ul e mai activ, cu atat history-ul lui e mai orb pe 1h.
 *
 * Fix (fara sa marim lista — pastram 60 sloturi): DOWNSAMPLE la scriere. Snapshot-ul live se actualizeaza pe
 * fiecare swap (pretul curent ramane proaspat), dar bufferul primeste un punct nou DOAR daca cel mai recent
 * are >= `minIntervalMs` (60s) vechime. Astfel 60 de puncte spatiate la >= 60s acopera ~1h → anchor-ul de 1h
 * (±15m) devine gasibil si oldest ajunge >= 55m (READY). Pool-urile lente (deja spatiate natural > 60s) nu sunt
 * afectate — downsampling-ul se declanseaza doar cand chiar sosesc swap-uri mai des de o data pe minut.
 *
 * Logica e PURA (fara Redis) → testabila izolat, inclusiv o simulare de 1h care dovedeste span-ul. Decizia
 * REALA din productie ruleaza ATOMIC in Lua (`APPEND_HISTORY_LUA`, mai jos) — helper-ele de aici sunt
 * oglinda semantica a scriptului (aceleasi reguli: gol/prag/viitor/corupt → append), pinuita de teste unit;
 * scriptul Lua e validat end-to-end de testul concurent (100 apeluri simultane → exact 1 punct).
 */

/**
 * Extrage `ts`-ul (ms) dintr-un raw de history point (`{p, ts}` serializat), SAFE:
 * `null` / JSON invalid / non-obiect / `ts` ne-numeric sau ne-finit → `null` (apelantul trateaza ca "buffer gol").
 */
export function parsePricePointTs(raw: string | null): number | null {
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const ts = (parsed as { ts?: unknown }).ts;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
}

/**
 * Decide daca scriem un punct NOU in ring buffer.
 *  - buffer gol (`newestTs === null`) → append (primul punct);
 *  - cel mai recent punct are >= `minIntervalMs` vechime → append (a trecut destul → punct util pt. span);
 *  - altfel → skip (prea devreme — ar comprima history-ul si ar orbi anchor-ul de 1h).
 *
 * Un `newestTs` din VIITOR (`now - newestTs < 0`, clock skew / valoare corupta) → append: nu ne blocam pe o
 * valoare in care nu avem incredere, iar noul punct real re-ancoreaza bufferul (dupa un LPUSH ajunge la index 0).
 */
export function shouldAppendPricePoint(
  newestTs:      number | null,
  now:           number,
  minIntervalMs: number,
): boolean {
  if (newestTs === null) return true;
  const age = now - newestTs;
  if (age < 0) return true;          // viitor / skew → nu te bloca
  return age >= minIntervalMs;
}

/**
 * E17 — gate + scriere ATOMICE in Redis. Blocker de concurenta (varu): un `LINDEX` urmat de un `LPUSH`
 * separat in JS lasa o fereastra in care doua swap-uri concurente citesc acelasi `newest` vechi, ambele trec
 * gate-ul si scriu → un pool hot re-comprima history-ul sub burst. Mutand decizia IN Redis (single-threaded,
 * fiecare EVAL atomic), primul swap face append, iar urmatoarele vad deja ts-ul nou si sar peste scriere.
 *
 * Oglindeste EXACT `parsePricePointTs` + `shouldAppendPricePoint`: newest absent / JSON invalid / `ts`
 * ne-numeric / `age < 0` (viitor) / `age >= minInterval` → append; altfel skip. `ZADD` (index de activitate)
 * ruleaza NECONDITIONAT (fiecare swap actualizeaza pozitia pool-ului). Intoarce 1 daca a scris, 0 daca a sarit.
 *
 * KEYS[1] = history key, KEYS[2] = pools ZSET.
 * ARGV[1] = now(ms), ARGV[2] = minIntervalMs, ARGV[3] = historyPoint JSON,
 * ARGV[4] = maxIndex (ltrim), ARGV[5] = ttlSec, ARGV[6] = pool (membru ZSET).
 */
export const APPEND_HISTORY_LUA = `
local newest = redis.call("LINDEX", KEYS[1], 0)
local shouldAppend = 0

if not newest then
  shouldAppend = 1
else
  local ok, point = pcall(cjson.decode, newest)
  if not ok or type(point) ~= "table" or type(point.ts) ~= "number" then
    shouldAppend = 1
  else
    local age = tonumber(ARGV[1]) - point.ts
    if age < 0 or age >= tonumber(ARGV[2]) then
      shouldAppend = 1
    end
  end
end

if shouldAppend == 1 then
  redis.call("LPUSH", KEYS[1], ARGV[3])
  redis.call("LTRIM", KEYS[1], 0, tonumber(ARGV[4]))
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[5]))
end

redis.call("ZADD", KEYS[2], ARGV[1], ARGV[6])
return shouldAppend
`;
