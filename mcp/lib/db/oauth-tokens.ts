/**
 * lib/db/oauth-tokens.ts
 * Access tokens + rate limiting — Redis, sesiuni temporare
 */

import { createHash, randomBytes } from "crypto";
import { getRedis }                from "./redis";
import { emergencyRateAllow, clearDegradedRate } from "../mcp/degraded";
import { parseStoredToken }        from "../mcp/tokenGuard";
import type { StoredTokenPayload } from "../oauth/tokenPayloadModel";
import { RL_CHECK_INCR_LUA, rateLimitFromEval, type RateLimitOutcome } from "./oauthAtomic";
import { QUOTA_CHECK_INCR_LUA, quotaFromEval, authCodeQuotaPlan, evalArgs, type ScopeLimits } from "./quotaAtomic";

// E6: contractul RateLimitOutcome (ok | limited | unavailable) trăiește acum în leaf-ul `oauthAtomic.ts`
// (împreună cu scriptul Lua + mapper-ul pur). Re-exportat aici ca să nu se schimbe importurile caller-ilor.
export type { RateLimitOutcome } from "./oauthAtomic";

export const TOKEN_TTL_SEC = 24 * 60 * 60; // 24h
// PH-4: refresh token lifetime — mult mai lung ca access token-ul (rotit la fiecare folosire), ca să elimine
// reautorizarea zilnică. La fiecare rotație TTL-ul se reînnoește (sliding), deci o sesiune activă nu expiră.
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // 30 zile
const RL_MIN_TTL    = 60;            // 1 min window
const RL_DAY_TTL    = 86_400;        // 24h window

export interface TokenPayload {
  client_id:          string;
  scopes:             string[];
  issued_at:          number;
  // secret_rotated_at value the issuing request read from the client row —
  // NOT compared against issued_at (that's TOCTOU-racy: a request that read
  // the old secret can still finish issuing after a concurrent rotation
  // bumps secret_rotated_at, since issued_at is stamped after the read).
  // Comparing this pinned value against the client's *current*
  // secret_rotated_at on every authenticate() call is race-free instead.
  credential_version: string;
  // PH-3 (RFC 8707 / spec MCP „token audience binding"): resursa canonică pentru care a fost emis tokenul
  // (`${issuer}/api/mcp`). Resource server-ul (resolveAuth) respinge un token al cărui audience != resursa lui.
  // Opțional pe tip (grandfather pentru tokenuri dinainte de PH-3), dar toate căile de emitere de acum îl setează.
  audience?:          string;
  // PH-4 (cgpt #1 — grant-level revocation): family_id-ul lanțului de refresh din care provine acest access token.
  // resolveAuth verifică `mcp:refresh_family:<family_id>`; dacă familia e REVOCATĂ (reuse-detection/logout), TOATE
  // access token-urile lanțului mor imediat, nu doar refresh-ul. Opțional: client_credentials NU are familie (fără
  // refresh), iar tokenurile dinainte de PH-4 n-au family_id → sar peste verificare (grandfather, nu revocate).
  family_id?:         string;
}

/**
 * E10: rezultat DISCRIMINAT pentru validarea tokenului. `unavailable` (Redis jos) NU trebuie confundat cu
 * `invalid` (token chiar inexistent/expirat) — caller-ul întoarce 503, nu 401. Un token neverificat NU se acceptă.
 */
// PH-2 step 10.5a: payload-ul validat e `StoredTokenPayload` (union discriminat user/client/legacy), nu doar forma
// client-shaped `TokenPayload`. `resolveAuth` accesează câmpurile care nu-s pe toți membrii (`credential_version`,
// `family_id`) prin accesorii siguri pe union (`tokenCredentialVersion`/`tokenFamilyId`). `TokenPayload` rămâne
// pentru EMITERE (issueToken/mintToken), care produce forma client-shaped.
export type TokenValidation =
  | { status: "valid";       payload: StoredTokenPayload }
  | { status: "invalid" }
  | { status: "unavailable"; reason: string };

// ── Token helpers ─────────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ── Issue ─────────────────────────────────────────────────────────────────────

export async function issueToken(payload: TokenPayload): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;

  const token = randomBytes(32).toString("hex");
  const hash  = hashToken(token);

  await r.set(`mcp:token:${hash}`, JSON.stringify(payload), "EX", TOKEN_TTL_SEC);
  return token;
}

