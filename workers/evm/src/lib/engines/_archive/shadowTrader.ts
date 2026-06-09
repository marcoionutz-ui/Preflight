/**
 * Shadow Trader — tracked hypothetical live trades
 * Agentul aplică constrângerile LIVE și salvează WOULD_BUY fără execuție
 */

import { syncShadowTrade, syncAllShadowTrades } from "@/lib/db/sync";

const STORAGE_KEY = "supreme_shadow_trades";
const MAX_ENTRIES = 500;

export interface ShadowTrade {
  id: string;
  timestamp: number;
  symbol: string;
  chain: string;
  pairAddress: string;
  tokenAddress: string;
  entryPrice: number;
  currentPrice: number;
  edgeScore: number;
  flagCount: number;
  note: string;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  exitedAt?: number;
  exitPrice?: number;
  exitReason?: string;
}

export interface ShadowStats {
  total: number;
  open: number;
  closed: number;
  winRate: number | null;
  medianReturn: number | null;
  bestTrade: { symbol: string; pct: number } | null;
  worstTrade: { symbol: string; pct: number } | null;
}

// ── Storage ───────────────────────────────────────────────────────────────────

function load(): ShadowTrade[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function save(entries: ShadowTrade[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {}
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function saveShadowTrade(trade: Omit<ShadowTrade, "id">): void {
  const all = load();
  // Nu duplica același pair în ultima oră
  const recent = all.find(
    t => t.pairAddress === trade.pairAddress && Date.now() - t.timestamp < 60 * 60_000
  );
  if (recent) return;

  all.push({
    ...trade,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
  });
  save(all);
  syncShadowTrade(all[all.length - 1]);
}

export function updateShadowPrices(
  trending: Array<{ pairAddress: string; priceUsd?: string | number }>
): void {
  const all = load();
  let changed = false;

  all.forEach(trade => {
    if (trade.exitedAt) return;
    const found = trending.find(p => p.pairAddress === trade.pairAddress);
    if (!found) return;
    const price = Number(found.priceUsd);
    if (!price || isNaN(price)) return;

    trade.currentPrice = price;
    changed = true;

    // Auto-exit pe SL/TP1
    if (price <= trade.sl) {
      trade.exitedAt  = Date.now();
      trade.exitPrice = price;
      trade.exitReason = "SL hit";
      changed = true;
    } else if (price >= trade.tp1) {
      trade.exitedAt  = Date.now();
      trade.exitPrice = price;
      trade.exitReason = "TP1 hit";
      changed = true;
    }
  });

  if (changed) {
    save(all);
    syncAllShadowTrades(all);
  }
}

export function getAllShadowTrades(): ShadowTrade[] {
  return load().sort((a, b) => b.timestamp - a.timestamp);
}

export function getShadowStats(): ShadowStats {
  const all = load();
  const open   = all.filter(t => !t.exitedAt);
  const closed = all.filter(t => t.exitedAt && t.exitPrice);

  const closedReturns = closed.map(t =>
    ((t.exitPrice! - t.entryPrice) / t.entryPrice) * 100
  );

  const winRate = closed.length > 0
    ? closed.filter((_, i) => closedReturns[i] > 0).length / closed.length
    : null;

  const medianReturn = closedReturns.length > 0 ? median(closedReturns) : null;

  const bestIdx  = closedReturns.length > 0 ? closedReturns.indexOf(Math.max(...closedReturns)) : -1;
  const worstIdx = closedReturns.length > 0 ? closedReturns.indexOf(Math.min(...closedReturns)) : -1;

  return {
    total:   all.length,
    open:    open.length,
    closed:  closed.length,
    winRate,
    medianReturn,
    bestTrade:  bestIdx  >= 0 ? { symbol: closed[bestIdx].symbol,  pct: closedReturns[bestIdx]  } : null,
    worstTrade: worstIdx >= 0 ? { symbol: closed[worstIdx].symbol, pct: closedReturns[worstIdx] } : null,
  };
}

export function clearShadowTrades(): void {
  if (typeof window !== "undefined") localStorage.removeItem(STORAGE_KEY);
}