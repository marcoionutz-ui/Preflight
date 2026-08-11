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
import { registerRecentPipelineDrops } from "./tp_recent_pipeline_drops";
import { registerPreflightSafety }  from "./tp_preflight_safety";
import { registerLateMoveContext }  from "./tp_late_move_context";
import { registerPositionContext }  from "./tp_position_context";
import { registerChainReport }      from "./tp_chain_report";
import { registerNextAction }       from "./tp_agent_brief";
import { registerWatchPair } from "./tp_watch_pair";

export function registerAllTools(server: McpServer): void {
  // Instrumentăm server-ul o singură dată — toate toolurile primesc middleware automat
  const s = createInstrumentedServer(server);

  registerHealthCheck(s);
  registerPairContext(s);
  registerWorkerPipeline(s);
  registerWorkerSnapshot(s);
  registerMarketOverview(s);
  registerSituationReport(s);
  registerCandidateBrief(s);
  registerWhyNot(s);
  registerRecentPipelineDrops(s);
  registerPreflightSafety(s);
  registerLateMoveContext(s);
  registerChainReport(s);
  registerPositionContext(s);
  registerNextAction(s);
  registerWatchPair(s);
}