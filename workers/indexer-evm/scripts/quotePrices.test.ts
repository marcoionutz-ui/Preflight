/**
 * scripts/quotePrices.test.ts — U3 (Chainlink freshness + NF5 sequencer + depeg).
 *
 * PUR: decodarea `latestRoundData` + guard-urile freshness/sequencer/per-feed-staleness (import type Redis
 * strip-uit de tsx). INTEGRARE (RPC mock + Redis mock): sequencer gate ÎNAINTE de cache, depeg prins, feed
 * stale/down → UNKNOWN (nu $1), routing la cele 5 feed-uri noi, staleness specific feed-ului.
 */
import {
  decodeLatestRoundData, isChainlinkPriceFresh, isSequencerUp, feedMaxStaleSec,
  getQuotePrice, getQuotePriceResult, type ChainlinkRoundData,
} from "../src/infra/quotePrices";
import type { Redis } from "ioredis";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

function word(v: bigint): string {
  const n = v < 0n ? (1n << 256n) + v : v;
  return n.toString(16).padStart(64, "0");
}
function encodeRound(r: ChainlinkRoundData): string {
  return "0x" + [r.roundId, r.answer, r.startedAt, r.updatedAt, r.answeredInRound].map(word).join("");
}

const NOW_SEC = 1_000_000;
const NOW_MS  = NOW_SEC * 1000;
const round = (over: Partial<ChainlinkRoundData> = {}): ChainlinkRoundData => ({
  roundId: 100n, answer: 300_000_000n, startedAt: BigInt(NOW_SEC - 200),
  updatedAt: BigInt(NOW_SEC - 100), answeredInRound: 100n, ...over,
});

// ── RPC mock (rutează eth_call după `to`, capturează adresele interogate) ─────────────────────────────
let ROUTES: Record<string, ChainlinkRoundData | "error"> = {};
let QUERIED: string[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, opts: { body: string }) => {
  const body = JSON.parse(opts.body) as { params: [{ to: string }, string] };
  const to = String(body.params[0].to).toLowerCase();
  QUERIED.push(to);
  const entry = ROUTES[to];
  if (!entry || entry === "error") return { ok: true, json: async () => ({ error: { message: "no feed" } }) };
  return { ok: true, json: async () => ({ result: encodeRound(entry) }) };
};

// Redis mock (doar get/set) pentru testul cache + sequencer down
class MockRedis {
  store = new Map<string, string>();
  async get(k: string): Promise<string | null> { return this.store.get(k) ?? null; }
  async set(k: string, v: string, ..._rest: unknown[]): Promise<"OK"> { this.store.set(k, v); return "OK"; }
}

// Feeds (lowercase)
const F_BASE_ETH = "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70";
const F_BASE_SEQ = "0xbcf85224fc0756b9fa45aa7892530b47e10b6433";
const F_ARB_SEQ  = "0xfdb631f5ee196f0ed6faa767959853a9f217697d";
const F_ETH_USDC = "0x8fffffd4afb6115b954bd326cbe7b4ba576818f6";
const F_BASE_DAI = "0x591e79239a7d679378ec8c847e5038150364c78f";
const F_ARB_USDC = "0x50834f3163758fcc1df9973b6e91f0f0f0434ad3";
const F_ARB_USDT = "0x3f3f5df88dc9f13eac63df89ec16ef6e7e25dde7";
const F_ARB_DAI  = "0xc5c8e77b397e531b8ec06bfb0048328b30e9ecfb";
const F_BSC_USDC = "0x51597f405303c4377e36123cbc172b13269ea163";
const F_BNB      = "0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee"; // BNB/USD bsc
// Tokens
const T_WETH_BASE = "0x4200000000000000000000000000000000000006";
const T_USDC_ETH  = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const T_DAI_BASE  = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
const T_USDC_ARB  = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const T_USDT_ARB  = "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9";
const T_DAI_ARB   = "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1";
const T_USDC_BSC  = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
const T_WBNB      = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

