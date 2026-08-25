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
  // PH-3 (RFC 8707): resursa (audience) cerută la /authorize, legată în cod → propagată în token. Opțional pe blob
  // (coduri vechi dinainte de PH-3 nu-l au; sunt tratate ca „resursă implicită canonică" la /token). Când e prezent,
  // trebuie să fie string.
  resource?:             string;
  // PH-2 step 10 (consimțământ user): claim-urile de identitate sigilate în cod pentru un grant de USER. OPȚIONALE pe
  // tip (un cod client-authorized / legacy NU le are), dar `isAuthCodePayload` le impune ALL-OR-NOTHING + semantic
  // valide LA BOUNDARY (toate absente = legacy; toate prezente + valide = user; orice parțial/invalid → blob respins).
  user_id?:              string;
  grant_id?:             string;
  entitlement_version?:  number;
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
  // PH-3: `resource` e opțional, dar dacă e prezent trebuie să fie string (un blob cu resource ne-string e corupt).
  if (o.resource !== undefined && typeof o.resource !== "string") return false;
  // PH-2 step 10 (cgpt): claim-urile user se impun ALL-OR-NOTHING + semantic valide CHIAR LA BOUNDARY. `peekAuthCode`
  // (→ `isAuthCodePayload`) e SINGURUL gate înainte de consum; `/token` NU re-verifică identitatea până la 10.4, deci
  // un cod cu claims parțiale/corupte NU trebuie să treacă drept legacy. Un cod stocat trebuie să fie FIE curat legacy
  // (toate trei absente), FIE curat user (toate trei prezente + valide: id-uri ne-goale, entitlement_version întreg ≥1).
  const anyUserClaim = o.user_id !== undefined || o.grant_id !== undefined || o.entitlement_version !== undefined;
  if (anyUserClaim) {
    if (typeof o.user_id !== "string" || o.user_id.length === 0) return false;
    if (typeof o.grant_id !== "string" || o.grant_id.length === 0) return false;
    if (typeof o.entitlement_version !== "number" || !Number.isInteger(o.entitlement_version) || o.entitlement_version < 1) return false;
  }
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

/**
 * U7 (atomic issuance): consumă codul ȘI scrie tokenul all-or-nothing. ⚠️ Redis Lua NU face rollback dacă o comandă
 * eșuează după alta (redis.io/blog/you-dont-need-transaction-rollbacks-in-redis) → ORDINEA contează: scriem tokenul
 * ÎNTÂI (`SET ... EX ... NX`), verificăm succesul, și DOAR APOI ștergem codul. Dacă SET eșuează (NX-collision, sau o
 * eroare care abortează scriptul), codul NU e șters → clientul reia cu ACELAȘI cod (nu-l ardem fără token emis).
 * Concurența e serializată oricum de atomicitatea EVAL (o cerere concurentă vede codul deja șters → 0, fără dublă emitere).
 *   KEYS[1]=codeKey KEYS[2]=tokenKey ; ARGV[1]=codeRaw ARGV[2]=tokenPayload ARGV[3]=tokenTtlSec.
 *   1 → token scris + cod consumat; 0 → codul nu mai există; -1 → alt blob (fail-closed); -2 → SET a eșuat, COD PĂSTRAT (retry).
 * Verdictul → `classifyIssueResult` (NU `classifyConsumeResult` — -2 e retry, nu already_used).
 */
