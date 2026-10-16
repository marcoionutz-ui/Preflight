/**
 * scripts/aeroV2.test.ts — BETA-1 / T2: Aerodrome clasic pe ruta V2 (Swap și Burn) + regula comună a deltelor V2.
 *
 * Contractul (design `BETA1_T2_FIX_DESIGN.md` rev3, §3.1): `decodeAerodromeSwap(data)` și `decodeAerodromeBurn(data)`
 * NU aruncă niciodată; orice intrare pe care nu o pot decoda sigur dă `null`. Swap: exact 256 hex după `0x`, toate
 * validate; Burn: exact 128 hex. Trunchierea și surplusul sunt refuzate. `v2PoolDeltas` = regula existentă a
 * workerului (swap fără intrare → `null`; altfel in > 0 ? in : −out), echivalentă cu formula veche.
 *
 * Fiecare id = rândul din §6 al designului. FIECARE apel al decodoarelor e învelit în `try`: o excepție aruncată pică
 * cazul cu id-ul lui. Linia finală `FAILED_IDS:` permite compararea automată.
 *
 * Pe baseline (`0f6a15e`), exporturile noi nu există: testul se oprește la încărcare, cu cod 1 și lista lor.
 *
 * Offline: fără rețea, fără Redis; prețul nativ e seed-uit explicit. A11 citește sursa lui `subscriptions.ts` și
 * `manager.ts` (gardă de sursă), fără să le importe. A5/A8 verifică DOAR decodoarele pure; dovada pe handlerul real
 * vine din controalele `C-AERO-*-NONSTRING` și `C-AERO-*-LONG` ale harness-ului.
 */
import { readFileSync } from "node:fs";
import * as qf from "../src/ws/quoteFlow";
import { __setNativePriceForTest } from "../src/infra/nativePrice";

// ── Gardă de încărcare: pe baseline, exporturile T2 lipsesc ─────────────────────────────────────────────────────
const QF = qf as unknown as Record<string, unknown>;
const NEEDED = ["decodeAerodromeSwap", "decodeAerodromeBurn", "v2PoolDeltas", "SWAP_AERODROME_TOPIC", "BURN_AERODROME_TOPIC"] as const;
const missing = NEEDED.filter(k => QF[k] === undefined);
if (missing.length > 0) {
  console.log(`aeroV2.test: exporturi lipsă din src/ws/quoteFlow: ${missing.join(", ")} — testul nu poate rula caz cu caz`);
  console.log("FAILED_IDS: (încărcare)");
  process.exit(1);
}
type Swap = { amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint } | null;
type Burn = { amount0: bigint; amount1: bigint } | null;
type Deltas = { amount0: bigint; amount1: bigint } | null;
const decodeSwap = QF.decodeAerodromeSwap as (data: unknown) => Swap;
const decodeBurn = QF.decodeAerodromeBurn as (data: unknown) => Burn;
const v2PoolDeltas = QF.v2PoolDeltas as (a0In: bigint, a1In: bigint, a0Out: bigint, a1Out: bigint) => Deltas;
const SWAP_AERODROME_TOPIC = QF.SWAP_AERODROME_TOPIC as string;
const BURN_AERODROME_TOPIC = QF.BURN_AERODROME_TOPIC as string;

__setNativePriceForTest("ETH", 2500);

