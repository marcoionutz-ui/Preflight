/**
 * LiveRiskManager — ultimul layer de siguranță înainte de execuție
 * Kill switch, daily loss, cooldown, max positions, max trades/day
 */

const STORAGE_KEY = "supreme_risk_state";

export interface LiveRiskState {
  killSwitch: boolean;
  // Daily tracking — reset la miezul nopții
  dailyDate: string;
  dailyRealizedPnlEth: number;
  tradesToday: number;
  // Position tracking
  openPositions: number;
  // Loss streak
  consecutiveLosses: number;
  cooldownUntil?: number;
  lastUpdated: number;
}

export interface RiskCheckResult {
  allowed: boolean;
  blockers: string[];
}

const DEFAULT_STATE: LiveRiskState = {
  killSwitch: false,
  dailyDate: "",
  dailyRealizedPnlEth: 0,
  tradesToday: 0,
  openPositions: 0,
  consecutiveLosses: 0,
  cooldownUntil: undefined,
  lastUpdated: Date.now(),
};

// ── Storage ───────────────────────────────────────────────────────────────────

function load(): LiveRiskState {
  if (typeof window === "undefined") return { ...DEFAULT_STATE };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
    // Reset daily counters dacă e o nouă zi
    const today = new Date().toISOString().slice(0, 10);
    if (state.dailyDate !== today) {
      state.dailyDate = today;
      state.dailyRealizedPnlEth = 0;
      state.tradesToday = 0;
      state.consecutiveLosses = 0;
      state.cooldownUntil = undefined;
    }
    return state;
  } catch { return { ...DEFAULT_STATE }; }
}

function save(state: LiveRiskState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...state,
      lastUpdated: Date.now(),
    }));
  } catch {}
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getRiskState(): LiveRiskState {
  return load();
}

export function canEnterTrade(
  maxDailyLossEth: number,
  maxOpenPositions: number,
  maxTradesPerDay: number
): RiskCheckResult {
  const state = load();
  const blockers: string[] = [];

  if (state.killSwitch) {
    blockers.push("🔴 KILL SWITCH ACTIVE — all trading halted");
  }

  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    const mins = Math.ceil((state.cooldownUntil - Date.now()) / 60_000);
    blockers.push(`⏸ COOLDOWN — ${mins}m remaining after consecutive losses`);
  }

  if (state.dailyRealizedPnlEth <= -Math.abs(maxDailyLossEth)) {
    blockers.push(`📉 DAILY LOSS LIMIT — ${state.dailyRealizedPnlEth.toFixed(4)} ETH (max -${maxDailyLossEth})`);
  }

  if (state.openPositions >= maxOpenPositions) {
    blockers.push(`📊 MAX POSITIONS — ${state.openPositions}/${maxOpenPositions} open`);
  }

  if (state.tradesToday >= maxTradesPerDay) {
    blockers.push(`🔢 MAX TRADES/DAY — ${state.tradesToday}/${maxTradesPerDay} today`);
  }

  return { allowed: blockers.length === 0, blockers };
}

export function recordTradeOpen(): void {
  const state = load();
  state.openPositions = (state.openPositions || 0) + 1;
  state.tradesToday   = (state.tradesToday || 0) + 1;
  state.dailyDate     = new Date().toISOString().slice(0, 10);
  save(state);
}

export function recordTradeClose(pnlEth: number, cooldownMinutes = 60): void {
  const state = load();
  state.openPositions       = Math.max(0, (state.openPositions || 0) - 1);
  state.dailyRealizedPnlEth = (state.dailyRealizedPnlEth || 0) + pnlEth;

  if (pnlEth < 0) {
    state.consecutiveLosses = (state.consecutiveLosses || 0) + 1;
    if (state.consecutiveLosses >= 2) {
      state.cooldownUntil = Date.now() + cooldownMinutes * 60_000;
    }
  } else {
    state.consecutiveLosses = 0;
    state.cooldownUntil = undefined;
  }
  save(state);
}

export function setKillSwitch(enabled: boolean): void {
  const state = load();
  state.killSwitch = enabled;
  save(state);
}

export function resetRiskState(): void {
  const today = new Date().toISOString().slice(0, 10);
  save({ ...DEFAULT_STATE, dailyDate: today });
}

export function getCooldownRemaining(): number {
  const state = load();
  if (!state.cooldownUntil) return 0;
  return Math.max(0, Math.ceil((state.cooldownUntil - Date.now()) / 60_000));
}