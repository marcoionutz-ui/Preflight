/**
 * ws/v4Hooks.ts — NF1: hook-uri Uniswap V4 + onestitatea flow-ului.
 *
 * Un pool V4 al cărui hook implementează `beforeSwapReturnDelta` / `afterSwapReturnDelta` poate modifica
 * sumele finale ale swap-ului (hook-ul ia/adaugă tokeni din delta), deci `Swap` event-ul emis de PoolManager
 * NU reflectă neapărat input/output-ul REAL → buy/sell + volumul derivate din event sunt „event-only",
 * posibil incomplete. Permisiunile hook-ului sunt codate în biții JOŞI ai ADRESEI (Uniswap v4-core `Hooks.sol`):
 * BEFORE_SWAP_RETURNS_DELTA_FLAG = 1<<3 (0x8), AFTER_SWAP_RETURNS_DELTA_FLAG = 1<<2 (0x4).
 *
 * MODEL TRI-STARE pentru câmpul `hooks` (normalizeHooks):
 *   - adresă validă non-zero  → custom hook CONFIRMAT (string)
 *   - zero-address            → vanilla V4 CONFIRMAT, fără hook (`null`)
 *   - absent / malformat      → info indisponibilă (`undefined`)
 * Coverage-ul (flowCoverageForPool) combină dexType + hooks: V2/V3 → FULL; V4 vanilla / hook fără return-delta
 * → FULL; V4 hook return-delta → EVENT_ONLY; V4 cu hooks necunoscut → UNKNOWN (nu pretindem FULL fals). PUR.
 */

export type FlowCoverage = "FULL" | "EVENT_ONLY" | "UNKNOWN";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BEFORE_SWAP_RETURNS_DELTA_FLAG = 1n << 3n; // 0x8
const AFTER_SWAP_RETURNS_DELTA_FLAG  = 1n << 2n; // 0x4

/**
 * Normalizează valoarea brută `hooks` (din pair-ul indexat) la modelul tri-stare:
 *   `string` (adresă lowercase non-zero) = custom hook; `null` = zero-address (vanilla); `undefined` = indisponibil
 * (absent sau malformat — nu inventăm „fără hook" când nu știm).
 */
export function normalizeHooks(raw: unknown): string | null | undefined {
  if (typeof raw !== "string") return undefined;
  const h = raw.toLowerCase().trim();
  if (!/^0x[0-9a-f]{40}$/.test(h)) return undefined; // malformat → indisponibil
  if (h === ZERO_ADDRESS) return null;               // zero-address → vanilla (fără hook)
  return h;                                          // custom hook confirmat
}

/** `true` dacă adresa hook-ului V4 are setat vreun bit de return-delta la swap. Input invalid/zero → `false`. */
export function hookReturnsDelta(hooks: string | null | undefined): boolean {
  if (!hooks) return false;
  const h = hooks.toLowerCase().trim();
  if (!/^0x[0-9a-f]{40}$/.test(h)) return false;
  let addr: bigint;
  try { addr = BigInt(h); } catch { return false; }
  if (addr === 0n) return false; // vanilla
  return (addr & BEFORE_SWAP_RETURNS_DELTA_FLAG) !== 0n
      || (addr & AFTER_SWAP_RETURNS_DELTA_FLAG)  !== 0n;
}

/**
 * Coverage-ul de flow al unui pool, din `dexType` + `hooks` (deja normalizat prin normalizeHooks):
 *   V2/V3 → FULL (fără concept de hook); V4 + hooks `undefined` → UNKNOWN (nu știm dacă hook-ul e return-delta);
 *   V4 + hooks `null` (vanilla) → FULL; V4 + custom hook → EVENT_ONLY dacă return-delta, altfel FULL.
 */
export function flowCoverageForPool(
  dexType: string | null | undefined,
  hooks:   string | null | undefined,
): FlowCoverage {
  if (dexType !== "V4") return "FULL";
  if (hooks === undefined) return "UNKNOWN";
  if (hooks === null) return "FULL";
  return hookReturnsDelta(hooks) ? "EVENT_ONLY" : "FULL";
}

/**
 * `true` dacă adresa pare un poolId Uniswap V4 (bytes32 = `0x` + 64 hex) — PE ORICE CHAIN, nu doar Base.
 * Fix NF1 (varu): înainte Gecko/DexScreener marcau V4 doar pe Base după lungime → V4 pe arbitrum/ethereum
 * cădea la V2. poolId-ul V4 e un bytes32 pe toate chain-urile.
 */
export function isV4PoolAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return /^0x[0-9a-f]{64}$/i.test(addr.trim());
}
