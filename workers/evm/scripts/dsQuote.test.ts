/**
 * scripts/dsQuote.test.ts — BETA-1 / D1: `extractBaseQuote` citește metadatele DexScreener.
 *
 * Contractul (design `BETA1_D1_FIX_DESIGN.md` rev3, §2): forma lui `_raw` se decide o singură dată — fără `_raw`,
 * IndexedPair (șiruri, neschimbat), DexScreener (clasificat după CHEI proprii `baseToken`/`quoteToken`/`chainId`,
 * indiferent de valoare), Gecko (neschimbat). Pe forma DexScreener, orice regulă încălcată → ambele goale; fără
 * ghicirea quote-ului și fără amestecarea chain-urilor.
 *
 * Fiecare caz are un id (tabelul din §3 al designului). Testul afirmă comportamentul DUPĂ fix. Pe baseline trebuie
 * să pice exact: U1–U4, P1–P7, N1–N3, I1–I3 (17) și să treacă exact: U5–U17, P8, P9, E1–E6 (21). Linia finală
 * `FAILED_IDS:` permite compararea automată.
 *
 * Offline: fără rețea, fără Redis; prețul nativ e seed-uit explicit (ca `lpQuote.test.ts`).
 */
import { extractBaseQuote, getQuoteFlowAsEth, resolveLpNativeAmount } from "../src/ws/quoteFlow";
import { normalizeDsPair } from "../src/sources/dexscreener";
import { __setNativePriceForTest } from "../src/infra/nativePrice";

__setNativePriceForTest("ETH", 2500);

