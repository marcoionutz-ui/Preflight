/**
 * state/memory.ts
 * Pair memory — trackează istoricul fiecărei perechi văzute.
 * Load/save din Redis și Supabase.
 */

import { detectPhase } from "../lib/engines/phaseDetector";
import type { PairMemoryEntry } from "../lib/engines/pairMemory";
import type { SourcePool } from "../sources/normalize";
import { memory, poolLiquidity } from "./stores";
import { tokenPoolKey, tokenPools } from "../infra/poolTracker";
import { getRedis } from "../infra/redis";
import { supabase } from "../infra/supabase";
import { getNativePrice, getNativeSymbolForChain } from "../infra/nativePrice";
import { WORKER_VERSION } from "../config/constants";
import { REDIS_KEYS, pairKey, splitPairKey, normalizeChainId, normalizePairAddress, type PairKey } from "@preflight/schema";
import type { PreflightWorkerSnapshot } from "@preflight/schema";

export function updatePoolLiquidity(addr: string, pool: SourcePool): void {
  const reserveUsd = pool.reserveUsd;
  if (reserveUsd > 0) {
    const nativeSymbol  = getNativeSymbolForChain(pool.chain);
    const nativePrice   = getNativePrice(nativeSymbol) || getNativePrice("ETH") || 1;
    const reserveNative = reserveUsd / 2 / nativePrice;

    poolLiquidity.set(pool.chain, addr, {
      reserveUsd,
      reserveEth:    reserveNative, 
      reserveNative,
      nativeSymbol,
      updatedAt: Date.now(),
    });
  }
}

export function updateMemory(pool: SourcePool, price: number): PairMemoryEntry {
  const addr         = pool.pairAddress;
  const symbol       = pool.symbol;
  const tokenAddress = pool.tokenAddress;
  const now          = Date.now();
  const m5           = pool.priceChange.m5;
  const h1           = pool.priceChange.h1;
  const h24          = pool.priceChange.h24;

  const existing = memory.get(pool.chain, addr);
  if (!existing) {
    const mem: PairMemoryEntry = {
      pairAddress: addr, symbol, tokenAddress,
      firstSeen: now, lastSeen: now, seenCount: 1,
      priceAtFirstSeen: price, highPrice: price, lowPrice: price, currentPrice: price,
      totalEntries: 0, lastEntryTime: 0, lastEntryPrice: 0,
      wins24h: 0, losses24h: 0, badExits24h: 0, consecutiveLosses: 0,
      lastExitReason: null, lastExitTime: null,
	  priceChange: { m5, h1, h24 },
	  chain:       pool.chain,
      phase: detectPhase({
        seenCount: 1, consecutiveLosses: 0, m5, h24,
        highPrice: price, lowPrice: price, currentPrice: price,
        totalEntries: 0, wins24h: 0, losses24h: 0, badExits24h: 0,
      }),
    };
    memory.set(pool.chain, addr, mem);
    updatePoolLiquidity(addr, pool);
    return mem;
  }

  existing.lastSeen      = now;
  existing.seenCount    += 1;
  existing.currentPrice  = price;
  existing.tokenAddress  = tokenAddress;
  if (price > existing.highPrice) existing.highPrice = price;
  if (price < existing.lowPrice)  existing.lowPrice  = price;
  
  existing.priceChange = { m5, h1, h24 };
  existing.chain = pool.chain;

  existing.phase = detectPhase({
    seenCount: existing.seenCount,
    consecutiveLosses: 0,
    m5,
    h24,
    highPrice: existing.highPrice,
    lowPrice: existing.lowPrice,
    currentPrice: price,
    totalEntries: 0,
    wins24h: 0,
    losses24h: 0,
    badExits24h: 0,
  });
  
  if (pool.discoverySource) {
    if (!existing.firstDiscoveredAt) existing.firstDiscoveredAt = now;
    existing.lastDiscoveryAt = now;
    existing.discoverySources ??= [];
    if (!existing.discoverySources.includes(pool.discoverySource)) {
      existing.discoverySources.push(pool.discoverySource);
    }
    existing.primaryDiscoverySource ??= pool.discoverySource;
  }

  memory.set(pool.chain, addr, existing);
  updatePoolLiquidity(addr, pool);
  return existing;
}

