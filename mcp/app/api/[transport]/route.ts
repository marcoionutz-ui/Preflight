/**
 * app/api/[transport]/route.ts
 * Preflight MCP Server — HTTP handler
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createMcpHandler }                from "mcp-handler";
import { registerAllTools }                from "@/lib/mcp/tools";
import { authenticate, authErrorResponse } from "@/lib/mcp/auth";
import { withToolContext }                 from "@/lib/mcp/middleware";
import type { NextRequest }                from "next/server";

const EXPOSE_PERFORMANCE = process.env.MCP_EXPOSE_PERFORMANCE === "true";

const handler = createMcpHandler(
  (server) => {
    registerAllTools(server, EXPOSE_PERFORMANCE);
  },
  {},
  {
    basePath:    "/api",
    maxDuration: 60,
    verboseLogs: process.env.NODE_ENV !== "production",
  },
);

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth.ok) return authErrorResponse(auth);
  return withToolContext(
    { clientId: auth.clientId!, scopes: auth.scopes!, plan: auth.plan },
    () => handler(req),
  );
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth.ok) return authErrorResponse(auth);
  return withToolContext(
    { clientId: auth.clientId!, scopes: auth.scopes!, plan: auth.plan },
    () => handler(req),
  );
}