/**
 * P1: real V2/V3/V4 dispatch, one isolated process per case; no entrypoint/network services.
 * Price is deliberately absent on MISSING. Refusal is correct; counter and bounded diagnostic are acceptance criteria.
 *
 * rev2 (cgpt P2): POSITIVE also asserts the counter stays 0 on every chain and no [NO PRICE line appears;
 * NOQUOTE proves the no-quote refusal (price absent too) does not count and keeps the true V4 diagnostic;
 * LP-MISSING proves an LP event without price is refused silently without counting. Reconnect preservation
 * is proven at unit level (nativePriceObservability S12/S13): the local node treats a second connection as an
 * anomaly by design, so an in-harness reconnect would be HARNESS_ERROR by doctrine, not a usable proof.
 */
import { runCase, type CaseContext, type CaseBodyResult } from "../harness/caseRuntime";
import { CONTROLS, controlBody } from "./controlDefs";
import { geckoPool, swapV4Log, POOL_V4_ID } from "../harness/evmFixtures";
import { mintV3Log } from "../harness/evmFixturesDefects";
import type { CaseSpec } from "../harness/caseProtocol";

type Body = "positive" | "missing" | "noquote" | "lp";
const choices: Record<string, { control: string; body: Body }> = {};
for (const kind of ["V2", "V3", "V4"]) {
  choices["P1-" + kind + "-POSITIVE"] = { control: "C-" + kind + "-BUY", body: "positive" };
  choices["P1-" + kind + "-MISSING"] = { control: "C-" + kind + "-BUY", body: "missing" };
}
choices["P1-V4-NOQUOTE"] = { control: "C-V4-BUY", body: "noquote" };
choices["P1-V3-LP-MISSING"] = { control: "C-V3-BUY", body: "lp" };
const id = process.env.BETA1_CASE_ID ?? "";
const choice = choices[id];
if (!choice) throw new Error("unknown P1 case: " + id);
const spec: CaseSpec = { id, kind: "control", section: "filter" };

const CHAINS_ALL = ["base", "arbitrum", "ethereum", "bsc"] as const;
const NO_PRICE_LINE_1 = "[NO PRICE base] mesaje swap refuzate fără preț nativ: total=1";

/** Loaded only after runtime guards and the real manager import; this is the same cached counter module. */
async function counters(): Promise<Record<string, number>> {
  const { getDroppedNoPrice } = await import("../../../src/infra/noPrice");
  return Object.fromEntries(CHAINS_ALL.map(c => [c, getDroppedNoPrice(c)]));
}

/** POSITIVE: the stock control body, plus proof the priced path never touches the counter or its log. */
async function positive(ctx: CaseContext): Promise<CaseBodyResult> {
  const r = await controlBody(CONTROLS[choice.control], ctx);
  const dropped = await counters();
  const noPriceLines = ctx.cons.lines().filter(l => l.text.includes("[NO PRICE ")).length;
  const reasons = [...r.reasons];
  if (Object.values(dropped).some(n => n !== 0)) reasons.push("contorul no-price a crescut pe un traseu cu preț");
  if (noPriceLines !== 0) reasons.push("linie [NO PRICE] pe un traseu cu preț");
  return {
    outcome: reasons.length > 0 ? "CONTROL_FAILED" : r.outcome, reasons,
    observations: { ...r.observations, droppedNoPrice: dropped, noPriceLines },
  };
}

interface Expect {
  /** Linii cerute EXACT o dată (substring); toate celelalte diagnostice P1 trebuie absente. */
  requiredLine: string | null;
  /** Contorul cerut pe chain-ul cazului (restul chain-urilor: mereu 0). */
  droppedOnChain: number;
  /** Linia [NO PRICE exactă cerută (doar când droppedOnChain > 0). */
  noPriceLine: string | null;
}

