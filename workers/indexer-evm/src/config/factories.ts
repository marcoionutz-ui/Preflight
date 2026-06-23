/**
 * config/factories.ts
 * Factory contract map pentru indexer-evm.
 *
 * TOATE adresele sunt verificate manual din surse oficiale:
 *   Uniswap V2 Base      → developers.uniswap.org/docs/protocols/v2/deployments
 *   Uniswap V3 Base      → docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
 *   Aerodrome Base       → basescan.org 0x420DD381b31aEf6683db6B902084cB0FFECe40Da (PoolFactory, nu FactoryRegistry)
 *   PancakeSwap V2 BSC   → bscscan.com 0xca143ce32fe78f1f7019d7d551a6402fc5350c73
 *   PancakeSwap V3 BSC   → bscscan.com 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865
 *   Uniswap V3 Arbitrum  → docs.uniswap.org/contracts/v3/reference/deployments/arbitrum-deployments
 *   Camelot Arbitrum     → docs.camelot.exchange/contracts/arbitrum/one-mainnet (AMMv2 Factory)
 *
 * topic0-uri calculate via keccak256 și verificate pe Basescan/BscScan:
 *   UNISWAP_V2 / CAMELOT / PANCAKE_V2: PairCreated(address,address,address,uint256)
 *   AERODROME:  PairCreated(address,address,bool,address,uint256)  ← semnătură diferită! câmp stable în plus
 *   UNISWAP_V3 / PANCAKE_V3: PoolCreated(address,address,uint24,int24,address)
 *
 * Faza 6.0: Base only. BSC + Arbitrum enabled:false până la Faza 6.9.
 */

export type ChainId = "base" | "bsc" | "arbitrum";

export type AdapterType =
  | "UNISWAP_V2"
  | "UNISWAP_V3"
  | "UNISWAP_V4"
  | "AERODROME"
  | "PANCAKE_V2"
  | "PANCAKE_V3"
  | "CAMELOT";

export type FactoryEvent = "PairCreated" | "PoolCreated" | "Initialize";

