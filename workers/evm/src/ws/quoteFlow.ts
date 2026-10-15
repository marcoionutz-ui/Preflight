/**
 * ws/quoteFlow.ts
 * Clasificarea flow-ului unui swap (buy/sell + volum native/USD) din amounts.
 * Extras din manager.ts (A5) ca să fie testabil izolat.
 *
 * CONVENȚIE DE SEMN (important):
 *   getQuoteFlowAsEth folosește convenția POOL (ca Uniswap V3): amount al
 *   tokenului quote POZITIV = quote plătit ÎN pool = BUY al tokenului base.
 *   - V3 Swap event emite deja delta pool-ului → se pasează direct (Uniswap V3 și PancakeSwap V3 — BETA-1 / T1).
 *   - V2 handler reconstruiește delta pool-ului din amountIn/amountOut → direct.
 *   - V4 Swap event emite delta din perspectiva SWAPPER-ului (negativ = plătit
 *     în pool, pozitiv = primit) — OPUS lui V3. Deci amounts V4 trebuie NEGATE
 *     înainte (vezi toPoolConventionAmounts).
 *
 *   Sursă convenție V4: Uniswap v4-core BalanceDelta (swapDelta caller-facing) +
 *   ghidul de indexare Uniswap Foundation ("the sign convention in v4 is from the
 *   user's perspective... this is opposite of v3, so watch out!") + exemplu Cyfrin
 *   (vânzare 1e7 WBTC → amount0(WBTC) = -10_000_000).
 */

import type { ChainConfig } from "../config/chains";
import { getNativePrice }    from "../infra/nativePrice";

// ── BETA-1 / T1: topicurile Swap V3 și decodarea pură a sumelor (Uniswap V3 și PancakeSwap V3) ─────────────────
// Stau aici, nu în `subscriptions.ts`, ca decodorul să rămână pur (fără dependențele operaționale ale abonării);
// `subscriptions.ts` le importă de aici și le re-exportă, deci importurile existente nu se schimbă.

/** `Swap(address,address,int256,int256,uint160,uint128,int24)` — Uniswap V3. */
export const SWAP_V3_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
/** `Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)` — PancakeSwap V3 (+2 câmpuri de taxe). */
export const SWAP_PANCAKE_V3_TOPIC = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";

/** Formatul evenimentului decodat — NU identitatea DEX-ului emitent (nu există gardă pe `dexId`). */
export type V3SwapVariant = "uniswap-v3" | "pancake-v3";

/** Uniswap V3: pragul de azi — cel puțin cele două cuvinte de sume; coada nu e inspectată (toleranță declarată). */
const UNISWAP_V3_MIN_HEX = 128;
/** PancakeSwap V3: forma completă a evenimentului, exact 7 cuvinte; trunchierea și surplusul sunt refuzate. */
const PANCAKE_V3_EXACT_HEX = 448;
const HEX_ONLY = /^[0-9a-fA-F]*$/;

/** Un cuvânt de 32 de octeți (64 hex, fără `0x`) citit ca `int256` (complement față de doi). Mutată din manager.ts. */
export function int256FromWord(hex64: string): bigint {
  const x = BigInt("0x" + hex64);
  return x >= (1n << 255n) ? x - (1n << 256n) : x;
}

/**
 * Sumele unui `Swap` V3, în convenția POOL (delta soldului pool-ului — la fel în Uniswap V3 și PancakeSwap V3, deci
 * se pasează direct la `getQuoteFlowAsEth`, fără negare). NU aruncă niciodată: orice intrare pe care nu o poate
 * decoda sigur dă `null`, iar apelantul o ignoră tăcut. Reguli, în ordine:
 *   0. `topic0` trebuie să fie exact (`===`) unul dintre cele două topicuri de swap;
 *   1. `data` trebuie să fie șir; 2. trebuie să înceapă exact cu `0x`;
 *   3. PancakeSwap V3: exact 448 de caractere după `0x`, TOATE hex;
 *   4. Uniswap V3: cel puțin 128 de caractere după `0x`, primele 128 hex; restul nu e inspectat;
 *   5. `amount0` = cuvântul 1, `amount1` = cuvântul 2, ambele `int256`.
 */
export function decodeV3SwapAmounts(
  topic0: unknown,
  data:   unknown,
): { amount0: bigint; amount1: bigint; variant: V3SwapVariant } | null {
  let variant: V3SwapVariant;
  if (topic0 === SWAP_V3_TOPIC) variant = "uniswap-v3";
  else if (topic0 === SWAP_PANCAKE_V3_TOPIC) variant = "pancake-v3";
  else return null;
  if (typeof data !== "string" || !data.startsWith("0x")) return null;
  const hex = data.slice(2);
  if (variant === "pancake-v3") {
    if (hex.length !== PANCAKE_V3_EXACT_HEX || !HEX_ONLY.test(hex)) return null;
  } else if (hex.length < UNISWAP_V3_MIN_HEX || !HEX_ONLY.test(hex.slice(0, UNISWAP_V3_MIN_HEX))) {
    return null;
  }
  return { amount0: int256FromWord(hex.slice(0, 64)), amount1: int256FromWord(hex.slice(64, 128)), variant };
}

