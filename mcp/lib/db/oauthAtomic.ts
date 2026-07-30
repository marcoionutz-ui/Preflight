/**
 * lib/db/oauthAtomic.ts — E4 + E6 (OAuth atomicitate + ordinea „validează ÎNAINTE de a consuma/incrementa").
 *
 * Logică PURĂ + scripturi Lua (frunză, ZERO importuri grele: fără ioredis/redis/next) → testabilă izolat în tsx
 * ȘI evaluabilă direct pe un Redis real. `oauth-codes.ts` și `oauth-tokens.ts` importă de aici și leagă la getRedis.
 *
 *  - E4 (`AUTH_CODE_CONSUME_LUA` + `isAuthCodePayload`/`classifyConsumeResult`): authorization code-ul NU se mai
 *    șterge cu GETDEL ÎNAINTE de validare (client_id/redirect_uri/PKCE). Un GETDEL prematur lăsa orice cerere cu un
 *    `code` valid (dar client_id/verifier greșit) să ARDĂ codul → clientul legitim primea „already used" = DoS de
 *    consum. Acum: `peek` (GET, fără ștergere) → validezi tot → DOAR pe succes total `finalize` = compare-and-delete
 *    ATOMIC (șterge doar dacă blob-ul e EXACT cel validat → single-use + anti-replay/concurență).
 *  - E6 (`RL_CHECK_INCR_LUA` + `rateLimitFromEval`): rate limiter-ul incrementa min ȘI day ÎNAINTE de evaluare →
 *    fiecare cerere respinsă (429) tot consuma quota de zi. Acum: citește, EVALUEAZĂ înainte, incrementează DOAR
 *    dacă e permisă (un block pe fereastra de minut NU mai atinge contorul de zi), totul ATOMIC într-un singur Lua.
 */

// ── E4: authorization code ────────────────────────────────────────────────────

export interface AuthCodePayload {
  client_id:             string;
  scopes:                string[];
  redirect_uri:          string;
  code_challenge:        string;
  code_challenge_method: string;
  issued_at:             number;
}

/**
 * Guard de formă pentru un authorization code stocat. Un blob corupt (JSON valid dar formă greșită) NU trebuie
 * tratat ca un code utilizabil — altfel `peek` ar întoarce un payload parțial care pică oricum la validare, dar
 * mai rău, ar putea invita `finalize` pe date pe care nu le poți verifica. Formă invalidă → tratat ca absent.
 */
export function isAuthCodePayload(v: unknown): v is AuthCodePayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.client_id !== "string" || o.client_id.length === 0) return false;
  if (typeof o.redirect_uri !== "string" || o.redirect_uri.length === 0) return false;
  if (typeof o.code_challenge !== "string") return false;
  if (typeof o.code_challenge_method !== "string") return false;
  if (typeof o.issued_at !== "number" || !Number.isFinite(o.issued_at)) return false;
  if (!Array.isArray(o.scopes) || !o.scopes.every(s => typeof s === "string")) return false;
  return true;
}

/** Parse safe al blob-ului stocat → payload valid sau null (JSON stricat / formă invalidă). */
export function parseAuthCode(raw: string): AuthCodePayload | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return isAuthCodePayload(parsed) ? parsed : null;
}

/**
 * Compare-and-delete ATOMIC. Șterge cheia DOAR dacă valoarea curentă e EXACT `ARGV[1]` (blob-ul pe care caller-ul
 * l-a citit ȘI validat). Întoarce:
 *   1  → am consumat noi codul (câștigat cursa) → emite token.
 *   0  → cheia nu mai există (deja consumat de o cerere concurentă / expirat între peek și finalize).
 *  -1  → cheia există dar cu ALT conținut (imposibil pt. coduri imuabile, dar fail-closed: nu ștergem ce nu am validat).
 * NB: sha256 (PKCE) NU se poate face în Lua → validarea PKCE rămâne în JS pe payload-ul din peek; Lua doar sigilează.
 */
