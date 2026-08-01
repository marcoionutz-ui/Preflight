/**
 * infra/nativePrice.ts
 * Prețuri native token per chain — ETH, BNB. Chainlink on-chain reads.
 *
 * E25: NU mai există fallback hardcodat ($2500 / $600). Starea pornește goală
 * (value=null) și se scrie DOAR printr-un fetch Chainlink reușit ȘI proaspăt.
 * `getNativePrice` întoarce `number | null`: `null` când prețul lipsește sau a
 * expirat → apelanții degradează (skip flow / skip liquidity), nu inventează preț.
 *
 * Două straturi de freshness (varu R2):
 *   1) SURSĂ (oracol): `latestRoundData().updatedAt` validat contra heartbeat-ului
 *      feedului (isOracleFresh). Un RPC care răspunde peste un oracol înghețat NU
 *      trebuie tratat drept proaspăt.
 *   2) LOCAL (loop-ul nostru): `fetchedAt` (când AM obținut ultimul preț valid) vs
 *      NATIVE_PRICE_MAX_AGE_MS. Dacă refresh-ul moare, degradăm la null după TTL.
 */

import { CHAINLINK_ETH_USD, CHAINLINK_LATEST_ROUND_DATA } from "../config/constants";
import { resolveNativePrice, isOracleFresh } from "./nativePriceState";

// ─── Feed-uri Chainlink (adrese PER-NETWORK; NU interschimbabile) ──────────────────
// CHAINLINK_ETH_USD (din constants.ts) = ETH/USD pe BASE (0x7104…).
const CHAINLINK_ETH_USD_MAINNET = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"; // ETH/USD Ethereum Mainnet
const CHAINLINK_ARB_ETH_USD     = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612"; // ETH/USD Arbitrum One
const CHAINLINK_BNB_USD         = "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE"; // BNB/USD BSC

// ─── Vârstă maximă acceptată a datei oracle, PER FEED ─────────────────────────────────────────────
// Varianta B (confirmată): maxSourceAge = min(heartbeat + marjă, PLAFON_TRADING). Heartbeat-uri reale
// confirmate pe data.chain.link. Nu acceptăm un ETH/USD de ~24h doar fiindcă feedul Arbitrum respectă
// heartbeat-ul lui de 24h — plafonăm la 1h (nevoia noastră de freshness pentru evaluarea unui trade).
// BNB/USD (heartbeat 27s) NU primește marjă globală de 30min — prag strâns de 60s.
const MAX_SOURCE_AGE_MS = {
  baseEth: 25 * 60_000,   // Base ETH/USD     — heartbeat 1200s (20m) + 5m marjă polling/RPC
  arbEth:  60 * 60_000,   // Arbitrum ETH/USD — heartbeat 86400s (24h), plafonat la 1h (trading)
  ethEth:  60 * 60_000,   // Ethereum ETH/USD — heartbeat 3600s (1h)
  bnb:          60_000,   // BSC BNB/USD      — heartbeat 27s, limită strânsă 60s (feed rapid)
} as const;
const ORACLE_FUTURE_SKEW_MS = 2 * 60_000;    // toleranță timestamp block vs ceas local

// TTL LOCAL: cât rămâne valid un preț DUPĂ ce l-am obținut. 15 min = 3× refresh (5 min).
export const NATIVE_PRICE_MAX_AGE_MS = 15 * 60_000;

type PriceState = { value: number | null; updatedAt: number | null; sourceUpdatedAt: number | null };
const state: Record<string, PriceState> = {
  eth: { value: null, updatedAt: null, sourceUpdatedAt: null },
  bnb: { value: null, updatedAt: null, sourceUpdatedAt: null },
};

export type NativeSymbol = "ETH" | "BNB";

/** Preț nativ curent SAU `null` dacă lipsește / e stale local (peste NATIVE_PRICE_MAX_AGE_MS). */
export function getNativePrice(nativeSymbol: NativeSymbol): number | null {
  const s = state[nativeSymbol.toLowerCase()];
  if (!s) return null;
  return resolveNativePrice(s.value, s.updatedAt, Date.now(), NATIVE_PRICE_MAX_AGE_MS);
}

// backward compat — prețul ETH sau `null` dacă stale/never-fetched.
export function getEthPrice(): number | null {
  return getNativePrice("ETH");
}

/**
 * TEST-ONLY: seed-uiește starea cu timestamp local proaspăt (implicit `now`). Producția scrie
 * starea EXCLUSIV prin refreshNativePrices — nu reintroducem defaulturi hardcodate. `at` mai mic
 * decât `now - NATIVE_PRICE_MAX_AGE_MS` simulează stale local.
 */
export function __setNativePriceForTest(
  symbol: NativeSymbol,
  price:  number | null,
  at:     number | null = Date.now(),
): void {
  state[symbol.toLowerCase()] = { value: price, updatedAt: at, sourceUpdatedAt: at };
}

/** TEST-ONLY: citește starea brută (value/fetchedAt/sourceUpdatedAt) fără TTL. */
export function __getNativeStateForTest(symbol: NativeSymbol): PriceState {
  return { ...state[symbol.toLowerCase()] };
}

/**
 * Citește un feed Chainlink prin eth_call(latestRoundData). Decodează ATÂT `answer` (word 1)
 * CÂT ȘI `updatedAt` (word 3) — freshness-ul la sursă e obligatoriu (varu R1). `fetchImpl`
 * injectabil pentru teste. Întoarce `{ price, sourceUpdatedAt(ms) }` sau `null` la eroare / answer invalid.
 */
