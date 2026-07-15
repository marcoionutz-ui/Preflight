/**
 * lib/db/oauth-tokens.ts
 * Access tokens + rate limiting — Redis, sesiuni temporare
 */

import { createHash, randomBytes } from "crypto";
import { getRedis }                from "./redis";

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

export interface RateLimitResult {
  allowed:       boolean;
  remaining_min: number;
  remaining_day: number;
  retry_after?:  number;
}

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

export async function validateToken(token: string): Promise<TokenPayload | null> {
  const r = getRedis();
  if (!r) return null;

  const raw = await r.get(`mcp:token:${hashToken(token)}`);
  if (!raw) return null;

  try { return JSON.parse(raw) as TokenPayload; }
  catch { return null; }
}

// ── Revoke ────────────────────────────────────────────────────────────────────

export async function revokeToken(token: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.del(`mcp:token:${hashToken(token)}`);
}

// ── Rate limit ────────────────────────────────────────────────────────────────

export async function checkRateLimit(
  clientId:              string,
  rate_limit_per_minute: number,
  rate_limit_per_day:    number,
): Promise<RateLimitResult> {
  const r = getRedis();
  if (!r) return { allowed: true, remaining_min: rate_limit_per_minute, remaining_day: rate_limit_per_day };

  const minKey = `mcp:rl:min:${clientId}`;
  const dayKey = `mcp:rl:day:${clientId}`;

  const pipeline = r.pipeline();
  pipeline.incr(minKey);
  pipeline.ttl(minKey);
  pipeline.incr(dayKey);
  pipeline.ttl(dayKey);
  const results = await pipeline.exec();

  if (!results) return { allowed: true, remaining_min: 0, remaining_day: 0 };

  const countMin = results[0]?.[1] as number ?? 0;
  const ttlMin   = results[1]?.[1] as number ?? -1;
  const countDay = results[2]?.[1] as number ?? 0;
  const ttlDay   = results[3]?.[1] as number ?? -1;

  if (countMin === 1 || ttlMin === -1) await r.expire(minKey, RL_MIN_TTL);
  if (countDay === 1 || ttlDay === -1) await r.expire(dayKey, RL_DAY_TTL);

  const unlimitedMin = rate_limit_per_minute < 0;
  const unlimitedDay = rate_limit_per_day    < 0;

  const remaining_min = unlimitedMin ? -1 : Math.max(0, rate_limit_per_minute - countMin);
  const remaining_day = unlimitedDay ? -1 : Math.max(0, rate_limit_per_day    - countDay);

  if (!unlimitedMin && countMin > rate_limit_per_minute) {
    return { allowed: false, remaining_min: 0, remaining_day, retry_after: RL_MIN_TTL };
  }
  if (!unlimitedDay && countDay > rate_limit_per_day) {
    return { allowed: false, remaining_min, remaining_day: 0, retry_after: RL_DAY_TTL };
  }

  return { allowed: true, remaining_min, remaining_day };
}