/**
 * scripts/lpQuote.test.ts — E18 (LP V2 Mint/Burn presupunea WETH-quoted → rug detection moartă pe stable-quoted).
 *
 * Dovedeste ca `resolveLpNativeAmount` (reutilizeaza `extractBaseQuote` + `getQuoteFlowAsEth`, ca path-ul de
 * swap si ca V3 Mint/Burn) calculeaza corect valoarea native-echivalenta a unui eveniment LP INDIFERENT de
 * quote (native SAU stable, cu decimalele corecte). Plus CONTRAST cu logica veche hardcodata (`weth<token` +
 * `/1e18`) care pe stable-quoted alegea rezerva gresita si/sau nu convertea USD→native → prag de rug niciodata
 * evaluat corect. `getNativePrice` are fallback determinist (BNB=600, ETH=2500) → test offline.
 */
import { resolveLpNativeAmount, extractBaseQuote, stableMetaFor } from "../src/ws/quoteFlow";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const E18 = 10n ** 18n;
const E6  = 10n ** 6n;

// ── chain stubs (ca A5) ──────────────────────────────────────────────────────────
const BSC: any = {
  id: "bsc", gecko: "bsc",
  weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",   // WBNB
  usdc: "0x55d398326f99059ff775485246999027b3197955",   // USDT (câmp usdc = stable quote)
  stableQuotes: [
    "0x55d398326f99059ff775485246999027b3197955", // USDT
    "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC BSC
  ],
  wsUrl: "",
};
const BASE: any = {
  id: "base", gecko: "base",
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  wsUrl: "",
};
const ETH: any = {
  id: "ethereum", gecko: "eth",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  stableQuotes: [
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC (6)
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT (6)
    "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI  (18)
  ],
  wsUrl: "",
};
const DAI  = "0x6b175474e89094c44da98b954eedeac495271d0f";
const USDT_ETH = "0xdac17f958d2ee523a2206206994597c13d831ec7";

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const BASE_LO   = "0x1111111111111111111111111111111111111111"; // < USDT și < WBNB
const BASE_MID  = "0x8888888888888888888888888888888888888888"; // > USDT, < WBNB (capcana logicii vechi)

const pool = (baseToken: string, quoteToken: string) => ({ _raw: { baseToken, quoteToken }, tokenAddress: baseToken });

// Reimplementarea FIDELĂ a logicii VECHI (bug-ul E18), ca să demonstrăm contrastul.
function oldWethAssumedEth(chain: any, tokenAddr: string, amount0: bigint, amount1: bigint): number {
  const wethIsT0 = chain.weth.toLowerCase() < tokenAddr.toLowerCase().replace(/^[a-z]+_/, "");
  return Number(wethIsT0 ? amount0 : amount1) / 1e18;
}

console.log("E18 — extractBaseQuote (mutată în quoteFlow)");

// 1. IndexedPair format (_raw.baseToken/quoteToken).
{
  const bq = extractBaseQuote(pool(BASE_LO, USDT));
  check("1a. indexed → baseToken", bq.baseToken === BASE_LO);
  check("1b. indexed → quoteToken", bq.quoteToken === USDT);
}
// 2. Gecko format (relationships cu prefix rețea → strip).
{
  const bq = extractBaseQuote({ _raw: { relationships: {
    base_token:  { data: { id: "bsc_" + BASE_LO } },
    quote_token: { data: { id: "bsc_" + USDT } },
  } } } as any);
  check("2a. gecko prefix strip → base", bq.baseToken === BASE_LO);
  check("2b. gecko prefix strip → quote", bq.quoteToken === USDT);
}
// 3. fără _raw → fallback pe tokenAddress, quote gol.
{
  const bq = extractBaseQuote({ tokenAddress: BASE_LO } as any);
  check("3a. fără _raw → base = tokenAddress", bq.baseToken === BASE_LO);
  check("3b. fără _raw → quote gol", bq.quoteToken === "");
}

console.log("\nE18 — resolveLpNativeAmount stable-quoted (BSC token/USDT) — bug-ul principal");

// 4. ⭐ base < USDT: token0 = base, USDT la amount1. 1000 USDT rezervă → 1000/600 BNB.
{
  const amount0 = 5000n * E18;   // rezervă token base (irelevantă)
  const amount1 = 1000n * E18;   // rezervă USDT (18 dec pe BSC)
  const lp = resolveLpNativeAmount(BSC, pool(BASE_LO, USDT), amount0, amount1);
  const correct = 1000 / 600;    // 1000 USD → BNB @ $600
  check("4a. ok + quote=USDT", lp.ok && lp.quote === "USDT");
  check("4b. native-echiv corect (1000/600 BNB)", Math.abs(lp.ethAmount - correct) < 1e-6);

  const oldVal = oldWethAssumedEth(BSC, BASE_LO, amount0, amount1);
  check("4c. logica VECHE = 1000 (tratează USDT ca BNB, 600× supraevaluat)", Math.abs(oldVal - 1000) < 1e-9);
  check("4d. vechi ≠ corect (bug demonstrat)", Math.abs(oldVal - correct) > 500);
}