export async function loadPairStats(): Promise<void> {
  const { data: trades } = await supabase
    .from("shadow_trades")
    .select("pair_address, symbol, token_address, chain, entry_price, exit_reason, exited_at, created_at, current_price")
    .gte("timestamp", Date.now() - 24 * 3600_000);

  if (!trades) return;

  for (const t of trades) {
    const rawChain   = String(t.chain ?? "").trim();
    const rawAddress = String(t.pair_address ?? "").trim();
    if (!rawChain || !rawAddress) continue;  // fără chain nu putem cheia intrarea (B3e)
    const chain = normalizeChainId(rawChain);
    const addr  = normalizePairAddress(chain, rawAddress);

    if (!memory.has(chain, addr)) {
      const ep = Number(t.entry_price);
      const cp = Number(t.current_price || t.entry_price);
      memory.set(chain, addr, {
        pairAddress: addr, symbol: t.symbol?.trim() ?? "?",
        tokenAddress: t.token_address ?? "",
        chain,
        firstSeen: new Date(t.created_at).getTime(),
        lastSeen:  new Date(t.created_at).getTime(),
        seenCount: 0, priceAtFirstSeen: ep,
        highPrice: cp, lowPrice: ep, currentPrice: cp,
        totalEntries: 0, lastEntryTime: 0, lastEntryPrice: ep,
        wins24h: 0, losses24h: 0, badExits24h: 0, consecutiveLosses: 0,
        lastExitReason: null, lastExitTime: null, phase: "TRENDING",
      });
    }

    const mem = memory.get(chain, addr)!;
    mem.totalEntries  += 1;
    mem.lastEntryTime  = Math.max(mem.lastEntryTime, new Date(t.created_at).getTime());
    mem.lastEntryPrice = Number(t.entry_price);

    if (t.exit_reason === "TP1 hit") {
      mem.wins24h += 1; mem.consecutiveLosses = 0;
      mem.lastExitReason = "TP1 hit"; mem.lastExitTime = t.exited_at;
    } else if (t.exit_reason === "SL hit") {
      mem.losses24h += 1; mem.consecutiveLosses += 1;
      mem.lastExitReason = "SL hit"; mem.lastExitTime = t.exited_at;
    } else if (
      t.exit_reason === "MAX HOLD" ||
      t.exit_reason === "SELL PRESSURE" ||
      t.exit_reason === "LP REMOVED" ||
      t.exit_reason === "RUGPULL"
    ) {
      mem.badExits24h += 1;
      mem.lastExitReason = t.exit_reason;
      mem.lastExitTime   = t.exited_at;
    }
  }

  console.log(`[MEMORY] Loaded ${memory.size} pairs from last 24h`);
}

export async function saveMemoryToRedis(): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;

    const memoryObj: Record<string, PairMemoryEntry> = {};
    for (const [{ chain, address: addr }, mem] of memory.entries()) memoryObj[pairKey(chain, addr)] = { ...mem, chain, pairAddress: addr };

    const reserveObj: Record<string, number> = {};
    for (const [{ chain, address: addr }, liqCtx] of poolLiquidity.entries()) reserveObj[pairKey(chain, addr)] = liqCtx.reserveEth;

     const snapshot: PreflightWorkerSnapshot = {
      version:        WORKER_VERSION,
      savedAt:        Date.now(),
      memory:         memoryObj,
      poolReserveEth: reserveObj,
    };
     await r.set(
      REDIS_KEYS.workerSnapshot,
      JSON.stringify(snapshot),
      "EX", 24 * 60 * 60,
    );
    console.log(`[REDIS] Worker snapshot saved: ${memory.size} pairs, ${poolLiquidity.size} reserves`);
  } catch {
    console.log(`[REDIS] Snapshot save failed`);
  }
}

