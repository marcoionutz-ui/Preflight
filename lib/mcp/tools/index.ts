/**
 * lib/mcp/tools/index.ts
 * Înregistrează toate toolurile MCP pe server
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHealthCheck }     from "./tp_health_check";
import { registerPairContext }     from "./tp_pair_context";
import { registerWorkerPipeline }  from "./tp_worker_pipeline";
import { registerWorkerSnapshot }  from "./tp_worker_snapshot";
import { registerMarketOverview }  from "./tp_market_overview";
import { registerSituationReport } from "./tp_situation_report";
import { registerCandidateBrief }  from "./tp_candidate_brief";
import { registerWhyNot }          from "./tp_why_not";
import { registerDoNotChase }      from "./tp_do_not_chase";
import { registerPreflightSafety } from "./tp_preflight_safety";

export function registerAllTools(server: McpServer, exposePerformance = false): void {
  registerHealthCheck(server, exposePerformance);
  registerPairContext(server, exposePerformance);
  registerWorkerPipeline(server);
  registerWorkerSnapshot(server, exposePerformance);
  registerMarketOverview(server);
  registerSituationReport(server);
  registerCandidateBrief(server, exposePerformance);
  registerWhyNot(server, exposePerformance);
  registerDoNotChase(server);
  registerPreflightSafety(server);
}