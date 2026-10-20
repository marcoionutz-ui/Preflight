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

const ALL = ["L1", "L2", "L3", "L4"];
console.log(`\n${passed} passed, ${failedIds.length} failed (cazuri: ${ALL.length})`);
console.log(`FAILED_IDS: ${failedIds.join(",")}`);
if (failedIds.length > 0) process.exit(1);
