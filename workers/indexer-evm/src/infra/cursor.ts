/**
 * infra/cursor.ts
 * Block cursor persistent în Redis pentru indexer-evm.
 *
 * Key: preflight:indexer:cursor:{chain}
 *
 * Cursor safety:
 *   - Nu sare niciodată blocuri silențios
 *   - blocksBehind > MAX_CATCHUP_BLOCKS → status DEGRADED
 *   - În DEGRADED: catch-up controlat (max CATCHUP_BATCHES_PER_LOOP batches/iterație)
 *   - Override manual explicit: INDEXER_SKIP_TO_LATEST=true în env
 */

import { getRedis } from "./redis";
import type { ChainId } from "../config/factories";
import type Redis from "ioredis";

const KEY_PREFIX = "preflight:indexer:cursor";

export const MAX_CATCHUP_BLOCKS          = 10_000; // > 10k blocuri în urmă → DEGRADED
export const CATCHUP_BATCHES_PER_LOOP    = 5;      // max batches per loop în catch-up
export const BATCH_SIZE                  = 500;    // blocuri per batch eth_getLogs
export const INDEXER_INITIAL_LOOKBACK_BLOCKS = 1_000; // first run: start de la latest - 1000

/**
 * Confirmation depth — reorg safety (C5).
 * Nu indexăm blocuri mai noi de `latest - CONFIRMATION_DEPTH`: write-urile de registry
 * sunt SET NX (ireversibile), deci un pair dintr-un bloc reorganizat ar rămâne PERMANENT
 * în index dacă l-am scrie înainte de confirmare (iar event-ul din blocul de înlocuire
 * s-ar rata). Per-chain: BSC reorg-uiește mai des; L2-urile (Base/Arbitrum) rar; ETH post-merge rar.
 * Override: INDEXER_CONFIRMATION_DEPTH_{CHAIN} (ex. INDEXER_CONFIRMATION_DEPTH_BSC=15)
 * sau global INDEXER_CONFIRMATION_DEPTH. 0 = dezactivat (indexează până la head).
 */
export const DEFAULT_CONFIRMATION_DEPTH: Record<ChainId, number> = {
  base:     5,
  arbitrum: 5,
  bsc:      15,
  ethereum: 6,
};

/** Adâncimea de confirmare pentru un chain (env override → default per-chain). */
export function confirmationDepth(chain: ChainId): number {
  const raw =
    process.env[`INDEXER_CONFIRMATION_DEPTH_${chain.toUpperCase()}`] ??
    process.env.INDEXER_CONFIRMATION_DEPTH;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    console.warn(
      `[INDEXER][CURSOR][${chain.toUpperCase()}] CONFIRMATION_DEPTH override invalid ("${raw}") — ` +
      `folosesc default ${DEFAULT_CONFIRMATION_DEPTH[chain]}`,
    );
  }
  return DEFAULT_CONFIRMATION_DEPTH[chain];
}

/**
 * Head sigur de indexat = latest - confirmationDepth, clamp la >= 0.
 * TOATE calculele downstream (computeCursorState, getBatchRanges, health blocksBehind)
 * folosesc safeHead, NU raw head — altfel health raportează perpetuu `behind == depth`.
 */
export function safeHead(chain: ChainId, latestBlock: number): number {
  return Math.max(0, latestBlock - confirmationDepth(chain));
}

export type CursorStatus = "OK" | "DEGRADED" | "CATCHING_UP";

export interface CursorState {
  lastBlock:    number;
  blocksBehind: number;
  status:       CursorStatus;
}

/**
 * Rezultat READ fail-closed (C4) — distinge eroarea de absență:
 *   { ok: true,  value: number } → cursor găsit
 *   { ok: true,  value: null }   → cheie absentă (first run legit)
 *   { ok: false }                → eroare Redis / valoare coruptă / Redis neconfigurat → apelantul NU
 *                                  tratează ca first-run (altfel resetează cursorul + sare blocuri silențios)
 */
export type CursorRead = { ok: true; value: number | null } | { ok: false };

function cursorKey(chain: string): string {
  return `${KEY_PREFIX}:${chain.toLowerCase()}`;
}

/**
 * Citește lastBlock din Redis — FAIL-CLOSED (C4).
 * Eroarea Redis, valoarea coruptă ȘI Redis-ul neconfigurat NU se colapsează în `null` (care ar fi
 * tratat drept first-run → reset la latest-lookback → blocuri sărite silențios). Fără client = {ok:false}
 * (fără persistență nu există confirmare → un dry-run fără Redis e mod EXPLICIT, nu default fail-closed).
 * Validarea valorii e STRICTĂ (parseInt e prea permisiv: "123abc"→123, "7.9"→7, "-5"→-5).
 * `client` injectabil pentru teste; implicit = singletonul getRedis().
 */
