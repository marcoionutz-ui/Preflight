/**
 * app/api/[transport]/route.ts
 * Preflight MCP Server — HTTP handler
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createMcpHandler }                from "mcp-handler";
import { registerAllTools }                from "@/lib/mcp/tools";
import { authenticate, authErrorResponse } from "@/lib/mcp/auth";
import { withToolContext, buildToolContext } from "@/lib/mcp/middleware";
import type { NextRequest }                from "next/server";



const handler = createMcpHandler(
  (server) => {
    registerAllTools(server);
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
  // PH-2 (9b-wire): subiectul de quota vine din `auth` (derivat din token în resolveAuth) → context, neschimbat.
  return withToolContext(
    buildToolContext({ clientId: auth.clientId!, scopes: auth.scopes!, plan: auth.plan, subject: auth.subject }),
    () => handler(req),
  );
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth.ok) return authErrorResponse(auth);
  return withToolContext(
    buildToolContext({ clientId: auth.clientId!, scopes: auth.scopes!, plan: auth.plan, subject: auth.subject }),
    () => handler(req),
  );
}