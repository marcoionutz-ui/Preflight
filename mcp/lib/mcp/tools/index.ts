/**
 * lib/mcp/tools/index.ts
 * Înregistrează toate toolurile MCP cu usage logging + scope enforcement
 * prin createInstrumentedServer — toolurile individuale nu se modifică
 */

import type { McpServer }           from "@modelcontextprotocol/sdk/server/mcp.js";
import { createInstrumentedServer } from "../middleware";

import { registerHealthCheck }      from "./tp_health_check";
import { registerPairContext }      from "./tp_pair_context";
import { registerWorkerPipeline }   from "./tp_worker_pipeline";
import { registerWorkerSnapshot }   from "./tp_worker_snapshot";
import { registerMarketOverview }   from "./tp_market_overview";
import { registerSituationReport }  from "./tp_situation_report";
import { registerCandidateBrief }   from "./tp_candidate_brief";
import { registerWhyNot }           from "./tp_why_not";
import { registerDoNotChase }       from "./tp_do_not_chase";
import { registerPreflightSafety }  from "./tp_preflight_safety";
import { registerChaseRisk }        from "./tp_chase_risk";
import { registerPositionContext }  from "./tp_position_context";
import { registerChainReport }      from "./tp_chain_report";
import { registerNextAction }       from "./tp_agent_brief";

export function registerAllTools(server: McpServer, exposePerformance = false): void {
  // Instrumentăm server-ul o singură dată — toate toolurile primesc middleware automat
  const s = createInstrumentedServer(server);

  registerHealthCheck(s, exposePerformance);
  registerPairContext(s, exposePerformance);
  registerWorkerPipeline(s);
  registerWorkerSnapshot(s, exposePerformance);
  registerMarketOverview(s);
  registerSituationReport(s);
  registerCandidateBrief(s, exposePerformance);
  registerWhyNot(s, exposePerformance);
  registerDoNotChase(s);
  registerPreflightSafety(s);
  registerChaseRisk(s);
  registerChainReport(s);
  registerPositionContext(s);
  registerNextAction(s);
}