// 5. ⭐ base ÎNTRE USDT și WBNB (0x8888): logica veche alege REZERVA GREȘITĂ (token base, nu quote).
{
  // USDT (0x55) < base (0x88) → token0 = USDT la amount0, base la amount1.
  const amount0 = 1000n * E18;   // rezervă USDT
  const amount1 = 5000n * E18;   // rezervă token base
  const lp = resolveLpNativeAmount(BSC, pool(BASE_MID, USDT), amount0, amount1);
  const correct = 1000 / 600;
  check("5a. ok + quote=USDT", lp.ok && lp.quote === "USDT");
  check("5b. native-echiv corect din rezerva USDT (amount0)", Math.abs(lp.ethAmount - correct) < 1e-6);

  const oldVal = oldWethAssumedEth(BSC, BASE_MID, amount0, amount1); // wethIsT0=false → amount1 = rezerva BASE
  check("5c. logica VECHE = 5000 (rezerva GREȘITĂ, token base)", Math.abs(oldVal - 5000) < 1e-9);
  check("5d. vechi ≠ corect (rug detection ar fi rulat pe gunoi)", Math.abs(oldVal - correct) > 1000);
}

console.log("\nE18 — decimale stable non-BSC (base chain token/USDC 6 dec)");

// 6. USDC pe base = 6 decimale (nu 18) — logica veche /1e18 dădea ~0.
{
  const USDC = BASE.usdc;                 // 0x8335… > BASE_LO → token0 = base, USDC la amount1
  const amount0 = 5000n * E18;            // rezervă base
  const amount1 = 1000n * E6;             // 1000 USDC (6 dec)
  const lp = resolveLpNativeAmount(BASE, pool(BASE_LO, USDC), amount0, amount1);
  const correct = 1000 / 2500;            // 1000 USD → ETH @ $2500
  check("6a. ok + quote=USDC", lp.ok && lp.quote === "USDC");
  check("6b. native-echiv corect (1000/2500 ETH, 6 dec)", Math.abs(lp.ethAmount - correct) < 1e-9);

  const oldVal = oldWethAssumedEth(BASE, BASE_LO, amount0, amount1); // amount1/1e18 = 1e-9 ≈ 0
  check("6c. logica VECHE ≈ 0 (a împărțit USDC 6-dec la 1e18)", oldVal < 1e-6);
  check("6d. vechi ≠ corect", Math.abs(oldVal - correct) > 0.3);
}

console.log("\nE18 — paritate WETH/WBNB-quoted (path-ul care mergea rămâne identic)");

// 7. token/WBNB pe BSC: native kind → ethAmount = rezerva WBNB direct. Vechi ȘI nou trebuie să dea la fel.
{
  const WBNB = BSC.weth;                  // 0xbb4c… > BASE_LO → token0 = base, WBNB la amount1
  const amount0 = 5000n * E18;            // rezervă base
  const amount1 = 2n * E18;               // 2 WBNB
  const lp = resolveLpNativeAmount(BSC, pool(BASE_LO, WBNB), amount0, amount1);
  check("7a. ok + quote=WBNB", lp.ok && lp.quote === "WBNB");
  check("7b. native = 2 (WBNB direct, fără conversie)", Math.abs(lp.ethAmount - 2) < 1e-9);

  const oldVal = oldWethAssumedEth(BSC, BASE_LO, amount0, amount1);
  check("7c. paritate: vechi == nou pe WETH-quoted (fără regresie)", Math.abs(oldVal - lp.ethAmount) < 1e-9);
}

console.log("\nE18 — stable decimals PER-ADRESĂ (varu R1: DAI 18 dec pe Ethereum)");

// 11. ⭐ blocker varu — Ethereum token/DAI: DAI are 18 decimale (NU 6). base < DAI → DAI la amount1.
{
  const amount0 = 5000n * E18;   // rezervă token base
  const amount1 = 1000n * E18;   // 1000 DAI (18 dec)
  const lp = resolveLpNativeAmount(ETH, pool(BASE_LO, DAI), amount0, amount1);
  const correct = 1000 / 2500;   // 1000 USD → ETH @ $2500
  check("11a. ok + quote=DAI (nu «USDC»)", lp.ok && lp.quote === "DAI");
  check("11b. native-echiv corect (18 dec: 1000/2500 ETH)", Math.abs(lp.ethAmount - correct) < 1e-9);

  // Contrast: vechiul `bsc?18:6` ar fi citit DAI ca 6 dec → 1000e18/1e6 = 1e15 USD → /2500 = 4e11 ETH.
  const oldWrong = (Number(amount1) / 1e6) / 2500;
  check("11c. vechea euristică (DAI ca 6 dec) → ~4e11 ETH (10^12 umflat → fals rug alert)", oldWrong > 1e11);
  check("11d. corect ≠ euristica veche", Math.abs(lp.ethAmount - oldWrong) > 1e10);
}