export const AUTH_CODE_CONSUME_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
if cur ~= ARGV[1] then return -1 end
redis.call('DEL', KEYS[1])
return 1
`;

export type ConsumeResult = "consumed" | "already_used";

/** Mapează întoarcerea `AUTH_CODE_CONSUME_LUA` la un verdict. 1→consumed; 0 sau -1→already_used (fail-closed). */
export function classifyConsumeResult(luaReturn: unknown): ConsumeResult {
  return Number(luaReturn) === 1 ? "consumed" : "already_used";
}

// ── E6: rate limit ─────────────────────────────────────────────────────────────

/**
 * Fixed-window „check-then-increment" ATOMIC pentru DOUĂ ferestre (minut + zi).
 *   KEYS[1]=minKey KEYS[2]=dayKey; ARGV[1]=limMin ARGV[2]=limDay ARGV[3]=minTtl ARGV[4]=dayTtl.
 * Evaluează contoarele CURENTE ÎNAINTE de a incrementa. Dacă VREO fereastră e la/peste limită → block, incrementând
 * NIMIC (o cerere respinsă nu mai consumă quota — nici pe cea care a blocat-o, nici pe cealaltă). Altfel incr ambele.
 * Limită < 0 = nelimitat (fără block pe acea fereastră). Întoarce {allowed, cMin, cDay, retryAfter}:
 *   allowed=1 → cMin/cDay = valorile DUPĂ incrementare, retryAfter=0.
 *   allowed=0 → cMin/cDay = valorile CURENTE (pre-incr), retryAfter = MAX-ul TTL-urilor ferestrelor care blochează.
 * ⭐ Retry-After ONEST (varu): dacă AMBELE ferestre blochează, retryAfter = max(minTtl, dayTtl) — altfel clientul
 *   reîncerca după TTL-ul mic (minut) și rămânea blocat de fereastra mare (zi), primind un Retry-After mincinos.
 * ⭐ TTL self-healing (varu): o cheie cu contor dar FĂRĂ expiry (TTL == -1, ex. process mort între INCR și EXPIRE
 *   în varianta veche) ar bloca PERMANENT. Reparăm expiry-ul ori de câte ori TTL < 0 pe o cheie existentă — atât
 *   pe ramura blocată (pe fereastra care blochează), cât și pe cea permisă (după incrementare).
 */
export const RL_CHECK_INCR_LUA = `
local cMin = tonumber(redis.call('GET', KEYS[1]) or '0')
local cDay = tonumber(redis.call('GET', KEYS[2]) or '0')
local limMin = tonumber(ARGV[1])
local limDay = tonumber(ARGV[2])
local minTtl = tonumber(ARGV[3])
local dayTtl = tonumber(ARGV[4])

local minBlocked = (limMin >= 0 and cMin >= limMin)
local dayBlocked = (limDay >= 0 and cDay >= limDay)

if minBlocked or dayBlocked then
  local retry = 0
  if minBlocked then
    local t = redis.call('TTL', KEYS[1])
    if t == -1 then redis.call('EXPIRE', KEYS[1], minTtl) t = minTtl
    elseif t < 0 then t = minTtl end
    if t > retry then retry = t end
  end
  if dayBlocked then
    local t = redis.call('TTL', KEYS[2])
    if t == -1 then redis.call('EXPIRE', KEYS[2], dayTtl) t = dayTtl
    elseif t < 0 then t = dayTtl end
    if t > retry then retry = t end
  end
  return {0, cMin, cDay, retry}
end

local nMin = redis.call('INCR', KEYS[1])
if nMin == 1 then
  redis.call('EXPIRE', KEYS[1], minTtl)
elseif redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], minTtl)
end
local nDay = redis.call('INCR', KEYS[2])
if nDay == 1 then
  redis.call('EXPIRE', KEYS[2], dayTtl)
elseif redis.call('TTL', KEYS[2]) < 0 then
  redis.call('EXPIRE', KEYS[2], dayTtl)
end
return {1, nMin, nDay, 0}
`;

/** Rezultatul discriminat al rate-limit-ului (contract E10 păstrat: ok | limited | unavailable). */
export type RateLimitOutcome =
  | { status: "ok";      remaining_min: number; remaining_day: number }
  | { status: "limited"; retry_after: number; remaining_min: number; remaining_day: number }
  | { status: "unavailable" };

/**
 * Mapează întoarcerea `RL_CHECK_INCR_LUA` la un `RateLimitOutcome`, PUR. `evalReturn` = [allowed, cMin, cDay, retry].
 * Rezultat gol / neașteptat → null (caller-ul cade pe plasa degraded). Pe „limited", fereastra care a blocat are
 * remaining 0 (onest), cealaltă păstrează remaining-ul real.
 */
export function rateLimitFromEval(
  evalReturn: unknown,
  limMin: number,
  limDay: number,
): RateLimitOutcome | null {
  if (!Array.isArray(evalReturn) || evalReturn.length < 4) return null;
  const allowed = Number(evalReturn[0]);
  const cMin    = Number(evalReturn[1]);
  const cDay    = Number(evalReturn[2]);
  const retry   = Number(evalReturn[3]);
  if (!Number.isFinite(cMin) || !Number.isFinite(cDay) || !Number.isFinite(retry)) return null;
  // `allowed` trebuie să fie exact 0 sau 1 — orice altceva = întoarcere Lua coruptă → degraded, nu ghici.
  if (allowed !== 0 && allowed !== 1) return null;

  const unlimitedMin = limMin < 0;
  const unlimitedDay = limDay < 0;
  const remaining_min = unlimitedMin ? -1 : Math.max(0, limMin - cMin);
  const remaining_day = unlimitedDay ? -1 : Math.max(0, limDay - cDay);

  if (allowed === 1) return { status: "ok", remaining_min, remaining_day };

  // Blocat: care fereastră? (min are prioritate, la fel ca în Lua.)
  const minBlocked = !unlimitedMin && cMin >= limMin;
  if (minBlocked) return { status: "limited", retry_after: retry, remaining_min: 0, remaining_day };
  return { status: "limited", retry_after: retry, remaining_min, remaining_day: 0 };
}