const failedIds: string[] = [];
let passed = 0;
function check(id: string, what: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✅ ${id}. ${what}`); }
  else      { failedIds.push(id); console.log(`  ❌ ${id}. ${what}${detail ? `\n       ${detail}` : ""}`); }
}

const E18 = 10n ** 18n;

// ── Adrese ─────────────────────────────────────────────────────────────────────────────────────────────────────
const T  = "0xf0000000000000000000000000000000000000a1";           // token (base)
const W  = "0x4200000000000000000000000000000000000006";           // WETH pe Base
const X  = "0x7777777777777777777777777777777777777777";           // token necunoscut
const GB = "0x6b00000000000000000000000000000000000001";           // adrese Gecko, DIFERITE de T/W
const GQ = "0x6b00000000000000000000000000000000000002";
const T_MIXED = "0xF0000000000000000000000000000000000000A1";      // T cu majuscule (checksum-like)
const W_MIXED = "0x4200000000000000000000000000000000000006".toUpperCase().replace("0X", "0x");

// ── Chain stubs (ca în lpQuote.test.ts) ────────────────────────────────────────────────────────────────────────
const BASE: any = { id: "base", gecko: "base", weth: W, usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", wsUrl: "" };
const ARB: any  = { id: "arbitrum", gecko: "arbitrum", weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", wsUrl: "" };

// ── Construcții de intrare ─────────────────────────────────────────────────────────────────────────────────────
/** Cast fără verificare de proprietăți în exces: pe baseline, tipul parametrului nu are încă `chain`. */
const asPool = (o: object): any => o;
const side = (address: unknown): Record<string, unknown> => ({ address, name: "n", symbol: "s" });
const R = {
  base_token:  { data: { id: `base_${GB}` } },
  quote_token: { data: { id: `base_${GQ}` } },
};
/** Perechea brută DexScreener „DS ok"; `over` suprascrie sau șterge (valoarea `DELETE`) câmpuri. */
const DELETE = Symbol("delete");
function dsRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    chainId: "base", dexId: "uniswap", pairAddress: "0x" + "d1".repeat(20),
    baseToken: side(T), quoteToken: side(W), priceUsd: "0.5",
  };
  for (const [k, v] of Object.entries(over)) { if (v === DELETE) delete raw[k]; else raw[k] = v; }
  return raw;
}
const dsPool = (raw: Record<string, unknown>, extra: Record<string, unknown> = {}): any =>
  asPool({ chain: "base", tokenAddress: T, _raw: raw, ...extra });

const pairOf = (p: { baseToken: string; quoteToken: string }): string => `(${p.baseToken || '""'}, ${p.quoteToken || '""'})`;
function expectPair(id: string, what: string, pool: any, base: string, quote: string): void {
  const got = extractBaseQuote(pool);
  check(id, what, got.baseToken === base && got.quoteToken === quote, `obținut ${pairOf(got)}, așteptat ${pairOf({ baseToken: base, quoteToken: quote })}`);
}
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

console.log("U. forma DexScreener — valid, malformat, chain, coerență");
expectPair("U1", "DS ok → (T, W)", dsPool(dsRaw()), T, W);
expectPair("U2", "DS ok cu majuscule și spații la capete → lowercase", dsPool(dsRaw({ baseToken: side(`  ${T_MIXED} `), quoteToken: side(` ${W_MIXED}  `) })), T, W);
expectPair("U3", "DS ok cu chainId «BASE» → acceptat", dsPool(dsRaw({ chainId: "BASE" })), T, W);
expectPair("U4", "DS ok fără tokenAddress → acceptat", asPool({ chain: "base", _raw: dsRaw() }), T, W);
expectPair("U5", "fără cheia quoteToken → gol", dsPool(dsRaw({ quoteToken: DELETE })), "", "");
expectPair("U6", "quoteToken fără address → gol", dsPool(dsRaw({ quoteToken: {} })), "", "");
expectPair("U7", "quoteToken.address număr → gol", dsPool(dsRaw({ quoteToken: side(42) })), "", "");
expectPair("U8", "quoteToken.address șir gol → gol", dsPool(dsRaw({ quoteToken: side("") })), "", "");
expectPair("U9", "quoteToken.address cu prefix «base_» → gol", dsPool(dsRaw({ quoteToken: side(`base_${W}`) })), "", "");
expectPair("U10", "adresă de 39 de octeți → gol", dsPool(dsRaw({ quoteToken: side(W.slice(0, 40)) })), "", "");
expectPair("U11", "adresă cu caractere non-hex → gol", dsPool(dsRaw({ quoteToken: side("0x" + "zz".repeat(20)) })), "", "");
expectPair("U12", "adresă Solana → gol", dsPool(dsRaw({ quoteToken: side("So11111111111111111111111111111111111111112") })), "", "");
expectPair("U13", "base = quote → gol", dsPool(dsRaw({ quoteToken: side(T) })), "", "");
expectPair("U14", "fără chainId → gol", dsPool(dsRaw({ chainId: DELETE })), "", "");
expectPair("U15", "chainId «ethereum», pool.chain «base» → gol", dsPool(dsRaw({ chainId: "ethereum" })), "", "");
expectPair("U16", "fără pool.chain → gol", asPool({ tokenAddress: T, _raw: dsRaw() }), "", "");
expectPair("U17", "tokenAddress ≠ baseToken.address → gol", dsPool(dsRaw(), { tokenAddress: X }), "", "");

console.log("P. precedență și forme amestecate (R = relationships Gecko valide spre GB/GQ)");
expectPair("P1", "DS ok + R → rezultat DexScreener", dsPool(dsRaw({ relationships: R })), T, W);
expectPair("P2", "chainId, baseToken null, quoteToken [] + R → gol (nu cade pe Gecko)", dsPool({ chainId: "base", baseToken: null, quoteToken: [], relationships: R }), "", "");
expectPair("P3", "chainId, baseToken 0, quoteToken true + R → gol", dsPool({ chainId: "base", baseToken: 0, quoteToken: true, relationships: R }), "", "");
expectPair("P4", "baseToken «», quoteToken obiect, chainId + R → gol", dsPool({ chainId: "base", baseToken: "", quoteToken: side(W), relationships: R }), "", "");
expectPair("P5", "doar chainId + R → gol", dsPool({ chainId: "base", relationships: R }), "", "");
expectPair("P6", "cheie baseToken cu valoarea undefined + R → gol", dsPool({ baseToken: undefined, relationships: R }), "", "");
expectPair("P7", "DS cu quoteToken {} (malformat) + R → gol", dsPool(dsRaw({ quoteToken: {}, relationships: R })), "", "");
expectPair("P8", "baseToken șir, quoteToken obiect + R → ramura IndexedPair (T, \"\"), neschimbat", dsPool({ baseToken: T, quoteToken: side(W), relationships: R }), T, "");
expectPair("P9", "quoteToken șir, baseToken obiect → ramura IndexedPair (T, W), comportament existent neschimbat", dsPool({ baseToken: side(T), quoteToken: W }), T, W);

console.log("E. formele existente — neschimbate");
expectPair("E1", "IndexedPair, ambele șiruri", asPool({ _raw: { baseToken: T, quoteToken: W } }), T, W);
expectPair("E2", "IndexedPair, quoteToken null", asPool({ _raw: { baseToken: T, quoteToken: null } }), T, "");
expectPair("E3", "IndexedPair doar cu quoteToken, base din tokenAddress", asPool({ tokenAddress: T, _raw: { quoteToken: W } }), T, W);
expectPair("E4", "Gecko real (prefix base_)", asPool({ chain: "base", tokenAddress: T, _raw: {
  id: `base_${"0x" + "c2".repeat(20)}`, type: "pool", attributes: { address: "0x" + "c2".repeat(20) },
  relationships: { base_token: { data: { id: `base_${T}` } }, quote_token: { data: { id: `base_${W}` } }, dex: { data: { id: "uniswap-v2-base" } } },
} }), T, W);
expectPair("E5", "fără _raw → base = tokenAddress, quote gol", asPool({ tokenAddress: T }), T, "");
expectPair("E6", "IndexedPair neîmbogățit (fără base/quote) → gol", asPool({ chain: "base", _raw: { chain: "base", dexId: "uniswap-v2", pairAddress: "0x" + "e1".repeat(20), token0: W, token1: T } }), "", "");

console.log("N. fără ghicirea quote-ului, fără amestecarea chain-urilor");
{
  const pool = dsPool(dsRaw({ quoteToken: side(X) }));
  const bq = extractBaseQuote(pool);
  const flow = getQuoteFlowAsEth(BASE, bq.baseToken, bq.quoteToken, E18, -E18);
  check("N1", "quote necunoscut: parserul întoarce (T, X), getQuoteFlowAsEth → ok:false", bq.baseToken === T && bq.quoteToken === X && flow.ok === false, `parser ${pairOf(bq)}, ok=${flow.ok}`);
}
expectPair("N2", "WETH ca base, T ca quote, tokenAddress = W → (W, T), neinversat", dsPool(dsRaw({ baseToken: side(W), quoteToken: side(T) }), { tokenAddress: W }), W, T);
{
  const pool = asPool({ chain: "arbitrum", tokenAddress: T, _raw: dsRaw({ chainId: "arbitrum" }) });
  const bq = extractBaseQuote(pool);
  const flow = getQuoteFlowAsEth(ARB, bq.baseToken, bq.quoteToken, E18, -E18);
  check("N3", "pe arbitrum, cu WETH Base ca quote: parserul întoarce (T, W), getQuoteFlowAsEth(arbitrum) → ok:false", bq.baseToken === T && bq.quoteToken === W && flow.ok === false, `parser ${pairOf(bq)}, ok=${flow.ok}`);
}

console.log("I. integrare pură: normalizeDsPair → extractBaseQuote → getQuoteFlowAsEth / resolveLpNativeAmount");
const dsApiPair = {
  chainId: "base", dexId: "uniswap", pairAddress: "0x" + "d1".repeat(20),
  baseToken:  { address: T, name: "Token", symbol: "TKN" },
  quoteToken: { address: W, name: "Wrapped Ether", symbol: "WETH" },
  priceUsd: "0.5", priceChange: { m5: 0, h1: 0, h24: 0 }, liquidity: { usd: 100_000 }, volume: { h24: 1_000 },
  txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 } },
};
const ds = normalizeDsPair(dsApiPair, BASE);
if (!ds) throw new Error("normalizeDsPair a respins fixture-ul (montaj)");
{
  // W < T ⇒ WETH e token0; convenția POOL: quote POZITIV (intrat în pool) = cumpărare.
  const bq = extractBaseQuote(ds);
  const flow = getQuoteFlowAsEth(BASE, bq.baseToken, bq.quoteToken, E18, -5n * E18);
  check("I1", "BUY 1 WETH → isBuy, 1 ETH, 2500 USD", flow.ok && flow.isBuy && near(flow.ethAmount, 1) && near(flow.usdAmount, 2_500), JSON.stringify(flow));
}
{
  const bq = extractBaseQuote(ds);
  const flow = getQuoteFlowAsEth(BASE, bq.baseToken, bq.quoteToken, -(E18 / 2n), 3n * E18);
  check("I2", "SELL 0,5 WETH → !isBuy, 0,5 ETH, 1250 USD", flow.ok && !flow.isBuy && near(flow.ethAmount, 0.5) && near(flow.usdAmount, 1_250), JSON.stringify(flow));
}
{
  const lp = resolveLpNativeAmount(BASE, ds, 2n * E18, 10n * E18);
  check("I3", "resolveLpNativeAmount pe pool DexScreener, 2 WETH → ok, 2 ETH, quote WETH", lp.ok && near(lp.ethAmount, 2) && lp.quote === "WETH", JSON.stringify(lp));
}

console.log(`\n${passed} passed, ${failedIds.length} failed`);
console.log(`FAILED_IDS: ${failedIds.join(",")}`);
if (failedIds.length > 0) process.exit(1);
