/**
 * lib/mcp/usage.ts
 * Request logging → Supabase mcp_request_logs
 * Fire and forget — nu blochează requestul
 */

import { supabaseAdmin } from "@/lib/db/supabase-admin";
import { randomUUID }    from "crypto";

export interface UsageLog {
  client_id:  string;
  tool_name:  string;
  status:     "ok" | "error";
  error_code: string | null;
  latency_ms: number;
  request_id: string;
}

export function logUsage(log: UsageLog): void {
  supabaseAdmin
    .from("mcp_request_logs")
    .insert({
      id:         randomUUID(),
      client_id:  log.client_id,
      tool_name:  log.tool_name,
      status:     log.status,
      error_code: log.error_code,
      latency_ms: log.latency_ms,
      request_id: log.request_id,
      created_at: new Date().toISOString(),
    })
    .then(() => {});
}

export function generateRequestId(): string {
  return randomUUID();
}