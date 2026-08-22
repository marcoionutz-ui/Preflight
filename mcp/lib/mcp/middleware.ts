/**
 * lib/mcp/middleware.ts
 * Middleware layer pentru MCP tools:
 * - AsyncLocalStorage pentru request context izolat per request
 * - Scope enforcement per tool
 * - Usage logging → Supabase (fire and forget)
 * - Timing per tool call
 */

import type { McpServer }              from "@modelcontextprotocol/sdk/server/mcp.js";
import { logUsage, generateRequestId, reserveQuota, refundQuota } from "./usage";
import { getToolCredits, resolvePlan }                  from "./billing";
import { toolAuthorized }                               from "./scopes";
import { mcpErr, ERR, sanitizeToolError }                                   from "./errors";
// PH-2 (9b-wire): context + builder pur trăiesc în `toolContext.ts` (modul ușor, testabil). Re-exportate aici ca
// importurile caller-ilor (`route.ts`, `tp_watch_pair.ts`) să rămână neschimbate.
import { getToolContext } from "./toolContext";
export { withToolContext, getToolContext, buildToolContext, type ToolContext } from "./toolContext";

// ── Plan-mismatch telemetry (E10) ──────────────────────────────────────────────
// Loud but de-duplicat: un plan necunoscut din DB (typo / plan legacy / drift DB↔cod) → degradat la free_trial,
// dar semnalat zgomotos O SINGURĂ dată per client+plan într-o fereastră, ca să prindem drift-ul fără spam.
const PLAN_MISMATCH_COOLDOWN_MS = 10 * 60_000;
const PLAN_MISMATCH_MAX_ENTRIES = 10_000;
const planMismatchLoggedAt = new Map<string, number>();

function logPlanMismatchOnce(clientId: string, receivedPlan: string): void {
  const key  = `${clientId}:${receivedPlan}`;
  const now  = Date.now();
  const last = planMismatchLoggedAt.get(key) ?? 0;
  if (now - last < PLAN_MISMATCH_COOLDOWN_MS) return;
  planMismatchLoggedAt.set(key, now);
  // Plafon de memorie: evacuează cele mai vechi intrări (Map păstrează ordinea de inserare).
  while (planMismatchLoggedAt.size > PLAN_MISMATCH_MAX_ENTRIES) {
    const oldest = planMismatchLoggedAt.keys().next().value;
    if (oldest === undefined) break;
    planMismatchLoggedAt.delete(oldest);
  }
  console.warn(`[PLAN_CONFIG_MISMATCH] clientId=${clientId} receivedPlan=${receivedPlan || "(none)"} fallback=free_trial`);
}

// ── Server instrumentation ────────────────────────────────────────────────────

/**
 * Wraps McpServer cu middleware transparent.
 * Toolurile se înregistrează normal — nu știu de middleware.
 */