/**
 * Aduce amounts la convenția POOL (V3) pe care o așteaptă getQuoteFlowAsEth.
 * Pentru V4 (perspectiva swapper-ului, opusă) negăm ambele; altfel pass-through.
 */
export function toPoolConventionAmounts(
  amount0: bigint,
  amount1: bigint,
  isV4:    boolean,
): [bigint, bigint] {
  return isV4 ? [-amount0, -amount1] : [amount0, amount1];
}

/**
 * E18 (varu R1): metadata stable PER-ADRESĂ (simbol + decimale). ÎNAINTE decimalele erau deduse din chain
 * (`chain.id === "bsc" ? 18 : 6`), ceea ce trata DAI-ul de pe Ethereum (18 dec) drept 6 dec → valoare umflată
 * cu 10^12 → posibil FALS rug-removal alert (exact opusul scopului E18); și eticheta USDT/DAI de pe Ethereum
 * ca "USDC". Adresele de token sunt unice per deployment → registry global pe adresă. (Ideal ar sta în
 * ChainConfig; minimal aici, dar sursă UNICĂ de adevăr pentru simbol+decimale — nu mai ghicim din chain.)
 */
const STABLE_METADATA: Record<string, { symbol: string; decimals: number }> = {
  // Base
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC",   decimals: 6  },
  // Arbitrum
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC",   decimals: 6  },
  "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": { symbol: "USDC.e", decimals: 6  },
  // BSC (stable-urile pegged sunt 18 dec)
  "0x55d398326f99059ff775485246999027b3197955": { symbol: "USDT",   decimals: 18 },
  "0xe9e7cea3dedca5984780bafc599bd69add087d56": { symbol: "BUSD",   decimals: 18 },
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { symbol: "USDC",   decimals: 18 },
  // Ethereum
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC",   decimals: 6  },
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT",   decimals: 6  },
  "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI",    decimals: 18 },
};

/** Metadata unei monede stable după ADRESĂ (simbol + decimale reale). `null` dacă nu-i o stable cunoscută. */
export function stableMetaFor(address: string): { symbol: string; decimals: number } | null {
  return STABLE_METADATA[address.toLowerCase()] ?? null;
}

export function getQuoteFlowAsEth(
  chain:      ChainConfig,
  baseToken:  string,
  quoteToken: string,
  amount0:    bigint,
  amount1:    bigint,
): { ok: boolean; ethAmount: number; usdAmount: number; isBuy: boolean; quote: string | null } {
  const base   = baseToken.toLowerCase();
  const quoteT = quoteToken.toLowerCase();
  const token0 = base < quoteT ? base : quoteT;
  const amountFor = (t: string) => t === token0 ? amount0 : amount1;

  // E18 (varu R2): allowlist PER-CHAIN. Adresele EVM NU sunt unice între rețele — aceeași adresă hex poate fi
  // USDC pe un chain și alt contract pe altul. Deci recunoaștem o stable DOAR dacă chain-ul o autorizează
  // explicit (usdc/usdcLegacy/stableQuotes), iar simbolul+decimalele vin din registry-ul per-adresă.
  const stableAddrs = new Set(
    [chain.usdc, chain.usdcLegacy, ...(chain.stableQuotes ?? [])]
      .filter((x): x is string => Boolean(x))
      .map(x => x.toLowerCase()),
  );

  const quoteMetaFor = (addr: string): { symbol: string; decimals: number; kind: "native" | "stable" } | null => {
    const a = addr.toLowerCase();
    if (a === chain.weth.toLowerCase()) {
      return { symbol: chain.id === "bsc" ? "WBNB" : "WETH", decimals: 18, kind: "native" };
    }
    // E18: chain-ul autorizează adresa ca quote (allowlist) + registry-ul dă simbolul & decimalele reale
    // (nu mai `bsc?18:6`). Ambele necesare: config-ul spune „e quote acceptat aici", registry-ul „ce e".
    const stable = stableAddrs.has(a) ? stableMetaFor(a) : null;
    if (stable) return { symbol: stable.symbol, decimals: stable.decimals, kind: "stable" };
    return null;
  };

  const baseMeta   = quoteMetaFor(base);
  const quoteMetaT = quoteMetaFor(quoteT);
  const quoteMeta  = baseMeta ?? quoteMetaT;

  if (!quoteMeta) return { ok: false, ethAmount: 0, usdAmount: 0, isBuy: false, quote: null };

  const quoteAddr   = baseMeta ? base : quoteT;
  const amt         = amountFor(quoteAddr);
  const abs         = amt < 0n ? -amt : amt;
  const quoteAmount = Number(abs) / (10 ** quoteMeta.decimals);
  // legacy name: ethAmount is native-equivalent (ETH or BNB depending on chain/quote).
  // usdAmount is the canonical cross-chain volume field.
  const nativeSymbol = chain.id === "bsc" ? "BNB" : "ETH";
  // E25 (fail-closed): preț nativ absent/stale → NU înregistrăm flow-ul cu evaluare incompletă.
  // AMBELE câmpuri depind de preț (native: usdAmount = amt × preț; stable: ethAmount = amt ÷ preț),
  // deci fără un preț valid rezultatul ar fi NaN/Infinity/inventat → ok:false.
  const nativePrice = getNativePrice(nativeSymbol);
  if (nativePrice === null) {
    return { ok: false, ethAmount: 0, usdAmount: 0, isBuy: false, quote: quoteMeta.symbol };
  }
  const ethAmount = quoteMeta.kind === "native" ? quoteAmount : quoteAmount / nativePrice;
  const usdAmount = quoteMeta.kind === "stable" ? quoteAmount : quoteAmount * nativePrice;

  return { ok: true, ethAmount, usdAmount, isBuy: amt > 0n, quote: quoteMeta.symbol };
}