export async function readCursor(
  chain:  string,
  client: Redis | null = getRedis(),
): Promise<CursorRead> {
  if (!client) {
    console.error(`[INDEXER][CURSOR] readCursor(${chain}) — Redis neconfigurat (REDIS_URL lipsește) — fail-closed`);
    return { ok: false };
  }

  try {
    const val = await client.get(cursorKey(chain));
    if (val === null || val === undefined) return { ok: true, value: null }; // cheie absentă = first run legit
    if (!/^\d+$/.test(val)) {
      console.error(`[INDEXER][CURSOR] readCursor(${chain}) valoare coruptă: "${val}" — fail-closed`);
      return { ok: false };
    }
    const n = Number(val);
    if (!Number.isSafeInteger(n) || n < 0) {
      console.error(`[INDEXER][CURSOR] readCursor(${chain}) valoare invalidă: "${val}" — fail-closed`);
      return { ok: false };
    }
    return { ok: true, value: n };
  } catch (err) {
    console.error(`[INDEXER][CURSOR] readCursor(${chain}) error:`, (err as Error).message);
    return { ok: false };
  }
}

/**
 * Scrie lastBlock în Redis după un batch procesat. Întoarce `true` DOAR la scriere confirmată (C4).
 * `false` → apelantul NU avansează lastProcessedBlock/health (altfel raportează „synced" fără ca
 * cursorul persistent să fi fost scris → la restart sare/re-procesează blocuri).
 * Fără Redis = `false` (fail-closed: fără persistență nu există confirmare; nu pretindem succes).
 * `client` injectabil pentru teste.
 */
export async function writeCursor(
  chain:  string,
  block:  number,
  client: Redis | null = getRedis(),
): Promise<boolean> {
  if (!client) {
    console.error(`[INDEXER][CURSOR] writeCursor(${chain}, ${block}) — Redis neconfigurat (REDIS_URL lipsește) — fail-closed`);
    return false;
  }

  try {
    await client.set(cursorKey(chain), String(block));
    return true;
  } catch (err) {
    console.error(`[INDEXER][CURSOR] writeCursor(${chain}, ${block}) error:`, (err as Error).message);
    return false;
  }
}

/**
 * Calculează starea cursorului față de latest block.
 * Gestionează override INDEXER_SKIP_TO_LATEST și DEGRADED safety.
 */
export function computeCursorState(
  lastBlock:   number | null,
  latestBlock: number,
  chain:       string,
): CursorState {
  // Override manual explicit — skipează la latest (numai cu env var setat)
  if (process.env.INDEXER_SKIP_TO_LATEST === "true") {
    console.warn(
      `[INDEXER][CURSOR][${chain.toUpperCase()}] INDEXER_SKIP_TO_LATEST=true — skipping to block ${latestBlock}`,
    );
    return { lastBlock: latestBlock, blocksBehind: 0, status: "OK" };
  }

  // First run — start cu INDEXER_INITIAL_LOOKBACK_BLOCKS înapoi
  if (lastBlock === null) {
    const startBlock = Math.max(0, latestBlock - INDEXER_INITIAL_LOOKBACK_BLOCKS);
    return {
      lastBlock:    startBlock,
      blocksBehind: latestBlock - startBlock,
      status:       "CATCHING_UP",
    };
  }

  const blocksBehind = latestBlock - lastBlock;

  if (blocksBehind <= 0) {
    return { lastBlock, blocksBehind: 0, status: "OK" };
  }

  if (blocksBehind > MAX_CATCHUP_BLOCKS) {
    console.warn(
      `[INDEXER][CURSOR][${chain.toUpperCase()}] DEGRADED: ${blocksBehind} blocks behind ` +
      `(max ${MAX_CATCHUP_BLOCKS}). Catch-up capped at ${CATCHUP_BATCHES_PER_LOOP} batches/loop. ` +
      `Set INDEXER_SKIP_TO_LATEST=true pentru skip manual.`,
    );
    return { lastBlock, blocksBehind, status: "DEGRADED" };
  }

  if (blocksBehind > BATCH_SIZE) {
    return { lastBlock, blocksBehind, status: "CATCHING_UP" };
  }

  return { lastBlock, blocksBehind, status: "OK" };
}

/**
 * Returnează batches de procesat în această iterație de loop.
 * În DEGRADED: max CATCHUP_BATCHES_PER_LOOP batches.
 * În OK/CATCHING_UP: toate batches necesare (de obicei 1-2).
 */
export function getBatchRanges(
  cursor:      CursorState,
  latestBlock: number,
): Array<{ fromBlock: number; toBlock: number }> {
  const { lastBlock, status } = cursor;
  const maxBatches = status === "DEGRADED" ? CATCHUP_BATCHES_PER_LOOP : Infinity;
  const ranges: Array<{ fromBlock: number; toBlock: number }> = [];

  let from       = lastBlock + 1;
  let batchCount = 0;

  while (from <= latestBlock && batchCount < maxBatches) {
    const to = Math.min(from + BATCH_SIZE - 1, latestBlock);
    ranges.push({ fromBlock: from, toBlock: to });
    from = to + 1;
    batchCount++;
  }

  return ranges;
}
