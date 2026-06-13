/**
 * state/memory.ts
 * Pair memory — trackează istoricul fiecărei perechi văzute.
 * Load/save din Redis și Supabase.
 */

import { detectPhase } from "../lib/engines/phaseDetector";
import type { PairMemoryEntry } from "../lib/engines/pairMemory";
import type { SourcePool } from "../sources/normalize";
import { cleanEvmAddress } from "../sources/normalize";
import { memory, poolLiquidity } from "./stores";
import { tokenPoolKey, tokenPools } from "../infra/poolTracker";
import { getRedis } from "../infra/redis";
import { supabase } from "../infra/supabase";
import { getEthPrice } from "../infra/ethPrice";
import { WORKER_VERSION } from "../config/constants";
import { REDIS_KEYS } from "@preflight/schema";

export function updatePoolLiquidity(addr: string, pool: SourcePool): void {
  const reserveUsd = pool.reserveUsd;
  if (reserveUsd > 0) {
    poolLiquidity.set(addr.toLowerCase(), {
      reserveUsd,
      reserveEth: reserveUsd / 2 / getEthPrice(),
      updatedAt:  Date.now(),
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

  const existing = memory.get(addr);
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
    memory.set(addr, mem);
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

  memory.set(addr, existing);
  updatePoolLiquidity(addr, pool);
  return existing;
}

export async function loadPairStats(): Promise<void> {
  const { data: trades } = await supabase
    .from("shadow_trades")
    .select("pair_address, symbol, token_address, entry_price, exit_reason, exited_at, created_at, current_price")
    .gte("timestamp", Date.now() - 24 * 3600_000);

  if (!trades) return;

  for (const t of trades) {
    const addr = t.pair_address?.toLowerCase();
    if (!addr) continue;

    if (!memory.has(addr)) {
      const ep = Number(t.entry_price);
      const cp = Number(t.current_price || t.entry_price);
      memory.set(addr, {
        pairAddress: addr, symbol: t.symbol?.trim() ?? "?",
        tokenAddress: t.token_address ?? "",
        firstSeen: new Date(t.created_at).getTime(),
        lastSeen:  new Date(t.created_at).getTime(),
        seenCount: 0, priceAtFirstSeen: ep,
        highPrice: cp, lowPrice: ep, currentPrice: cp,
        totalEntries: 0, lastEntryTime: 0, lastEntryPrice: ep,
        wins24h: 0, losses24h: 0, badExits24h: 0, consecutiveLosses: 0,
        lastExitReason: null, lastExitTime: null, phase: "TRENDING",
      });
    }

    const mem = memory.get(addr)!;
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
    for (const [addr, mem] of memory.entries()) memoryObj[addr] = mem;

    const reserveObj: Record<string, number> = {};
    for (const [addr, liqCtx] of poolLiquidity.entries()) reserveObj[addr] = liqCtx.reserveEth;

     await r.set(
      REDIS_KEYS.workerSnapshot,
      JSON.stringify({
        version:        WORKER_VERSION,
        savedAt:        Date.now(),
        memory:         memoryObj,
        poolReserveEth: reserveObj,
      }),
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

      const snap = JSON.parse(raw) as {
        version?:        string;
        savedAt?:        number;
        memory?:         Record<string, PairMemoryEntry>;
        poolReserveEth?: Record<string, number>;
      };

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
      for (const [addr, mem] of Object.entries(snap.memory ?? {})) {
        memory.set(addr, mem);
        count++;
        const chainPrefix = mem.chain ?? "unknown";
        const key = tokenPoolKey(chainPrefix, mem.tokenAddress);
        if (!tokenPools.has(key)) tokenPools.set(key, new Set());
        tokenPools.get(key)!.add(addr);
      }

      for (const [addr, eth] of Object.entries(snap.poolReserveEth ?? {})) {
        const val = Number(eth);
        if (Number.isFinite(val) && val > 0) {
          poolLiquidity.set(addr, {
            reserveUsd: val * 2 * getEthPrice(),
            reserveEth: val,
            updatedAt:  snap.savedAt ?? Date.now(),
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