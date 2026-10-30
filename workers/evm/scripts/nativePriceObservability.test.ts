import assert from "node:assert/strict";
import { getNativePriceStatus, __setNativePriceForTest, __getNativeStateForTest, refreshNativePrices, NATIVE_PRICE_MAX_AGE_MS } from "../src/infra/nativePrice";
import { getQuoteFlowAsEth } from "../src/ws/quoteFlow";
import { nextNoPriceState, recordNoPriceDrop, getDroppedNoPrice } from "../src/infra/noPrice";
import { createReconnectManager } from "../src/ws/wsBackoff";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { queueWorkerRuntime } from "../src/pipeline/workerRuntime";
import type { ChainConfig } from "../src/config/chains";

let passed = 0;
function check(name: string, run: () => void): void { run(); passed++; console.log("  OK " + name); }
const now = 1_800_000_000_000;
check("S1 never fetched", () => {
  __setNativePriceForTest("ETH", null, null);
  assert.deepEqual(getNativePriceStatus("ETH", now), { value: null, ageSec: null, sourceAgeSec: null });
});
check("S2 local TTL inclusive, source age not a new TTL", () => {
  __setNativePriceForTest("ETH", 2500, now - NATIVE_PRICE_MAX_AGE_MS);
  assert.equal(getNativePriceStatus("ETH", now).value, 2500);
  assert.equal(getNativePriceStatus("ETH", now + 1).value, null);
});
check("S3 invalid value and future/nonfinite local timestamps", () => {
  for (const value of [0, -1, NaN, Infinity]) { __setNativePriceForTest("ETH", value, now); assert.equal(getNativePriceStatus("ETH", now).value, null); }
  for (const at of [now + 1, NaN, Infinity]) { __setNativePriceForTest("ETH", 2500, at); const s = getNativePriceStatus("ETH", now); assert.equal(s.value, null); assert.equal(s.ageSec, null); }
});
check("S4 rate limit: first, burst, exact boundary; immutable input", () => {
  const initial = { total: 0, lastLoggedAt: null };
  const a = nextNoPriceState(initial, 0); assert.equal(a.emit, true);
  const b = nextNoPriceState(a.state, 59_999); assert.equal(b.emit, false); assert.equal(b.state.total, 2);
  const c = nextNoPriceState(b.state, 60_000); assert.equal(c.emit, true); assert.equal(c.state.total, 3);
  assert.deepEqual(initial, { total: 0, lastLoggedAt: null });
});
check("S5 per-chain counters, exact cumulative line", () => {
  const lines: string[] = []; const log = (s: string) => { lines.push(s); };
  recordNoPriceDrop("base", 0, log); recordNoPriceDrop("base", 1, log); recordNoPriceDrop("arbitrum", 1, log);
  assert.deepEqual(lines, ["[NO PRICE base] mesaje swap refuzate fără preț nativ: total=1", "[NO PRICE arbitrum] mesaje swap refuzate fără preț nativ: total=1"]);
  assert.equal(getDroppedNoPrice("base"), 2); assert.equal(getDroppedNoPrice("arbitrum"), 1); assert.equal(getDroppedNoPrice("bsc"), 0);
});
const chain: ChainConfig = { id: "base", gecko: "base", wsUrl: "", weth: "0x4200000000000000000000000000000000000006", usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
const token = "0xffffffffffffffffffffffffffffffffffffffff";
check("S6 no-quote precedes no-price; valid success shape unchanged", () => {
  __setNativePriceForTest("ETH", null);
  assert.equal(getQuoteFlowAsEth(chain, token, chain.weth, 10n ** 18n, -1n).reason, "no-price");
  assert.equal(getQuoteFlowAsEth(chain, token, "0x1111111111111111111111111111111111111111", 1n, -1n).reason, "no-quote");
  __setNativePriceForTest("ETH", 2500);
  assert.deepEqual(getQuoteFlowAsEth(chain, token, chain.weth, 10n ** 18n, -1n), { ok: true, ethAmount: 1, usdAmount: 2500, isBuy: true, quote: "WETH" });
});
check("S7 actual publisher: same timestamp, ETH shared, BNB isolated, counters chain-scoped", () => {
  __setNativePriceForTest("ETH", 2500, now - 2500); __setNativePriceForTest("BNB", 600, now);
  const rows: Array<{ key: string; raw: string; ttl: number }> = [];
  const sink = { set(key: string, raw: string, mode: "EX", ttl: number) { assert.equal(mode, "EX"); rows.push({ key, raw, ttl }); } };
  for (const id of ["base", "arbitrum", "bsc"] as const) queueWorkerRuntime(sink, { chain: id, wsConnected: true, updatedAt: now }, 120);
  const payloads = rows.map(r => JSON.parse(r.raw));
  assert.equal(payloads[0].nativePrice.value, 2500); assert.equal(payloads[1].nativePrice.value, 2500); assert.equal(payloads[2].nativePrice.value, 600);
  assert.equal(payloads[0].nativePrice.ageSec, 2); assert.equal(payloads[0].nativePrice.observedAt, now);
  assert.equal(payloads[0].nativePrice.droppedNoPrice, 2); assert.equal(payloads[1].nativePrice.droppedNoPrice, 1);
  assert.equal(payloads[2].nativePrice.symbol, "BNB"); assert(rows.every(r => r.ttl === 120));
});
async function main(): Promise<void> {
  const before = __getNativeStateForTest("ETH");
  const badFetch: typeof fetch = async () => new Response(JSON.stringify({ result: "0x" }), { status: 200 });
  await refreshNativePrices({ env: { ALCHEMY_BASE_RPC: "https://base.example" }, fetchImpl: badFetch, now: now + 1000 });
  check("S8 failed refresh keeps accepted timestamps", () => assert.deepEqual(__getNativeStateForTest("ETH"), before));
  const oracle = now - 13_000;
  const word = (n: bigint) => n.toString(16).padStart(64, "0");
  const data = "0x" + [1n, 2500n * 100_000_000n, 0n, BigInt(oracle / 1000), 1n].map(word).join("");
  const freshFetch: typeof fetch = async () => new Response(JSON.stringify({ result: data }), { status: 200 });
  await refreshNativePrices({ env: { ALCHEMY_BASE_RPC: "https://base.example" }, fetchImpl: freshFetch, now });
  check("S9 fetch age differs from oracle age", () => assert.deepEqual(getNativePriceStatus("ETH", now + 1500), { value: 2500, ageSec: 1, sourceAgeSec: 14 }));
  const futureData = "0x" + [1n, 2500n * 100_000_000n, 0n, BigInt((now + 1000) / 1000), 1n].map(word).join("");
  await refreshNativePrices({ env: { ALCHEMY_BASE_RPC: "https://base.example" }, fetchImpl: async () => new Response(JSON.stringify({ result: futureData })), now });
  check("S10 tolerated oracle skew does not become age zero", () => { const s = getNativePriceStatus("ETH", now); assert.equal(s.value, 2500); assert.equal(s.sourceAgeSec, null); });

  // rev2 (cgpt P2): getter-ul NU revalidează heartbeat-ul sursei. Fetch Base ACCEPTAT cu oracle vechi de 20 min
  // (sub limita Base de 25 min LA FETCH), citit după încă 6 min: vârsta sursei e 26 min — peste limita de fetch —
  // dar valoarea se păstrează, pentru că singura regulă la citire e TTL-ul LOCAL (6 min < 15 min).
  const t0 = now + 10 * 60_000;
  const oldOracle = t0 - 20 * 60_000;
  const oldData = "0x" + [1n, 2500n * 100_000_000n, 0n, BigInt(oldOracle / 1000), 1n].map(word).join("");
  await refreshNativePrices({ env: { ALCHEMY_BASE_RPC: "https://base.example" }, fetchImpl: async () => new Response(JSON.stringify({ result: oldData })), now: t0 });
  check("S11 no source TTL in getter: accepted 20min-old oracle read 6min later keeps value", () =>
    assert.deepEqual(getNativePriceStatus("ETH", t0 + 6 * 60_000), { value: 2500, ageSec: 360, sourceAgeSec: 1560 }));

  // rev2 (cgpt P2): reconnect-ul NU resetează totalul. Mecanismul REAL de reconnect (wsBackoff, exact cel pe care
  // manager.ts îl folosește la on("close")) e pilotat cu timer injectat; contorul REAL e scris înainte și după.
  check("S12 reconnect preserves total and rate limit", () => {
    const lines: string[] = []; const log = (l: string) => { lines.push(l); };
    const chainId = "reconnect-proof";
    let timer: (() => void) | null = null;
    const mgr = createReconnectManager({
      connect: () => { recordNoPriceDrop(chainId, 10_000, log); },   // primul swap fără preț DUPĂ reconectare
      config: { baseMs: 1_000, capMs: 30_000, jitterRatio: 0 }, stableMs: 60_000,
      setTimer: (fn) => { timer = fn as () => void; return 1; }, clearTimer: () => { timer = null; }, rand: () => 0,
    });
    recordNoPriceDrop(chainId, 0, log); recordNoPriceDrop(chainId, 5_000, log); // două refuzuri înainte de „close"
    mgr.handleClose(chainId);                                                    // exact calea din manager.ts on("close")
    assert.equal(getDroppedNoPrice(chainId), 2);                                 // close-ul nu atinge contorul
    assert(timer !== null); (timer as unknown as () => void)();                  // reconnect-ul firează → connect → al 3-lea refuz
    assert.equal(getDroppedNoPrice(chainId), 3);                                 // totalul CONTINUĂ peste reconnect
    assert.deepEqual(lines, ["[NO PRICE " + chainId + "] mesaje swap refuzate fără preț nativ: total=1"]); // rate-limit intact (10s < 60s)
  });

  // rev2 (cgpt P2): structural — nu EXISTĂ o cale de reset în src/. Modulul nu exportă reset/clear, starea e privată,
  // iar singurele fișiere din src/ care ating modulul sunt manager.ts (scrie) și workerRuntime.ts (citește).
  check("S13 no reset path exists in src/", () => {
    const noPriceSrc = readFileSync("src/infra/noPrice.ts", "utf8");
    assert(!/export[^\n]*(reset|clear|delete)/i.test(noPriceSrc), "modulul exportă un reset");
    assert(!noPriceSrc.includes("export const byChain"), "starea e exportată");
    const refs: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith(".ts") || p.endsWith("infra/noPrice.ts")) continue;
        if (readFileSync(p, "utf8").includes("infra/noPrice")) refs.push(p.replace(/\\/g, "/"));
      }
    };
    walk("src");
    assert.deepEqual(refs.sort(), ["src/pipeline/workerRuntime.ts", "src/ws/manager.ts"]);
    assert(/import \{ recordNoPriceDrop \} from "\.\.\/infra\/noPrice"/.test(readFileSync("src/ws/manager.ts", "utf8")));
    assert(readFileSync("src/pipeline/workerRuntime.ts", "utf8").includes("getDroppedNoPrice"));
  });
  console.log(passed + " passed, 0 failed (P1 core)");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
