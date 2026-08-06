/**
 * infra/quotePrices.ts
 * USD price resolver pentru quote tokens.
 *
 * Priority order:
 *   1. STABLE      — Chainlink <stable>/USD feed (prinde DEPEG). Feed configurat + preț de neîncredere
 *                    (stale/RPC-fail/sequencer down) → UNKNOWN (null). $1.00 STATIC_STABLE DOAR când NU există feed.
 *   2. CHAINLINK   — ETH/BNB din on-chain Chainlink feed (Redis cache, TTL 5min)
 *   3. ENV_FALLBACK — INDEXER_WETH_USD / INDEXER_BNB_USD / INDEXER_{SYMBOL}_USD
 *   4. null        — unknown, caller setează priceStatus=QUOTE_PRICE_UNKNOWN
 *
 * U3 (correctness varu + NF5):
 *   - FRESHNESS: `latestRoundData()` se decodează COMPLET (roundId/answer/startedAt/updatedAt/answeredInRound),
 *     nu doar `answer`. Un round mort nu mai pare proaspăt: validăm `answer>0`, `answeredInRound>=roundId`,
 *     `updatedAt>0` și age vs limita PER FEED (heartbeat oficial × buffer, vezi HEARTBEAT_SEC);
 *     `QuotePriceResult.updatedAt` = timpul ORACLE (nu `Date.now()`), ca reader-ul (E11 `quotePriceCheckedAt`)
 *     să calculeze vârsta REALĂ.
 *   - NF5 SEQUENCER: pe L2 (Base/Arbitrum) prețul Chainlink nu e de încredere dacă secvențatorul a fost jos;
 *     gate pe L2 Sequencer Uptime Feed ÎNAINTE de cache-serve (down / grace-period după revenire → refuzăm CHAINLINK).
 *   - DEPEG STABLE: stables nu mai sunt presupuse permanent $1 — dacă există un feed <stable>/USD (proaspăt),
 *     folosim prețul REAL; feed configurat dar de neîncredere → UNKNOWN (null), NU $1 (nu masca depeg-ul).
 *
 * ⚠️ ADRESE + HEARTBEAT DE FEED: cele hardcodate sunt din directoarele oficiale Chainlink (reference-data-directory,
 * confirmate 2026-08-06). Oricare poate fi suprascrisă prin env (`INDEXER_STABLE_FEED_<CHAIN>_<SYMBOL>`,
 * `INDEXER_SEQUENCER_FEED_<CHAIN>`, `INDEXER_FEED_MAX_STALE_<CHAIN>_<LABEL>`) FĂRĂ modificare de cod — pt.
 * schimbări de parametri Chainlink (ex. Arbitrum a coborât heartbeat-urile pe 2026-04-29).
 */

import type { Redis } from "ioredis";

// ── Types ─────────────────────────────────────────────────────────────────────

export type QuotePriceSource =
  | "STATIC_STABLE"   // stablecoin fără feed → $1.00 fallback
  | "CHAINLINK"       // fetched de la Chainlink on-chain oracle (Redis cached) — incl. <stable>/USD (depeg)
  | "ENV_FALLBACK"    // citit din env var Railway (INDEXER_WETH_USD etc.)
  | "UNKNOWN";        // fără preț disponibil

export interface QuotePriceResult {
  price:     number;
  source:    QuotePriceSource;
  updatedAt: number;  // ms timestamp — pentru CHAINLINK = timpul ORACLE (updatedAt din round), nu fetch-time
}