export interface FactoryConfig {
  chain:      ChainId;
  dexId:      string;
  dexType:    "V2" | "V3" | "V4";
  address:    `0x${string}`;
  adapter:    AdapterType;
  event:      FactoryEvent;
  /** keccak256(event signature) — folosit ca topic[0] în eth_getLogs */
  topic0:     `0x${string}`;
  enabled:    boolean;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

// ── topic0 constants (keccak256, verificate) ──────────────────────────────────

/** PairCreated(address,address,address,uint256) — Uniswap V2, PancakeSwap V2, Camelot */
export const TOPIC0_PAIR_CREATED_V2 =
  "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9" as const;

/**
 * PairCreated(address,address,bool,address,uint256) — Aerodrome / Velodrome V2
 * Diferit de Uniswap V2: are câmpul `stable bool` în plus, înainte de `pair address`.
 * Verificat pe Basescan via eth_getLogs logs de la factory 0x420DD381...
 */
export const TOPIC0_PAIR_CREATED_AERODROME =
  "0xc4805696c66d7cf352fc1d6bb633ad5ee82f6cb577c453024b6e0eb8306c6fc9" as const;

/** PoolCreated(address,address,uint24,int24,address) — Uniswap V3, PancakeSwap V3 */
export const TOPIC0_POOL_CREATED_V3 =
  "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118" as const;

/**
 * Initialize(bytes32,address,address,uint24,int24,address,uint160,int24) — Uniswap V4 PoolManager
 * Emis de PoolManager singleton la inițializarea unui pool nou.
 * topics[1]=poolId, topics[2]=currency0, topics[3]=currency1 (indexed)
 * data = fee(uint24) + tickSpacing(int24) + hooks(address) + sqrtPriceX96(uint160) + tick(int24)
 */
export const TOPIC0_INITIALIZE_V4 =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438" as const;

// ── V4 chain config (StateView per chain) ─────────────────────────────────────

/**
 * V4 chains config — PoolManager + StateView addresses.
 * PoolManager = singleton, acționează ca "factory" pentru pool discovery.
 * StateView   = contract lens pentru reads offchain (getSlot0, getLiquidity).
 *
 * Adrese verificate din docs.uniswap.org/contracts/v4/deployments (2026-06-23).
 */
export interface V4ChainConfig {
  poolManagerAddress: `0x${string}`;
  stateViewAddress:   `0x${string}`;
}

export const V4_CHAIN_CONFIG: Partial<Record<ChainId, V4ChainConfig>> = {
  base: {
    poolManagerAddress: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    stateViewAddress:   "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
  },
  arbitrum: {
    poolManagerAddress: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
    stateViewAddress:   "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
  },
  bsc: {
    poolManagerAddress: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    stateViewAddress:   "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
  },
};

/** Returns the V4 config for a chain, or null if not available. */
export function getV4Config(chain: ChainId): V4ChainConfig | null {
  return V4_CHAIN_CONFIG[chain] ?? null;
}

// ── Factory definitions ───────────────────────────────────────────────────────

export const FACTORIES: FactoryConfig[] = [
  // ── BASE (enabled în Faza 6.0) ─────────────────────────────────────────────
  {
    chain:      "base",
    dexId:      "uniswap-v2",
    dexType:    "V2",
    address:    "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    adapter:    "UNISWAP_V2",
    event:      "PairCreated",
    topic0:     TOPIC0_PAIR_CREATED_V2,
    enabled:    true,
    confidence: "HIGH",
  },
  {
    chain:      "base",
    dexId:      "uniswap-v3",
    dexType:    "V3",
    address:    "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    adapter:    "UNISWAP_V3",
    event:      "PoolCreated",
    topic0:     TOPIC0_POOL_CREATED_V3,
    enabled:    true,
    confidence: "HIGH",
  },
  {
    chain:      "base",
    dexId:      "aerodrome",
    dexType:    "V2",
    // PoolFactory (AMM basic, emite PairCreated cu bool stable) — NU FactoryRegistry (0x5C3F18F0...)
    address:    "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
    adapter:    "AERODROME",
    event:      "PairCreated",
    topic0:     TOPIC0_PAIR_CREATED_AERODROME,
    enabled:    true,
    confidence: "HIGH",
  },

  // ── BSC (env-gated — setează INDEXER_ENABLE_BSC=1 în Railway pentru activare) ──
  {
    chain:      "bsc",
    dexId:      "pancakeswap-v2",
    dexType:    "V2",
    address:    "0xca143ce32fe78f1f7019d7d551a6402fc5350c73",
    adapter:    "PANCAKE_V2",
    event:      "PairCreated",
    topic0:     TOPIC0_PAIR_CREATED_V2,
    enabled:    process.env.INDEXER_ENABLE_BSC === "1",
    confidence: "HIGH",
  },
  {
    chain:      "bsc",
    dexId:      "pancakeswap-v3",
    dexType:    "V3",
    address:    "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    adapter:    "PANCAKE_V3",
    event:      "PoolCreated",
    topic0:     TOPIC0_POOL_CREATED_V3,
    enabled:    process.env.INDEXER_ENABLE_BSC === "1",
    confidence: "HIGH",
  },

  // ── V4 BASE (env-gated — INDEXER_ENABLE_V4=1) ─────────────────────────────────
  {
    chain:      "base",
    dexId:      "uniswap-v4",
    dexType:    "V4",
    address:    "0x498581ff718922c3f8e6a244956af099b2652b2b", // PoolManager Base
    adapter:    "UNISWAP_V4",
    event:      "Initialize",
    topic0:     TOPIC0_INITIALIZE_V4,
    enabled:    process.env.INDEXER_ENABLE_V4 === "1",
    confidence: "HIGH",
  },

  // ── V4 ARBITRUM (env-gated — INDEXER_ENABLE_V4=1 + INDEXER_ENABLE_ARBITRUM=1) ──
  {
    chain:      "arbitrum",
    dexId:      "uniswap-v4",
    dexType:    "V4",
    address:    "0x360e68faccca8ca495c1b759fd9eee466db9fb32", // PoolManager Arbitrum
    adapter:    "UNISWAP_V4",
    event:      "Initialize",
    topic0:     TOPIC0_INITIALIZE_V4,
    enabled:    process.env.INDEXER_ENABLE_V4 === "1" && process.env.INDEXER_ENABLE_ARBITRUM === "1",
    confidence: "HIGH",
  },

  // ── V4 BSC (env-gated — INDEXER_ENABLE_V4=1 + INDEXER_ENABLE_BSC=1) ──────────
  {
    chain:      "bsc",
    dexId:      "uniswap-v4",
    dexType:    "V4",
    address:    "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df", // PoolManager BSC
    adapter:    "UNISWAP_V4",
    event:      "Initialize",
    topic0:     TOPIC0_INITIALIZE_V4,
    enabled:    process.env.INDEXER_ENABLE_V4 === "1" && process.env.INDEXER_ENABLE_BSC === "1",
    confidence: "HIGH",
  },

  // ── ARBITRUM (env-gated — setează INDEXER_ENABLE_ARBITRUM=1 în Railway pentru activare) ──
  {
    chain:      "arbitrum",
    dexId:      "uniswap-v3",
    dexType:    "V3",
    address:    "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    adapter:    "UNISWAP_V3",
    event:      "PoolCreated",
    topic0:     TOPIC0_POOL_CREATED_V3,
    enabled:    process.env.INDEXER_ENABLE_ARBITRUM === "1",
    confidence: "HIGH",
  },
  {
    chain:      "arbitrum",
    dexId:      "camelot",
    dexType:    "V2",
    // AMMv2 Factory — din docs.camelot.exchange/contracts/arbitrum/one-mainnet
    address:    "0x6EcCab422D763aC031210895C81787E87B43A652",
    adapter:    "CAMELOT",
    event:      "PairCreated",
    topic0:     TOPIC0_PAIR_CREATED_V2,
    enabled:    process.env.INDEXER_ENABLE_ARBITRUM === "1",
    confidence: "HIGH",
  },
];

// ── Helper functions ──────────────────────────────────────────────────────────

/** Chainuri cu cel puțin o factory enabled. */
export function getEnabledChains(): ChainId[] {
  return [...new Set(
    FACTORIES.filter(f => f.enabled).map(f => f.chain),
  )];
}

/** Factories active pentru un chain dat. */
export function getEnabledFactories(chain: ChainId): FactoryConfig[] {
  return FACTORIES.filter(f => f.chain === chain && f.enabled);
}

/** Adresele factory active pentru un chain (pentru filtrul eth_getLogs). */
export function getFactoryAddresses(chain: ChainId): `0x${string}`[] {
  return getEnabledFactories(chain).map(f => f.address);
}

/** Lookup factory după adresă (lowercase). */
export function getFactoryByAddress(
  chain:   ChainId,
  address: string,
): FactoryConfig | undefined {
  const lower = address.toLowerCase();
  return FACTORIES.find(
    f => f.chain === chain && f.address.toLowerCase() === lower,
  );
}
