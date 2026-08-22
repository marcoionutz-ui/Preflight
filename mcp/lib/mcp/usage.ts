/**
 * lib/mcp/usage.ts
 * Request logging → Supabase mcp_request_logs
 * Fire and forget — nu blochează requestul
 */

import { supabaseAdmin } from "@/lib/db/supabase-admin";
import { getRedis }      from "@/lib/db/redis";
import { randomUUID }    from "crypto";
import { emergencyQuotaAllow, clearDegradedQuota } from "./degraded";
import { monthlyQuotaKey, yearMonthUTC, type QuotaSubject } from "@/lib/db/quotaKey";

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

// PH-2 (9b): cheia lunară e derivată din SUBIECT via `monthlyQuotaKey` (leaf pur aprobat), NU mai construită aici.
//   subiect client → `mcp:quota:${clientId}:${ym}` (IDENTIC cu formula veche → contoarele client_credentials NU se
//   resetează). subiect account → `mcp:quota:acct:${userId}:${ym}` (doi clienți ai aceluiași user împart o quota).

/** Id stabil pentru plasa degraded in-process. Client → `clientId` (IDENTIC cu azi). Account → `acct:${userId}`.
 *  EXPLICIT pe ambele kind-uri, fără fallback implicit: un kind necunoscut → aruncă (fail-closed, prins de apelant). */
function degradedBucketId(subject: QuotaSubject): string {
  if (subject.kind === "account") return `acct:${subject.userId}`;
  if (subject.kind === "client")  return subject.clientId;
  throw new Error(`degradedBucketId: kind invalid „${(subject as { kind?: unknown }).kind}"`);
}

/**
 * E10: rezultat DISCRIMINAT.
 *   reserved    — contorul Redis a fost incrementat (doar acesta se refundează); `key` e cheia exactă (pinned).
 *   unlimited   — plan cu quota -1 (nimic de urmărit).
 *   exceeded    — quota lunară depășită (limită reală) → caller-ul întoarce QUOTA_EXCEEDED.
 *   degraded    — Redis jos, dar în bugetul mic al ferestrei degraded → permis, NEreconciliat (nu refunda).
 *   unavailable — Redis jos ȘI bugetul/fereastra degraded epuizat → QUOTA_UNAVAILABLE (eroare MCP isError, nu HTTP 503).
 * `refundQuota` rulează DOAR pe `reserved` (altfel ar decrementa un contor neatins — degraded/unlimited nu au scris).
 */
export type QuotaOutcome =
  | { status: "reserved";  used: number; key: string }
  | { status: "unlimited" }
  | { status: "exceeded";  used: number }
  | { status: "degraded" }
  | { status: "unavailable" };

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
 * E10 (design înghețat): NU mai fail-open nelimitat. Fără Redis nu putem enforce quota lunară → cădem pe un
 * buget MICROSCOPIC per client/proces (`emergencyQuotaAllow`: ≤3 requesturi pe o fereastră de 60s), apoi
 * fail-closed (`unavailable` → QUOTA_UNAVAILABLE, eroare MCP). Cele ≤3 rămân nereconciliate, dar pierderea e strict
 * mărginită — mult mai bine decât „billing jos → trafic gratuit nelimitat" sau outage total la un reconnect.
 * Un succes Redis resetează starea degraded a clientului. Nu aruncă niciodată (rulează înainte de try/catch-ul
 * din middleware).
 */
export async function reserveQuota(
  subject:      QuotaSubject,
  credits:      number,
  monthlyQuota: number,
): Promise<QuotaOutcome> {
  // 1. Validează SUBIECTUL PRIMUL (cgpt, fail-closed): construiește cheia (ARUNCĂ pe subiect malformat) ÎNAINTE de
  //    ramurile unlimited / Redis / degraded — un subiect invalid → `unavailable`, NICIODATĂ `unlimited` sau
  //    `degraded` (nu trebuie să scape prin plasa degraded fără să fi trecut validarea). reserveQuota NU aruncă
  //    (rulează înainte de try/catch-ul din middleware) → orice throw devine `unavailable` (nu crash, nu quota gratis).
  let key: string;
  try {
    key = monthlyQuotaKey(subject, yearMonthUTC(new Date()));
  } catch (err) {
    console.error("[QUOTA] subiect invalid pentru cheie:", err instanceof Error ? err.message : err);
    return { status: "unavailable" };
  }

  // 2. unlimited abia DUPĂ ce subiectul e valid (un subiect malformat cu quota -1 tot e `unavailable`, nu `unlimited`).
  if (monthlyQuota === -1) return { status: "unlimited" };

  // 3. Redis / plasa degraded — subiect deja validat. Bucket EXPLICIT pe ambele kind-uri.
  const bucketId = degradedBucketId(subject);
  const r = getRedis();
  if (!r) return degradedQuota(bucketId);

  try {
    const result = await r.eval(
      RESERVE_QUOTA_LUA,
      1,
      key,
      String(credits),
      String(monthlyQuota),
      String(QUOTA_KEY_TTL_SEC),
    ) as [number, number];

    // Redis a răspuns → subiectul iese din degraded.
    clearDegradedQuota(bucketId);

    // Lua întoarce {0, current} fără să atingă Redis când e depășit; {1, newTotal} când a incrementat.
    return result[0] === 1
      ? { status: "reserved", used: Number(result[1]), key }
      : { status: "exceeded", used: Number(result[1]) };
  } catch (err) {
    console.error("[QUOTA] reserve degraded:", err instanceof Error ? err.message : err);
    return degradedQuota(bucketId);
  }
}

/**
 * E10: plasa locală bounded pentru quota când Redis nu răspunde. `allow` → `degraded` (permis, NEreconciliat);
 * buget/fereastră epuizat → `unavailable` (→ QUOTA_UNAVAILABLE, eroare MCP). `bucketId` din `degradedBucketId`.
 */
function degradedQuota(bucketId: string): QuotaOutcome {
  return emergencyQuotaAllow(bucketId) === "allow" ? { status: "degraded" } : { status: "unavailable" };
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