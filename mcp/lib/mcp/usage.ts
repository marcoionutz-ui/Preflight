/**
 * lib/mcp/usage.ts
 * Request logging → Supabase mcp_request_logs
 * Fire and forget — nu blochează requestul
 */

import { supabaseAdmin } from "@/lib/db/supabase-admin";
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

export async function isQuotaExceeded(
  clientId:        string,
  monthlyQuota:    number,
  incomingCredits: number = 1,
): Promise<boolean> {
  if (monthlyQuota === -1) return false;
  const used = await getMonthlyCreditsUsed(clientId);
  return used + incomingCredits > monthlyQuota;
}