/**
 * scripts/v3Swap.test.ts — BETA-1 / T1: decodarea swapurilor V3 (Uniswap V3 și PancakeSwap V3).
 *
 * Contractul (design `BETA1_T1_FIX_DESIGN.md` rev3, §2.1): `decodeV3SwapAmounts(topic0, data)` NU aruncă niciodată;
 * orice intrare pe care nu o poate decoda sigur dă `null`. PancakeSwap V3: exact 448 hex după `0x`, toate validate
 * (trunchierea și surplusul sunt refuzate). Uniswap V3: cel puțin 128 hex, primele 128 validate, coada tolerată și
 * neinspectată (ca azi). Schimbări declarate pe Uniswap, numai pe date malformate: ne-hex în sume → `null` (azi
 * excepție + `[WS ERR`); lipsa prefixului `0x` → `null`.
 *
 * Fiecare caz are un id (tabelul din §3). FIECARE apel al decodorului e învelit în `try`: o excepție aruncată pică
 * cazul respectiv, cu id-ul lui — contractul „fără excepții" e verificat, nu presupus. Linia finală `FAILED_IDS:`
 * permite compararea automată.
 *
 * Pe baseline (`997f4af`), exporturile noi nu există: testul se oprește la încărcare, cu cod 1 și lista lor.
 *
 * Offline: fără rețea, fără Redis; prețul nativ e seed-uit explicit (ca `dsQuote.test.ts`). S15 citește sursa lui
 * `subscriptions.ts` și `manager.ts` (gardă de sursă, ca `wsSubsPublish.test.ts`), fără să le importe: importul lor
 * aduce dependențele operaționale ale abonării.
 */
import { readFileSync } from "node:fs";
import * as qf from "../src/ws/quoteFlow";
import { __setNativePriceForTest } from "../src/infra/nativePrice";

// ── Gardă de încărcare: pe baseline, exporturile T1 lipsesc ─────────────────────────────────────────────────────
const NEEDED = ["decodeV3SwapAmounts", "int256FromWord", "SWAP_V3_TOPIC", "SWAP_PANCAKE_V3_TOPIC"] as const;
const QF = qf as unknown as Record<string, unknown>;
const missing = NEEDED.filter(k => QF[k] === undefined);
if (missing.length > 0) {
  console.log(`v3Swap.test: exporturi lipsă din src/ws/quoteFlow: ${missing.join(", ")} — testul nu poate rula caz cu caz`);
  console.log("FAILED_IDS: (încărcare)");
  process.exit(1);
}
type Decoded = { amount0: bigint; amount1: bigint; variant: "uniswap-v3" | "pancake-v3" } | null;
const decode = QF.decodeV3SwapAmounts as (topic0: unknown, data: unknown) => Decoded;
const int256FromWord = QF.int256FromWord as (hex64: string) => bigint;
const SWAP_V3_TOPIC = QF.SWAP_V3_TOPIC as string;
const SWAP_PANCAKE_V3_TOPIC = QF.SWAP_PANCAKE_V3_TOPIC as string;

__setNativePriceForTest("ETH", 2500);