/**
 * U7: pregătește un token nou FĂRĂ a-l scrie. Întoarce tokenul plain (de returnat clientului) + cheia Redis +
 * valoarea serializată, ca `consumeCodeAndIssueToken` (oauth-codes) să facă scrierea ATOMIC cu consumul codului
 * (un singur EVAL). `issueToken` de mai sus rămâne pentru client_credentials (scriere directă, fără cod de consumat).
 */
// PH-2 10.4c: generic pe payload (serializează orice formă validă) — acceptă și `UserTokenPayload` (finalizat),
// nu doar `TokenPayload` client-shaped. Doar `JSON.stringify` + hash; forma e garantată de builder-ul apelantului.
export function mintToken<T>(payload: T): { token: string; key: string; value: string } {
  const token = randomBytes(32).toString("hex");
  return { token, key: `mcp:token:${hashToken(token)}`, value: JSON.stringify(payload) };
}

// ── Validate ──────────────────────────────────────────────────────────────────

export async function validateToken(token: string): Promise<TokenValidation> {
  const r = getRedis();
  // Redis neconfigurat = nu POT verifica identitatea → unavailable (503), NU „invalid" (401 ar minți).
  if (!r) return { status: "unavailable", reason: "redis_unconfigured" };

  try {
    const raw = await r.get(`mcp:token:${hashToken(token)}`);
    // Cheie absentă = token chiar inexistent/expirat → invalid (verificarea a reușit, răspunsul e „nu").
    if (!raw) return { status: "invalid" };
    // JSON invalid SAU formă invalidă (null / {} / scopes ne-string) → invalid, NU „valid cu payload null"
    // (care ar arunca în resolveAuth → 500). Payload neutilizabil = 401 INVALID_TOKEN.
    return parseStoredToken(raw);
  } catch (err) {
    // Redis a respins (down / reconnect cu enableOfflineQueue:false) → NU pretinde invalid, semnalează unavailable.
    return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
}

// ── Revoke ────────────────────────────────────────────────────────────────────

export async function revokeToken(token: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.del(`mcp:token:${hashToken(token)}`);
}

// ── Rate limit ────────────────────────────────────────────────────────────────

/**
 * E10: când Redis nu poate aplica limita (jos / respinge / rezultat gol) → NU fail-open nelimitat, ci plasa locală
 * bounded (`emergencyRateAllow`: cap ≤5rpm, burst 2, fereastră 60s per instanță); epuizată → `unavailable` (503).
 * Un succes Redis resetează starea degraded a clientului (a ieșit din outage).
 */
function degradedRate(clientId: string, rate_limit_per_minute: number): RateLimitOutcome {
  return emergencyRateAllow(clientId, rate_limit_per_minute) === "allow"
    ? { status: "ok", remaining_min: 0, remaining_day: 0 } // degraded → remaining necunoscut
    : { status: "unavailable" };
}

export async function checkRateLimit(
  clientId:              string,
  rate_limit_per_minute: number,
  rate_limit_per_day:    number,
): Promise<RateLimitOutcome> {
  const r = getRedis();
  if (!r) return degradedRate(clientId, rate_limit_per_minute);

  const minKey = `mcp:rl:min:${clientId}`;
  const dayKey = `mcp:rl:day:${clientId}`;

  try {
    // E6: „check-then-increment" ATOMIC într-un singur Lua — evaluează contoarele CURENTE ÎNAINTE de a incrementa.
    // O cerere respinsă (peste limită) NU mai incrementează nimic → nu mai arde quota de zi pe 429-uri de minut.
    // Înlocuiește pipeline-ul incr→ttl→(evaluează după), care contoriza fiecare cerere respinsă.
    const res = await r.eval(
      RL_CHECK_INCR_LUA,
      2,
      minKey, dayKey,
      String(rate_limit_per_minute),
      String(rate_limit_per_day),
      String(RL_MIN_TTL),
      String(RL_DAY_TTL),
    );

    const outcome = rateLimitFromEval(res, rate_limit_per_minute, rate_limit_per_day);
    // Rezultat gol/neașteptat din Lua → nu putem avea încredere în contoare → plasa locală degraded.
    if (!outcome) return degradedRate(clientId, rate_limit_per_minute);

    // Redis a răspuns corect → clientul nu mai e în degraded.
    clearDegradedRate(clientId);
    return outcome;
  } catch {
    // Redis a respins (down / reconnect) → plasa locală bounded, nu fail-open.
    return degradedRate(clientId, rate_limit_per_minute);
  }
}

/**
 * PH-2 step 10.5a frunza 4c — plasa degraded pt. tokenurile USER, MULTIDIMENSIONALĂ (cgpt): păstrează AMBELE dimensiuni
 * (cont + client) când Redis cade, ca plafonul secundar al clientului să NU dispară exact la outage. Altfel un client
 * public folosit de mulți useri ar primi câte un burst PER user (bucket-uri per-user distincte), ocolind limita
 * clientului. Bucket CONT pe `acct:${userId}` (namespace distinct → fără coliziune dacă `userId === clientId`); bucket
 * CLIENT pe `clientId` — ACELAȘI bucket ca `checkRateLimit` legacy → PARTAJAT între toți userii clientului (plafon
 * agregat). Ambele decizii sunt computate (fiecare bucket vede cererea); trece DOAR dacă AMBELE permit.
 */
function degradedAccountRate(userId: string, account: ScopeLimits, clientId: string, client: ScopeLimits): RateLimitOutcome {
  const acctOk   = emergencyRateAllow(`acct:${userId}`, account.perMinute) === "allow";
  const clientOk = emergencyRateAllow(clientId,          client.perMinute)  === "allow";
  return acctOk && clientOk
    ? { status: "ok", remaining_min: 0, remaining_day: 0 } // degraded → remaining necunoscut
    : { status: "unavailable" };
}

/**
 * PH-2 step 10.5a frunza 4c — rate-limit ATOMIC pentru tokenurile USER (auth-code): ACCOUNT primar (`user_id`) +
 * CLIENT secundar anti-abuz (`client_id`), cele 4 ferestre (day+min pe fiecare) all-or-nothing într-un singur EVAL
 * (`QUOTA_CHECK_INCR_LUA` via `authCodeQuotaPlan` — reutilizează planul 9a). La refuz NU se incrementează NICIUNA.
 * Degradare simetrică cu `checkRateLimit` DAR multidimensională (`degradedAccountRate`): Redis jos/corupt → plasa
 * locală bounded pe AMBELE dimensiuni (cont + client), NU fail-open, NU pierde plafonul clientului. Succes Redis →
 * curăță AMBELE bucket-uri degraded. `remaining_*` sunt pe ferestrele CONTULUI; `resolveUserAuth` folosește status + retry.
 */
export async function checkAccountRateLimit(
  userId:  string,
  account: ScopeLimits,
  clientId: string,
  client:  ScopeLimits,
): Promise<RateLimitOutcome> {
  const r = getRedis();
  if (!r) return degradedAccountRate(userId, account, clientId, client);

  const plan = authCodeQuotaPlan(userId, account, { clientId, limits: client });
  const { keys, argv } = evalArgs(plan);

  try {
    const res = await r.eval(QUOTA_CHECK_INCR_LUA, keys.length, ...keys, ...argv);
    const outcome = quotaFromEval(res, plan.length);
    // Rezultat gol/neașteptat din Lua → nu putem avea încredere în contoare → plasa locală degraded (ambele dimensiuni).
    if (!outcome) return degradedAccountRate(userId, account, clientId, client);

    // Redis a răspuns corect → AMBELE dimensiuni ies din degraded (cont + client).
    clearDegradedRate(`acct:${userId}`);
    clearDegradedRate(clientId);
    // counts (ordine authCodeQuotaPlan): [account.day, account.min, client.day, client.min].
    const remaining_min = account.perMinute < 0 ? -1 : Math.max(0, account.perMinute - outcome.counts[1]);
    const remaining_day = account.perDay    < 0 ? -1 : Math.max(0, account.perDay    - outcome.counts[0]);
    return outcome.status === "limited"
      ? { status: "limited", retry_after: outcome.retryAfterSec, remaining_min, remaining_day }
      : { status: "ok", remaining_min, remaining_day };
  } catch {
    return degradedAccountRate(userId, account, clientId, client);
  }
}

/** Export intern pt. teste: plasa degraded multidimensională (cont + client) — vezi `degradedAccountRate`. */
export const __degradedAccountRateForTest = degradedAccountRate;