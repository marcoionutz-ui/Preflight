/**
 * Pattern Memory Engine
 *
 * Logs every analysis with all signals, then tracks outcomes
 * at 30m / 1h / 6h / 24h intervals.
 *
 * After 50+ entries you can see:
 * - Which setups actually work
 * - AI accuracy rate
 * - GoPlus accuracy rate
 * - What Edge Score threshold has best win rate
 *
 * Stored in localStorage — persists between sessions.
 */

export interface MemoryEntry {
  id: string;
  timestamp: number;
  symbol: string;
  chain: string;
  pairAddress: string;
  entryPrice: number;

  // Scores at analysis time
  smartScore: number;
  edgeScore: number;
  edgeSafety: number;
  edgeCanEnter: boolean;

  // AI verdict
  aiVerdict: string;
  aiRiskScore: number;
  aiConfidence: number;

  // GoPlus
  isHoneypot: boolean;
  buyTax: number;
  sellTax: number;
  holderCount: number;
  goplusAvailable: boolean;

  // Red flags count
  highFlags: number;

  // Outcomes — filled in over time
  outcomes: {
    m30?: OutcomePoint;
    h1?:  OutcomePoint;
    h6?:  OutcomePoint;
    h24?: OutcomePoint;
  };

  // User note (optional)
  note?: string;
}

export interface OutcomePoint {
  price: number;
  pct: number;
  timestamp: number;
}

const STORAGE_KEY = "supreme_trader_memory";
const MAX_ENTRIES = 500;

// ── Storage helpers ────────────────────────────────────────────────────────

function loadAll(): MemoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveAll(entries: MemoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch { /* quota exceeded */ }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function addMemoryEntry(entry: Omit<MemoryEntry, "id" | "outcomes">): MemoryEntry {
  const full: MemoryEntry = {
    ...entry,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    outcomes: {},
  };
  const all = loadAll();
  all.push(full);
  saveAll(all);
  return full;
}

export function updateOutcome(
  id: string,
  interval: keyof MemoryEntry["outcomes"],
  price: number,
  entryPrice: number
): void {
  const all = loadAll();
  const idx = all.findIndex(e => e.id === id);
  if (idx === -1) return;
  all[idx].outcomes[interval] = {
    price,
    pct: ((price - entryPrice) / entryPrice) * 100,
    timestamp: Date.now(),
  };
  saveAll(all);
}

export function getAllMemory(): MemoryEntry[] {
  return loadAll().sort((a, b) => b.timestamp - a.timestamp);
}

export function clearMemory(): void {
  if (typeof window !== "undefined") localStorage.removeItem(STORAGE_KEY);
}

// ── Analytics ──────────────────────────────────────────────────────────────

export interface MemoryStats {
  total: number;
  withOutcomes: number;

  // AI accuracy
  aiAccuracy: {
    total: number;
    correct: number;  // AI said BUY → positive outcome
    rate: number;
  };

  // Edge Score breakdown
  edgeScoreStats: {
    high:   { count: number; winRate: number; avgReturn: number }; // >=75
    medium: { count: number; winRate: number; avgReturn: number }; // 55-74
    low:    { count: number; winRate: number; avgReturn: number }; // <55
  };

  // GoPlus accuracy
  goplusAccuracy: {
    safeAndWon: number;
    safeAndLost: number;
    dangerAvoided: number;
  };

  // Overall returns at 1h
  avgReturn1h: number;
  avgReturn24h: number;
  bestTrade: { symbol: string; pct: number } | null;
  worstTrade: { symbol: string; pct: number } | null;
}

export function computeStats(): MemoryStats {
  const entries = loadAll();
  const withH1 = entries.filter(e => e.outcomes.h1);
  const withH24 = entries.filter(e => e.outcomes.h24);

  // AI accuracy (using 1h outcome)
  const aiTotal = withH1.length;
  const aiCorrect = withH1.filter(e => {
    const pct = e.outcomes.h1!.pct;
    return (e.aiVerdict === "BUY" && pct > 5) ||
           (e.aiVerdict === "AVOID" && pct < -5) ||
           (e.aiVerdict === "SELL" && pct < 0);
  }).length;

  // Edge score tiers
  const tier = (e: MemoryEntry) =>
    e.edgeScore >= 75 ? "high" : e.edgeScore >= 55 ? "medium" : "low";

  const tierStats = (t: "high" | "medium" | "low") => {
    const group = withH1.filter(e => tier(e) === t);
    const wins = group.filter(e => (e.outcomes.h1?.pct ?? 0) > 5).length;
    const avgR = group.length
      ? group.reduce((s, e) => s + (e.outcomes.h1?.pct ?? 0), 0) / group.length
      : 0;
    return { count: group.length, winRate: group.length ? wins / group.length : 0, avgReturn: avgR };
  };

  // Returns
  const avg1h = withH1.length
    ? withH1.reduce((s, e) => s + (e.outcomes.h1?.pct ?? 0), 0) / withH1.length : 0;
  const avg24h = withH24.length
    ? withH24.reduce((s, e) => s + (e.outcomes.h24?.pct ?? 0), 0) / withH24.length : 0;

  const allWithOutcome = [...withH1, ...withH24];
  const best = allWithOutcome.reduce((b, e) => {
    const p = e.outcomes.h24?.pct ?? e.outcomes.h1?.pct ?? 0;
    return !b || p > b.pct ? { symbol: e.symbol, pct: p } : b;
  }, null as { symbol: string; pct: number } | null);

  const worst = allWithOutcome.reduce((b, e) => {
    const p = e.outcomes.h24?.pct ?? e.outcomes.h1?.pct ?? 0;
    return !b || p < b.pct ? { symbol: e.symbol, pct: p } : b;
  }, null as { symbol: string; pct: number } | null);

  return {
    total: entries.length,
    withOutcomes: withH1.length,
    aiAccuracy: { total: aiTotal, correct: aiCorrect, rate: aiTotal ? aiCorrect / aiTotal : 0 },
    edgeScoreStats: { high: tierStats("high"), medium: tierStats("medium"), low: tierStats("low") },
    goplusAccuracy: { safeAndWon: 0, safeAndLost: 0, dangerAvoided: 0 },
    avgReturn1h: avg1h,
    avgReturn24h: avg24h,
    bestTrade: best,
    worstTrade: worst,
  };
}