export function createInstrumentedServer(server: McpServer): McpServer {
  const originalRegisterTool = server.registerTool.bind(server);

  (server as unknown as Record<string, unknown>)["registerTool"] = (
    name: string,
    config: unknown,
    handler: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>,
  ) => {
    const instrumentedHandler = async (args: Record<string, unknown>) => {
      const ctx       = getToolContext();
      const requestId = generateRequestId();
      const startTime = Date.now();

      // 1. Rezolvă planul PRIMUL — e sursa de entitlement (+quota). Plan necunoscut/lipsă → free_trial (NU
      // starter) + telemetrie zgomotoasă (nu retrogradare tăcută).
      const { config: planConfig, mismatch, received } = resolvePlan(ctx.plan);
      if (mismatch) logPlanMismatchOnce(ctx.clientId, received);

      // 2. Entitlement pe DOUĂ straturi (E10): tool-ul e permis DOAR dacă ȘI tokenul ȘI planul rezolvat îl permit.
      // Altfel un client cu plan necunoscut degradat la free_trial dar token `read:all` ar păstra acces `read:all`
      // (reparasem quota, nu entitlement-ul). `toolAuthorized` = hasScope(token) AND hasScope(plan), fără OR-ul
      // periculos din vechiul isRequestAllowed.
      if (!toolAuthorized(name, ctx.scopes, planConfig.allowed_scopes)) {
        logUsage({
          client_id:    ctx.clientId,
          tool_name:    name,
          status:       "error",
          error_code:   ERR.FORBIDDEN,
          latency_ms:   Date.now() - startTime,
          request_id:   requestId,
          credits_used: 0,
        });
        return mcpErr(ERR.FORBIDDEN, `Insufficient scope for ${name}.`);
      }

      // 3. Quota check — reserves credits atomically up front via a Lua
      // script (check+increment+TTL in one Redis op), refunded below if the
      // call ends up erroring. Only a `reserved` outcome actually touched
      // Redis; `reservedKey` (pinned below) is what refundQuota() must use —
      // never recompute from ctx.clientId, or it can decrement a counter that
      // degraded/unlimited never incremented, or hit next month's key if the
      // request straddles a month boundary.
      const credits = getToolCredits(name);

      // E10: quota discriminată — `unavailable` (Redis jos, buget degraded epuizat) → QUOTA_UNAVAILABLE (eroare
      // MCP cu isError + retryAfter — NU un HTTP 503; quota-gate e per-tool, în interiorul dispatch-ului MCP,
      // deci nu poate emite un status HTTP ca auth/rate-limit). Distinct de `exceeded` (limită lunară reală).
      // reserved|unlimited|degraded → trece mai departe.
      // PH-2 (9b-wire): quota lunară pe SUBIECTUL purtat din `resolveAuth` (NU reconstruit aici). Token client →
      // subiect client → cheie identică cu azi; token user (la cutover) → subiect account → quota pe user_id.
      const quota = await reserveQuota(ctx.quotaSubject, credits, planConfig.monthly_quota);
      if (quota.status === "unavailable") {
        logUsage({
          client_id:    ctx.clientId,
          tool_name:    name,
          status:       "error",
          error_code:   ERR.QUOTA_UNAVAILABLE,
          latency_ms:   Date.now() - startTime,
          request_id:   requestId,
          credits_used: 0,
        });
        return mcpErr(ERR.QUOTA_UNAVAILABLE, "Quota backend temporarily unavailable — retry shortly.", { retryAfter: 2 });
      }
      if (quota.status === "exceeded") {
        logUsage({
          client_id:    ctx.clientId,
          tool_name:    name,
          status:       "error",
          error_code:   ERR.QUOTA_EXCEEDED,
          latency_ms:   Date.now() - startTime,
          request_id:   requestId,
          credits_used: 0,
        });
        return mcpErr(ERR.QUOTA_EXCEEDED, `Monthly quota exceeded for plan ${received || "unknown"}.`);
      }

      // Doar o rezervare `reserved` a atins contorul Redis → doar ea se poate refunda.
      const reservedKey = quota.status === "reserved" ? quota.key : null;

      // 3. Execute original handler
      try {
        const result  = await handler(args);
        const latency = Date.now() - startTime;

        // Determină status din response
        let status: "ok" | "error" = "ok";
        let errorCode: string | null = null;
        try {
          const text = result?.content?.[0]?.text ?? "";
          if (text.startsWith("{")) {
            const parsed = JSON.parse(text) as { ok?: boolean; error?: { code?: string } };
            if (parsed?.ok === false) {
              status    = "error";
              errorCode = parsed?.error?.code ?? "UNKNOWN";
            }
          }
        } catch { /* non-JSON response = ok */ }

        if (status === "error" && reservedKey) await refundQuota(reservedKey, credits);

        logUsage({
          client_id:    ctx.clientId,
          tool_name:    name,
          status,
          error_code:   errorCode,
          latency_ms:   latency,
          request_id:   requestId,
          credits_used: status === "ok" ? credits : 0,
        });

        return result;
      } catch (e) {
        const latency = Date.now() - startTime;
        if (reservedKey) await refundQuota(reservedKey, credits);
        logUsage({
          client_id:    ctx.clientId,
          tool_name:    name,
          status:       "error",
          error_code:   ERR.INTERNAL,
          latency_ms:   latency,
          request_id:   requestId,
          credits_used: 0,
        });
        return mcpErr(ERR.INTERNAL, sanitizeToolError(e));
      }
    };

    return originalRegisterTool(
      name,
      config as Parameters<typeof originalRegisterTool>[1],
      instrumentedHandler as Parameters<typeof originalRegisterTool>[2],
    );
  };

  return server;
}