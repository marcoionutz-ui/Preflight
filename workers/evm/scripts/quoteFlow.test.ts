import { getQuoteFlowAsEth, toPoolConventionAmounts } from "../src/ws/quoteFlow";
import { __setNativePriceForTest } from "../src/infra/nativePrice";

// E25: prețul nativ nu mai are default hardcodat → seed-uim explicit (timestamp proaspăt).
// Fără asta getQuoteFlowAsEth ar întoarce ok:false (fail-closed) pe quote-urile care cer preț.
__setNativePriceForTest("ETH", 2500);
__setNativePriceForTest("BNB", 600);

const chain: any = {
  id: "base", gecko: "base",
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  wsUrl: "",
};

const WETH = chain.weth;
const BASE_HI = "0xffffffffffffffffffffffffffffffffffffffff"; // > WETH → token0 = WETH (amount0 = quote)
const BASE_LO = "0x1111111111111111111111111111111111111111"; // < WETH → token0 = BASE (amount1 = quote)
const E18 = 10n ** 18n;

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else       { failed++; console.log("  ❌ " + name); }
}

console.log("A5 quoteFlow (V4 buy/sell sign) tests");

// token0 = WETH (amount0 e quote) ─────────────────────────────────────────────
// V3 BUY: WETH plătit în pool (convenție pool, pozitiv) → isBuy true
{
  const q = getQuoteFlowAsEth(chain, BASE_HI, WETH, E18, -5n * E18);
  check("1. V3 BUY (WETH in, +) → isBuy true", q.ok && q.isBuy === true && q.quote === "WETH");
  check("2. V3 BUY ethAmount ≈ 1 (magnitudine)", Math.abs(q.ethAmount - 1) < 1e-9);
}
// V3 SELL: WETH iese din pool (negativ) → isBuy false
{
  const q = getQuoteFlowAsEth(chain, BASE_HI, WETH, -E18, 5n * E18);
  check("3. V3 SELL (WETH out, -) → isBuy false", q.ok && q.isBuy === false);
}

// V4 RAW (fără fix) — demonstrează bug-ul ─────────────────────────────────────
// V4 BUY: swapper plătește WETH (convenție swapper, NEGATIV). Raw → isBuy false = GREȘIT
{
  const q = getQuoteFlowAsEth(chain, BASE_HI, WETH, -E18, 5n * E18);
  check("4. V4 BUY RAW (fără fix) → isBuy false = GREȘIT (documentează bug-ul)", q.isBuy === false);
}

// V4 FIXAT (cu toPoolConventionAmounts) ───────────────────────────────────────
// V4 BUY: raw amount0 = -E18 (swapper plătește) → negat → +E18 → isBuy true ✓
{
  const [a0, a1] = toPoolConventionAmounts(-E18, 5n * E18, true);
  const q = getQuoteFlowAsEth(chain, BASE_HI, WETH, a0, a1);
  check("5. V4 BUY FIXAT → isBuy true", q.isBuy === true);
  check("6. V4 BUY FIXAT ethAmount ≈ 1 (magnitudine păstrată)", Math.abs(q.ethAmount - 1) < 1e-9);
}
// V4 SELL: swapper primește WETH → raw amount0 = +E18 → negat → -E18 → isBuy false ✓
{
  const [a0, a1] = toPoolConventionAmounts(E18, -5n * E18, true);
  const q = getQuoteFlowAsEth(chain, BASE_HI, WETH, a0, a1);
  check("7. V4 SELL FIXAT → isBuy false", q.isBuy === false);
}

// token0 = BASE (amount1 e quote) — cealaltă ordonare ─────────────────────────
// V4 BUY: swapper plătește WETH = amount1 negativ → negat → pozitiv → isBuy true
{
  const [a0, a1] = toPoolConventionAmounts(5n * E18, -E18, true);
  const q = getQuoteFlowAsEth(chain, BASE_LO, WETH, a0, a1);
  check("8. V4 BUY FIXAT (token0=base, quote=amount1) → isBuy true", q.isBuy === true && q.quote === "WETH");
}

// toPoolConventionAmounts pass-through pentru non-V4 (V2/V3) ───────────────────
{
  const [a0, a1] = toPoolConventionAmounts(7n, -3n, false);
  check("9. toPoolConventionAmounts(_, _, false) → neschimbat", a0 === 7n && a1 === -3n);
  const [b0, b1] = toPoolConventionAmounts(7n, -3n, true);
  check("10. toPoolConventionAmounts(_, _, true) → negat", b0 === -7n && b1 === 3n);
}

// USDC-quoted (stable) V4 buy: swapper plătește USDC (negativ, 6 dec) → fixat → buy
{
  const USDC = chain.usdc;
  // USDC (0x8335...) < BASE_HI (0xffff) → token0 = USDC → amount0 = quote
  const [a0, a1] = toPoolConventionAmounts(-1_000_000n, 5n * E18, true); // -1 USDC (6 dec)
  const q = getQuoteFlowAsEth(chain, BASE_HI, USDC, a0, a1);
  check("11. V4 BUY USDC-quoted FIXAT → isBuy true, quote USDC, ethAmount>0",
    q.isBuy === true && q.quote === "USDC" && q.ethAmount > 0);
}

// Simetrie (sugestii ChatGPT) — SELL pe cealaltă ordonare + USDC sell ─────────
// token0 = BASE, V4 SELL: swapper primește WETH (amount1 pozitiv raw) → negat → false
{
  const [a0, a1] = toPoolConventionAmounts(-5n * E18, E18, true);
  const q = getQuoteFlowAsEth(chain, BASE_LO, WETH, a0, a1);
  check("12. V4 SELL FIXAT (token0=base) → isBuy false", q.ok && q.isBuy === false);
}
// V4 SELL USDC-quoted: swapper primește USDC (amount0 pozitiv raw) → negat → false
{
  const USDC = chain.usdc;
  const [a0, a1] = toPoolConventionAmounts(1_000_000n, -5n * E18, true);
  const q = getQuoteFlowAsEth(chain, BASE_HI, USDC, a0, a1);
  check("13. V4 SELL USDC-quoted FIXAT → isBuy false, quote USDC", q.isBuy === false && q.quote === "USDC");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
