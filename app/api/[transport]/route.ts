/**
 * app/api/[transport]/route.ts
 * Preflight MCP Server — HTTP handler
 *
 * Tot codul de business e în:
 *   lib/mcp/tools/    — tool definitions
 *   lib/mcp/auth.ts   — autentificare
 *   lib/mcp/          — layere comerciale
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "@/lib/mcp/tools";
import { authenticate, authErrorResponse } from "@/lib/mcp/auth";
import type { NextRequest } from "next/server";

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
  return handler(req);
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth.ok) return authErrorResponse(auth);
  return handler(req);
}
