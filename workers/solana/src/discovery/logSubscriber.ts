/**
 * discovery/logSubscriber.ts
 * 8.0c: Shadow discovery — subscribe la logs program pentru Raydium + pump.fun.
 * Nu scrie în Redis; logează ce găsește și actualizează cursorul prin callback.
 *
 * TODO 8.0d: parse log messages pentru pool init events + enrich token metadata.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  RAYDIUM_AMM_V4,
  RAYDIUM_CLMM,
  RAYDIUM_CPMM,
  PUMPFUN_PROGRAM,
} from "../config/programs";

export interface LogEvent {
  program:   string;
  programId: string;
  signature: string;
  slot:      number;
  logs:      string[];
}

type LogCallback = (event: LogEvent) => void;

const DISCOVERY_PROGRAMS: Array<{ name: string; id: string }> = [
  { name: "raydium_amm_v4", id: RAYDIUM_AMM_V4 },
  { name: "raydium_clmm",   id: RAYDIUM_CLMM   },
  { name: "raydium_cpmm",   id: RAYDIUM_CPMM   },
  { name: "pumpfun",        id: PUMPFUN_PROGRAM },
];

/**
 * Pornește subscriptions onLogs pentru toate programele de discovery.
 * Apelează callback pentru fiecare tranzacție reușită (err === null).
 * Returnează un array de subscription IDs (pentru unsubscribe la nevoie).
 */
export function startLogSubscriptions(
  connection: Connection,
  onLog: LogCallback,
): number[] {
  const subIds: number[] = [];

  for (const { name, id } of DISCOVERY_PROGRAMS) {
    const pubkey = new PublicKey(id);

    const subId = connection.onLogs(
      pubkey,
      (logs, ctx) => {
        if (logs.err !== null) return; // skip failed txs
        onLog({
          program:   name,
          programId: id,
          signature: logs.signature,
          slot:      ctx.slot,
          logs:      logs.logs,
        });
      },
      "confirmed",
    );

    subIds.push(subId);
    console.log(
      "[SOLANA][DISCOVERY] subscribed:"
      + " program=" + name
      + " id=" + id.slice(0, 8) + "..."
      + " subId=" + subId,
    );
  }

  return subIds;
}
