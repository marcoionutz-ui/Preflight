"use client";

import { useState, useCallback, useRef } from "react";
import type { Alert, Pair } from "@/types";

const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per pair

export function useAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const cooldowns = useRef<Record<string, number>>({});

  const addAlert = useCallback((sym: string, msg: string, warn = false, key?: string) => {
    const now = Date.now();
    const k = key ?? `${sym}:${msg}`;

    // Deduplicate — don't fire same alert within cooldown window
    if (cooldowns.current[k] && now - cooldowns.current[k] < COOLDOWN_MS) return;
    cooldowns.current[k] = now;

    setAlerts((a) => [...a.slice(-8), { id: now + Math.random(), sym, msg, warn }]);
  }, []);

  const checkVolumeSpikeAlerts = useCallback((pairs: Pair[]) => {
    pairs.forEach((p) => {
      const avg5m = (p.volume?.h1 ?? 0) / 12;
      if (avg5m === 0) return;
      const ratio = (p.volume?.m5 ?? 0) / avg5m;
      if (ratio > 2.5) {
        addAlert(
          p.baseToken?.symbol ?? "?",
          `Vol spike ×${ratio.toFixed(1)}`,
          false,
          `${p.pairAddress}:volSpike`
        );
      }
    });
  }, [addAlert]);

  const addRiskAlert = useCallback((sym: string, riskScore: number, verdict: string) => {
    if (riskScore >= 75) {
      addAlert(sym, `HIGH RISK ${riskScore}/100: ${verdict}`, true, `${sym}:risk`);
    }
  }, [addAlert]);

  const addFlagAlert = useCallback((sym: string, highFlagCount: number) => {
    if (highFlagCount > 0) {
      addAlert(sym, `${highFlagCount} HIGH red flags`, true, `${sym}:flags`);
    }
  }, [addAlert]);

  return { alerts, addAlert, checkVolumeSpikeAlerts, addRiskAlert, addFlagAlert };
}
