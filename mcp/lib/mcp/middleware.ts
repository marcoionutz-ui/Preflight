/**
 * lib/mcp/middleware.ts
 * Middleware layer pentru MCP tools:
 * - AsyncLocalStorage pentru request context izolat per request
 * - Scope enforcement per tool
 * - Usage logging → Supabase (fire and forget)
 * - Timing per tool call
 */

import { AsyncLocalStorage }           from "async_hooks";
import type { McpServer }              from "@modelcontextprotocol/sdk/server/mcp.js";
import { logUsage, generateRequestId } from "./usage";
import { hasScope }                    from "./scopes";
import { mcpErr, ERR }                 from "./errors";

// ── Request context ───────────────────────────────────────────────────────────

export interface ToolContext {
  clientId: string;
  scopes:   string[];
}

const contextStorage = new AsyncLocalStorage<ToolContext>();

/**
 * Rulează fn în contextul requestului curent.
 * Fiecare request are contextul lui izolat — thread-safe.
 */
export function withToolContext<T>(ctx: ToolContext, fn: () => T): T {
  return contextStorage.run(ctx, fn);
}

export function getToolContext(): ToolContext {
  return contextStorage.getStore() ?? { clientId: "unknown", scopes: [] };
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

      // 1. Scope check
      if (!hasScope(ctx.scopes, name)) {
        const latency = Date.now() - startTime;
        logUsage({
          client_id:  ctx.clientId,
          tool_name:  name,
          status:     "error",
          error_code: ERR.FORBIDDEN,
          latency_ms: latency,
          request_id: requestId,
        });
        return mcpErr(
          ERR.FORBIDDEN,
          `Insufficient scope for ${name}. Your scopes: ${ctx.scopes.join(", ")}`,
        );
      }

      // 2. Execute original handler
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

        logUsage({
          client_id:  ctx.clientId,
          tool_name:  name,
          status,
          error_code: errorCode,
          latency_ms: latency,
          request_id: requestId,
        });

        return result;
      } catch (e) {
        const latency = Date.now() - startTime;
        logUsage({
          client_id:  ctx.clientId,
          tool_name:  name,
          status:     "error",
          error_code: ERR.INTERNAL,
          latency_ms: latency,
          request_id: requestId,
        });
        return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e));
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