const failedIds: string[] = [];
let passed = 0;
function check(id: string, what: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✅ ${id}. ${what}`); }
  else      { if (!failedIds.includes(id)) failedIds.push(id); console.log(`  ❌ ${id}. ${what}${detail ? `\n       ${detail}` : ""}`); }
}

type Safe<T> = { threw: false; value: T } | { threw: true; error: string };
/** Apel protejat: o excepție devine eșecul cazului, cu id-ul lui. */
function safe<T>(id: string, fn: () => T): Safe<T> {
  try { return { threw: false, value: fn() }; }
  catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    check(id, `decodorul NU aruncă (a aruncat: ${error})`, false);
    return { threw: true, error };
  }
}
const show = (r: Safe<unknown>): string =>
  r.threw ? `aruncat: ${r.error}` : JSON.stringify(r.value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const isNull = (r: Safe<unknown>): boolean => !r.threw && r.value === null;
const swapIs = (r: Safe<Swap>, a: [bigint, bigint, bigint, bigint]): boolean =>
  !r.threw && r.value !== null && r.value.amount0In === a[0] && r.value.amount1In === a[1] && r.value.amount0Out === a[2] && r.value.amount1Out === a[3];
const burnIs = (r: Safe<Burn>, a0: bigint, a1: bigint): boolean => !r.threw && r.value !== null && r.value.amount0 === a0 && r.value.amount1 === a1;

// ── Fixture, scrise independent de produs (topicuri = keccak-256 al semnăturilor din comentarii) ───────────────
/** `Swap(address,address,uint256,uint256,uint256,uint256)` — Aerodrome `IPool.sol` @ 1ba30815 */
const T_SWAP_AERO = "0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b";
/** `Burn(address,address,uint256,uint256)` — Aerodrome `IPool.sol` @ 1ba30815 */
const T_BURN_AERO = "0x5d624aa9c148153ab3446c1b154f660ee7701e549fe9b62dab7171b1c80e6fa2";
const T_SWAP_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const T_MINT_V2 = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
const T_BURN_V2 = "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496";

const E18 = 10n ** 18n;
const MAX = (1n << 256n) - 1n;
const word = (v: bigint): string => v.toString(16).padStart(64, "0");
const swapData = (a0In: bigint, a1In: bigint, a0Out: bigint, a1Out: bigint): string => "0x" + word(a0In) + word(a1In) + word(a0Out) + word(a1Out);
const burnData = (a0: bigint, a1: bigint): string => "0x" + word(a0) + word(a1);
/** Înlocuiește caracterul de la poziția `i` (în partea de după `0x`) cu `c`. */
const poke = (data: string, i: number, c: string): string => data.slice(0, 2 + i) + c + data.slice(3 + i);

if (T_SWAP_AERO !== SWAP_AERODROME_TOPIC || T_BURN_AERO !== BURN_AERODROME_TOPIC) {
  console.log("aeroV2.test: topicurile din src/ws/quoteFlow diferă de cele calculate independent");
  console.log("FAILED_IDS: (montaj)");
  process.exit(1);
}

const BUY: [bigint, bigint, bigint, bigint] = [E18, 0n, 0n, 5n * E18];          // 1 WETH intră, 5 TKN ies
const SELL: [bigint, bigint, bigint, bigint] = [0n, 3n * E18, E18 / 2n, 0n];     // 3 TKN intră, 0,5 WETH iese

console.log("Swap Aerodrome — exact 256 hex");
{
  const b = safe("A1", () => decodeSwap(swapData(...BUY)));
  check("A1", "BUY: sumele exacte", swapIs(b, BUY), show(b));
  const s = safe("A1", () => decodeSwap(swapData(...SELL)));
  check("A1", "SELL: sumele exacte", swapIs(s, SELL), show(s));
}
{
  const full = swapData(...BUY);
  for (const n of [192, 255]) {
    const r = safe("A2", () => decodeSwap(full.slice(0, 2 + n)));
    check("A2", `${n} hex → null`, isNull(r), show(r));
  }
  for (const extra of ["0", word(0n)]) {
    const r = safe("A3", () => decodeSwap(full + extra));
    check("A3", `${256 + extra.length} hex (surplus) → null`, isNull(r), show(r));
  }
}
{
  const d = swapData(...BUY);
  for (let w = 0; w < 4; w++) {
    const r = safe("A4", () => decodeSwap(poke(d, w * 64 + 10, "g")));
    check("A4", `ne-hex în cuvântul ${w + 1} → null, fără excepție`, isNull(r), show(r));
  }
}
const BAD_DATA: Array<[string, unknown]> = [
  ["undefined", undefined], ["null", null], ["număr", 7], ["obiect", {}], ["șir gol", ""], ["\"0x\"", "0x"],
];
{
  const d = swapData(...BUY);
  for (const [what, data] of [...BAD_DATA, ["fără 0x", d.slice(2)], ["cu 0X", "0X" + d.slice(2)]] as Array<[string, unknown]>) {
    const r = safe("A5", () => decodeSwap(data));
    check("A5", `data ${what} → null`, isNull(r), show(r));
  }
}

console.log("Burn Aerodrome — exact 128 hex");
{
  const r = safe("A6", () => decodeBurn(burnData(2n * E18, 10n * E18)));
  check("A6", "sumele exacte", burnIs(r, 2n * E18, 10n * E18), show(r));
}
{
  const full = burnData(2n * E18, 10n * E18);
  for (const [what, data] of [["64 hex", full.slice(0, 2 + 64)], ["127 hex", full.slice(0, -1)], ["129 hex", full + "0"], ["192 hex (surplus)", full + word(0n)]] as Array<[string, string]>) {
    const r = safe("A7", () => decodeBurn(data));
    check("A7", `${what} → null`, isNull(r), show(r));
  }
}
{
  const d = burnData(2n * E18, 10n * E18);
  for (let w = 0; w < 2; w++) {
    const r = safe("A8", () => decodeBurn(poke(d, w * 64 + 3, "z")));
    check("A8", `ne-hex în cuvântul ${w + 1} → null, fără excepție`, isNull(r), show(r));
  }
  for (const [what, data] of [...BAD_DATA, ["fără 0x", d.slice(2)], ["cu 0X", "0X" + d.slice(2)]] as Array<[string, unknown]>) {
    const r = safe("A8", () => decodeBurn(data));
    check("A8", `data ${what} → null`, isNull(r), show(r));
  }
}

console.log("v2PoolDeltas — regula existentă, extrasă");
{
  const cases: Array<[string, [bigint, bigint, bigint, bigint], Deltas]> = [
    ["ambele intrări 0 → null", [0n, 0n, 5n, 7n], null],
    ["ambele intrări 0, fără ieșiri → null", [0n, 0n, 0n, 0n], null],
    ["BUY (in0, out1)", [E18, 0n, 0n, 5n * E18], { amount0: E18, amount1: -5n * E18 }],
    ["SELL (in1, out0)", [0n, 3n * E18, E18 / 2n, 0n], { amount0: -(E18 / 2n), amount1: 3n * E18 }],
    ["intrare și ieșire pe același token → intrarea câștigă", [4n, 0n, 9n, 2n], { amount0: 4n, amount1: -2n }],
    ["ambele intrări pozitive", [3n, 5n, 1n, 1n], { amount0: 3n, amount1: 5n }],
  ];
  for (const [what, a, want] of cases) {
    const r = safe("A9", () => v2PoolDeltas(...a));
    const ok = !r.threw && (want === null ? r.value === null : r.value !== null && r.value.amount0 === want.amount0 && r.value.amount1 === want.amount1);
    check("A9", what, ok, show(r));
  }
}
{
  // Copia de referință a formulei din manager.ts la 0f6a15e (zero-in → ignorat; altfel in > 0 ? in : −out).
  const old = (a0In: bigint, a1In: bigint, a0Out: bigint, a1Out: bigint): Deltas =>
    a0In === 0n && a1In === 0n ? null : { amount0: a0In > 0n ? a0In : -a0Out, amount1: a1In > 0n ? a1In : -a1Out };
  const vals = [0n, 1n, MAX];
  let same = true; const diffs: string[] = [];
  for (const a of vals) for (const b of vals) for (const c of vals) for (const d of vals) {
    const r = safe("A10", () => v2PoolDeltas(a, b, c, d));
    const o = old(a, b, c, d);
    const eq = !r.threw && (o === null ? r.value === null : r.value !== null && r.value.amount0 === o.amount0 && r.value.amount1 === o.amount1);
    if (!eq) { same = false; diffs.push(`${a},${b},${c},${d}`); }
  }
  check("A10", "v2PoolDeltas = formula veche, pe toate cele 81 de combinații {0, 1, 2²⁵⁶−1}", same, diffs.slice(0, 5).join(" | "));
}

console.log("Filtrul, maparea pe kind și ordinea dispatch-ului (gardă de sursă — A11)");
{
  const subs = readFileSync(new URL("../src/ws/subscriptions.ts", import.meta.url), "utf8");
  const mgr  = readFileSync(new URL("../src/ws/manager.ts", import.meta.url), "utf8");
  check("A11", "subscriptions.ts: topicurile Aerodrome importate din ./quoteFlow și re-exportate; nicio constantă locală",
    /import\s*\{[^}]*\bSWAP_AERODROME_TOPIC\b[^}]*\bBURN_AERODROME_TOPIC\b[^}]*\}\s*from\s*["']\.\/quoteFlow["']/.test(subs)
      && /export\s*\{[^}]*\bSWAP_AERODROME_TOPIC\b[^}]*\bBURN_AERODROME_TOPIC\b[^}]*\}/.test(subs)
      && !subs.includes(T_SWAP_AERO) && !subs.includes(T_BURN_AERO));
  check("A11", "V2_SCOPED_TOPICS = exact [Swap V2, Swap Aerodrome, Mint, Burn V2, Burn Aerodrome], în această ordine",
    /export const V2_SCOPED_TOPICS[^=]*=\s*Object\.freeze\(\[\s*SWAP_V2_TOPIC\s*,\s*SWAP_AERODROME_TOPIC\s*,\s*MINT_V2_TOPIC\s*,\s*BURN_V2_TOPIC\s*,\s*BURN_AERODROME_TOPIC\s*\]\)/.test(subs)
      && subs.includes(`SWAP_V2_TOPIC = "${T_SWAP_V2}"`) && subs.includes(`MINT_V2_TOPIC = "${T_MINT_V2}"`) && subs.includes(`BURN_V2_TOPIC = "${T_BURN_V2}"`));
  check("A11", "subscribeV2Scoped trimite filtrul din V2_SCOPED_TOPICS (fără lista veche)",
    /topics:\s*\[\[\.\.\.V2_SCOPED_TOPICS\]\]/.test(subs) && !/\[\[SWAP_V2_TOPIC,\s*MINT_V2_TOPIC/.test(subs));
  check("A11", "manager.ts: ambele topicuri Aerodrome mapate la kind v2",
    /\[SWAP_AERODROME_TOPIC\]:\s*"v2"/.test(mgr) && /\[BURN_AERODROME_TOPIC\]:\s*"v2"/.test(mgr));
  const iDispatch = mgr.indexOf("if (topicAero === SWAP_AERODROME_TOPIC || topicAero === BURN_AERODROME_TOPIC) {");
  const iSwapDec  = mgr.indexOf("decodeAerodromeSwap(logA.data)");
  const iBurnDec  = mgr.indexOf("decodeAerodromeBurn(logA.data)");
  const iAddrStr  = mgr.indexOf('if (typeof logA.address !== "string") return;');
  const iPairV2   = mgr.indexOf("const pairAddress = log.address?.toLowerCase();");
  const iRawV2    = mgr.indexOf("const raw = log.data?.slice(2);");
  check("A11", "dispatch-ul Aerodrome precede `log.address?.toLowerCase()` și `log.data?.slice(2)` din secțiunea V2 și folosește decodoarele",
    iDispatch > 0 && iAddrStr > iDispatch && iSwapDec > iDispatch && iBurnDec > iDispatch
      && iPairV2 > iSwapDec && iPairV2 > iBurnDec && iRawV2 > iPairV2,
    `dispatch=${iDispatch} adresă=${iAddrStr} swap=${iSwapDec} burn=${iBurnDec} pairV2=${iPairV2} rawV2=${iRawV2}`);
  check("A11", "linia [V2 SWAP] primește swapVariant; Uniswap V2 și Aerodrome trec prin coada comună",
    /swapVariant=\$\{variant\}/.test(mgr)
      && /recordV2PoolSwap\(chain, pairAddress, amount0In, amount1In, amount0Out, amount1Out, "uniswap-v2"\)/.test(mgr)
      && /recordV2PoolSwap\(chain, pairA, [^)]*"aerodrome-classic"\)/.test(mgr)
      && /recordV2PoolBurn\(chain, pairAddress, amount0, amount1\)/.test(mgr) && /recordV2PoolBurn\(chain, pairA, burnA\.amount0, burnA\.amount1\)/.test(mgr));
}

console.log("Integrare pură (Base, preț 2500; WETH < TKN ⇒ WETH e token0)");
const T = "0xf0000000000000000000000000000000000000a1";
const W = "0x4200000000000000000000000000000000000006";
const BASE: any = { id: "base", gecko: "base", weth: W, usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", wsUrl: "" };
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
{
  for (const [what, a, isBuy, eth, usd] of [["BUY 1 WETH", BUY, true, 1, 2_500], ["SELL 0,5 WETH", SELL, false, 0.5, 1_250]] as Array<[string, [bigint, bigint, bigint, bigint], boolean, number, number]>) {
    const r = safe("A12", () => decodeSwap(swapData(...a)));
    if (r.threw || r.value === null) { check("A12", `${what}: decodat`, false, show(r)); continue; }
    const d = v2PoolDeltas(r.value.amount0In, r.value.amount1In, r.value.amount0Out, r.value.amount1Out);
    if (d === null) { check("A12", `${what}: delte`, false); continue; }
    const f = qf.getQuoteFlowAsEth(BASE, T, W, d.amount0, d.amount1);
    check("A12", `${what} → ${isBuy ? "BUY" : "SELL"}, ${eth} ETH, ${usd} USD`, f.ok && f.isBuy === isBuy && near(f.ethAmount, eth) && near(f.usdAmount, usd), JSON.stringify(f));
  }
}
{
  const r = safe("A13", () => decodeBurn(burnData(2n * E18, 10n * E18)));
  if (r.threw || r.value === null) check("A13", "Burn decodat", false, show(r));
  else {
    const geckoPool = { _raw: { relationships: { base_token: { data: { id: `base_${T}` } }, quote_token: { data: { id: `base_${W}` } } } } };
    const lp = qf.resolveLpNativeAmount(BASE, geckoPool, r.value.amount0, r.value.amount1);
    check("A13", "Burn 2 WETH → resolveLpNativeAmount: ok, 2 ETH, quote WETH", lp.ok && near(lp.ethAmount, 2) && lp.quote === "WETH", JSON.stringify(lp));
  }
}

const ALL = Array.from({ length: 13 }, (_, i) => `A${i + 1}`);
console.log(`\n${passed} passed, ${failedIds.length} failed (cazuri: ${ALL.length})`);
console.log(`FAILED_IDS: ${failedIds.join(",")}`);
if (failedIds.length > 0) process.exit(1);
