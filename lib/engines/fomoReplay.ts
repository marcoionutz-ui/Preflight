/**
 * FOMO Replay — urmărește ce s-a întâmplat după fiecare block Anti-FOMO
 * Dovedește că engine-ul funcționează cu date reale
 */

const STORAGE_KEY = "supreme_fomo_replay";
const MAX_ENTRIES = 200;

export interface FOMOBlock {
  id: string;
  timestamp: number;
  symbol: string;
  chain: string;
  pairAddress: string;
  priceAtBlock: number;
  priceChange24hAtBlock: number;
  reason: string;
  outcome1h?:  { price: number; pct: number; timestamp: number };
  outcome6h?:  { price: number; pct: number; timestamp: number };
  outcome24h?: { price: number; pct: number; timestamp: number };
}

export interface FOMOStats {
  total: number;
  withOutcomes: number;
  goodBlocks: number;   // token a dump-uit după block ✓
  badBlocks: number;    // token a continuat să pompeze ✗
  accuracy: number;     // goodBlocks / withOutcomes
  avgDump1h: number;    // median % change la 1h după block
}

// ── Storage ───────────────────────────────────────────────────────────────────

function load(): FOMOBlock[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function save(entries: FOMOBlock[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {}
}

// ── Public API ────────────────────────────────────────────────────────────────

export function saveFOMOBlock(
  symbol: string,
  chain: string,
  pairAddress: string,
  priceAtBlock: number,
  priceChange24h: number,
  reason: string
): void {
  const all = load();
  // Nu duplica același pair în ultima oră
  const recent = all.find(
    b => b.pairAddress === pairAddress && Date.now() - b.timestamp < 60 * 60_000
  );
  if (recent) return;

  all.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    timestamp: Date.now(),
    symbol, chain, pairAddress, priceAtBlock,
    priceChange24hAtBlock: priceChange24h,
    reason,
  });
  save(all);
}

/** Apelat la fiecare trending refresh — actualizează outcome-urile */
export function updateFOMOOutcomes(
  trending: Array<{ pairAddress: string; priceUsd?: string | number }>
): void {
  const all = load();
  let changed = false;
  const now = Date.now();

  all.forEach(block => {
    const found = trending.find(p => p.pairAddress === block.pairAddress);
    if (!found) return;
    const price = Number(found.priceUsd);
    if (!price || isNaN(price)) return;

    const age = now - block.timestamp;
    const pct = (price - block.priceAtBlock) / block.priceAtBlock * 100;

    if (age >= 60 * 60_000 && !block.outcome1h) {
      block.outcome1h = { price, pct, timestamp: now };
      changed = true;
    }
    if (age >= 6 * 3600_000 && !block.outcome6h) {
      block.outcome6h = { price, pct, timestamp: now };
      changed = true;
    }
    if (age >= 24 * 3600_000 && !block.outcome24h) {
      block.outcome24h = { price, pct, timestamp: now };
      changed = true;
    }
  });

  if (changed) save(all);
}

export function getFOMOBlocks(): FOMOBlock[] {
  return load().sort((a, b) => b.timestamp - a.timestamp);
}

export function getFOMOStats(): FOMOStats {
  const all = load();
  const withH1 = all.filter(b => b.outcome1h);

  const goodBlocks = withH1.filter(b => (b.outcome1h?.pct ?? 0) < -5).length;
  const badBlocks  = withH1.filter(b => (b.outcome1h?.pct ?? 0) > 10).length;
  const accuracy   = withH1.length > 0 ? goodBlocks / withH1.length : 0;

  const sum1h = withH1.reduce((s, b) => s + (b.outcome1h?.pct ?? 0), 0);
  const avgDump1h = withH1.length > 0 ? sum1h / withH1.length : 0;

  return {
    total: all.length,
    withOutcomes: withH1.length,
    goodBlocks,
    badBlocks,
    accuracy,
    avgDump1h,
  };
}

export function clearFOMOReplay(): void {
  if (typeof window !== "undefined") localStorage.removeItem(STORAGE_KEY);
}