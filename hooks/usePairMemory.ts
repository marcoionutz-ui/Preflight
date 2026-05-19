import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import { detectPhase } from "@/lib/engines/phaseDetector";
import type { PairMemoryEntry } from "@/lib/engines/pairMemory";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export function usePairMemory() {
  const memRef  = useRef<Map<string, PairMemoryEntry>>(new Map());
  const [size, setSize] = useState(0);

  const load = useCallback(async () => {
    const { data: trades } = await supabase
      .from("shadow_trades")
      .select("*")
      .gte("timestamp", Date.now() - 24 * 3600_000)
      .order("created_at", { ascending: true });

    if (!trades) return;

    const map = new Map<string, PairMemoryEntry>();

    for (const t of trades) {
      const addr = t.pair_address?.toLowerCase();
      if (!addr) continue;

      if (!map.has(addr)) {
        const ep = Number(t.entry_price);
        map.set(addr, {
          pairAddress:       addr,
          symbol:            t.symbol?.trim() ?? "?",
          tokenAddress:      t.token_address ?? "",
          firstSeen:         new Date(t.created_at).getTime(),
          lastSeen:          new Date(t.created_at).getTime(),
          seenCount:         0,
          priceAtFirstSeen:  ep,
          highPrice:         ep,
          lowPrice:          ep,
          currentPrice:      ep,
          totalEntries:      0,
          lastEntryTime:     0,
          lastEntryPrice:    ep,
          wins24h:           0,
          losses24h:         0,
          consecutiveLosses: 0,
          lastExitReason:    null,
          lastExitTime:      null,
          phase:             "TRENDING",
        });
      }

      const mem = map.get(addr)!;
      mem.totalEntries  += 1;
      mem.seenCount     += 2; // aproximare — app nu trackează seenCount direct
      mem.lastEntryTime  = Math.max(mem.lastEntryTime, new Date(t.created_at).getTime());
      mem.lastEntryPrice = Number(t.entry_price);

      const cp = Number(t.current_price || t.entry_price);
      if (cp > mem.highPrice)             mem.highPrice    = cp;
      if (Number(t.entry_price) < mem.lowPrice) mem.lowPrice = Number(t.entry_price);
      mem.currentPrice = cp;

      if (t.exit_reason === "TP1 hit") {
        mem.wins24h  += 1;
        mem.consecutiveLosses = 0;
        mem.lastExitReason    = "TP1 hit";
        mem.lastExitTime      = t.exited_at;
      } else if (t.exit_reason === "SL hit") {
        mem.losses24h         += 1;
        mem.consecutiveLosses += 1;
        mem.lastExitReason     = "SL hit";
        mem.lastExitTime       = t.exited_at;
      }

      mem.phase = detectPhase({
        seenCount:         mem.seenCount,
        consecutiveLosses: mem.consecutiveLosses,
        m5:  0, h24: 0,
        highPrice:    mem.highPrice,
        lowPrice:     mem.lowPrice,
        currentPrice: mem.currentPrice,
        totalEntries: mem.totalEntries,
        wins24h:      mem.wins24h,
        losses24h:    mem.losses24h,
      });
    }

    memRef.current = map;
    setSize(map.size);
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 60_000);
    return () => clearInterval(iv);
  }, [load]);

  const getPairMem = useCallback((addr: string): PairMemoryEntry | null => {
    return memRef.current.get(addr.toLowerCase()) ?? null;
  }, []);

  return { getPairMem, memorySize: size };
}