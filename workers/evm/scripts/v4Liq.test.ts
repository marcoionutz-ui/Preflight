/**
 * scripts/v4Liq.test.ts — BETA-1 / V4L: topicul V4 `ModifyLiquidity` (rutare diagnostică, nu suport LP V4).
 *
 * Contractul (design `BETA1_V4L_FIX_DESIGN.md` rev2, §5): `MODIFY_LIQUIDITY_V4_TOPIC` este keccak-256 al semnăturii
 * `ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)` din Uniswap/v4-core @ 46c68346 (IPoolManager.sol
 * L63–L72; `PoolId` = `bytes32`, PoolId.sol L6). Valoarea veche era `DecreaseLiquidity(uint256,uint128,uint256,uint256)`
 * din V3 NonfungiblePositionManager, pe care PoolManager nu o emite niciodată.
 *
 * Importă DOAR `src/config/constants.ts` (fișier fără importuri). L3 și L4 citesc sursele lui `subscriptions.ts` și
 * `manager.ts` ca text (gărzi de sursă), fără să le importe. Dovada pe traseul real vine din controlul `C-V4-LIQ`.
 *
 * Pe baseline (`fbafeaa`) constanta are valoarea veche: L1 și L2 pică, cu cod 1 și `FAILED_IDS: L1,L2`.
 *
 * Felia V4LR (design `BETA1_V4LR_ROBUSTNESS_DESIGN.md` rev1, §5): L5 = gardă de sursă LIMITATĂ la ramura `[V4 LIQ]`
 * (de la comentariul `// ── V4 ModifyLiquidity` până la comentariul ramurii următoare): `data` ne-șir e tratat ca date
 * goale, iar `return;` e cerut ÎN ramură. L5 PICĂ dacă oricare delimitator lipsește — niciodată verde pe o secțiune
 * negăsită. L6 verifică garda pe un model sintetic (mutații, cu motivul exact), L7 pe sursa reală fără `return`-ul LIQ.
 * Nu inspectează ramura V4 Swap. Pe baseline (`698c8b4`): `FAILED_IDS: L5` (L6, L7 trec: verifică garda, nu produsul).
 */
import { readFileSync } from "node:fs";
import * as constants from "../src/config/constants";

// ── Literale scrise independent de produs (keccak-256 al semnăturilor din comentarii) ─────────────────────────────
/** `ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)` — Uniswap V4 PoolManager */
const T_MODIFY_LIQUIDITY_V4 = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
/** `DecreaseLiquidity(uint256,uint128,uint256,uint256)` — V3 NonfungiblePositionManager (valoarea veche) */
const T_DECREASE_LIQUIDITY_V3 = "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4";
/** `Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)` — Uniswap V4 PoolManager */
const T_SWAP_V4 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";