export const AUTH_CODE_CONSUME_AND_ISSUE_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
if cur ~= ARGV[1] then return -1 end
local ok = redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[3]), 'NX')
if not ok then return -2 end
redis.call('DEL', KEYS[1])
return 1
`;

export type IssueLuaVerdict = "issued" | "already_used" | "write_failed";

/**
 * Mapează întoarcerea `AUTH_CODE_CONSUME_AND_ISSUE_LUA`. 1→issued (token scris + cod consumat); -2→write_failed
 * (SET NX a eșuat → COD PĂSTRAT → caller-ul întoarce 503 retry, NU „already used"); 0/-1→already_used (cod dispărut /
 * blob schimbat → fail-closed).
 */
export function classifyIssueResult(luaReturn: unknown): IssueLuaVerdict {
  const n = Number(luaReturn);
  if (n === 1)  return "issued";
  if (n === -2) return "write_failed";
  return "already_used";
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

// ── PH-4: refresh tokens (RFC 6749 §6 / OAuth 2.1 — rotație + reuse-detection cu family revocation) ──────────────
//
// Un refresh token e legat de o FAMILIE (`family_id`, comună întregului lanț descendent dintr-un authorization code).
// Cheia de familie `mcp:refresh_family:<family_id>` ține hash-ul refresh-ului CURENT valid (SAU sentinela REVOKED).
// Un refresh e valid DOAR dacă e egal cu „current"-ul familiei. La rotație, „current" devine hash-ul nou. Dacă un
// refresh care NU mai e current e prezentat (semn de furt — a fost deja rotit), REVOCĂM toată familia. Astfel un
// token furat poate fi folosit cel mult până când oricare parte rotește; apoi ambele sunt tăiate.

/** Sentinela stocată în cheia de familie când familia e revocată (reuse detectat sau logout). */
export const REFRESH_FAMILY_REVOKED = "REVOKED";

export interface RefreshPayload {
  client_id:          string;
  scopes:             string[];
  audience:           string;   // PH-3: resursa canonică pentru care sunt emise access token-urile din acest lanț
  credential_version: string;   // secret_rotated_at pinned — rotația secretului forțează reauth (ca la access token)
  family_id:          string;   // lanțul de rotație; reuse pe familie → revocare
  issued_at:          number;
}

/**
 * Guard de formă pentru un blob de refresh CLIENT stocat. Formă invalidă (JSON valid dar câmpuri greșite) → tratat ca absent.
 *
 * 10.4a (cgpt — coliziune hibrid): forma client (subject_kind ABSENT) trebuie să RESPINGĂ explicit orice contaminare
 * cu identitate user (`subject_kind` prezent, `user_id`/`grant_id`/`entitlement_version`). Un refresh client legitim NU
 * poartă niciodată aceste câmpuri; prezența oricăruia = blob necredibil → false. Fără asta, un blob hibrid
 * `{...client, user_id, grant_id, entitlement_version}` (fără subject_kind) ar trece drept refresh client — o formă
 * coruptă interpretată ca legacy/client. Strict la rădăcină ⇒ și calea vie `parseRefresh`→`peekRefreshToken` e strictă,
 * nu doar discriminatorul nou `classifyStoredRefresh`.
 */
export function isRefreshPayload(v: unknown): v is RefreshPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.subject_kind !== undefined) return false; // orice subject_kind (inclusiv "user"/"client") → NU e refresh client
  if (o.user_id !== undefined || o.grant_id !== undefined || o.entitlement_version !== undefined) return false; // identitate user interzisă
  if (typeof o.client_id !== "string" || o.client_id.length === 0) return false;
  if (typeof o.audience !== "string" || o.audience.length === 0) return false;
  if (typeof o.credential_version !== "string" || o.credential_version.length === 0) return false;
  if (typeof o.family_id !== "string" || o.family_id.length === 0) return false;
  if (typeof o.issued_at !== "number" || !Number.isFinite(o.issued_at)) return false;
  if (!Array.isArray(o.scopes) || !o.scopes.every(s => typeof s === "string")) return false;
  return true;
}

/** Parse safe al blob-ului stocat → payload valid sau null (JSON stricat / formă invalidă). */
export function parseRefresh(raw: string): RefreshPayload | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return isRefreshPayload(parsed) ? parsed : null;
}

/**
 * ROTAȚIE ATOMICĂ a refresh-ului cu reuse-detection. Sursă de adevăr = cheia de familie (KEYS[1]), care ține hash-ul
 * refresh-ului CURENT valid sau `REVOKED`. NU ștergem înregistrările vechi de refresh (expiră prin TTL) — pointerul de
 * familie decide cine e valid, deci un refresh superseded (reuse) e respins + declanșează revocarea familiei.
 *   KEYS[1]=familyKey KEYS[2]=newRefreshKey KEYS[3]=newAccessKey
 *   ARGV[1]=oldHash ARGV[2]=newRefreshPayload ARGV[3]=newAccessPayload ARGV[4]=refreshTtlSec ARGV[5]=accessTtlSec ARGV[6]=newHash
 *   1  → rotit (access + refresh noi scrise, family.current=newHash)
 *   0  → familie inexistentă/expirată → invalid_grant
 *  -1  → familie deja revocată → invalid_grant
 *  -2  → REUSE: refresh prezentat ≠ current → familie REVOCATĂ acum → invalid_grant (toate tokenurile lanțului mor)
 *  -3  → SET NX pe access a eșuat (coliziune astronomică) → write_failed (retry, nu consumăm)
 */
export const REFRESH_ROTATE_LUA = `
local fam = redis.call('GET', KEYS[1])
if not fam then return 0 end
if fam == '${REFRESH_FAMILY_REVOKED}' then return -1 end
if fam ~= ARGV[1] then
  redis.call('SET', KEYS[1], '${REFRESH_FAMILY_REVOKED}', 'EX', tonumber(ARGV[4]))
  return -2
