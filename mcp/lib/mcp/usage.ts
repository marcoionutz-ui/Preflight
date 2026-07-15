/**
 * lib/mcp/usage.ts
 * Request logging → Supabase mcp_request_logs
 * Fire and forget — nu blochează requestul
 */

import { supabaseAdmin } from "@/lib/db/supabase-admin";
import { getRedis }      from "@/lib/db/redis";
import { randomUUID }    from "crypto";

export interface UsageLog {
  client_id:    string;
  tool_name:    string;
  status:       "ok" | "error";
  error_code:   string | null;
  latency_ms:   number;
  request_id:   string;
  credits_used: number;
}

export function logUsage(log: UsageLog): void {
  supabaseAdmin
    .from("mcp_request_logs")
    .insert({
      id:           randomUUID(),
      client_id:    log.client_id,
      tool_name:    log.tool_name,
      status:       log.status,
      error_code:   log.error_code,
      latency_ms:   log.latency_ms,
      request_id:   log.request_id,
      credits_used: log.credits_used,
      created_at:   new Date().toISOString(),
    })
    .then(() => {}, () => {});
}

export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Audit/reporting only — sums the Supabase log, not used for quota
 * enforcement anymore (see reserveQuota() below). Kept for a future
 * "usage this month" dashboard view; not on the hot request path.
 */
export async function getMonthlyCreditsUsed(clientId: string): Promise<number> {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { data, error } = await supabaseAdmin
    .from("mcp_request_logs")
    .select("credits_used")
    .eq("client_id", clientId)
    .eq("status", "ok")
    .gte("created_at", startOfMonth.toISOString());

  if (error || !data) return 0;
  return data.reduce((sum, row) => sum + (row.credits_used ?? 1), 0);
}

// ── Atomic quota enforcement (Redis) ────────────────────────────────────────
//
// getMonthlyCreditsUsed() above summed mcp_request_logs on every request —
// besides being a full-table SELECT per call, it's check-then-act: two
// concurrent requests can both read "used" below quota and both pass,
// overshooting the limit. reserveQuota() replaces it as the enforcement
// path: a Lua script runs the check + increment + TTL-set as one atomic
// Redis operation, so concurrent requests serialize on the check itself
// instead of racing on a stale read (or, with a plain INCRBY-then-rollback,
// producing false denials under contention — see the comment on
// RESERVE_QUOTA_LUA below). Supabase logging (logUsage /
// getMonthlyCreditsUsed) stays as the audit trail — it's just no longer the
// source of truth for the gate itself.

const QUOTA_KEY_TTL_SEC = 32 * 24 * 60 * 60; // outlives any calendar month; next month just uses a new key

function quotaKey(clientId: string): string {
  const now = new Date();
  const ym  = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `mcp:quota:${clientId}:${ym}`;
}

export interface QuotaReservation {
  allowed:  boolean;
  used:     number;
  // Whether the Redis counter was actually incremented. False for unlimited
  // plans, a down Redis, or a script error that fell back to fail-open —
  // three cases the caller can't tell apart from `allowed: true` alone.
  // refundQuota() must only run when this is true, otherwise it can
  // decrement a counter that was never touched.
  reserved: boolean;
  // The exact key that was incremented, pinned at reserve time. Not
  // recomputed at refund time — quotaKey() depends on the current month,
  // so a request straddling a month boundary (reserved 23:59:59 UTC,
  // refunded 00:00:01 UTC) would otherwise refund next month's counter
  // instead of the one it actually charged.
  key:      string | null;
}

// INCRBY-then-check-then-DECRBY (the previous version of this function) is
// only atomic per-step, not as a sequence: a concurrent request can read the
// temporarily-over-quota counter between another request's INCRBY and its
// rollback DECRBY, and get falsely denied even though it would've fit once
// the rollback landed. This Lua script makes GET+compare+INCRBY+EXPIRE a
// single Redis operation — Redis executes scripts atomically, so concurrent
// reservations serialize instead of interleaving. A request that would be
// rejected never touches the counter at all, so no rollback is needed for
// the quota-exceeded path (refundQuota below is still needed for the
// separate case of a reservation that succeeded but the tool call errored).
const RESERVE_QUOTA_LUA = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local credits = tonumber(ARGV[1])
local quota   = tonumber(ARGV[2])
local ttl     = tonumber(ARGV[3])

if current + credits > quota then
  return {0, current}
end

local newTotal = redis.call("INCRBY", KEYS[1], credits)
if redis.call("TTL", KEYS[1]) < 0 then
  redis.call("EXPIRE", KEYS[1], ttl)
end

return {1, newTotal}
`;

// Floors at zero — a refund should never leave the counter negative, e.g.
// if two errors get refunded against a counter that a concurrent rotation
// or manual reset already zeroed. DEL instead of DECRBY-then-SET-0 when the
// refund would exhaust the balance, so a fully-refunded key doesn't linger
// around at 0 with no TTL.
const REFUND_QUOTA_LUA = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local credits = tonumber(ARGV[1])

if current <= credits then
  redis.call("DEL", KEYS[1])
  return 0
end

return redis.call("DECRBY", KEYS[1], credits)
`;

/**
 * Atomically reserves `credits` against the client's monthly quota.
 * Charges up front — call refundQuota() if the tool call ends up erroring,
 * so only successful calls consume quota (same semantics the old
 * Supabase-summing check had, minus the race).
 *
 * Fails open if Redis is unreachable or the script call throws — an outage
 * shouldn't turn into a hard denial for every paying client. This function
 * is called before middleware.ts's try/catch even starts, so it must never
 * throw itself; the try/catch here is load-bearing, not decorative.
 */
export async function reserveQuota(
  clientId:     string,
  credits:      number,
  monthlyQuota: number,
): Promise<QuotaReservation> {
  if (monthlyQuota === -1) return { allowed: true, used: 0, reserved: false, key: null };

  const r = getRedis();
  if (!r) return { allowed: true, used: 0, reserved: false, key: null };

  const key = quotaKey(clientId);

  try {
    const result = await r.eval(
      RESERVE_QUOTA_LUA,
      1,
      key,
      String(credits),
      String(monthlyQuota),
      String(QUOTA_KEY_TTL_SEC),
    ) as [number, number];

    const allowed = result[0] === 1;
    // Only allowed reservations actually incremented the counter — the
    // Lua script returns {0, current} without touching Redis when denied.
    return { allowed, used: Number(result[1]), reserved: allowed, key: allowed ? key : null };
  } catch (err) {
    console.error("[QUOTA] reserve failed open:", err instanceof Error ? err.message : err);
    return { allowed: true, used: 0, reserved: false, key: null };
  }
}

/**
 * Refunds a reservation after the tool call errored — errors don't consume
 * quota. Takes the exact key returned by reserveQuota(), not a freshly
 * recomputed one: the caller must only invoke this when reserved was true,
 * and only with that same key (see QuotaReservation.key/.reserved docs).
 */
export async function refundQuota(key: string | null, credits: number): Promise<void> {
  if (!key || credits <= 0) return;
  const r = getRedis();
  if (!r) return;

  try {
    await r.eval(REFUND_QUOTA_LUA, 1, key, String(credits));
  } catch (err) {
    // Swallow — this runs inside middleware's success/error paths and must
    // never throw, or it'd shadow the real tool result/error being returned.
    console.error("[QUOTA] refund failed:", err instanceof Error ? err.message : err);
  }
}