async function integration(): Promise<void> {
  const nowSec  = Math.floor(Date.now() / 1000);
  const fresh   = (answer: bigint): ChainlinkRoundData => ({ roundId: 10n, answer, startedAt: BigInt(nowSec - 100), updatedAt: BigInt(nowSec - 50), answeredInRound: 10n });
  const staleAt = (answer: bigint, ageSec: number): ChainlinkRoundData => ({ roundId: 10n, answer, startedAt: BigInt(nowSec - ageSec), updatedAt: BigInt(nowSec - ageSec), answeredInRound: 10n });
  const seqUp   = (): ChainlinkRoundData => ({ roundId: 1n, answer: 0n, startedAt: BigInt(nowSec - 7200), updatedAt: BigInt(nowSec - 7200), answeredInRound: 1n });
  const seqDown = (): ChainlinkRoundData => ({ roundId: 1n, answer: 1n, startedAt: BigInt(nowSec - 7200), updatedAt: BigInt(nowSec - 7200), answeredInRound: 1n });
  const rpc = "http://rpc";

  // A. ETH/base: sequencer up + feed fresh → CHAINLINK, updatedAt = ORACLE
  ROUTES = { [F_BASE_SEQ]: seqUp(), [F_BASE_ETH]: fresh(3000_00000000n) };
  const a = await getQuotePriceResult(T_WETH_BASE, "base", rpc, null);
  check("I1. ETH/base: sequencer up + feed fresh → CHAINLINK $3000, updatedAt=oracle",
    !!a && a.source === "CHAINLINK" && a.price === 3000 && a.updatedAt === (nowSec - 50) * 1000);

  // B. ETH/base: sequencer JOS → refuză CHAINLINK; fără env → null (NF5)
  ROUTES = { [F_BASE_SEQ]: seqDown(), [F_BASE_ETH]: fresh(3000_00000000n) };
  const b = await getQuotePriceResult(T_WETH_BASE, "base", rpc, null);
  check("I2. ETH/base: sequencer JOS → refuză CHAINLINK → null (NF5)", b === null);

  // C. DEPEG prins: USDC/eth feed la $0.90 → CHAINLINK 0.90 (nu $1)
  ROUTES = { [F_ETH_USDC]: fresh(90_000000n) };
  const c = await getQuotePriceResult(T_USDC_ETH, "ethereum", rpc, null);
  check("I3. stable USDC/eth: feed $0.90 → DEPEG prins (CHAINLINK 0.90, nu $1)",
    !!c && c.source === "CHAINLINK" && Math.abs(c.price - 0.90) < 1e-9);

  // ── BLOCKER 3: stable cu feed configurat + preț de neîncredere → null (UNKNOWN), NU $1 ──────────────
  ROUTES = { [F_ETH_USDC]: fresh(0n) }; // answer 0 = nevalid
  check("I4. stable feed NEVALID → null (UNKNOWN), NU $1",
    (await getQuotePriceResult(T_USDC_ETH, "ethereum", rpc, null)) === null);
  ROUTES = { [F_ETH_USDC]: "error" }; // RPC error
  check("I5. stable feed RPC ERROR → null (UNKNOWN), NU $1",
    (await getQuotePriceResult(T_USDC_ETH, "ethereum", rpc, null)) === null);
  ROUTES = { [F_BASE_SEQ]: seqDown(), [F_BASE_DAI]: fresh(1_00000000n) }; // sequencer down pe base
  check("I6. stable/base cu sequencer DOWN → null (UNKNOWN), NU $1",
    (await getQuotePriceResult(T_DAI_BASE, "base", rpc, null)) === null);

  // ── BLOCKER 1: price cache prezent + sequencer down → NU returnează CHAINLINK ───────────────────────
  const mock = new MockRedis() as unknown as Redis;
  ROUTES = { [F_BASE_SEQ]: seqUp(), [F_BASE_ETH]: fresh(3000_00000000n) };
  const warm = await getQuotePriceResult(T_WETH_BASE, "base", rpc, mock); // populează cache
  ROUTES = { [F_BASE_SEQ]: seqDown(), [F_BASE_ETH]: fresh(3000_00000000n) };
  const cold = await getQuotePriceResult(T_WETH_BASE, "base", rpc, mock); // cache prezent, dar sequencer jos
  check("I7. cache prezent + sequencer down → gate ÎNAINTE de cache → null (NU CHAINLINK cached)",
    !!warm && warm.source === "CHAINLINK" && cold === null);

  // ── cele 5 feed-uri NOI → routing la adresa corectă ────────────────────────────────────────────────
  const routed = async (token: string, chain: string, seqFeed: string | null, priceFeed: string): Promise<boolean> => {
    ROUTES = { [priceFeed]: fresh(1_00000000n) };
    if (seqFeed) ROUTES[seqFeed] = seqUp();
    QUERIED = [];
    const res = await getQuotePriceResult(token, chain, rpc, null);
    return !!res && res.source === "CHAINLINK" && QUERIED.includes(priceFeed);
  };
  check("I8. routing base DAI → 0x591e…c78f",     await routed(T_DAI_BASE, "base", F_BASE_SEQ, F_BASE_DAI));
  check("I9. routing arbitrum USDC → 0x5083…4ad3", await routed(T_USDC_ARB, "arbitrum", F_ARB_SEQ, F_ARB_USDC));
  check("I10. routing arbitrum USDT → 0x3f3f…dde7", await routed(T_USDT_ARB, "arbitrum", F_ARB_SEQ, F_ARB_USDT));
  check("I11. routing arbitrum DAI → 0xc5c8…ecfb",  await routed(T_DAI_ARB, "arbitrum", F_ARB_SEQ, F_ARB_DAI));
  check("I12. routing bsc USDC → 0x5159…a163",      await routed(T_USDC_BSC, "bsc", null, F_BSC_USDC));

  // ── staleness SPECIFIC feed-ului (native): BNB/bsc (limită 33s) respinge age 100s; același age pe eth USDC
  //    (limită 99360s) e acceptat → dovedește limita per-feed, NU un backstop global uniform.
  ROUTES = { [F_BNB]: staleAt(1000_00000000n, 100) }; // 100s > 33 (bsc BNB per-feed)
  check("I13. NATIVE BNB/bsc age 100s > limita per-feed (33s) → null (staleness specific per feed)",
    (await getQuotePriceResult(T_WBNB, "bsc", rpc, null)) === null);
  ROUTES = { [F_ETH_USDC]: staleAt(1_00000000n, 100) }; // 100s < 99360 (eth USDC)
  const ethOk = await getQuotePriceResult(T_USDC_ETH, "ethereum", rpc, null);
  check("I14. USDC/eth age 100s < limita (99360s) → CHAINLINK (aceeași vârstă, feed diferit)",
    !!ethOk && ethOk.source === "CHAINLINK");
}