const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasOwnKey = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Adresa EVM dintr-o latură DexScreener (`{ address, … }`), lowercase; `null` dacă lipsește sau e invalidă. */
function dexScreenerSideAddress(side: unknown): string | null {
  if (!isPlainObject(side) || typeof side.address !== "string") return null;
  const a = side.address.trim().toLowerCase();
  return EVM_ADDRESS_RE.test(a) ? a : null;
}

/**
 * BETA-1 / D1: base/quote dintr-o pereche brută DexScreener (`normalizeDsPair` păstrează `_raw` = perechea API, unde
 * `baseToken` / `quoteToken` sunt OBIECTE `{ address, name, symbol }`). CONSERVATOR: orice regulă încălcată →
 * ambele goale (apelanții tratează `""` ca „nu înregistra"):
 *   0. `baseToken` și `quoteToken` sunt obiecte (non-null, nu tablouri);
 *   1. adresele, după `trim` + lowercase, sunt exact `0x` + 40 hex (fără curățare de prefixe, fără conversii);
 *   2. adresele diferă;
 *   3. `chainId` (DexScreener) e egal cu `pool.chain` — fără amestecarea chain-urilor; lipsa oricăruia → gol;
 *   4. `pool.tokenAddress`, dacă există, e egal cu adresa base (normalizeDsPair îl derivă din ea);
 *   5. fără ghicire: întoarce exact perechea declarată, neinversată; quote-ul îl recunoaște `getQuoteFlowAsEth`.
 */
function extractDexScreenerBaseQuote(
  raw: Record<string, unknown>,
  pool: { tokenAddress?: string; chain?: string },
): { baseToken: string; quoteToken: string } {
  const none = { baseToken: "", quoteToken: "" };
  if (!isPlainObject(raw.baseToken) || !isPlainObject(raw.quoteToken)) return none;
  const base  = dexScreenerSideAddress(raw.baseToken);
  const quote = dexScreenerSideAddress(raw.quoteToken);
  if (!base || !quote || base === quote) return none;
  const chainId   = typeof raw.chainId === "string" ? raw.chainId.toLowerCase() : "";
  const poolChain = typeof pool.chain === "string" ? pool.chain.toLowerCase() : "";
  if (!chainId || !poolChain || chainId !== poolChain) return none;
  const tokenAddress = typeof pool.tokenAddress === "string" ? pool.tokenAddress.toLowerCase() : "";
  if (tokenAddress && tokenAddress !== base) return none;
  return { baseToken: base, quoteToken: quote };
}

/**
 * Extrage baseToken + quoteToken dintr-un SourcePool. (Mutată din manager.ts — pură, testabilă izolat.)
 * Forma lui `_raw` se decide O SINGURĂ DATĂ, în ordine, fără cădere pe forma următoare:
 *   1. fără `_raw` → base = tokenAddress, quote gol;
 *   2. IndexedPair: `_raw.baseToken` / `_raw.quoteToken` ȘIR nevid (INDEXER pools) — neschimbat;
 *   3. DexScreener (BETA-1 / D1): `_raw` are CHEIE proprie `baseToken`, `quoteToken` sau `chainId`, indiferent de
 *      valoare → numai regulile din `extractDexScreenerBaseQuote`; ramura Gecko NU mai e consultată;
 *   4. Gecko: `_raw.relationships.{base,quote}_token.data.id` cu prefix rețea ("eth_0x…", "base_0x…") — neschimbat.
 */
