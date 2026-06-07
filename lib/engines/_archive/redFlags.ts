import type { Pair, RedFlag } from "@/types";
import { ageHours } from "@/lib/utils";

export function computeRedFlags(pair: Pair): RedFlag[] {
  const flags: RedFlag[] = [];

  // Force Number() on everything — GeckoTerminal returns strings sometimes
  const liq    = Number(pair.liquidity?.usd   ?? 0);
  const vol24  = Number(pair.volume?.h24      ?? 0);
  const vol1h  = Number(pair.volume?.h1       ?? 0);
  const vol5m  = Number(pair.volume?.m5       ?? 0);
  const pct24  = Number(pair.priceChange?.h24 ?? 0);
  const pct1h  = Number(pair.priceChange?.h1  ?? 0);
  const buys1h = Number(pair.txns?.h1?.buys   ?? 0);
  const sells1h= Number(pair.txns?.h1?.sells  ?? 0);
  const buys5m = Number(pair.txns?.m5?.buys   ?? 0);
  const sells5m= Number(pair.txns?.m5?.sells  ?? 0);
  const t1h    = buys1h + sells1h || 1;
  const t5m    = buys5m + sells5m || 1;
  const ah     = ageHours(pair.pairCreatedAt);
  const mcap   = Number(pair.marketCap ?? 0);
  const fdv    = Number(pair.fdv       ?? 0);

  // ── Liquidity ───────────────────────────────────────────────────────────────
  if (liq < 5_000)
    flags.push({ code: "CRITICAL_LOW_LIQ", sev: "high", msg: `Liquidity $${liq.toFixed(0)} — extreme rug risk` });
  else if (liq < 25_000)
    flags.push({ code: "LOW_LIQUIDITY", sev: "high", msg: `Liquidity ${(liq / 1000).toFixed(1)}K — high rug risk` });

  // ── Wash volume ─────────────────────────────────────────────────────────────
  if (liq > 0) {
    const ratio = vol24 / liq;
    if (ratio > 30)
      flags.push({ code: "WASH_VOLUME", sev: "high", msg: `Vol/Liq ${ratio.toFixed(0)}× — likely wash trading` });
    else if (ratio > 10)
      flags.push({ code: "HIGH_VOL_LIQ", sev: "med", msg: `Vol/Liq ${ratio.toFixed(0)}× — monitor closely` });
  }

  // ── Late entry / pump ───────────────────────────────────────────────────────
  if (pct24 > 500)
    flags.push({ code: "LATE_ENTRY_RISK", sev: "high", msg: `+${pct24.toFixed(0)}% 24h — likely late entry` });
  else if (pct24 > 200)
    flags.push({ code: "PUMP_WATCH", sev: "med", msg: `+${pct24.toFixed(0)}% 24h — pump phase` });

  // ── Age ─────────────────────────────────────────────────────────────────────
  if (ah < 0.25)
    flags.push({ code: "VERY_NEW_PAIR", sev: "high", msg: `Pair age ${Math.round(ah * 60)}min — extreme caution` });
  else if (ah < 2)
    flags.push({ code: "NEW_PAIR", sev: "med", msg: `Pair age ${(ah * 60).toFixed(0)}min — unproven` });

  // ── Selling pressure ────────────────────────────────────────────────────────
  if (t1h > 5 && sells1h / t1h > 0.75)
    flags.push({ code: "HEAVY_SELLING", sev: "high", msg: `${Math.round((sells1h / t1h) * 100)}% sells 1h — distribution` });

  if (t5m > 5 && sells5m / t5m > 0.8)
    flags.push({ code: "DUMP_5M", sev: "high", msg: `${Math.round((sells5m / t5m) * 100)}% sells 5m — active dump` });

  // ── Volume spike (5m vs 1h avg) ─────────────────────────────────────────────
  if (vol1h > 0 && vol5m > vol1h * 0.5)
    flags.push({ code: "VOLUME_SPIKE", sev: "med", msg: "5m volume >50% of 1h — sudden spike" });

  // ── FDV risk ────────────────────────────────────────────────────────────────
  if (mcap > 0 && fdv > 0 && fdv / mcap > 15)
    flags.push({ code: "HIGH_FDV_RISK", sev: "med", msg: `FDV/MCap ${(fdv / mcap).toFixed(0)}× — large unlock risk` });

  // ── Sharp drop ──────────────────────────────────────────────────────────────
  if (pct1h < -30)
    flags.push({ code: "SHARP_DROP_1H", sev: "high", msg: `${pct1h.toFixed(1)}% in 1h — possible rug` });

  return flags;
}