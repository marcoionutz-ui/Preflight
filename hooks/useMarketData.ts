"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Pair, GeckoPool, FearGreedEntry, CoinPrices, LogEntry, LogType, BuyerVelocity, ChainId } from "@/types";
import { getTrendingPools, getNewPools } from "@/lib/apis/geckoterminal";
import { getFearGreed } from "@/lib/apis/feargreed";
import { getCoinPrices } from "@/lib/apis/coingecko";
import { computeBuyerVelocity } from "@/lib/engines/buyerVelocity";
import { CHAINS } from "@/lib/chains";
import { timestamp } from "@/lib/utils";

const REFRESH_INTERVAL = 30;

export function useMarketData(chain: ChainId) {
  const [trending, setTrending]     = useState<Pair[]>([]);
  const [newPools, setNewPools]     = useState<GeckoPool[]>([]);
  const [fg, setFg]                 = useState<FearGreedEntry[]>([]);
  const [coins, setCoins]           = useState<CoinPrices>({});
  const [logs, setLogs]             = useState<LogEntry[]>([]);
  const [countdown, setCountdown]   = useState(REFRESH_INTERVAL);
  const [selectedPair, setSelectedPair] = useState<Pair | null>(null);
  const [velocity, setVelocity]     = useState<BuyerVelocity | null>(null);

  const logIdRef      = useRef(0);
  const prevPairRef   = useRef<Pair | null>(null);
  const activeChainRef = useRef<ChainId>(chain);
  const isLoadingRef  = useRef(false); // prevents concurrent fetches

  const log = useCallback((msg: string, t: LogType = "info") => {
    setLogs((l) => [...l.slice(-60), { id: logIdRef.current++, ts: timestamp(), msg, t }]);
  }, []);

  // Stable ref so interval never needs to re-subscribe
  const loadDataRef = useRef<() => Promise<void>>(async () => {});

  loadDataRef.current = async () => {
    // Prevent concurrent fetches (double-fire protection)
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;

    const forChain = activeChainRef.current;
    log(`Refreshing ${CHAINS[forChain].name} market data…`);

    try {
      const [tr, np, fgd, cd] = await Promise.all([
        getTrendingPools(CHAINS[forChain].gecko),
        getNewPools(CHAINS[forChain].gecko),
        getFearGreed(),
        getCoinPrices(),
      ]);

      // Discard stale response if chain changed mid-fetch
      if (activeChainRef.current !== forChain) {
        log(`Stale response discarded (${CHAINS[forChain].name})`, "warn");
        isLoadingRef.current = false;
        return;
      }

      // GeckoTerminal rate limit: retry once after 2s if both come back empty
      if (tr.length === 0 && np.length === 0) {
        log(`Empty response — retrying in 2s…`, "warn");
        isLoadingRef.current = false;
        setTimeout(() => loadDataRef.current(), 2000);
        return;
      }

      setTrending(tr);
      setNewPools(np);
      setFg(fgd);
      setCoins(cd);

      setSelectedPair((prev) => {
        if (!prev) return prev;
        const updated = tr.find((p) => p.pairAddress === prev.pairAddress);
        if (updated) {
          if (prevPairRef.current) setVelocity(computeBuyerVelocity(prevPairRef.current, updated));
          prevPairRef.current = updated;
          return updated;
        }
        return prev;
      });

      log(`${tr.length} trending + ${np.length} new pools`, "ok");
    } catch (err) {
      if (activeChainRef.current !== forChain) { isLoadingRef.current = false; return; }
      log(`Refresh error: ${err instanceof Error ? err.message : "unknown"}`, "err");
    }

    isLoadingRef.current = false;
  };

  // Chain change — update ref, clear state, load fresh data
  useEffect(() => {
    activeChainRef.current = chain;
    isLoadingRef.current = false; // reset lock on chain switch
    setTrending([]);
    setNewPools([]);
    setSelectedPair(null);
    setVelocity(null);
    prevPairRef.current = null;
    setCountdown(REFRESH_INTERVAL);
    log(`Chain switched → ${CHAINS[chain].name}`);
    loadDataRef.current();
  }, [chain]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable interval — never re-subscribes, uses ref
  useEffect(() => {
    const iv = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          loadDataRef.current();
          return REFRESH_INTERVAL;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, []); // intentionally empty — stable forever

  const loadData = useCallback(() => loadDataRef.current(), []);

  const selectPair = useCallback((pair: Pair) => {
    prevPairRef.current = pair;
    setSelectedPair(pair);
    setVelocity(null);
    log(`→ ${pair.baseToken?.symbol} selected`, "info");
  }, [log]);

  return {
    trending, newPools, fg, coins, logs, countdown,
    selectedPair, velocity,
    setSelectedPair: selectPair,
    loadData, log,
  };
}