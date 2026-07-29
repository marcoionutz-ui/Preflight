import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis, dedupeByPair, resolvePairChain } from "../redis-reader";
import { classifyEmptyDrops, isWorkerFresh } from "../health-freshness";
import { mcpResponse, mcpErr, ERR } from "../errors";

export function registerRecentPipelineDrops(server: McpServer) {
  server.registerTool(
    "tp_recent_pipeline_drops",
    {
      title: "Preflight Recent Pipeline Drops",
      description: `Pairs recently dropped from HOT/ARMED/WATCHING, with reasons.

Reports pipeline exits — pairs that looked active but were dropped or rejected by
the worker's criteria. Evidence of why continuation didn't hold; not a recommendation.

Args: limit (default 10, max 30), minutes_back (default 10, max 10)`,
      inputSchema: {
        limit:        z.number().int().min(1).max(30).default(10),
        minutes_back: z.number().int().min(1).max(10).default(10),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit, minutes_back }: { limit: number; minutes_back: number }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, drops, states, snapshotSavedAtByChain, knownChains } = ctx;
        // E15 (varu R4): worker proaspăt = TOATE chain-urile CUNOSCUTE au snapshot ȘI cel mai slab e <60s (nu max,
        // și nu doar live — un chain mort iese din live după 120s și ar dispărea din calcul).
        const workerFresh = isWorkerFresh(now, snapshotSavedAtByChain, knownChains);
        const cutoff     = now - minutes_back * 60_000;
        const rawRecent  = drops.filter(d => d.droppedAt >= cutoff);
        const deduped    = dedupeByPair(rawRecent, "droppedAt")
          .sort((a, b) => (b.droppedAt ?? 0) - (a.droppedAt ?? 0))
          .slice(0, limit);

        // E15: listă goală ≠ „zero drop-uri". HIGH doar dacă datele sunt citibile (cheie prezentă + JSON valid pe
        // toate chain-urile deținute) ȘI worker-ul e proaspăt. Absent/corupt/worker-stale → LOW + warning.
        if (!deduped.length) {
          const rep = classifyEmptyDrops({ dropsReadable: ctx.recentDropsReadable, workerFresh, minutesBack: minutes_back });
          return mcpResponse({ text: rep.text, confidence: rep.confidence, warnings: rep.warnings });
        }

        const lines: string[] = [];
        lines.push(`RECENT PIPELINE DROPS — last ${minutes_back}m (${deduped.length} pairs):`);
        lines.push("");

        for (const d of deduped) {
          const ageSec    = Math.round((now - d.droppedAt) / 1000);
          // B3f: states e keyed pe pairKey(chain, addr). Drop-ul poartă chain
          // (d.chain) → construim cheia cu hint-ul; fallback probe dacă lipsește.
          const dAddr     = (d.pairAddress ?? "").toLowerCase();
          const dKey      = dAddr ? (resolvePairChain(dAddr, [states], d.chain).key ?? "") : "";
          const pairData  = states[dKey];
          // pairData.phase is now a real Phase union (item 4b), which can
          // never equal the "?" sentinel — swapped for an undefined check,
          // which also covers the (TS-invisible-here) case where the
          // address just isn't a key in `states` at all.
          const phase     = pairData?.phase;
          const countNote = d._eventCount > 1 ? ` (${d._eventCount} drops in ${minutes_back}m)` : "";

          const fromState = d.wasIn ?? "UNKNOWN";
          const reason    = d.dropReason ?? "unknown";
          const symbol    = d.symbol ?? d.pairAddress?.slice(0, 8) ?? "UNKNOWN";
          const chain     = d.chain ?? "unknown";

          let line = `${symbol} [${chain}] — dropped from ${fromState} ${ageSec}s ago${countNote}`;
          line += `\n  Reason: ${reason}`;
          if (phase) line += ` | phase: ${phase}`;
          if (pairData?.flow?.hasData) line += ` | flow now: ${pairData.flow.pressure}`;

          const r = reason.toLowerCase();
          if (r.includes("flow faded") || r.includes("flow turned") || r.includes("no buying flow")) {
            line += "\n  → Fresh WS confirmation absent; continuation evidence not currently present.";
			} else if (r.includes("too late") || r.includes("vertical")) {
            line += "\n  → Price extension was elevated when the pipeline exit occurred.";
          } else if (r.includes("dump")) {
            line += "\n  → Price declined after the pipeline event; continuation was not confirmed.";
          } else if (r.includes("gate") || r.includes("score") || r.includes("evidence")) {
            line += "\n  → Failed quality check. Worker's criteria not met.";
          } else if (r.includes("no ws") || r.includes("no confirmation")) {
            line += "\n  → Live-flow confirmation was not observed before this exit.";
          } else if (r.includes("expired") || r.includes("5m")) {
            line += "\n  → Timed out without confirmation inside the observation window.";
          }

          lines.push(line);
          lines.push("");
        }

        // E15 (varu R4): drop-urile listate sunt dovezi reale, DAR fereastra e COMPLETĂ doar dacă worker-ul e
        // proaspăt ȘI recent_drops e citibilă pe toate chain-urile cunoscute (altfel un payload BSC corupt/absent
        // sau un chain stale lasă găuri). Fără completitudine → LOW + warning; drop-urile rămân listate.
        const windowComplete = workerFresh && ctx.recentDropsReadable;
        return mcpResponse({
          text: lines.join("\n").trim(),
          confidence: windowComplete ? "HIGH" : "LOW",
          freshnessSec: Math.round((now - (deduped[0]?.droppedAt ?? now)) / 1000),
          warnings: windowComplete ? undefined
            : ["Listed drops are recorded evidence, but coverage of the requested window may be incomplete (worker stale or recent-drops unreadable on ≥1 known chain)."],
		});
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
