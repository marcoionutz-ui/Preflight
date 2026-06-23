/**
 * discovery/discoveryLoop.ts
 * Discovery loop — eth_getLogs per batch, decode, sanity check, optional registry write.
 *
 * INDEXER_DRY_RUN=true  (implicit default) → decode + log only, fără write Redis
 * INDEXER_DRY_RUN=false                   → decode + write pair registry
 *
 * Per batch:
 *   1. eth_getLogs cu adrese factory + topic0s (OR) pentru chain-ul dat
 *   2. Decode fiecare log prin eventDecoder (adapter-specific)
 *   3. Sanity check (zero addr, token0 ≠ token1, etc.)
 *   4. DRY_RUN: log | LIVE: writePair în Redis registry
 *   5. writeCursor(toBlock) după fiecare batch reușit — nu skipăm niciodată blocuri silențios
 *
 * La eth_getLogs failure: loghează, break — cursorul rămâne la ultimul batch reușit.
 */

import { getLogs, toHex, getRpcUrl } from "../infra/rpc";
import { getEnabledFactories, getFactoryByAddress } from "../config/factories";
import type { ChainId } from "../config/factories";
import { getBatchRanges, writeCursor } from "../infra/cursor";
import type { CursorState } from "../infra/cursor";
import { decodeLog, sanityCheck } from "./eventDecoder";
import { writePair } from "./pairRegistry";
import type { WritePairResult } from "./pairRegistry";

/** true = log only, false = write registry. Default: true. */
export const DRY_RUN = process.env.INDEXER_DRY_RUN !== "false";

/**
 * Whether to advance the real cursor in DRY_RUN mode.
 * Default: false — dry-run re-scans the same blocks every loop so you can validate logs.
 * Set INDEXER_DRY_RUN_ADVANCE_CURSOR=true if you want cursor to advance during dry-run.
 * In LIVE mode (DRY_RUN=false) cursor always advances.
 */
const ADVANCE_CURSOR = !DRY_RUN || process.env.INDEXER_DRY_RUN_ADVANCE_CURSOR === "true";

export interface DiscoveryResult {
  pairsFound:         number;        // genuinely new pairs (NX write succeeded or dry-run count)
  lastProcessedBlock: number;        // last persisted cursor position (original if DRY_RUN + no advance)
  batchesProcessed:   number;        // batches completed (0 if already at latest or error on first batch)
  error?:             string;        // first batch error message, if any
}

/**
 * Runs discovery for one chain across all pending batch ranges.
 * Writes cursor to Redis after each successful batch.
 * Returns summary suitable for health reporting.
 */
export async function runDiscovery(
  chain:       ChainId,
  cursor:      CursorState,
  latestBlock: number,
): Promise<DiscoveryResult> {
  const rpcUrl    = getRpcUrl(chain);
  const factories = getEnabledFactories(chain);
  const addresses = factories.map(f => f.address);

  // Union of all topic0s — eth_getLogs OR filter
  const topic0s = [...new Set(factories.map(f => f.topic0))];

  const batches = getBatchRanges(cursor, latestBlock);

  let pairsFound         = 0;
  let lastProcessedBlock = cursor.lastBlock; // stays at original if ADVANCE_CURSOR=false
  let batchesProcessed   = 0;
  let discoveryError: string | undefined;

  // Nothing to process (already at latest, or SKIP_TO_LATEST just ran)
  if (batches.length === 0) {
    return { pairsFound, lastProcessedBlock, batchesProcessed };
  }

  for (const { fromBlock, toBlock } of batches) {
    let logs;
    try {
      logs = await getLogs(rpcUrl, {
        fromBlock: toHex(fromBlock),
        toBlock:   toHex(toBlock),
        address:   addresses,
        topics:    [topic0s],
      });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(
        `[DISCOVERY][${chain.toUpperCase()}] eth_getLogs failed ` +
        `(blocks ${fromBlock}→${toBlock}): ${msg}`,
      );
      // Don't advance cursor — retry on next loop iteration
      discoveryError = msg;
      break;
    }

    let batchNew    = 0;
    let batchFailed = false;

    for (const log of logs) {
      // Map log address back to its factory config
      const factory = getFactoryByAddress(chain, log.address);
      if (!factory) continue;

      const decoded = decodeLog(log, factory.adapter);
      if (!decoded) {
        console.warn(
          `[DISCOVERY][${chain.toUpperCase()}] decode null @ tx:${log.transactionHash} log:${log.logIndex}`,
        );
        continue;
      }
      if (!sanityCheck(decoded)) {
        console.warn(
          `[DISCOVERY][${chain.toUpperCase()}] sanity fail — ` +
          `t0:${decoded.token0} t1:${decoded.token1} pair:${decoded.pairAddress}`,
        );
        continue;
      }

      if (DRY_RUN) {
        console.log(
          `[DISCOVERY][DRY_RUN][${chain.toUpperCase()}] ${factory.dexId}: ` +
          `${decoded.token0} / ${decoded.token1} → ${decoded.pairAddress}` +
          (decoded.stable      !== undefined ? ` stable:${decoded.stable}`           : "") +
          (decoded.fee         !== undefined ? ` fee:${decoded.fee}`                  : "") +
          (decoded.tickSpacing !== undefined ? ` tickSpacing:${decoded.tickSpacing}` : "") +
          (decoded.hooks       !== undefined ? ` hooks:${decoded.hooks}`             : "") +
          ` block:${decoded.blockNumber}`,
        );
        batchNew++;
      } else {
        const result: WritePairResult = await writePair(chain, factory.dexId, decoded);
        if (result === "inserted") {
          batchNew++;
        } else if (result === "error") {
          // Redis failure — abort this batch without advancing cursor
          // The pair will be retried on the next loop iteration
          discoveryError = `Redis write failed for pair ${decoded.pairAddress}`;
          batchFailed = true;
          break;
        }
        // "exists" → pair already in registry, continue silently
      }
    }

    // On Redis failure: stop outer loop too — don't advance cursor
    if (batchFailed) break;

    // Cursor advance: always in LIVE mode, optional in DRY_RUN
    if (ADVANCE_CURSOR) {
      await writeCursor(chain, toBlock);
      lastProcessedBlock = toBlock;
    }
    batchesProcessed++;
    pairsFound += batchNew;

    console.log(
      `[DISCOVERY][${chain.toUpperCase()}] ` +
      `blocks ${fromBlock}→${toBlock} | ` +
      `logs:${logs.length} | new:${batchNew} | ` +
      `dry_run:${DRY_RUN} | cursor_advance:${ADVANCE_CURSOR}`,
    );
  }

  return { pairsFound, lastProcessedBlock, batchesProcessed, error: discoveryError };
}
