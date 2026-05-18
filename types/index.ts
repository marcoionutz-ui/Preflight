export type ChainId = "base" | "solana" | "ethereum" | "bsc" | "arbitrum";

export interface ChainConfig {
  name: string;
  short: string;
  color: string;
  gecko: string;
}

export interface Token {
  address: string;
  name: string;
  symbol: string;
}

export interface Pair {
  pairAddress: string;
  chainId: string;
  dexId?: string;
  baseToken: Token;
  quoteToken: Token;
  priceUsd?: string | number;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  volume?: { m5?: number; h1?: number; h24?: number };
  liquidity?: { usd?: number; base?: number; quote?: number };
  marketCap?: number;
  fdv?: number;
  txns?: {
    m5?: { buys: number; sells: number };
    h1?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
  pairCreatedAt?: number;
  _gecko?: boolean;
}

export type FlagSeverity = "high" | "med" | "low";
export interface RedFlag { code: string; sev: FlagSeverity; msg: string; }

export interface SmartScore {
  total: number; liqScore: number; momentumScore: number;
  safetyScore: number; buyPressure: number; buyRatio1h: number;
  hardReject: string | null;
}

export type VelocityTrend = "GROWING" | "SHRINKING" | "STABLE";
export interface BuyerVelocity { delta: number; trend: VelocityTrend; }

export type Verdict = "BUY" | "SELL" | "HOLD" | "AVOID" | "HONEYPOT";
export type Momentum = "BULLISH" | "BEARISH" | "NEUTRAL" | "PUMP" | "DUMP";

export interface AIAnalysis {
  riskScore: number; verdict: Verdict; confidence: number;
  observedSignals: string[]; inferredSignals: string[]; unknowns: string[];
  momentum: Momentum; entryZone: string; stopLoss: string;
  takeProfit: string; summary: string;
}

export interface OHLCVCandle {
  time: string; open: number; high: number; low: number; close: number; volume: number;
}

export interface FearGreedEntry {
  value: string; value_classification: string; timestamp: string;
}

export interface CoinPrice { usd: number; usd_24h_change: number; }
export type CoinPrices = Record<string, CoinPrice>;

export interface Position {
  id: number; symbol: string; address: string; chain: string;
  pairAddress: string; buyPrice: number; amount: number; currentPrice: number;
}

export interface PaperTrade {
  id: number; symbol: string; chain: string; address: string;
  pairAddress: string; entryPrice: number; currentPrice: number;
  entryTime: number; score: number; flagCount: number; note: string;
  checkpoints: Array<{ t: number; price: number }>;
  exitedAt?: number;
  exitPrice?: number;
  exitReason?: string;
  sl?: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
}

export type LogType = "info" | "ok" | "warn" | "err";
export interface LogEntry { id: number; ts: string; msg: string; t: LogType; }
export interface Alert { id: number; sym: string; msg: string; warn: boolean; }

export interface GeckoPool {
  id: string;
  attributes: {
    name?: string; address?: string; base_token_price_usd?: string;
    reserve_in_usd?: string; market_cap_usd?: number | null;
    price_change_percentage?: { m5?: number; h1?: number; h24?: number };
    volume_usd?: { m5?: string; h1?: string; h24?: string };
    transactions?: {
      m5?: { buys: number; sells: number };
      h1?: { buys: number; sells: number };
      h24?: { buys: number; sells: number };
    };
    pool_created_at?: string; base_token_id?: string;
  };
  relationships?: { network?: { data?: { id?: string } }; base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } }; };
}