async function fetchChainlinkPrice(
  rpcUrl:    string,
  contract:  string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ price: number; sourceUpdatedAt: number } | null> {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetchImpl(rpcUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  ctrl.signal,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method:  "eth_call",
        params:  [{ to: contract, data: CHAINLINK_LATEST_ROUND_DATA }, "latest"],
      }),
    });
    const json   = await res.json() as any;
    const result = json?.result;
    // latestRoundData() = 5 cuvinte (roundId, answer, startedAt, updatedAt, answeredInRound).
    // "0x" + 5×64 = exact 320 hex chars. ABI strict → orice răspuns trunchiat/malformat = respins.
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]{320}$/.test(result)) return null;
    const answerHex    = "0x" + result.slice(66, 130);   // word 1 (answer, int256)
    const updatedAtHex = "0x" + result.slice(194, 258);  // word 3 (updatedAt, uint256)

    // answer e int256 (SIGNED) — decodează two's-complement, nu unsigned. Un `-1` unsigned ar deveni
    // ~1.16e69 și ar fi acceptat drept preț. Respinge orice ≤ 0.
    const rawAnswer    = BigInt(answerHex);
    const signedAnswer = rawAnswer >= (1n << 255n) ? rawAnswer - (1n << 256n) : rawAnswer;
    if (signedAnswer <= 0n) return null;

    const price           = Number(signedAnswer) / 1e8;
    const sourceUpdatedAt = Number(BigInt(updatedAtHex)) * 1000; // secunde → ms
    if (!Number.isFinite(price) || price <= 10) return null;
    return { price, sourceUpdatedAt };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

type EthSource = { name: string; rpc: string; feed: string; maxSourceAgeMs: number };

/**
 * Surse ETH/USD în ordinea de preferință, din env. Feed PER-CHAIN (nu refolosi adresa între rețele).
 * Fallback real: dacă prima sursă configurată eșuează (fetch SAU oracle stale), se încearcă următoarea.
 */
function buildEthSources(env: Record<string, string | undefined>): EthSource[] {
  const list: (EthSource | null)[] = [
    env.ALCHEMY_BASE_RPC ? { name: "base",     rpc: env.ALCHEMY_BASE_RPC, feed: CHAINLINK_ETH_USD,         maxSourceAgeMs: MAX_SOURCE_AGE_MS.baseEth } : null,
    env.ALCHEMY_ARB_RPC  ? { name: "arbitrum", rpc: env.ALCHEMY_ARB_RPC,  feed: CHAINLINK_ARB_ETH_USD,     maxSourceAgeMs: MAX_SOURCE_AGE_MS.arbEth  } : null,
    env.ALCHEMY_ETH_RPC  ? { name: "ethereum", rpc: env.ALCHEMY_ETH_RPC,  feed: CHAINLINK_ETH_USD_MAINNET, maxSourceAgeMs: MAX_SOURCE_AGE_MS.ethEth  } : null,
  ];
  return list.filter((s): s is EthSource => s !== null);
}

export interface RefreshOpts {
  fetchImpl?: typeof fetch;
  env?:       Record<string, string | undefined>;
  now?:       number;
}

export async function refreshNativePrices(opts: RefreshOpts = {}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env       = opts.env ?? process.env;
  const now       = opts.now ?? Date.now();

  // ── ETH/USD: surse per-chain, încercate secvențial. Prima cu preț PROASPĂT (fetch OK + oracle fresh) câștigă.
  const ethSources = buildEthSources(env);
  if (ethSources.length === 0) {
    console.log(`[NATIVE PRICE] ETH: niciun RPC configurat (BASE/ARB/ETH) → null`);
  } else {
    let got = false;
    for (const src of ethSources) {
      const r = await fetchChainlinkPrice(src.rpc, src.feed, fetchImpl);
      if (!r) {
        console.log(`[NATIVE PRICE] ETH ${src.name}: fetch eșuat → încerc următoarea sursă`);
        continue;
      }
      if (!isOracleFresh(r.sourceUpdatedAt, now, src.maxSourceAgeMs, ORACLE_FUTURE_SKEW_MS)) {
        console.log(`[NATIVE PRICE] ETH ${src.name}: oracle stale/viitor (source age ${Math.round((now - r.sourceUpdatedAt) / 1000)}s) → resping, încerc următoarea`);
        continue;
      }
      state.eth = { value: r.price, updatedAt: now, sourceUpdatedAt: r.sourceUpdatedAt };
      console.log(`[NATIVE PRICE] ETH: $${r.price.toFixed(2)} (sursă ${src.name})`);
      got = true;
      break;
    }
    if (!got) {
      console.log(`[NATIVE PRICE] ETH: toate sursele au eșuat/stale → păstrez ultimul preț (degradează la null la expirarea TTL local)`);
    }
  }

  // ── BNB/USD: sursă unică (BSC).
  const bnbRpc = env.ALCHEMY_BNB_RPC ?? "";
  if (bnbRpc) {
    const r = await fetchChainlinkPrice(bnbRpc, CHAINLINK_BNB_USD, fetchImpl);
    if (r && isOracleFresh(r.sourceUpdatedAt, now, MAX_SOURCE_AGE_MS.bnb, ORACLE_FUTURE_SKEW_MS)) {
      state.bnb = { value: r.price, updatedAt: now, sourceUpdatedAt: r.sourceUpdatedAt };
      console.log(`[NATIVE PRICE] BNB: $${r.price.toFixed(2)}`);
    } else {
      console.log(`[NATIVE PRICE] BNB: fetch eșuat sau oracle stale → păstrez ultimul preț (degradează la null la TTL)`);
    }
  } else {
    console.log(`[NATIVE PRICE] BNB: niciun RPC configurat → null`);
  }
}

export function getNativeSymbolForChain(chainId: string): NativeSymbol {
  return chainId === "bsc" ? "BNB" : "ETH";
}