/** Cele 5 câmpuri din Chainlink `latestRoundData()` (roundId, answer, startedAt, updatedAt, answeredInRound). */
export interface ChainlinkRoundData {
  roundId:         bigint;
  answer:          bigint;
  startedAt:       bigint;
  updatedAt:       bigint;
  answeredInRound: bigint;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const NATIVE_ADDRESS          = "0x0000000000000000000000000000000000000000";
const CHAINLINK_CACHE_TTL_SEC = 300;   // 5 min — limitează RPC (re-fetch), NU e garanția de freshness
const CHAINLINK_TIMEOUT_MS    = 4_000;
const SEL_LATEST_ROUND_DATA   = "0xfeaf968c"; // latestRoundData()

function envNum(key: string, def: number): number {
  const v = Number(process.env[key] ?? NaN);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

// Backstop GLOBAL — atins DOAR de un feed care nu e în HEARTBEAT_SEC (feed viitor neconfigurat). Cele 15 feed-uri
// live au toate limită per-feed mai jos; global e doar plasa de siguranță „preț absurd de vechi".
const CHAINLINK_MAX_STALE_SEC = envNum("INDEXER_CHAINLINK_MAX_STALE_SEC", 86_400); // 24h (fallback)
// Grace după revenirea secvențatorului (recomandarea Chainlink) — prețurile pot fi stale în fereastra asta.
const SEQUENCER_GRACE_SEC     = envNum("INDEXER_SEQUENCER_GRACE_SEC", 3_600);      // 1h

// Heartbeat OFICIAL per feed (secunde), din directoarele Chainlink reference-data-directory (confirmate 2026-08-06).
// LABEL = cacheLabel-ul din getQuotePriceResult: "ETH"/"BNB"/"STABLE_<SYMBOL>". Staleness per feed = heartbeat × buffer
// (feedMaxStaleSec). NB: heartbeat = intervalul MAX garantat (nu cadența deviation-driven) → limita ≥ heartbeat, altfel
// respingem prețuri valide. Arbitrum a coborât heartbeat-urile pe 2026-04-29 (ETH 1755s, USDC/USDT 255s).
const HEARTBEAT_SEC: Record<string, Record<string, number>> = {
  ethereum: { ETH: 3_600, STABLE_USDC: 82_800, STABLE_USDT: 86_400, STABLE_DAI: 3_600 },
  base:     { ETH: 1_200, STABLE_USDC: 86_400, STABLE_DAI: 86_400 },
  arbitrum: { ETH: 1_755, STABLE_USDC: 255,    STABLE_USDT: 255,    STABLE_DAI: 86_400 },
  bsc:      { BNB: 27,    STABLE_USDT: 900,     STABLE_USDC: 900,    STABLE_BUSD: 900 },
};
// Buffer peste heartbeat (jitter block/propagare) — prețul valid la marginea heartbeat-ului nu e respins.
const STALE_BUFFER_FACTOR = 1.2; // +20% (aprobat Marco/varu)

// ── Token address sets ────────────────────────────────────────────────────────

// Stable token → { chain, symbol de FEED }. USDbC/USDC.e mapează la simbolul "USDC" (folosesc feed-ul USDC/USD).
const STABLE_TOKENS: Record<string, { chain: string; symbol: string }> = {
  // Ethereum mainnet
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { chain: "ethereum", symbol: "USDC" },
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { chain: "ethereum", symbol: "USDT" },
  "0x6b175474e89094c44da98b954eedeac495271d0f": { chain: "ethereum", symbol: "DAI"  },
  // Base
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { chain: "base", symbol: "USDC" },
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { chain: "base", symbol: "USDC" }, // USDbC → feed USDC/USD
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { chain: "base", symbol: "DAI"  },
  // Arbitrum
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { chain: "arbitrum", symbol: "USDC" }, // USDC native
  "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": { chain: "arbitrum", symbol: "USDC" }, // USDC.e → feed USDC/USD
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { chain: "arbitrum", symbol: "USDT" },
  "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { chain: "arbitrum", symbol: "DAI"  },
  // BSC
  "0x55d398326f99059ff775485246999027b3197955": { chain: "bsc", symbol: "USDT" },
  "0xe9e7cea3dedca5984780bafc599bd69add087d56": { chain: "bsc", symbol: "BUSD" },
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { chain: "bsc", symbol: "USDC" },
};

const WETH_ADDRESSES = new Set([
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH Ethereum mainnet
  "0x4200000000000000000000000000000000000006", // WETH Base
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH Arbitrum
]);

const WBNB_ADDRESSES = new Set([
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB BSC
]);

// ── Chainlink ETH/USD + BNB/USD feed addresses per chain ─────────────────────

const CHAINLINK_ETH_FEED: Record<string, string> = {
  ethereum: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", // ETH/USD Ethereum mainnet
  base:     "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  arbitrum: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
};

const CHAINLINK_BNB_FEED: Record<string, string> = {
  bsc: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
};

// ── Chainlink <stable>/USD feed addresses (DEPEG) ────────────────────────────
// Toate 11 din directoarele oficiale Chainlink (confirmate 2026-08-06); override per feed prin env dacă e nevoie.
const STABLE_USD_FEED: Record<string, Record<string, string>> = {
  ethereum: {
    USDC: "0x8fffffd4afb6115b954bd326cbe7b4ba576818f6", // etherscan: Chainlink USDC/USD ✓
    USDT: "0x3e7d1eab13ad0104d2750b8863b489d65364e32d", // etherscan: Chainlink USDT/USD ✓
    DAI:  "0xaed0c38402a5d19df6e4c03f4e2dced6e29c1ee9", // etherscan: Chainlink DAI/USD ✓
  },
  base: {
    USDC: "0x7e860098f58bbfc8648a4311b374b1d669a2bc6b", // USDC/USD ✓
    DAI:  "0x591e79239a7d679378ec8c847e5038150364c78f", // DAI/USD ✓
  },
  arbitrum: {
    USDC: "0x50834f3163758fcc1df9973b6e91f0f0f0434ad3", // USDC/USD ✓ (varu)
    USDT: "0x3f3f5df88dc9f13eac63df89ec16ef6e7e25dde7", // USDT/USD ✓ (varu)
    DAI:  "0xc5c8e77b397e531b8ec06bfb0048328b30e9ecfb", // DAI/USD ✓ (varu)
  },
  bsc: {
    USDT: "0xb97ad0e74fa7d920791e90258a6e2085088b4320", // USDT/USD ✓
    BUSD: "0xcbb98864ef56e9042e7d2efef76141f15731b82f", // BUSD/USD ✓
    USDC: "0x51597f405303c4377e36123cbc172b13269ea163", // USDC/USD ✓ (varu)
  },
};

// ── L2 Sequencer Uptime Feeds (NF5) ──────────────────────────────────────────
// docs.chain.link/data-feeds/l2-sequencer-feeds ✓
const SEQUENCER_FEED: Record<string, string> = {
  arbitrum: "0xfdb631f5ee196f0ed6faa767959853a9f217697d",
  base:     "0xbcf85224fc0756b9fa45aa7892530b47e10b6433",
};

// ── Ecosystem tokens — env-gated, no Chainlink feed ──────────────────────────

const ECOSYSTEM_TOKEN_ENV: Record<string, string> = {
  "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b": "INDEXER_VIRTUAL_USD", // VIRTUAL (Base)
  "0x1111111111166b7fe7bd91427724b487980afc69": "INDEXER_ZORA_USD",    // ZORA (Base)
};

// ── Pure decode + freshness (leaf — testabile fără RPC) ───────────────────────

/** Decodează cele 5 word-uri din `latestRoundData()`. int256 pt. answer (sign-extend); uint80/uint256 restul. */
export function decodeLatestRoundData(result: string): ChainlinkRoundData | null {
  if (!result || result === "0x") return null;
  const hex = result.startsWith("0x") ? result.slice(2) : result;
  if (hex.length < 320) return null; // < 5 × 32 bytes → payload incomplet
  const word = (i: number): bigint => BigInt("0x" + hex.slice(i * 64, i * 64 + 64));
  const toInt256 = (raw: bigint): bigint => (raw > (1n << 255n) - 1n ? raw - (1n << 256n) : raw);
  return {
    roundId:         word(0),
    answer:          toInt256(word(1)),
    startedAt:       word(2),
    updatedAt:       word(3),
    answeredInRound: word(4),
  };
}

/**
 * `true` dacă round-ul de PREȚ e utilizabil: answer>0, round complet (`updatedAt>0`), NU e un round vechi
 * carried-over (`answeredInRound>=roundId`), și nu depășește backstop-ul de staleness (feed mort). Vârsta
 * reală curge oricum spre reader — asta e doar poarta de „preț nevalid / feed mort".
 */
export function isChainlinkPriceFresh(round: ChainlinkRoundData, nowMs: number, maxStaleSec: number): boolean {
  if (round.answer <= 0n) return false;
  if (round.updatedAt <= 0n) return false;
  if (round.answeredInRound < round.roundId) return false;
  const ageSec = Math.floor(nowMs / 1000) - Number(round.updatedAt);
  if (ageSec < 0) return false;          // updatedAt din viitor → suspect
  if (ageSec > maxStaleSec) return false; // feed mort
  return true;
}

/**
 * NF5: `true` dacă secvențatorul L2 e SUS și trecut de grace-period. Round.answer: 0 = up, 1 = down;
 * `startedAt` = timestamp-ul ultimei schimbări de status. În fereastra de grace după revenire prețurile
 * pot fi stale → tratăm ca „nu de încredere".
 */
export function isSequencerUp(round: ChainlinkRoundData, nowMs: number, graceSec: number): boolean {
  if (round.answer !== 0n) return false;   // 1 = jos
  if (round.startedAt <= 0n) return false; // startedAt==0 = feed neinițializat (Arbitrum) → tratează ca jos
  const sinceChangeSec = Math.floor(nowMs / 1000) - Number(round.startedAt);
  if (sinceChangeSec < 0) return false;      // startedAt din viitor → suspect
  if (sinceChangeSec <= graceSec) return false; // încă în grace
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function chainlinkCacheKey(chain: string, label: string): string {
  return `preflight:indexer:quoteprice:${chain}:${label}`;
}

function readEnvPrice(key: string): number | null {
  const v = Number(process.env[key] ?? 0);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function isFeedAddr(v: string | undefined): v is string {
  return !!v && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/** Feed <stable>/USD: env override (`INDEXER_STABLE_FEED_<CHAIN>_<SYMBOL>`) > hardcodat > null. */
function resolveStableFeed(chain: string, symbol: string): string | null {
  const env = process.env[`INDEXER_STABLE_FEED_${chain.toUpperCase()}_${symbol}`];
  if (isFeedAddr(env)) return env.toLowerCase();
  return STABLE_USD_FEED[chain]?.[symbol] ?? null;
}

/** Feed sequencer uptime: env override (`INDEXER_SEQUENCER_FEED_<CHAIN>`) > hardcodat > null (chain fără gate). */
function resolveSequencerFeed(chain: string): string | null {
  const env = process.env[`INDEXER_SEQUENCER_FEED_${chain.toUpperCase()}`];
  if (isFeedAddr(env)) return env.toLowerCase();
  return SEQUENCER_FEED[chain] ?? null;
}

/**
 * Staleness per feed (sec): env `INDEXER_FEED_MAX_STALE_<CHAIN>_<LABEL>` (maxStale direct) > `ceil(heartbeat × buffer)`
 * din HEARTBEAT_SEC > backstop global (doar pt. feed necunoscut, neatins de cele 15 live).
 */
export function feedMaxStaleSec(chain: string, label: string): number {
  const env = envNum(`INDEXER_FEED_MAX_STALE_${chain.toUpperCase()}_${label}`, 0);
  if (env > 0) return env;
  const hb = HEARTBEAT_SEC[chain]?.[label];
  if (hb) return Math.ceil(hb * STALE_BUFFER_FACTOR);
  return CHAINLINK_MAX_STALE_SEC;
}

/** eth_call `latestRoundData()` → round decodat (sau null la eroare/timeout/payload invalid). */
async function fetchRoundData(rpcUrl: string, feedAddress: string): Promise<ChainlinkRoundData | null> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), CHAINLINK_TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method:  "eth_call",
        params:  [{ to: feedAddress, data: SEL_LATEST_ROUND_DATA }, "latest"],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string; error?: unknown };
    if (json.error || !json.result) return null;
    return decodeLatestRoundData(json.result);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Preț Chainlink dintr-un feed USD (8 decimale), cu guard de freshness PER FEED. Întoarce prețul + updatedAt ORACLE (ms). */
async function fetchChainlinkPrice(
  rpcUrl: string, feedAddress: string, nowMs: number, maxStaleSec: number,
): Promise<{ price: number; updatedAtMs: number } | null> {
  const round = await fetchRoundData(rpcUrl, feedAddress);
  if (!round) return null;
  if (!isChainlinkPriceFresh(round, nowMs, maxStaleSec)) return null;
  const price = Number(round.answer) / 1e8;
  if (!(price > 0)) return null;
  return { price, updatedAtMs: Number(round.updatedAt) * 1000 };
}

/** NF5: pe un chain cu sequencer feed, prețurile Chainlink sunt permise DOAR dacă secvențatorul e sus. Fail-closed. */
async function isChainlinkAllowedOnChain(chain: string, rpcUrl: string, nowMs: number): Promise<boolean> {
  const seqFeed = resolveSequencerFeed(chain);
  if (!seqFeed) return true; // chain fără sequencer feed (ex. ethereum/bsc) → nu se aplică gate-ul
  const round = await fetchRoundData(rpcUrl, seqFeed);
  if (!round) return false;  // nu putem confirma statusul → fail-closed (refuză CHAINLINK; caller: env fallback pt. native, UNKNOWN pt. stable)
  return isSequencerUp(round, nowMs, SEQUENCER_GRACE_SEC);
}

/**
 * Rezolvă un preț CHAINLINK dintr-un feed: gate sequencer (L2) ÎNAINTE de orice → cache (guard pe vârsta ORACLE,
 * limită per-feed) → fetch fresh. `updatedAt` returnat = timpul oracle (nu fetch-time), pe cache-hit ȘI pe fetch nou.
 */
async function resolveViaChainlink(
  chain: string, rpcUrl: string, r: Redis | null | undefined,
  feedAddress: string, cacheLabel: string, nowMs: number,
): Promise<QuotePriceResult | null> {
  const cacheKey     = chainlinkCacheKey(chain, cacheLabel);
  const maxStaleSec  = feedMaxStaleSec(chain, cacheLabel);

  // NF5: gate sequencer pe L2 ÎNAINTE de orice (inclusiv cache-serve) — altfel un preț cached ar fi servit
  // până la 5 min după ce secvențatorul cade (blocker varu). Fail-closed dacă statusul nu poate fi citit.
  if (!(await isChainlinkAllowedOnChain(chain, rpcUrl, nowMs))) return null;

  // Cache (serve dacă prețul e valid și vârsta ORACLE ≤ limita PER FEED)
  if (r) {
    try {
      const cached = await r.get(cacheKey);
      if (cached) {
        const p     = JSON.parse(cached) as { price: number; updatedAt: number };
        const ageMs = nowMs - Number(p.updatedAt ?? 0);
        if (
          Number.isFinite(p.price) && p.price > 0 &&
          Number.isFinite(ageMs)  && ageMs >= 0 &&
          ageMs <= maxStaleSec * 1000
        ) {
          return { price: p.price, source: "CHAINLINK", updatedAt: p.updatedAt };
        }
      }
    } catch { /* ignoră Redis errors */ }
  }

  const fresh = await fetchChainlinkPrice(rpcUrl, feedAddress, nowMs, maxStaleSec);
  if (!fresh) return null;

  if (r) {
    try {
      await r.set(cacheKey, JSON.stringify({ price: fresh.price, updatedAt: fresh.updatedAtMs }), "EX", CHAINLINK_CACHE_TTL_SEC);
    } catch { /* ignoră */ }
  }
  return { price: fresh.price, source: "CHAINLINK", updatedAt: fresh.updatedAtMs };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Async price resolver — sursa primară pentru enrichment.
 * Priority: STABLE (feed depeg → preț real; UNKNOWN dacă feed de neîncredere; $1 DOAR fără feed) → CHAINLINK ETH/BNB (cache) → ENV_FALLBACK → null
 *
 * @param tokenAddress  lowercase token address (sau address(0) pentru native)
 * @param chain         chain id (obligatoriu pentru address(0) și routing Chainlink)
 * @param rpcUrl        RPC URL pentru Chainlink fetch
 * @param r             Redis client pentru cache (opțional)
 */
export async function getQuotePriceResult(
  tokenAddress: string,
  chain:        string,
  rpcUrl?:      string,
  r?:           Redis | null,
): Promise<QuotePriceResult | null> {
  const addr = tokenAddress.toLowerCase();
  const now  = Date.now();

  // 1. Stables — DEPEG. Dacă EXISTĂ un feed <stable>/USD configurat, prețul TREBUIE să vină de la oracle:
  //    stale / RPC-fail / sequencer down → `null` (UNKNOWN), NU $1 — altfel am masca exact momentul în care
  //    prețul nu mai e de încredere (blocker varu). $1.00 STATIC_STABLE rămâne DOAR când NU există feed.
  const stable = STABLE_TOKENS[addr];
  if (stable) {
    const feed = resolveStableFeed(stable.chain, stable.symbol);
    if (feed) {
      if (!rpcUrl) return null; // feed configurat dar nu-l putem verifica → UNKNOWN (nu presupune $1)
      return await resolveViaChainlink(stable.chain, rpcUrl, r, feed, `STABLE_${stable.symbol}`, now);
    }
    return { price: 1.0, source: "STATIC_STABLE", updatedAt: now }; // fără feed → $1.00 best-effort
  }

  // 2. ETH / BNB (wrapped sau native)
  const isEth = WETH_ADDRESSES.has(addr) || (addr === NATIVE_ADDRESS && chain !== "bsc");
  const isBnb = WBNB_ADDRESSES.has(addr) || (addr === NATIVE_ADDRESS && chain === "bsc");

  if (isEth || isBnb) {
    const symbol   = isEth ? "ETH" as const : "BNB" as const;
    const feedAddr = (isEth ? CHAINLINK_ETH_FEED : CHAINLINK_BNB_FEED)[chain];
    const envKey   = isEth ? "INDEXER_WETH_USD" : "INDEXER_BNB_USD";

    if (feedAddr && rpcUrl) {
      const via = await resolveViaChainlink(chain, rpcUrl, r, feedAddr, symbol, now);
      if (via) return via;
    }

    // 3. Env fallback
    const envPrice = readEnvPrice(envKey);
    if (envPrice) return { price: envPrice, source: "ENV_FALLBACK", updatedAt: now };

    return null;
  }

  // ── Ecosystem tokens (VIRTUAL, ZORA) — env only ───────────────────────────
  const ecoKey = ECOSYSTEM_TOKEN_ENV[addr];
  if (ecoKey) {
    const envPrice = readEnvPrice(ecoKey);
    if (envPrice) return { price: envPrice, source: "ENV_FALLBACK", updatedAt: now };
    return null;
  }

  return null;
}

/**
 * Sync wrapper — env only, fără Chainlink și Redis.
 * Folosit doar unde async nu e posibil. Preferă getQuotePriceResult() pentru enrichment.
 */
export function getQuotePrice(tokenAddress: string, chain?: string): number | null {
  const addr = tokenAddress.toLowerCase();
  if (STABLE_TOKENS[addr])      return 1.0; // sync nu are RPC → nu poate detecta depeg; $1.00 conservator
  if (WETH_ADDRESSES.has(addr)) return readEnvPrice("INDEXER_WETH_USD");
  if (WBNB_ADDRESSES.has(addr)) return readEnvPrice("INDEXER_BNB_USD");
  if (addr === NATIVE_ADDRESS) {
    return chain?.toLowerCase() === "bsc"
      ? readEnvPrice("INDEXER_BNB_USD")
      : readEnvPrice("INDEXER_WETH_USD");
  }
  const ecoKey = ECOSYSTEM_TOKEN_ENV[addr];
  if (ecoKey) return readEnvPrice(ecoKey);
  return null;
}