async function main(): Promise<void> {
  console.log("U3 — quotePrices (Chainlink freshness + sequencer NF5 + depeg)");

  // ── decodeLatestRoundData ──────────────────────────────────────────────────
  const r0 = round({ roundId: 42n, answer: 250_000_000n, startedAt: 111n, updatedAt: 222n, answeredInRound: 43n });
  const d0 = decodeLatestRoundData(encodeRound(r0));
  check("1. decode: cele 5 câmpuri recuperate corect",
    !!d0 && d0.roundId === 42n && d0.answer === 250_000_000n && d0.startedAt === 111n && d0.updatedAt === 222n && d0.answeredInRound === 43n);
  const dNeg = decodeLatestRoundData(encodeRound(round({ answer: -12345n })));
  check("2. decode: answer negativ (int256 sign-extend) -> negativ", !!dNeg && dNeg.answer === -12345n);
  check("3. decode: '0x' -> null", decodeLatestRoundData("0x") === null);
  check("4. decode: hex prea scurt -> null", decodeLatestRoundData("0x" + "00".repeat(32)) === null);
  check("5. decode: string gol -> null", decodeLatestRoundData("") === null);

  // ── isChainlinkPriceFresh ──────────────────────────────────────────────────
  check("6. fresh: round valid recent -> true", isChainlinkPriceFresh(round(), NOW_MS, 86_400) === true);
  check("7. fresh: answer 0 -> false", isChainlinkPriceFresh(round({ answer: 0n }), NOW_MS, 86_400) === false);
  check("8. fresh: answer negativ -> false", isChainlinkPriceFresh(round({ answer: -1n }), NOW_MS, 86_400) === false);
  check("9. fresh: answeredInRound < roundId -> false (carried-over stale)",
    isChainlinkPriceFresh(round({ roundId: 100n, answeredInRound: 99n }), NOW_MS, 86_400) === false);
  check("10. fresh: updatedAt 0 -> false (round incomplet)", isChainlinkPriceFresh(round({ updatedAt: 0n }), NOW_MS, 86_400) === false);
  check("11. fresh: age peste backstop -> false", isChainlinkPriceFresh(round({ updatedAt: BigInt(NOW_SEC - 90_000) }), NOW_MS, 86_400) === false);
  check("12. fresh: updatedAt în viitor (age<0) -> false", isChainlinkPriceFresh(round({ updatedAt: BigInt(NOW_SEC + 500) }), NOW_MS, 86_400) === false);
  check("13. fresh: age exact la limită (== maxStale) -> true", isChainlinkPriceFresh(round({ updatedAt: BigInt(NOW_SEC - 86_400) }), NOW_MS, 86_400) === true);

  // ── isSequencerUp (NF5) ────────────────────────────────────────────────────
  check("14. sequencer: up (0) + trecut de grace -> true", isSequencerUp(round({ answer: 0n, startedAt: BigInt(NOW_SEC - 7200) }), NOW_MS, 3600) === true);
  check("15. sequencer: down (1) -> false", isSequencerUp(round({ answer: 1n, startedAt: BigInt(NOW_SEC - 7200) }), NOW_MS, 3600) === false);
  check("16. sequencer: up dar în grace (1800<3600) -> false", isSequencerUp(round({ answer: 0n, startedAt: BigInt(NOW_SEC - 1800) }), NOW_MS, 3600) === false);
  check("17. sequencer: startedAt în viitor -> false", isSequencerUp(round({ answer: 0n, startedAt: BigInt(NOW_SEC + 500) }), NOW_MS, 3600) === false);
  check("18. sequencer: exact la limita grace (==) -> false (strict >)", isSequencerUp(round({ answer: 0n, startedAt: BigInt(NOW_SEC - 3600) }), NOW_MS, 3600) === false);
  check("19. sequencer: startedAt == 0 -> false (feed neinițializat, Arbitrum) [blocker varu]",
    isSequencerUp(round({ answer: 0n, startedAt: 0n }), NOW_MS, 3600) === false);

  // ── feedMaxStaleSec: heartbeat OFICIAL × 1.2, explicit pt. toate categoriile (native fast / native / L2 scurt / stable) ──
  check("20. native BNB/bsc: 27 → 33",              feedMaxStaleSec("bsc", "BNB") === 33);
  check("21. native ETH/ethereum: 3600 → 4320",     feedMaxStaleSec("ethereum", "ETH") === 4320);
  check("22. native ETH/arbitrum: 1755 → 2106",     feedMaxStaleSec("arbitrum", "ETH") === 2106);
  check("23. native ETH/base: 1200 → 1440",         feedMaxStaleSec("base", "ETH") === 1440);
  check("24. L2 scurt arb USDC: 255 → 306",         feedMaxStaleSec("arbitrum", "STABLE_USDC") === 306);
  check("25. L2 scurt arb USDT: 255 → 306",         feedMaxStaleSec("arbitrum", "STABLE_USDT") === 306);
  check("26. stable bsc USDT/USDC/BUSD: 900 → 1080", feedMaxStaleSec("bsc", "STABLE_USDT") === 1080 && feedMaxStaleSec("bsc", "STABLE_USDC") === 1080 && feedMaxStaleSec("bsc", "STABLE_BUSD") === 1080);
  check("27. eth USDC (oficial 82800 ≠ 86400): → 99360", feedMaxStaleSec("ethereum", "STABLE_USDC") === 99360);
  check("28. eth USDT: 86400 → 103680",             feedMaxStaleSec("ethereum", "STABLE_USDT") === 103680);
  check("29. eth DAI: 3600 → 4320",                 feedMaxStaleSec("ethereum", "STABLE_DAI") === 4320);
  check("30. base USDC/DAI: 86400 → 103680",        feedMaxStaleSec("base", "STABLE_USDC") === 103680 && feedMaxStaleSec("base", "STABLE_DAI") === 103680);
  check("31. arbitrum DAI: 86400 → 103680",         feedMaxStaleSec("arbitrum", "STABLE_DAI") === 103680);
  check("32. feed necunoscut → backstop global 86400", feedMaxStaleSec("ethereum", "STABLE_BUSD") === 86_400);
  process.env.INDEXER_FEED_MAX_STALE_ARBITRUM_STABLE_USDC = "999";
  check("33. env override are prioritate → 999",    feedMaxStaleSec("arbitrum", "STABLE_USDC") === 999);
  delete process.env.INDEXER_FEED_MAX_STALE_ARBITRUM_STABLE_USDC;

  // ── BOUNDARY per feed pt. TOATE cele 15 intrări: age == maxStale ACCEPTĂ, maxStale+1 RESPINGE ──────────
  const FEEDS: Array<[string, string]> = [
    ["ethereum", "ETH"], ["ethereum", "STABLE_USDC"], ["ethereum", "STABLE_USDT"], ["ethereum", "STABLE_DAI"],
    ["base", "ETH"], ["base", "STABLE_USDC"], ["base", "STABLE_DAI"],
    ["arbitrum", "ETH"], ["arbitrum", "STABLE_USDC"], ["arbitrum", "STABLE_USDT"], ["arbitrum", "STABLE_DAI"],
    ["bsc", "BNB"], ["bsc", "STABLE_USDT"], ["bsc", "STABLE_USDC"], ["bsc", "STABLE_BUSD"],
  ];
  const atAge = (ms: number, age: number): boolean =>
    isChainlinkPriceFresh(round({ updatedAt: BigInt(NOW_SEC - age) }), NOW_MS, ms);
  let boundaryOk = 0;
  for (const [c, l] of FEEDS) {
    const ms = feedMaxStaleSec(c, l);
    const ok = atAge(ms, ms) === true && atAge(ms, ms + 1) === false;
    check(`B. ${c}/${l}: age==${ms} ACCEPTĂ, ${ms + 1} RESPINGE`, ok);
    if (ok) boundaryOk++;
  }
  check("B*. toate cele 15 feed-uri au boundary corect (maxStale / maxStale+1)", boundaryOk === 15 && FEEDS.length === 15);

  // ── getQuotePrice sync — stables păstrează $1.00 conservator (fără RPC) ─────
  check("34. sync: stable USDC (ethereum) -> 1.0", getQuotePrice("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") === 1.0);
  check("35. sync: stable USDbC (base) -> 1.0", getQuotePrice("0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca") === 1.0);
  check("36. sync: token necunoscut -> null", getQuotePrice("0x000000000000000000000000000000000000dead") === null);

  await integration();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
