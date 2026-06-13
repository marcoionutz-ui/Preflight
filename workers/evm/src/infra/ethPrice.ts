/**
 * infra/ethPrice.ts
 * Backward compat wrapper — re-exportă din nativePrice.ts
 * Nu șterge acest fișier — e importat în memory.ts, index.ts etc.
 */

export {
  getEthPrice,
  refreshNativePrices as refreshEthPrice,
} from "./nativePrice";