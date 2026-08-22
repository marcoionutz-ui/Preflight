/**
 * lib/db/quotaAtomic.ts — PH-2 (quota ATOMICĂ multi-dimensională: Lua + parser + planuri). Frunză: ZERO importuri
 * grele (fără ioredis/redis/next) → testabilă în tsx ȘI evaluabilă direct pe un Redis real (ca `oauthAtomic.ts`).
 *
 * Generalizează `RL_CHECK_INCR_LUA` (E6, 2 ferestre min+zi pe UN client) la N ferestre pe MAI MULTE scope-uri:
 * tokenurile auth-code (subject_kind=user) se contorizează pe ACCOUNT (`user_id`) primar + CLIENT secundar
 * anti-abuz, fiecare pe minut ȘI zi = 4 ferestre. Permis DOAR dacă TOATE au loc; la refuz NU se incrementează
 * NICIUNA (fără consum parțial). client_credentials rămâne o singură dimensiune (client), aceleași chei ca azi.
 *
 * `quotaDecision.ts` e SPECIFICAȚIA pură (aprobată de cgpt); Lua-ul de aici o reimplementează 1:1 în Redis + atomic.
 * Redis-down/corupt = tratat de apelant (plasa degraded, ca `checkRateLimit`), NU aici.
 */

// ── Lua: check-then-increment ATOMIC pe N ferestre (all-or-nothing) ───────────
//   KEYS[1..n]   = cheile contoarelor (în ordinea planului).
//   ARGV[1]      = n (număr de ferestre).
//   ARGV[2i], ARGV[2i+1] = (limită, ttlSec) pentru fereastra i.  (limită = -1 nelimitat, altfel întreg >= 0)
//   Întoarce {allowed, retry, c_1, …, c_n}:
//     allowed=1 → c_i = valorile DUPĂ incrementare, retry=0.
//     allowed=0 → c_i = valorile CURENTE (pre-incr), retry = MAX TTL al ferestrelor care BLOCHEAZĂ (retry onest).
//   TTL self-healing: o cheie existentă cu contor dar fără expiry (TTL == -1) primește EXPIRE (nu blochează permanent).
//
//   ⚠️ PREVALIDARE COMPLETĂ ÎNAINTE de ORICE mutație (cgpt): Redis Lua NU face rollback la eroare. Nu e destul ca
//   `tonumber` să dea un întreg — `tonumber` acceptă „1e3", „0x1f", „ 5", „01" pe care `INCR` le RESPINGE, plus
//   valori peste int64 pe care `INCR` le dă overflow. Deci validăm REPREZENTAREA BRUTĂ a contorului ca întreg Redis
//   CANONIC (doar cifre, fără semn/exponent/spații/zerouri-în-față) ȘI sub un plafon sigur (`MAXV`=1e15 << 2^53 <<
//   int64 max) astfel încât `INCR` de la orice contor valid să nu poată depăși. TTL-ul e plafonat (1..2^31-1) ca
//   `EXPIRE` să nu poată eșua. Toate verificările sunt din GET-uri (zero scrieri); DOAR dacă totul e valid trecem la
//   EXPIRE/INCR. Orice invaliditate → `redis.error_reply` (scriptul eșuează, cheile rămân IDENTICE; degraded la apelant).
export const QUOTA_CHECK_INCR_LUA = `
local MAXV = 1000000000000000
local function canon_nonneg(raw)
  if type(raw) ~= 'string' then return nil end
  if not string.match(raw, '^%d+$') then return nil end
  if #raw > 15 then return nil end
  if #raw > 1 and string.byte(raw, 1) == 48 then return nil end
  local v = tonumber(raw)
  if not v or v ~= math.floor(v) or v < 0 or v > MAXV then return nil end
  return v
end

local n = tonumber(ARGV[1])
if not n or n ~= math.floor(n) or n < 1 then return redis.error_reply('QUOTA_BAD_N') end
if #KEYS ~= n then return redis.error_reply('QUOTA_KEYS_MISMATCH') end
if #ARGV ~= 1 + 2 * n then return redis.error_reply('QUOTA_ARGV_MISMATCH') end

local counts = {}
local lims   = {}
local ttls   = {}
for i = 1, n do
  local lim = tonumber(ARGV[2*i])
  if not lim or lim ~= math.floor(lim) or lim < -1 or lim > MAXV then return redis.error_reply('QUOTA_BAD_LIMIT') end
  lims[i] = lim
  local ttl = tonumber(ARGV[2*i + 1])
  if not ttl or ttl ~= math.floor(ttl) or ttl < 1 or ttl > 2147483647 then return redis.error_reply('QUOTA_BAD_TTL') end
  ttls[i] = ttl
  local raw = redis.call('GET', KEYS[i])
  local c
  if raw == false then
    c = 0
  else
    c = canon_nonneg(raw)
    if c == nil then return redis.error_reply('QUOTA_BAD_COUNTER') end
  end
  counts[i] = c
end

-- toate valide → decidem (de aici încolo pot exista mutații, dar niciun input nu mai poate eșua un INCR)
local blocked = false
for i = 1, n do
  if lims[i] >= 0 and counts[i] >= lims[i] then blocked = true end
end

if blocked then
  local retry = 0
  for i = 1, n do
    if lims[i] >= 0 and counts[i] >= lims[i] then
      local t = redis.call('TTL', KEYS[i])
      if t == -1 then redis.call('EXPIRE', KEYS[i], ttls[i]) t = ttls[i]
      elseif t < 0 then t = ttls[i] end
      if t > retry then retry = t end
    end
  end
  local out = {0, retry}
  for i = 1, n do out[#out + 1] = counts[i] end
  return out
end

local out = {1, 0}
for i = 1, n do
  local nv = redis.call('INCR', KEYS[i])
  if nv == 1 then redis.call('EXPIRE', KEYS[i], ttls[i])
  elseif redis.call('TTL', KEYS[i]) < 0 then redis.call('EXPIRE', KEYS[i], ttls[i]) end
  out[#out + 1] = nv
end
return out
`;