const C = constants as unknown as Record<string, unknown>;
const failedIds: string[] = [];
let passed = 0;
function check(id: string, what: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✅ ${id}. ${what}`); }
  else      { if (!failedIds.includes(id)) failedIds.push(id); console.log(`  ❌ ${id}. ${what}${detail ? `\n       ${detail}` : ""}`); }
}

console.log("V4L — topicul V4 ModifyLiquidity");
const topic = C.MODIFY_LIQUIDITY_V4_TOPIC;
check("L1", "MODIFY_LIQUIDITY_V4_TOPIC = keccak-256(ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32))",
  topic === T_MODIFY_LIQUIDITY_V4, `valoarea din produs: ${String(topic)}`);
check("L2", "constanta nu e topicul vechi (DecreaseLiquidity V3 NPM) și nici topicul Swap V4",
  typeof topic === "string" && topic !== T_DECREASE_LIQUIDITY_V3 && topic !== T_SWAP_V4 && C.SWAP_V4_TOPIC === T_SWAP_V4,
  `MODIFY_LIQUIDITY_V4_TOPIC=${String(topic)}, SWAP_V4_TOPIC=${String(C.SWAP_V4_TOPIC)}`);

const subs = readFileSync(new URL("../src/ws/subscriptions.ts", import.meta.url), "utf8");
const mgr  = readFileSync(new URL("../src/ws/manager.ts", import.meta.url), "utf8");
check("L3", "gardă de sursă: filtrul V4 păstrează forma topics: [[SWAP_V4_TOPIC, MODIFY_LIQUIDITY_V4_TOPIC], poolIds], pe PoolManager",
  /\{\s*address:\s*poolManager,\s*topics:\s*\[\[SWAP_V4_TOPIC,\s*MODIFY_LIQUIDITY_V4_TOPIC\],\s*poolIds\]\s*\}/.test(subs)
    && !subs.includes(T_DECREASE_LIQUIDITY_V3) && !subs.includes(T_MODIFY_LIQUIDITY_V4));
check("L4", "gardă de sursă: manager.ts mapează constanta la \"v4\", iar ramura [V4 LIQ] există neschimbată (doar linia diagnostică)",
  /\[MODIFY_LIQUIDITY_V4_TOPIC\]:\s*"v4"/.test(mgr)
    && /topics\?\.\[0\] === MODIFY_LIQUIDITY_V4_TOPIC && msg\.params\?\.result\?\.address\?\.toLowerCase\(\) === V4_POOL_MANAGERS\[chain\.id\]\?\.toLowerCase\(\)/.test(mgr)
    && mgr.includes("console.log(`[V4 LIQ] ${mem4?.symbol ?? poolId} len=${raw4.length} data=${raw4.slice(0, 192)} tx=${log4.transactionHash}`);")
    && !mgr.includes(T_DECREASE_LIQUIDITY_V3) && !mgr.includes(T_MODIFY_LIQUIDITY_V4));

// ── L5–L7 (V4LR): garda ramurii LIQ, cu delimitatori obligatorii la AMBELE capete ────────────────────────────────
// Secțiunea începe la comentariul `// ── V4 ModifyLiquidity` (exact o apariție) și se termină la comentariul URMĂTOAREI
// ramuri (`// ── `, ex. `// ── V3 Swap`). `return;` e cerut ÎN interiorul secțiunii, după linia `raw4` — garda nu poate
// împrumuta `return`-ul altei ramuri (cgpt P2). Lipsa oricărui delimitator → eșec, niciodată verde.
const LIQ_START = "// ── V4 ModifyLiquidity";
const NEXT_BRANCH = "// ── ";
const LIQ_RAW4 = 'const raw4   = typeof log4.data === "string" ? log4.data.slice(2) : "";';
function liqSection(src: string): { section: string | null; why: string } {
  const starts = src.split(LIQ_START).length - 1;
  if (starts !== 1) return { section: null, why: `comentariul de început al ramurii LIQ apare de ${starts} ori (se cere 1)` };
  const start = src.indexOf(LIQ_START);
  const next = src.indexOf(NEXT_BRANCH, start + LIQ_START.length);
  if (next < 0) return { section: null, why: "delimitatorul de sfârșit (comentariul ramurii următoare) lipsește" };
  return { section: src.slice(start, next), why: "" };
}
function liqGuard(src: string): { ok: boolean; why: string } {
  const { section, why } = liqSection(src);
  if (section === null) return { ok: false, why };
  const raw = section.indexOf(LIQ_RAW4);
  if (raw < 0) return { ok: false, why: "linia `raw4` cu gardă de tip lipsește din ramura LIQ" };
  if (section.includes("log4.data?.slice")) return { ok: false, why: "ramura LIQ conține `log4.data?.slice`" };
  if (section.indexOf("return;", raw) < 0) return { ok: false, why: "`return;` lipsește din ramura LIQ (după linia `raw4`)" };
  return { ok: true, why: "" };
}
const g5 = liqGuard(mgr);
check("L5", "gardă de sursă (ramura [V4 LIQ], delimitată la ambele capete): `data` ne-șir → date goale; `return;` în ramură; fără `log4.data?.slice`",
  g5.ok, g5.why);

// L6: garda pe un model SINTETIC al structurii (independent de produs): trece pe forma corectă și pică pe fiecare
// mutație, cu motivul exact — inclusiv eliminarea DOAR a `return`-ului LIQ, cu `return`-ul ramurii V3 păstrat.
const TPL = [
  "      // ── V4 ModifyLiquidity (investigating layout) ─────",
  "      if (liq) {",
  `        ${LIQ_RAW4}`,
  "        console.log(`[V4 LIQ] ...`);",
  "        return;",
  "      }",
  "",
  "      // ── V3 Swap: Uniswap V3 și PancakeSwap V3 (BETA-1 / T1) ─────",
  "      if (v3) {",
  "        return;",
  "      }",
].join("\n");
const LIQ_RETURN = "        console.log(`[V4 LIQ] ...`);\n        return;";
const mutations: Array<[string, string, string]> = [
  ["fără return LIQ (return V3 păstrat)", TPL.replace(LIQ_RETURN, "        console.log(`[V4 LIQ] ...`);"), "`return;` lipsește din ramura LIQ (după linia `raw4`)"],
  ["fără comentariul de început", TPL.replace(LIQ_START, "// V4"), "comentariul de început al ramurii LIQ apare de 0 ori (se cere 1)"],
  ["comentariul de început dublat", TPL + "\n" + LIQ_START, "comentariul de început al ramurii LIQ apare de 2 ori (se cere 1)"],
  ["fără ramura următoare", TPL.replace("// ── V3 Swap", "// V3 Swap"), "delimitatorul de sfârșit (comentariul ramurii următoare) lipsește"],
  ["forma veche a lui raw4", TPL.replace(LIQ_RAW4, 'const raw4   = log4.data?.slice(2) ?? "";'), "linia `raw4` cu gardă de tip lipsește din ramura LIQ"],
  ["`log4.data?.slice` în plus în ramură", TPL.replace("      if (liq) {", "      if (liq) { void log4.data?.slice;"), "ramura LIQ conține `log4.data?.slice`"],
];
const tplOk = liqGuard(TPL).ok && TPL.split("return;").length - 1 === 2;
const badMut = mutations.filter(([, src, why]) => { const g = liqGuard(src); return g.ok || g.why !== why; }).map(([n]) => n);
check("L6", "garda pe modelul sintetic: trece pe forma corectă, pică pe fiecare mutație cu motivul exact (inclusiv fără return LIQ, cu return V3 păstrat)",
  tplOk && badMut.length === 0 && mutations[0][1].split("return;").length - 1 === 1, `model corect acceptat: ${tplOk}; mutații greșit tratate: ${badMut.join(", ")}`);

// L7: regresia pe sursa REALĂ — elimină DOAR `return`-ul din ramura LIQ (toate celelalte `return;` din fișier rămân);
// garda trebuie să pice. Mutația trebuie să se fi aplicat efectiv: secțiunea LIQ găsită, cu exact un `return;`.
const sec = liqSection(mgr).section;
const returnsInSec = sec === null ? -1 : sec.split("return;").length - 1;
const mutated = sec !== null && returnsInSec === 1 ? mgr.replace(sec, sec.replace("return;", "")) : null;
const fileReturns = (t: string): number => t.split("return;").length - 1;
check("L7", "regresie pe manager.ts: fără `return`-ul LIQ (celelalte păstrate) → garda pică",
  mutated !== null && fileReturns(mutated) === fileReturns(mgr) - 1 && !liqGuard(mutated).ok,
  `secțiune LIQ găsită: ${sec !== null}; return; în secțiune: ${returnsInSec}`);

const ALL = ["L1", "L2", "L3", "L4", "L5", "L6", "L7"];
console.log(`\n${passed} passed, ${failedIds.length} failed (cazuri: ${ALL.length})`);
console.log(`FAILED_IDS: ${failedIds.join(",")}`);
if (failedIds.length > 0) process.exit(1);
