/**
 * lib/db/oauth-tokens.ts
 * Access tokens + rate limiting — Redis, sesiuni temporare
 */

import { createHash, randomBytes } from "crypto";
import { getRedis }                from "./redis";
import { emergencyRateAllow, clearDegradedRate } from "../mcp/degraded";
import { parseStoredToken }        from "../mcp/tokenGuard";

const TOKEN_TTL_SEC = 24 * 60 * 60; // 24h
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
}

/**
 * E10: rezultat DISCRIMINAT — separă „limita reală atinsă în Redis" (→ 429) de „nu pot aplica limita" (→ 503).
 * `ok` = permis; `limited` = ai depășit limita reală; `unavailable` = Redis jos ȘI plasa locală degraded s-a
 * epuizat (fereastră expirată sau cap local atins).
 */
export type RateLimitOutcome =
  | { status: "ok";      remaining_min: number; remaining_day: number }
  | { status: "limited"; retry_after: number; remaining_min: number; remaining_day: number }
  | { status: "unavailable" };

/**
 * E10: rezultat DISCRIMINAT pentru validarea tokenului. `unavailable` (Redis jos) NU trebuie confundat cu
 * `invalid` (token chiar inexistent/expirat) — caller-ul întoarce 503, nu 401. Un token neverificat NU se acceptă.
 */
export type TokenValidation =
  | { status: "valid";       payload: TokenPayload }
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
    const pipeline = r.pipeline();
    pipeline.incr(minKey);
    pipeline.ttl(minKey);
    pipeline.incr(dayKey);
    pipeline.ttl(dayKey);
    const results = await pipeline.exec();

    // Rezultat gol sau vreo comandă eșuată în pipeline → nu putem avea încredere în contoare → degraded.
    if (!results || results.some(res => res?.[0])) return degradedRate(clientId, rate_limit_per_minute);

    const countMin = results[0]?.[1] as number ?? 0;
    const ttlMin   = results[1]?.[1] as number ?? -1;
    const countDay = results[2]?.[1] as number ?? 0;
    const ttlDay   = results[3]?.[1] as number ?? -1;

    if (countMin === 1 || ttlMin === -1) await r.expire(minKey, RL_MIN_TTL);
    if (countDay === 1 || ttlDay === -1) await r.expire(dayKey, RL_DAY_TTL);

    // Redis a răspuns corect → clientul nu mai e în degraded.
    clearDegradedRate(clientId);

    const unlimitedMin = rate_limit_per_minute < 0;
    const unlimitedDay = rate_limit_per_day    < 0;

    const remaining_min = unlimitedMin ? -1 : Math.max(0, rate_limit_per_minute - countMin);
    const remaining_day = unlimitedDay ? -1 : Math.max(0, rate_limit_per_day    - countDay);

    if (!unlimitedMin && countMin > rate_limit_per_minute) {
      return { status: "limited", retry_after: RL_MIN_TTL, remaining_min: 0, remaining_day };
    }
    if (!unlimitedDay && countDay > rate_limit_per_day) {
      return { status: "limited", retry_after: RL_DAY_TTL, remaining_min, remaining_day: 0 };
    }

    return { status: "ok", remaining_min, remaining_day };
  } catch {
    // Redis a respins (down / reconnect) → plasa locală bounded, nu fail-open.
    return degradedRate(clientId, rate_limit_per_minute);
  }
}