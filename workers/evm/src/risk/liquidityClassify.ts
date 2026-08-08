/**
 * risk/liquidityClassify.ts — NF/U5: clasificarea liqStatus, PUR (fără store/IO → testabil cu tsx).
 *
 * Rezervele reale (V2 getReserves / V3 balanceOf / Gecko/DexScreener reported) folosesc pragurile
 * standard (CONFIRMED ≥ $25k / WEAK ≥ $5k). `reserveUsd`-ul V4 provine din virtual reserves
 * (StateView.getLiquidity × sqrtPrice × 2) — un ESTIMAT care SUPRAESTIMEAZĂ pozițiile concentrate:
 * o poziție îngustă arată virtual reserves uriașe față de TVL-ul real, iar factorul de supraestimare
 * e NEmărginit (nu doar ~4×) fără tick data. DECI un estimat V4 (`V4_STATE_LIQUIDITY`) NU poate ajunge
 * NICIODATĂ CONFIRMED — maximum WEAK cât e proaspăt (peste un prag minim), altfel MISSING (gating
 * conservator, U5 / decizia varu). Astfel gate-ul V3/V4-cere-CONFIRMED din gates.ts nu intră niciodată
 * pe baza unei rezerve V4 umflate. Pragul WEAK al estimatului e env-overridable.
 */

import { isEstimatedReserve, type ReserveSource, type LiquidityStatus } from "@preflight/schema";
import { isV4PoolAddress } from "../ws/v4Hooks";

export type LiqStatus = "CONFIRMED" | "WEAK" | "MISSING";

/**
 * NF/U5 (R4 varu): proveniența rezervei la RESTORE din snapshot, unde reserveSource NU e persistat.
 * O adresă V4 (poolId bytes32) are ÎNTOTDEAUNA rezervă din virtual reserves → o marcăm conservator ca
 * estimat V4 (ca să nu redevină CONFIRMED după restart). Non-V4 (V2/V3, adresă 42) = rezerve reale → undefined.
 * Sursă unică folosită de state/memory.ts (restore) ȘI de teste (nu o copie a ternarului).
 */
export function reserveSourceForRestore(address: string): ReserveSource | undefined {
  return isV4PoolAddress(address) ? "V4_STATE_LIQUIDITY" : undefined;
}

function envUsd(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Rezerve REALE / raportate de DEX.
const LIQ_CONFIRMED_USD = envUsd("EVM_LIQ_CONFIRMED_USD", 25_000);
const LIQ_WEAK_USD      = envUsd("EVM_LIQ_WEAK_USD",       5_000);

// Estimat V4 (virtual reserves): NU există prag de CONFIRMED (imposibil, oricât de mare). Doar un prag
// minim ca să conteze drept WEAK (sub el → MISSING). Default mai conservator decât WEAK-ul real.
const LIQ_V4EST_WEAK_USD = envUsd("EVM_LIQ_V4EST_WEAK_USD", 25_000);

// Ferestre de prospețime (neschimbate față de logica veche).
const FRESH_CONFIRMED_MS = 5  * 60_000;
const FRESH_WEAK_MS      = 10 * 60_000;

/**
 * Pragurile efective pt. o sursă de rezervă (expus pt. raportare/teste). Pentru un estimat V4,
 * `confirmedUsd` e `Infinity` (CONFIRMED imposibil) — doar `weakUsd` contează.
 */
export function liquidityBars(reserveSource: ReserveSource | null | undefined): {
  confirmedUsd: number;
  weakUsd:      number;
  estimated:    boolean;
} {
  const estimated = isEstimatedReserve(reserveSource);
  return estimated
    ? { confirmedUsd: Infinity,           weakUsd: LIQ_V4EST_WEAK_USD, estimated: true }
    : { confirmedUsd: LIQ_CONFIRMED_USD,  weakUsd: LIQ_WEAK_USD,       estimated: false };
}

/**
 * Clasifică lichiditatea în CONFIRMED / WEAK / MISSING pe baza rezervei, prospețimii ȘI a proveniénței.
 * `freshnessMs` = now - updatedAt (ms). Un estimat V4 (V4_STATE_LIQUIDITY) NU poate fi CONFIRMED niciodată
 * (confirmedUsd = Infinity) — maximum WEAK; peste TTL sau sub pragul minim → MISSING.
 */
export function classifyLiquidity(
  reserveUsd:    number,
  freshnessMs:   number,
  reserveSource: ReserveSource | null | undefined,
): LiqStatus {
  if (!Number.isFinite(reserveUsd) || reserveUsd <= 0)   return "MISSING";
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0)  return "MISSING"; // updatedAt lipsă/în viitor → nu pretinde
  const { confirmedUsd, weakUsd } = liquidityBars(reserveSource);
  if (reserveUsd >= confirmedUsd && freshnessMs < FRESH_CONFIRMED_MS) return "CONFIRMED";
  if (reserveUsd >= weakUsd      && freshnessMs < FRESH_WEAK_MS)      return "WEAK";
  return "MISSING";
}

// ── Derived tier pt. semnale (momentum/signal/qualified) — THIN/OK/CONFIRMED/DEEP ──────────────
// Sursă unică (folosită de workers/evm/src/lib/preflight-redis.ts deriveLiquidityStatus). Clasificarea
// derivată din semnale NU trebuie să reconstruiască CONFIRMED/DEEP din raw reserveUsd când sursa e un
// ESTIMAT V4 (V4_STATE_LIQUIDITY) — altfel plafonarea din liqStatus e ocolită. Estimat → maximum OK.
const DERIVED_THIN_USD    = 15_000;
const DERIVED_DEEP_USD    = 500_000;
const DERIVED_CONFIRM_USD = 100_000;
export function deriveLiquidityTier(
  reserveUsd:    number,
  liqStatus:     string,
  reserveSource?: ReserveSource | null,
): LiquidityStatus {
  if (reserveUsd < DERIVED_THIN_USD)             return "THIN";
  // NF/U5: estimat V4 → niciodată CONFIRMED/DEEP (virtual reserves pot supraestima nelimitat).
  if (isEstimatedReserve(reserveSource))         return "OK";
  if (reserveUsd > DERIVED_DEEP_USD)             return "DEEP";
  if (liqStatus === "CONFIRMED" || reserveUsd > DERIVED_CONFIRM_USD) return "CONFIRMED";
  return "OK";
}