export function extractBaseQuote(
  pool: { discoverySource?: string; _raw?: unknown; tokenAddress?: string; chain?: string },
): { baseToken: string; quoteToken: string } {
  const raw = pool._raw as Record<string, unknown> | undefined;
  if (!raw) return { baseToken: pool.tokenAddress?.toLowerCase() ?? "", quoteToken: "" };

  // IndexedPair format: baseToken / quoteToken direct pe _raw (indiferent de discoverySource)
  const indexedBase  = typeof raw.baseToken  === "string" ? raw.baseToken.toLowerCase()  : "";
  const indexedQuote = typeof raw.quoteToken === "string" ? raw.quoteToken.toLowerCase() : "";
  if (indexedBase || indexedQuote) {
    return {
      baseToken:  indexedBase  || pool.tokenAddress?.toLowerCase() || "",
      quoteToken: indexedQuote,
    };
  }

  // BETA-1 / D1: forma DexScreener, clasificată după CHEI (înaintea validării valorilor), ca o pereche malformată
  // (`baseToken: null`, `quoteToken: []` etc.) să nu poată cădea pe ramura Gecko și să producă adrese.
  if (typeof raw === "object" && !Array.isArray(raw)
      && (hasOwnKey(raw, "baseToken") || hasOwnKey(raw, "quoteToken") || hasOwnKey(raw, "chainId"))) {
    return extractDexScreenerBaseQuote(raw, pool);
  }

  // Gecko format: relationships.{base,quote}_token.data.id are prefixul rețelei Gecko (chain.gecko, ex. "eth").
  // A1: strip generic al prefixului "{alnum}_" — înainte se folosea chain.id ("ethereum"), dar prefixul e
  // chain.gecko ("eth"), deci pe Ethereum adresa nu era curățată → quoteMetaFor nu potrivea → flow WS tăcut.
  const stripGeckoPrefix = (id: string | undefined): string =>
    id?.replace(/^[a-z0-9-]+_/i, "").toLowerCase() ?? "";
  const rel = raw.relationships as Record<string, unknown> | undefined;
  const base  = stripGeckoPrefix(((rel?.base_token  as Record<string, unknown>)?.data as Record<string, unknown>)?.id  as string | undefined);
  const quote = stripGeckoPrefix(((rel?.quote_token as Record<string, unknown>)?.data as Record<string, unknown>)?.id as string | undefined);
  return { baseToken: base, quoteToken: quote };
}

/**
 * E18: valoarea NATIVE-echivalentă a unui eveniment LP V2 (Mint/Burn), QUOTE-AGNOSTIC.
 *
 * Bug (Intern M10): path-ul de LP V2 presupunea mereu WETH-quoted (`wethIsT0 = weth < token`, apoi
 * `/1e18`). Pe perechile stable-quoted (ex. token/USDT pe BSC) WETH/WBNB NU e nici măcar o rezervă a
 * pool-ului → comparația alegea rezerva GREȘITĂ și o interpreta ca „ETH" → detecția de rug (LP removed %)
 * calcula gunoi → moartă pe stable-quoted. Fix: reutilizează `extractBaseQuote` + `getQuoteFlowAsEth`
 * exact ca path-ul de swap și ca V3 Mint/Burn — quote-ul (native SAU stable) e rezolvat corect, cu
 * decimalele lui, iar stable-ul e convertit în native-echivalent prin oracolul de preț.
 *
 * `amount0`/`amount1` = rezervele token0/token1 din event (pozitive). `{ok:false}` dacă pool-ul n-are
 * base/quote rezolvabil sau quote-ul nu e recunoscut (nici native nici stable) → apelantul sare `recordLp`.
 */
export function resolveLpNativeAmount(
  chain:   ChainConfig,
  pool:    { discoverySource?: string; _raw?: unknown; tokenAddress?: string } | undefined,
  amount0: bigint,
  amount1: bigint,
): { ok: boolean; ethAmount: number; quote: string | null } {
  if (!pool) return { ok: false, ethAmount: 0, quote: null };
  const { baseToken, quoteToken } = extractBaseQuote(pool);
  if (!baseToken || !quoteToken) return { ok: false, ethAmount: 0, quote: null };
  const q = getQuoteFlowAsEth(chain, baseToken, quoteToken, amount0, amount1);
  if (!q.ok || q.ethAmount <= 0) return { ok: false, ethAmount: 0, quote: q.quote };
  return { ok: true, ethAmount: q.ethAmount, quote: q.quote };
}
