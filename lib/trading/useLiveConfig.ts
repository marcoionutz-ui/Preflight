/**
 * useLiveConfig — Live config dinamic, persistat în localStorage
 * Înlocuiește LIVE_CONFIG static din liveConfig.ts
 */

import { useState, useEffect } from "react";
import { LIVE_CONFIG } from "@/lib/trading/liveConfig";
import type { LiveConfig, TradingMode } from "@/lib/trading/liveConfig";

const STORAGE_KEY = "supreme_live_config";

function loadConfig(): LiveConfig {
  if (typeof window === "undefined") return LIVE_CONFIG;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return LIVE_CONFIG;
    return { ...LIVE_CONFIG, ...JSON.parse(raw) };
  } catch { return LIVE_CONFIG; }
}

function saveConfig(cfg: LiveConfig): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch {}
}

export function useLiveConfig() {
  const [config, setConfig] = useState<LiveConfig>(loadConfig);

  useEffect(() => { saveConfig(config); }, [config]);

  const setMode = (mode: TradingMode) => {
    setConfig(prev => ({ ...prev, mode }));
  };

  const setMaxTradeEth = (val: number) => {
    setConfig(prev => ({ ...prev, maxTradeEth: val }));
  };

  const setMinEdgeScore = (val: number) => {
    setConfig(prev => ({ ...prev, minEdgeScore: val }));
  };

  const resetToDefaults = () => {
    setConfig(LIVE_CONFIG);
    if (typeof window !== "undefined") localStorage.removeItem(STORAGE_KEY);
  };

   const setMaxTradesPerDay = (val: number) => {
    setConfig(prev => ({ ...prev, maxTradesPerDay: val }));
  };

  return { config, setMode, setMaxTradeEth, setMinEdgeScore, resetToDefaults };
}