// ── parser PUR al întoarcerii Lua ─────────────────────────────────────────────
export type QuotaEvalOutcome =
  | { status: "ok";      counts: number[] }
  | { status: "limited"; retryAfterSec: number; counts: number[] }
  | null; // rezultat corupt/neașteptat → apelantul cade pe plasa degraded (NU fail-open)

function isNonNegInt(n: unknown): n is number { return typeof n === "number" && Number.isInteger(n) && n >= 0; }

/**
 * Mapează `[allowed, retry, c_1..c_n]` la un outcome. Fail-closed (cgpt): `nWindows` trebuie întreg > 0; lungime
 * exactă `2 + nWindows`; `allowed` ∈ {0,1}; `retry` întreg ≥ 0; `allowed=1` ⇒ `retry===0` (altfel contract Lua
 * corupt); fiecare `count` întreg ≥ 0. Orice abatere → null (apelantul aplică degraded). NB: pe stare coruptă
 * Lua-ul dă `error_reply` → `r.eval` ARUNCĂ (nu ajunge aici).
 */
export function quotaFromEval(evalReturn: unknown, nWindows: number): QuotaEvalOutcome {
  if (!Number.isInteger(nWindows) || nWindows < 1) return null;
  if (!Array.isArray(evalReturn) || evalReturn.length !== 2 + nWindows) return null;
  const allowed = Number(evalReturn[0]);
  const retry   = Number(evalReturn[1]);
  if (allowed !== 0 && allowed !== 1) return null;
  if (!isNonNegInt(retry)) return null;
  if (allowed === 1 && retry !== 0) return null; // permis ⇒ retry 0 (altfel Lua a întors ceva incoerent)

  const counts: number[] = [];
  for (let i = 0; i < nWindows; i++) {
    const c = Number(evalReturn[2 + i]);
    if (!isNonNegInt(c)) return null;
    counts.push(c);
  }
  return allowed === 1 ? { status: "ok", counts } : { status: "limited", retryAfterSec: retry, counts };
}

// ── chei + planuri ─────────────────────────────────────────────────────────────
export const RL_MIN_TTL = 60;      // fereastră de minut
export const RL_DAY_TTL = 86_400;  // fereastră de 24h

export interface RlWindowKeys { minKey: string; dayKey: string; }
/** ACCOUNT (user_id) — namespace NOU, pentru tokenurile auth-code. */
export function accountRlKeys(userId: string): RlWindowKeys {
  return { minKey: `mcp:rl:acct:min:${userId}`, dayKey: `mcp:rl:acct:day:${userId}` };
}
/** CLIENT (client_id) — ACELEAȘI chei ca `checkRateLimit` de azi (client_credentials rămâne neschimbat). */
export function clientRlKeys(clientId: string): RlWindowKeys {
  return { minKey: `mcp:rl:min:${clientId}`, dayKey: `mcp:rl:day:${clientId}` };
}

export interface PlanWindow { key: string; limit: number; ttlSec: number; }
export interface ScopeLimits { perMinute: number; perDay: number; } // -1 = nelimitat

/** ferestrele unui scope, ordine day-înainte-minute (consistent cu quotaDecision). */
function scopePlan(keys: RlWindowKeys, lim: ScopeLimits): PlanWindow[] {
  return [
    { key: keys.dayKey, limit: lim.perDay,    ttlSec: RL_DAY_TTL },
    { key: keys.minKey, limit: lim.perMinute, ttlSec: RL_MIN_TTL },
  ];
}

/**
 * Plan auth-code: ACCOUNT primar (obligatoriu) + CLIENT secundar EXPLICIT (`{accountOnly:true}` pentru account-only,
 * ca la `authCodeQuotaWindows`). Ordine: account (day,min) apoi client (day,min).
 */
export type SecondaryClientPolicy = { clientId: string; limits: ScopeLimits } | { accountOnly: true };
export function authCodeQuotaPlan(userId: string, account: ScopeLimits, client: SecondaryClientPolicy): PlanWindow[] {
  const plan = scopePlan(accountRlKeys(userId), account);
  if (!("accountOnly" in client)) plan.push(...scopePlan(clientRlKeys(client.clientId), client.limits));
  return plan;
}

/** Plan client_credentials: o singură dimensiune (client), ca azi. */
export function clientCredsQuotaPlan(clientId: string, limits: ScopeLimits): PlanWindow[] {
  return scopePlan(clientRlKeys(clientId), limits);
}

/** Transformă un plan în argumentele pentru `redis.eval(LUA, keys.length, ...keys, ...argv)`. */
export function evalArgs(plan: readonly PlanWindow[]): { keys: string[]; argv: string[] } {
  const keys: string[] = [];
  const argv: string[] = [String(plan.length)];
  for (const w of plan) {
    keys.push(w.key);
    argv.push(String(w.limit), String(w.ttlSec));
  }
  return { keys, argv };
}