/** Trunchi comun: montaj explicit, preț ABSENT, un singur subiect livrat; verdictul din efectele observabile. */
async function refusalBody(
  ctx: CaseContext,
  setup: { raw: unknown; pair: string; kind: "v2" | "v3" | "v4"; admit: "v3" | "v4" | null; dexType: string },
  subject: import("../harness/localNode").RpcLog,
  expect: Expect,
): Promise<CaseBodyResult> {
  const { src, chain } = ctx;
  const st = src.stores;
  const { getDroppedNoPrice } = await import("../../../src/infra/noPrice");
  if (getDroppedNoPrice(chain.id) !== 0) throw new Error("counter not initially empty");
  src.nativePrice.__setNativePriceForTest("ETH", null);
  const pool = src.normalize.normalizePool(setup.raw, chain);
  if (!pool || pool.pairAddress !== setup.pair || pool.dexType !== setup.dexType) throw new Error("bad pool fixture");
  src.memory.updateMemory(pool, pool.priceUsd);
  if (setup.admit === "v3") st.v3PoolMap.set(chain.id, setup.pair, pool);
  if (setup.admit === "v4") st.v4PoolMap.set(chain.id, setup.pair, pool);
  src.transitions.addWatchCandidate(setup.pair, { chain: chain.id, addedAt: Date.now(), kind: "NORMAL" }, pool);
  await ctx.connect();
  await ctx.awaitOpenSubscribes();
  const requests = await ctx.clientBarrier("P1-subscribe");
  if (requests.length !== 1 || requests[0].method !== "eth_subscribe") throw new Error("subscription request not unique");
  await ctx.awaitPromoted(setup.kind, requests[0], setup.pair);
  const delivery = await ctx.deliver([subject], "P1-delivery");
  const sub = delivery.perLog[subject.transactionHash];
  const lines = ctx.cons.lines().map(l => l.text);
  const noPrice = lines.filter(l => l.includes("[NO PRICE "));
  const required = expect.requiredLine === null ? [] : lines.filter(l => l.includes(expect.requiredLine as string));
  const swaps = [...st.wsFlow.values()].reduce((n, a) => n + a.length, 0);
  const lp = [...st.lpEvents.values()].reduce((n, a) => n + a.length, 0);
  const dropped = await counters();
  const reasons: string[] = [];
  if (sub.sent !== 1 || sub.received !== 1) reasons.push("delivery not exactly one subject");
  if (!st.wsLastMessageAtByKind.has(chain.id + ":" + setup.kind)) reasons.push("kind not marked");
  if (dropped[chain.id] !== expect.droppedOnChain) reasons.push(`no-price counter must be exactly ${expect.droppedOnChain}`);
  if (CHAINS_ALL.some(c => c !== chain.id && dropped[c] !== 0)) reasons.push("counter crossed chain boundary");
  if (expect.noPriceLine === null) {
    if (noPrice.length !== 0) reasons.push("no-price diagnostic must be absent on this path");
  } else if (noPrice.length !== 1 || noPrice[0] !== expect.noPriceLine) {
    reasons.push("no-price diagnostic not exact and unique");
  }
  if (expect.requiredLine !== null && required.length !== 1) reasons.push("required diagnostic not exact and unique: " + expect.requiredLine);
  if (swaps !== 0 || lp !== 0) reasons.push("unexpected recorded events");
  if (lines.some(l => /\[V[234] SWAP [^\]]*\]|\b(?:V3 )?LP (?:ADD|REMOVE) [^\]]*\]/.test(l))) reasons.push("unexpected swap/LP line");
  if (expect.requiredLine === null && lines.some(l => l.includes("no WETH/USDC side"))) reasons.push("misleading V4 no-quote diagnostic");
  return {
    outcome: reasons.length ? "CONTROL_FAILED" : "CONTROL_OK", reasons,
    observations: { kind: setup.kind, delivery, droppedNoPrice: dropped, noPrice, swaps, lp, mapAdmission: setup.admit ?? "none" },
  };
}

/** MISSING: swapul controlului, fără preț → refuz + contor exact 1 + exact prima linie [NO PRICE. */
function missingPrice(ctx: CaseContext): Promise<CaseBodyResult> {
  const def = CONTROLS[choice.control];
  return refusalBody(ctx, { raw: def.raw, pair: def.pair, kind: def.kind as "v2" | "v3" | "v4", admit: def.admit, dexType: def.dexType },
    def.swap, { requiredLine: null, droppedOnChain: 1, noPriceLine: NO_PRICE_LINE_1 });
}

/** NOQUOTE: pool V4 cu quote nerecunoscut, preț TOT absent → refuzul e no-quote: diagnosticul V4 adevărat, contor 0. */
function noQuote(ctx: CaseContext): Promise<CaseBodyResult> {
  const ALT = "0x" + "77".repeat(20);
  return refusalBody(ctx,
    { raw: geckoPool(POOL_V4_ID, "uniswap-v4-base", ALT, "ALT"), pair: POOL_V4_ID, kind: "v4", admit: "v4", dexType: "V4" },
    swapV4Log(POOL_V4_ID, { amount0: -(10n ** 18n), amount1: 5n * 10n ** 18n }, 0x7701),
    { requiredLine: "no WETH/USDC side", droppedOnChain: 0, noPriceLine: null });
}

/** LP-MISSING: Mint V3 pe pool admis, fără preț → LP refuzat tăcut, contorul (doar swapuri) rămâne 0. */
function lpMissing(ctx: CaseContext): Promise<CaseBodyResult> {
  const def = CONTROLS[choice.control];
  return refusalBody(ctx, { raw: def.raw, pair: def.pair, kind: "v3", admit: "v3", dexType: def.dexType },
    mintV3Log(def.pair, { amount0: 10n ** 18n, amount1: 5n * 10n ** 18n }, 0x7703),
    { requiredLine: null, droppedOnChain: 0, noPriceLine: null });
}

const bodies: Record<Body, (ctx: CaseContext) => Promise<CaseBodyResult>> = {
  positive, missing: missingPrice, noquote: noQuote, lp: lpMissing,
};
runCase(spec, bodies[choice.body]);
