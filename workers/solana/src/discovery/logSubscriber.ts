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
  succeeded: boolean; // D2: tranzacția a reușit (err === null)? tx eșuate NU intră în pipeline, dar
                      //     callback-ul lor tot dovedește că subscripția e VIE → contează pt. freshness.
}

type LogCallback = (event: LogEvent) => void;

/** D2: definiție program discovery + dacă e health-critical. `healthCritical:false` = subscripția e
 *  urmărită (contribuie la observed slot) dar staleness-ul ei NU degradează statusul.
 *  D4c: `raydium_amm_v4` a fost promovat — acum ARE pipeline de procesare (fetchAmmV4Init → registry),
 *  deci e `healthCritical:true` (tăcerea lui ascunde ratarea creărilor DIRECTE de pool AMM V4). */
export interface DiscoveryProgramDef {
  name:           string;
  id:             string;
  healthCritical: boolean;
}

const DISCOVERY_PROGRAMS: DiscoveryProgramDef[] = [
  { name: "raydium_amm_v4", id: RAYDIUM_AMM_V4,  healthCritical: true  }, // D4c: pipeline live (Initialize2 → registry)
  { name: "raydium_clmm",   id: RAYDIUM_CLMM,    healthCritical: true  },
  { name: "raydium_cpmm",   id: RAYDIUM_CPMM,    healthCritical: true  },
  { name: "pumpfun",        id: PUMPFUN_PROGRAM, healthCritical: true  },
];

/** D2: programele așteptate + flag `critical` — sursa unică pt. freshness per-program în health.
 *  Un program complet absent din tracker (n-a livrat niciodată) e tot raportat, nu ignorat tăcut. */
export const DISCOVERY_PROGRAM_HEALTH: readonly { program: string; critical: boolean }[] =
  DISCOVERY_PROGRAMS.map(p => ({ program: p.name, critical: p.healthCritical }));

/**
 * Pornește subscriptions onLogs pentru toate programele de discovery.
 * Apelează callback pentru FIECARE tranzacție primită (reușită sau eșuată) — `event.succeeded` spune
 * care e care. Freshness-ul per-program (D2) trebuie să vadă orice callback (= subscripție vie), nu doar
 * pe cele reușite; filtrarea pt. pipeline se face în index.ts pe `succeeded`.
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
        onLog({
          program:   name,
          programId: id,
          signature: logs.signature,
          slot:      ctx.slot,
          logs:      logs.logs,
          succeeded: logs.err === null,
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
