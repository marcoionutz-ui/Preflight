/**
 * discovery/backfillCpmm.ts
 * 8.0e: Snapshot backfill pentru Raydium CPMM via getProgramAccounts.
 *
 * Filtre:
 *   memcmp @ offset 0 = Anchor discriminator "account:PoolState"
 *   → returnează DOAR PoolState accounts, nu și config/observation accounts
 *
 * Layout PoolState (Anchor, fixed offsets):
 *   [0..7]     discriminator   (8 bytes)
 *   [8..39]    amm_config      (Pubkey)
 *   [40..71]   pool_creator    (Pubkey)
 *   [72..103]  token0_vault    (Pubkey)
 *   [104..135] token1_vault    (Pubkey)
 *   [136..167] lp_mint         (Pubkey)
 *   [168..199] token0_mint     (Pubkey)  ← citim asta
 *   [200..231] token1_mint     (Pubkey)  ← și asta
 *
 * Env vars:
 *   SOLANA_BACKFILL_ENABLED=1       (default: off)
 *   SOLANA_BACKFILL_MAX_ACCOUNTS    (default: 1000)
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { RAYDIUM_CPMM } from "../config/programs";
import { buildSolanaPool, writeSolanaPool } from "./pairWriter";

// Anchor discriminator pentru "account:PoolState"
// = sha256("account:PoolState").slice(0,8) encodat base58
// Derivat din: crypto.createHash('sha256').update('account:PoolState').digest().slice(0,8)
const POOL_STATE_DISCRIMINATOR_B58 = "iUE1qg7KXeV";

const MINT0_OFFSET = 168;
const MINT1_OFFSET = 200;
const MIN_DATA_LEN = MINT1_OFFSET + 32; // 232 bytes minim

const BATCH_SIZE   = 50;
const BATCH_DELAY  = 150; // ms între batch-uri — protecție RPC

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getMaxAccounts(): number {
  const val = parseInt(process.env.SOLANA_BACKFILL_MAX_ACCOUNTS ?? "1000", 10);
  return isNaN(val) || val <= 0 ? 1000 : val;
}

/**
 * Rulează snapshot backfill CPMM.
 * Nu aruncă erori — logează și returnează stats.
 */
export async function runCpmmBackfill(connection: Connection): Promise<void> {
  if (!process.env.SOLANA_BACKFILL_ENABLED || process.env.SOLANA_BACKFILL_ENABLED !== "1") {
    console.log("[SOLANA][BACKFILL] disabled (set SOLANA_BACKFILL_ENABLED=1 to enable)");
    return;
  }

  const maxAccounts = getMaxAccounts();
  console.log("[SOLANA][BACKFILL] cpmm starting | max=" + maxAccounts);

  let rawAccounts: Awaited<ReturnType<typeof connection.getProgramAccounts>>;
  try {
    rawAccounts = await connection.getProgramAccounts(
      new PublicKey(RAYDIUM_CPMM),
      {
        commitment: "confirmed",
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes:  POOL_STATE_DISCRIMINATOR_B58,
            },
          },
        ],
      },
    );
  } catch (err) {
    console.error("[SOLANA][BACKFILL] getProgramAccounts failed:", (err as Error).message);
    return;
  }

  const total = rawAccounts.length;
  const capped = Math.min(total, maxAccounts);
  console.log("[SOLANA][BACKFILL] cpmm fetched=" + total + " | processing=" + capped);

  // Validare offset-uri pe primele 3 accounts — pentru debugging
  for (let i = 0; i < Math.min(3, capped); i++) {
    const { pubkey, account } = rawAccounts[i];
    const data = account.data;
    if (data.length < MIN_DATA_LEN) continue;
    const m0 = new PublicKey(data.slice(MINT0_OFFSET, MINT0_OFFSET + 32)).toBase58();
    const m1 = new PublicKey(data.slice(MINT1_OFFSET, MINT1_OFFSET + 32)).toBase58();
    console.log(
      "[SOLANA][BACKFILL] validate[" + i + "]"
      + " pool=" + pubkey.toBase58().slice(0, 8) + "..."
      + " mint0=" + m0.slice(0, 8) + "..."
      + " mint1=" + m1.slice(0, 8) + "...",
    );
  }

  const stats = { scanned: 0, inserted: 0, existing: 0, skipped: 0, errors: 0 };

  for (let i = 0; i < capped; i += BATCH_SIZE) {
    const batch = rawAccounts.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async ({ pubkey, account }) => {
      stats.scanned++;
      const data = account.data;

      if (data.length < MIN_DATA_LEN) {
        stats.skipped++;
        return;
      }

      try {
        const mint0 = new PublicKey(data.slice(MINT0_OFFSET, MINT0_OFFSET + 32)).toBase58();
        const mint1 = new PublicKey(data.slice(MINT1_OFFSET, MINT1_OFFSET + 32)).toBase58();

        // slot=0 pentru backfill (nu avem slot-ul de creare din getProgramAccounts)
        const pool = buildSolanaPool(
          pubkey.toBase58(),
          mint0,
          mint1,
          0,
          "backfill",
          "raydium_cpmm",
        );

        const result = await writeSolanaPool(pool);
        if      (result === "inserted") stats.inserted++;
        else if (result === "exists")   stats.existing++;
        else                            stats.errors++;
      } catch (err) {
        stats.errors++;
        console.error("[SOLANA][BACKFILL] parse error pool=" + pubkey.toBase58().slice(0, 8) + ":", (err as Error).message);
      }
    }));

    if (i + BATCH_SIZE < capped) {
      await sleep(BATCH_DELAY);
    }
  }

  console.log(
    "[SOLANA][BACKFILL] cpmm done"
    + " scanned=" + stats.scanned
    + " inserted=" + stats.inserted
    + " existing=" + stats.existing
    + " skipped=" + stats.skipped
    + " errors=" + stats.errors,
  );
}