// 12. Ethereum token/USDT: 6 decimale + etichetă corectă "USDT" (nu «USDC»).
{
  const amount0 = 5000n * E18;   // rezervă base
  const amount1 = 1000n * E6;    // 1000 USDT (6 dec pe Ethereum)
  const lp = resolveLpNativeAmount(ETH, pool(BASE_LO, USDT_ETH), amount0, amount1);
  const correct = 1000 / 2500;
  check("12a. ok + quote=USDT (nu «USDC»)", lp.ok && lp.quote === "USDT");
  check("12b. native-echiv corect (6 dec)", Math.abs(lp.ethAmount - correct) < 1e-9);
}

// 13. stableMetaFor direct — decimale + simbol per adresă (case-insensitive).
{
  check("13a. DAI → 18 dec / DAI",        stableMetaFor(DAI)?.decimals === 18 && stableMetaFor(DAI)?.symbol === "DAI");
  check("13b. ETH USDT → 6 dec / USDT",   stableMetaFor(USDT_ETH)?.decimals === 6 && stableMetaFor(USDT_ETH)?.symbol === "USDT");
  check("13c. ETH USDC → 6 dec / USDC",   stableMetaFor("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")?.decimals === 6);
  check("13d. BSC USDT → 18 dec",         stableMetaFor("0x55d398326f99059ff775485246999027b3197955")?.decimals === 18);
  check("13e. BSC USDC → 18 dec",         stableMetaFor("0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d")?.decimals === 18);
  check("13f. Base USDC → 6 dec",         stableMetaFor("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")?.decimals === 6);
  check("13g. Arb USDC.e → 6 dec / USDC.e", stableMetaFor("0xff970a61a04b1ca14834a43f5de4533ebddb5cc8")?.symbol === "USDC.e");
  check("13h. case-insensitive (uppercase DAI)", stableMetaFor(DAI.toUpperCase())?.decimals === 18);
  check("13i. token necunoscut → null",   stableMetaFor("0x2222222222222222222222222222222222222222") === null);
}

console.log("\nE18 — allowlist per-chain (varu R2: adresele nu-s unice între rețele)");

// 14. ⭐ blocker varu — adresa DAI (Ethereum) folosită pe BASE (care NU o autorizează în stableQuotes) → skip.
{
  const fakeCrossChain = resolveLpNativeAmount(BASE, pool(BASE_LO, DAI), 5000n * E18, 1000n * E18);
  check("14a. DAI (adresă Ethereum) pe Base → nerecunoscut (ok:false)", fakeCrossChain.ok === false);
}
// 15. aceeași adresă DAI ESTE recunoscută pe Ethereum (chain-ul o autorizează).
{
  const legit = resolveLpNativeAmount(ETH, pool(BASE_LO, DAI), 5000n * E18, 1000n * E18);
  check("15. DAI pe Ethereum → recunoscut (autorizat de chain)", legit.ok === true && legit.quote === "DAI");
}
// 16. USDT-ul BSC (adresă 0x55d3…) folosit pe Base (neautorizat acolo) → skip.
{
  const bscUsdtOnBase = resolveLpNativeAmount(BASE, pool(BASE_LO, USDT), 5000n * E18, 1000n * E18);
  check("16. USDT (adresă BSC) pe Base → nerecunoscut (ok:false)", bscUsdtOnBase.ok === false);
}

console.log("\nE18 — guard-uri (skip recordLp)");

// 8. pool undefined → ok:false (apelantul sare recordLp).
check("8. pool undefined → ok:false", resolveLpNativeAmount(BSC, undefined, E18, E18).ok === false);

// 9. quote nerecunoscut (token/token, nici native nici stable) → ok:false.
{
  const rnd = "0x2222222222222222222222222222222222222222";
  check("9. quote nerecunoscut → ok:false", resolveLpNativeAmount(BSC, pool(BASE_LO, rnd), E18, E18).ok === false);
}

// 10. base/quote nerezolvabil (fără _raw, quote gol) → ok:false.
check("10. base/quote gol → ok:false", resolveLpNativeAmount(BSC, { tokenAddress: BASE_LO } as any, E18, E18).ok === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