end
local ok = redis.call('SET', KEYS[3], ARGV[3], 'EX', tonumber(ARGV[5]), 'NX')
if not ok then return -3 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[4]))
redis.call('SET', KEYS[1], ARGV[6], 'EX', tonumber(ARGV[4]))
return 1
`;

export type RefreshRotateVerdict = "rotated" | "invalid" | "revoked" | "reuse_detected" | "write_failed";

/** Mapează întoarcerea `REFRESH_ROTATE_LUA` la un verdict. */
export function classifyRefreshRotate(luaReturn: unknown): RefreshRotateVerdict {
  const n = Number(luaReturn);
  if (n === 1)  return "rotated";
  if (n === -1) return "revoked";
  if (n === -2) return "reuse_detected";
  if (n === -3) return "write_failed";
  return "invalid";
}

/**
 * EMITERE INIȚIALĂ atomică la authorization_code: consumă codul (compare-and-delete pe blob) ȘI scrie access + refresh
 * + cheia de familie, all-or-nothing. Analog `AUTH_CODE_CONSUME_AND_ISSUE_LUA` dar cu refresh + familie în plus.
 *   KEYS[1]=codeKey KEYS[2]=accessKey KEYS[3]=refreshKey KEYS[4]=familyKey
 *   ARGV[1]=codeRaw ARGV[2]=accessPayload ARGV[3]=refreshPayload ARGV[4]=accessTtlSec ARGV[5]=refreshTtlSec ARGV[6]=refreshHash
 *   1 → cod consumat + access + refresh + familie scrise; 0/-1 → already_used; -2 → SET access a eșuat (cod PĂSTRAT, retry).
 * Verdictul → `classifyIssueResult` (același contract: 1→issued, -2→write_failed, else already_used).
 */
export const AUTH_CODE_ISSUE_WITH_REFRESH_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
if cur ~= ARGV[1] then return -1 end
local ok = redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[4]), 'NX')
if not ok then return -2 end
redis.call('SET', KEYS[3], ARGV[3], 'EX', tonumber(ARGV[5]))
redis.call('SET', KEYS[4], ARGV[6], 'EX', tonumber(ARGV[5]))
redis.call('DEL', KEYS[1])
return 1
`;

export type ScopeNarrowResult =
  | { status: "ok";              scopes: string[] }
  | { status: "invalid_scope";   reason: string };

/**
 * RFC 6749 §6: la refresh, scope-ul cerut trebuie să fie EGAL sau MAI ÎNGUST decât cel original (fără escaladare).
 *   - `requested` gol/absent → păstrează `original` (RFC: omiterea = scope-ul original).
 *   - orice scope cerut care NU e în `original` → invalid_scope (nu poți lărgi la refresh).
 * PUR → testabil izolat.
 */
export function narrowScopes(requested: string[] | undefined, original: string[]): ScopeNarrowResult {
  if (!requested || requested.length === 0) return { status: "ok", scopes: original };
  const orig = new Set(original);
  const escalated = requested.filter(s => !orig.has(s));
  if (escalated.length > 0) return { status: "invalid_scope", reason: `scope escalation not allowed: ${escalated.join(", ")}` };
  return { status: "ok", scopes: requested };
}