export async function loadMemoryFromRedis(): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = getRedis();
      if (!r) return;

      const raw = await r.get(REDIS_KEYS.workerSnapshot);
      if (!raw) return;

      // Blind cast, not runtime validation — matches the risk tolerance
      // already established elsewhere in this codebase (no Zod parsing
      // introduced here). Partial<> because every field is optional at this
      // point: the two guards below (version/savedAt) handle a snapshot
      // that fails to parse as expected.
      const snap = JSON.parse(raw) as Partial<PreflightWorkerSnapshot>;

      if (snap.version && snap.version !== WORKER_VERSION) {
        console.log(`[REDIS] Snapshot from ${snap.version} ignored — current is ${WORKER_VERSION}`);
        return;
      }

      const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60_000;
      if (snap.savedAt && Date.now() - snap.savedAt > SNAPSHOT_MAX_AGE_MS) {
        console.log(`[REDIS] Snapshot too old ignored — age:${Math.round((Date.now() - snap.savedAt) / 60_000)}m`);
        return;
      }

      let count = 0;
      for (const [k, mem] of Object.entries(snap.memory ?? {})) {
        // k e `pairKey` (chain:address) de la B3e; snapshot-uri vechi aveau doar
        // adresa → splitPairKey dă chain="" și cădem pe mem.chain.
        const { chain: keyChain, address } = splitPairKey(k as PairKey);
        const rawChain = keyChain !== "" ? keyChain : (mem.chain ?? "");
        if (!rawChain) continue;
        // Canonicalizăm ȘI realiniem valoarea (mem.chain/pairAddress) la cheie,
        // ca modulele care citesc mem.chain să nu vadă `eth` necanonic.
        const setChain   = normalizeChainId(rawChain);
        const setAddress = normalizePairAddress(setChain, address);
        const restoredMem: PairMemoryEntry = { ...mem, chain: setChain, pairAddress: setAddress };
        memory.set(setChain, setAddress, restoredMem);
        count++;
        const key = tokenPoolKey(setChain, restoredMem.tokenAddress);
        if (!tokenPools.has(key)) tokenPools.set(key, new Set());
        tokenPools.get(key)!.add(setAddress);
      }

     for (const [key, nativeReserveRaw] of Object.entries(snap.poolReserveEth ?? {})) {
        // key e `pairKey` (chain:address) de la B3d-1; snapshot-urile vechi aveau
        // doar adresa → splitPairKey dă chain="".
        const { chain: keyChain, address } = splitPairKey(key as PairKey);
        const nativeReserve = Number(nativeReserveRaw);
        if (Number.isFinite(nativeReserve) && nativeReserve > 0) {
          // memory[key] e pregătit pt. B3e (când memory devine pairKey); acum cade pe [address].
          const mem          = snap.memory?.[key] ?? snap.memory?.[address];
          // Cheia NOUĂ (pairKey) e source-of-truth; mem.chain e DOAR fallback pt.
          // snapshot-uri vechi unde keyChain="". Altfel, dacă memory (încă bare-addr
          // până la B3e) a fost suprascris de alt chain, ai restaura pe chain greșit.
          const rawChain     = keyChain !== "" ? keyChain : mem?.chain;
          if (!rawChain) continue;
          const setChain     = normalizeChainId(rawChain);
          const setAddress   = normalizePairAddress(setChain, address);
          const nativeSymbol = getNativeSymbolForChain(setChain);
          const nativePrice  = getNativePrice(nativeSymbol) || getNativePrice("ETH") || 1;

          poolLiquidity.set(setChain, setAddress, {
            reserveUsd:    nativeReserve * 2 * nativePrice,
            reserveEth:    nativeReserve, // legacy alias
            reserveNative: nativeReserve,
            nativeSymbol,
            updatedAt: snap.savedAt ?? Date.now(),
          });
        }
      }

      console.log(`[REDIS] Worker snapshot loaded: ${count} pairs, ${poolLiquidity.size} reserves`);
      return;

    } catch (e) {
      console.log(`[REDIS] Snapshot load attempt ${attempt}/5 failed: ${e}`);
      if (attempt < 5) await new Promise(res => setTimeout(res, attempt * 1000));
    }
  }
  console.log(`[REDIS] Snapshot load gave up after 5 attempts`);
}