const failedIds: string[] = [];
let passed = 0;
function check(id: string, what: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✅ ${id}. ${what}`); }
  else      { if (!failedIds.includes(id)) failedIds.push(id); console.log(`  ❌ ${id}. ${what}${detail ? `\n       ${detail}` : ""}`); }
}

/** Apel protejat: o excepție devine eșecul cazului, cu id-ul lui. */
function safeDecode(id: string, topic0: unknown, data: unknown): { threw: false; value: Decoded } | { threw: true; error: string } {
  try { return { threw: false, value: decode(topic0, data) }; }
  catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    check(id, `decodorul NU aruncă (a aruncat: ${error})`, false);
    return { threw: true, error };
  }
}
const show = (r: ReturnType<typeof safeDecode>): string =>
  r.threw ? `aruncat: ${r.error}` : JSON.stringify(r.value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const isNull = (r: ReturnType<typeof safeDecode>): boolean => !r.threw && r.value === null;
const is = (r: ReturnType<typeof safeDecode>, a0: bigint, a1: bigint, variant: string): boolean =>
  !r.threw && r.value !== null && r.value.amount0 === a0 && r.value.amount1 === a1 && r.value.variant === variant;

// ── Fixture, scrise independent de produs (topicuri = keccak-256 al semnăturilor din comentarii) ───────────────
/** `Swap(address,address,int256,int256,uint160,uint128,int24)` — Uniswap V3 */
const T_UNI = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
/** `Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)` — PancakeSwap V3 */
const T_PCS = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";
const T_MINT_V3 = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
const T_BURN_V3 = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c";
const T_SWAP_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const T_SWAP_V4 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const T_SOLIDLY = "0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b";

const E18 = 10n ** 18n;
const TWO256 = 1n << 256n;
const word = (v: bigint): string => (v < 0n ? TWO256 + v : v).toString(16).padStart(64, "0");
/** Cuvintele 3..n ale unui Swap (sqrtPriceX96, liquidity, tick, taxe), valori plauzibile și valide. */
const tail = (n: number): string => [word(1n << 96n), word(10n ** 12n), word(-600n), word(7n), word(9n)].slice(0, n).join("");
const uniData = (a0: bigint, a1: bigint): string => "0x" + word(a0) + word(a1) + tail(3);        // 5 cuvinte
const pcsData = (a0: bigint, a1: bigint): string => "0x" + word(a0) + word(a1) + tail(5);        // 7 cuvinte
/** Înlocuiește caracterul de la poziția `i` (în partea de după `0x`) cu `c`. */
const poke = (data: string, i: number, c: string): string => data.slice(0, 2 + i) + c + data.slice(3 + i);

if (T_UNI !== SWAP_V3_TOPIC || T_PCS !== SWAP_PANCAKE_V3_TOPIC) {
  // Montaj: topicurile produsului trebuie să fie exact cele calculate independent.
  console.log("v3Swap.test: topicurile din src/ws/quoteFlow diferă de cele calculate independent");
  console.log("FAILED_IDS: (montaj)");
  process.exit(1);
}

console.log("Uniswap V3 — compatibilitate");
{
  const buy = safeDecode("S1", T_UNI, uniData(E18, -5n * E18));
  check("S1", "5 cuvinte, BUY → sumele exacte, variant uniswap-v3", is(buy, E18, -5n * E18, "uniswap-v3"), show(buy));
  const sell = safeDecode("S1", T_UNI, uniData(-(E18 / 2n), 3n * E18));
  check("S1", "5 cuvinte, SELL → sumele exacte, variant uniswap-v3", is(sell, -(E18 / 2n), 3n * E18, "uniswap-v3"), show(sell));
}
{
  const r = safeDecode("S2", T_UNI, "0x" + word(E18) + word(-5n * E18));
  check("S2", "exact 128 hex → acceptat, ca azi", is(r, E18, -5n * E18, "uniswap-v3"), show(r));
}
{
  const full = "0x" + word(E18) + word(-5n * E18);
  for (const n of [127, 126]) {
    const r = safeDecode("S3", T_UNI, full.slice(0, 2 + n));
    check("S3", `${n} hex → null`, isNull(r), show(r));
  }
}
{
  const r = safeDecode("S4", T_UNI, "0x" + word(E18) + word(-5n * E18) + "zz-nu-e-hex");
  check("S4", "primele 128 valide + coadă ne-hex → acceptat (toleranța declarată la coadă)", is(r, E18, -5n * E18, "uniswap-v3"), show(r));
}
{
  const d = uniData(E18, -5n * E18);
  for (const [where, i] of [["cuvântul 1", 10], ["cuvântul 2", 64 + 10]] as const) {
    const r = safeDecode("S5", T_UNI, poke(d, i, "g"));
    check("S5", `ne-hex în ${where} → null, fără excepție (schimbare declarată)`, isNull(r), show(r));
  }
}

console.log("PancakeSwap V3 — exact 448 hex");
{
  const buy = safeDecode("S6", T_PCS, pcsData(E18, -5n * E18));
  check("S6", "exact 448 hex, BUY → sumele exacte, variant pancake-v3", is(buy, E18, -5n * E18, "pancake-v3"), show(buy));
  const sell = safeDecode("S6", T_PCS, pcsData(-(E18 / 2n), 3n * E18));
  check("S6", "exact 448 hex, SELL → sumele exacte, variant pancake-v3", is(sell, -(E18 / 2n), 3n * E18, "pancake-v3"), show(sell));
}
{
  const r = safeDecode("S7", T_PCS, uniData(E18, -5n * E18));
  check("S7", "320 hex (formă Uniswap cu topic Pancake) → null", isNull(r), show(r));
}
{
  const r = safeDecode("S8", T_PCS, "0x" + word(E18) + word(-5n * E18) + tail(4));
  check("S8", "384 hex (6 cuvinte) → null", isNull(r), show(r));
}
{
  const full = pcsData(E18, -5n * E18);
  const r447 = safeDecode("S9", T_PCS, full.slice(0, -1));
  check("S9", "447 hex → null", isNull(r447), show(r447));
  const r449 = safeDecode("S9", T_PCS, full + "0");
  check("S9", "449 hex → null", isNull(r449), show(r449));
}
{
  const r = safeDecode("S10", T_PCS, pcsData(E18, -5n * E18) + word(0n));
  check("S10", "512 hex (surplus de un cuvânt, primele 448 valide) → null", isNull(r), show(r));
}
{
  const d = pcsData(E18, -5n * E18);
  for (const [where, i] of [["cuvântul 1", 10], ["cuvântul 2", 64 + 10], ["cuvântul 5 (în afara sumelor)", 4 * 64 + 10]] as const) {
    const r = safeDecode("S11", T_PCS, poke(d, i, "x"));
    check("S11", `ne-hex în ${where} → null, fără excepție`, isNull(r), show(r));
  }
}

console.log("Complement față de doi, pe ambele variante");
{
  const MIN = -(1n << 255n), MAX = (1n << 255n) - 1n;
  const vectors: Array<[string, bigint, bigint]> = [
    ["sume negative", -7n * E18, -(E18 / 3n)],
    ["0xff…ff → −1", -1n, 1n],
    ["0x80…00 → −2²⁵⁵", MIN, 0n],
    ["0x7f…ff → 2²⁵⁵−1", MAX, MIN],
  ];
  if (word(-1n) !== "f".repeat(64) || word(MIN) !== "8" + "0".repeat(63) || word(MAX) !== "7" + "f".repeat(63)) {
    check("S12", "montaj: cuvintele de limită au forma așteptată", false);
  }
  for (const [what, a0, a1] of vectors) {
    const u = safeDecode("S12", T_UNI, uniData(a0, a1));
    check("S12", `${what} — uniswap-v3`, is(u, a0, a1, "uniswap-v3"), show(u));
    const p = safeDecode("S12", T_PCS, pcsData(a0, a1));
    check("S12", `${what} — pancake-v3`, is(p, a0, a1, "pancake-v3"), show(p));
  }
}

console.log("Topicuri și intrări care nu sunt date de swap");
{
  const d5 = uniData(E18, -5n * E18), d7 = pcsData(E18, -5n * E18);
  for (const [name, t] of [["Mint V3", T_MINT_V3], ["Burn V3", T_BURN_V3], ["Swap V2", T_SWAP_V2], ["Swap V4", T_SWAP_V4], ["Solidly", T_SOLIDLY], ["Uniswap V3 cu majuscule", "0x" + T_UNI.slice(2).toUpperCase()]] as const) {
    const a = safeDecode("S13", t, d5), b = safeDecode("S13", t, d7);
    check("S13", `topic ${name} → null (date de 5 și de 7 cuvinte)`, isNull(a) && isNull(b), `${show(a)} / ${show(b)}`);
  }
}
{
  const d = uniData(E18, -5n * E18);
  const bad: Array<[string, unknown]> = [
    ["undefined", undefined], ["null", null], ["număr", 123], ["obiect", { data: d }], ["șir gol", ""], ["\"0x\"", "0x"],
    ["fără 0x", d.slice(2)], ["cu 0X", "0X" + d.slice(2)],
  ];
  for (const [topic, t] of [["uniswap", T_UNI], ["pancake", T_PCS]] as const) {
    for (const [what, data] of bad) {
      const r = safeDecode("S14", t, data);
      check("S14", `${topic}: data ${what} → null`, isNull(r), show(r));
    }
  }
  for (const [what, t] of [["undefined", undefined], ["null", null], ["număr", 1], ["array", [T_UNI]], ["obiect", { t: T_UNI }]] as const) {
    const r = safeDecode("S14", t, d);
    check("S14", `topic0 ${what} → null`, isNull(r), show(r));
  }
}

console.log("Filtrul și cablarea (gardă de sursă — S15)");
{
  const subs = readFileSync(new URL("../src/ws/subscriptions.ts", import.meta.url), "utf8");
  const mgr  = readFileSync(new URL("../src/ws/manager.ts", import.meta.url), "utf8");
  check("S15", "subscriptions.ts importă topicurile de swap V3 din ./quoteFlow și le re-exportă",
    /import\s*\{\s*SWAP_V3_TOPIC\s*,\s*SWAP_PANCAKE_V3_TOPIC\s*\}\s*from\s*["']\.\/quoteFlow["']/.test(subs)
      && /export\s*\{\s*SWAP_V2_TOPIC\s*,\s*SWAP_V3_TOPIC\s*,\s*SWAP_PANCAKE_V3_TOPIC\s*\}/.test(subs)
      && !/const\s+SWAP_V3_TOPIC\s*=/.test(subs) && !subs.includes(T_UNI) && !subs.includes(T_PCS));
  check("S15", "V3_SCOPED_TOPICS = exact [Swap Uniswap V3, Swap Pancake V3, Mint V3, Burn V3], în această ordine",
    /export const V3_SCOPED_TOPICS[^=]*=\s*Object\.freeze\(\[\s*SWAP_V3_TOPIC\s*,\s*SWAP_PANCAKE_V3_TOPIC\s*,\s*MINT_V3_TOPIC\s*,\s*BURN_V3_TOPIC\s*\]\)/.test(subs)
      && subs.includes(`MINT_V3_TOPIC = "${T_MINT_V3}"`) && subs.includes(`BURN_V3_TOPIC = "${T_BURN_V3}"`));
  check("S15", "subscribeV3Scoped trimite filtrul din V3_SCOPED_TOPICS (fără lista veche)",
    /topics:\s*\[\[\.\.\.V3_SCOPED_TOPICS\]\]/.test(subs) && !/\[\[SWAP_V3_TOPIC,\s*MINT_V3_TOPIC/.test(subs));
  check("S15", "manager.ts: topicul Pancake mapat la kind v3; ramura V3 Swap folosește decodorul; fără int256FromWord local",
    /\[SWAP_PANCAKE_V3_TOPIC\]:\s*"v3"/.test(mgr) && /decodeV3SwapAmounts\(log3\.topics\?\.\[0\],\s*log3\.data\)/.test(mgr)
      && /=== SWAP_V3_TOPIC \|\| msg\.params\?\.result\?\.topics\?\.\[0\] === SWAP_PANCAKE_V3_TOPIC/.test(mgr)
      && !/function int256FromWord/.test(mgr) && /swapVariant=\$\{dec3\.variant\}/.test(mgr));
}

console.log("int256FromWord mutată — aceleași valori ca vechea implementare");
{
  // Copia de referință a implementării din manager.ts de la 997f4af.
  const old = (hex64: string): bigint => { const x = BigInt("0x" + hex64); return x >= (1n << 255n) ? x - (1n << 256n) : x; };
  const words = [word(0n), word(1n), word(-1n), word(-(1n << 255n)), word((1n << 255n) - 1n), word(E18), word(-5n * E18), "F".repeat(64), "8" + "0".repeat(63)];
  let same = true; const diffs: string[] = [];
  for (const w of words) {
    try { const a = int256FromWord(w), b = old(w); if (a !== b) { same = false; diffs.push(w.slice(0, 8)); } }
    catch (e) { same = false; diffs.push(`${w.slice(0, 8)}: ${String(e)}`); }
  }
  check("S16", "int256FromWord = implementarea veche, pe vectorii de limită", same, diffs.join(", "));
}

console.log("Integrare pură: decodor → getQuoteFlowAsEth (Base, preț 2500)");
{
  const T = "0xf0000000000000000000000000000000000000a1";  // token (base)
  const W = "0x4200000000000000000000000000000000000006";  // WETH pe Base: W < T ⇒ WETH e token0
  const BASE: any = { id: "base", gecko: "base", weth: W, usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", wsUrl: "" };
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  const buy = safeDecode("S17", T_PCS, pcsData(E18, -5n * E18));
  if (!buy.threw && buy.value) {
    const f = qf.getQuoteFlowAsEth(BASE, T, W, buy.value.amount0, buy.value.amount1);
    check("S17", "Pancake BUY 1 WETH → isBuy, 1 ETH, 2500 USD", f.ok && f.isBuy && near(f.ethAmount, 1) && near(f.usdAmount, 2_500), JSON.stringify(f));
  } else check("S17", "Pancake BUY decodat", false, show(buy));
  const sell = safeDecode("S17", T_PCS, pcsData(-(E18 / 2n), 3n * E18));
  if (!sell.threw && sell.value) {
    const f = qf.getQuoteFlowAsEth(BASE, T, W, sell.value.amount0, sell.value.amount1);
    check("S17", "Pancake SELL 0,5 WETH → !isBuy, 0,5 ETH, 1250 USD", f.ok && !f.isBuy && near(f.ethAmount, 0.5) && near(f.usdAmount, 1_250), JSON.stringify(f));
  } else check("S17", "Pancake SELL decodat", false, show(sell));
}

const ALL = Array.from({ length: 17 }, (_, i) => `S${i + 1}`);
console.log(`\n${passed} passed, ${failedIds.length} failed (cazuri: ${ALL.length})`);
console.log(`FAILED_IDS: ${failedIds.join(",")}`);
if (failedIds.length > 0) process.exit(1);
