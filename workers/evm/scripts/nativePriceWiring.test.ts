/**
 * scripts/nativePriceWiring.test.ts — E25 (wiring fail-closed în getQuoteFlowAsEth).
 *
 * Dovedește COMPORTAMENTUL, nu doar leaf-ul: fără preț nativ (never-fetched SAU stale) un swap
 * — stable-quoted SAU native-quoted — întoarce `ok:false` (fără NaN/Infinity, fără volum inventat).
 * După un seed proaspăt (via __setNativePriceForTest) devine `ok:true` cu valorile așteptate.
 * Stale = seed cu timestamp mai vechi decât TTL → iar `ok:false`. Fiecare stare setată explicit
 * înainte de apel (fără ordine ascunsă). Rulează în tsx: quoteFlow → nativePrice (pure imports).
 */
import { getQuoteFlowAsEth } from "../src/ws/quoteFlow";
import { __setNativePriceForTest, NATIVE_PRICE_MAX_AGE_MS } from "../src/infra/nativePrice";

const chain: any = {
  id: "base", gecko: "base",
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  wsUrl: "",
};
const WETH    = chain.weth;
const USDC    = chain.usdc;
// USDC (0x8335…) < BASE_HI (0xffff) → token0 = USDC → amount0 e quote. WETH (0x4200…) < BASE_HI → idem.
const BASE_HI = "0xffffffffffffffffffffffffffffffffffffffff";
const E18     = 10n ** 18n;

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

function main(): void {
  console.log("E25 wiring — getQuoteFlowAsEth fail-closed pe preț nativ absent/stale");

  // 1-3. never-fetched (state null) → ok:false, fără NaN/Infinity.
  __setNativePriceForTest("ETH", null, null);
  {
    const q = getQuoteFlowAsEth(chain, BASE_HI, USDC, -1_000_000n, 5n * E18); // -1 USDC (6 dec)
    check("1. never-fetched + USDC-quoted → ok:false", q.ok === false && q.quote === "USDC");
    check("2. never-fetched → ethAmount 0 finit (fără NaN/Infinity)", q.ethAmount === 0 && Number.isFinite(q.ethAmount));
    check("3. never-fetched → usdAmount 0 finit", q.usdAmount === 0 && Number.isFinite(q.usdAmount));
  }
  {
    const q = getQuoteFlowAsEth(chain, BASE_HI, WETH, E18, -5n * E18);
    check("4. never-fetched + WETH-quoted → ok:false (usdAmount cere preț)", q.ok === false);
  }

  // 5-8. seed proaspăt → ok:true cu valorile corecte.
  // USDC POZITIV = quote plătit ÎN pool = BUY (convenția pool V3).
  __setNativePriceForTest("ETH", 2500);
  {
    const q = getQuoteFlowAsEth(chain, BASE_HI, USDC, 1_000_000n, -5n * E18);
    check("5. seed fresh + USDC → ok:true, isBuy true", q.ok === true && q.isBuy === true);
    check("6. seed fresh + USDC → ethAmount = 1/2500", Math.abs(q.ethAmount - 1 / 2500) < 1e-12);
    check("7. seed fresh + USDC → usdAmount = 1 (stable pass-through)", Math.abs(q.usdAmount - 1) < 1e-9);
  }
  {
    const q = getQuoteFlowAsEth(chain, BASE_HI, WETH, E18, -5n * E18);
    check("8. seed fresh + WETH → ok:true, ethAmount ≈ 1, usdAmount = 2500",
      q.ok === true && Math.abs(q.ethAmount - 1) < 1e-9 && Math.abs(q.usdAmount - 2500) < 1e-6);
  }

  // 9. STALE: seed cu timestamp peste TTL → degradează la null → ok:false.
  __setNativePriceForTest("ETH", 2500, Date.now() - NATIVE_PRICE_MAX_AGE_MS - 10_000);
  {
    const q = getQuoteFlowAsEth(chain, BASE_HI, USDC, -1_000_000n, 5n * E18);
    check("9. stale (peste TTL) + USDC → ok:false", q.ok === false);
  }
  // 10. sub TTL (marjă confortabilă) → ok:true.
  __setNativePriceForTest("ETH", 2500, Date.now() - NATIVE_PRICE_MAX_AGE_MS + 60_000);
  {
    const q = getQuoteFlowAsEth(chain, BASE_HI, USDC, -1_000_000n, 5n * E18);
    check("10. sub TTL (fresh) + USDC → ok:true", q.ok === true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
