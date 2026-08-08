/**
 * lib/mcp/safeParse.test.ts — E8a (Solana) + E8b (EVM/worker) — Zod la granițele de parse Redis.
 *
 * Dovedește că `parseWithSchema` este fail-closed pe TREI căi: (1) raw null/gol → fallback;
 * (2) JSON sintactic invalid → fallback (ca vechiul safeJson); (3) JSON valid dar FORMĂ neconformă
 * → fallback (comportament NOU — safeJson dădea cast oarb). Pe payload valid întoarce datele cu
 * câmpurile necunoscute păstrate (`.passthrough()` = forward-compat).
 *
 * REGRESII ANCORĂ (review varu): Pool/PriceSnapshot/ObservedCandidate NU acceptă `{}` — un obiect gol
 * care altfel ar seta `found=true` în readSolanaPoolContext pică pe câmpurile-ancoră obligatorii.
 * Mover-ele trec prin SolanaMoverSchema: un câmp consumat greșit tipat → snapshot fallback.
 *
 * Import-heavy (zod + schemele) → rulat cu NODE_PATH către zod (nu leaf-pur, dar deterministic).
 * Verificat sub zod 3.25.76 ȘI 4.4.3 (versiunea hoisted în tree via porto).
 */
import { parseWithSchema, mergeChainRecords, mergeChainArrays } from "./safeParse";
import {
  PipelineEventSchema, DropSchema, MomentumEventSchema,
  SignalPipelineEntrySchema, QualifiedSignalSchema, LifecycleEntrySchema,
} from "./schemas/pipeline";
import {
  SolanaHealthSchema, SolanaMoversSnapshotSchema, SolanaPoolSchema,
  SolanaLaunchSchema, SolanaPriceSnapshotSchema, SolanaPoolActivitySchema,
  SolanaPricePointSchema, SolanaObservedCandidateSchema,
} from "./schemas/solana";
import {
  PairStatesRecordSchema, WatchRecordSchema, HotRecordSchema, ArmedRecordSchema,
  WorkerSnapshotSchema, PipelineCoverageSchema, ScannerStatsSchema, WorkerRuntimeSchema,
} from "./schemas/evm";
import {
  MoversArraySchema, QuotePriceSchema, QuotePriceHealthEntrySchema, PairContextSchema,
  resolveValidatedPairContext,
} from "./schemas/reader";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

const FB = { __fallback__: true } as const;

// Payload-uri valide „minime dar reale" (au câmpurile-ancoră) — folosite ca bază pentru mutații.
const VALID_POOL = '{"poolAddress":"Po0l","program":"raydium"}';
const VALID_PRICE = '{"poolAddress":"P","priceInQuote":1.5,"lastUpdatedAt":1700000000000}';
const VALID_CAND = '{"poolAddress":"P","program":"raydium","sampleCount":9,"baseSymbol":null}';

function main(): void {
  console.log("E8a — parseWithSchema (fail-closed) + scheme Solana + ancore anti-`{}`");

  // --- 1. căile fail-closed ale lui parseWithSchema ---------------------------------
  check("1. raw null -> fallback (fără parse)",
    parseWithSchema(null, SolanaPoolSchema, FB) === FB);
  check("2. raw string gol -> fallback",
    parseWithSchema("", SolanaPoolSchema, FB) === FB);
  check("3. JSON sintactic invalid -> fallback",
    parseWithSchema("{not json", SolanaPoolSchema, FB) === FB);
  check("4. * sintaxă OK dar câmp consumat greșit tipat -> fallback",
    parseWithSchema('{"poolAddress":"P","program":123}', SolanaPoolSchema, FB) === FB);
  check("5. * root array -> fallback (nu obiect)",
    parseWithSchema('[1,2,3]', SolanaPoolSchema, FB) === FB);
  check("6. * root primitiv (number) -> fallback",
    parseWithSchema('42', SolanaPoolSchema, FB) === FB);
  check("7. * root JSON null -> fallback",
    parseWithSchema('null', SolanaPoolSchema, FB) === FB);

  const okPool = parseWithSchema<{ program?: string } | typeof FB>(VALID_POOL, SolanaPoolSchema, FB);
  check("8. * payload valid -> date (nu fallback)", okPool !== FB);
  check("9. * câmpul consumat e păstrat", (okPool as any).program === "raydium");
  const withExtra = parseWithSchema<any>(
    '{"poolAddress":"P","program":"orca","futureField":"keep-me"}', SolanaPoolSchema, FB);
  check("10. * passthrough păstrează câmp necunoscut", withExtra.futureField === "keep-me");

  // --- 2. ANCORE: `{}` NU trece prin schemele care setează found=true --------------
  check("11. * Pool `{}` -> fallback (ancoră poolAddress+program)",
    parseWithSchema('{}', SolanaPoolSchema, FB) === FB);
  check("12. * Pool fără poolAddress (doar program) -> fallback",
    parseWithSchema('{"program":"raydium"}', SolanaPoolSchema, FB) === FB);
  check("13. * Pool fără program (doar poolAddress) -> fallback",
    parseWithSchema('{"poolAddress":"P"}', SolanaPoolSchema, FB) === FB);

  check("14. * PriceSnapshot `{}` -> fallback (ancoră poolAddress+priceInQuote+lastUpdatedAt)",
    parseWithSchema('{}', SolanaPriceSnapshotSchema, FB) === FB);
  check("15. * PriceSnapshot fără priceInQuote -> fallback",
    parseWithSchema('{"poolAddress":"P","lastUpdatedAt":1}', SolanaPriceSnapshotSchema, FB) === FB);
  check("16. * PriceSnapshot fără lastUpdatedAt -> fallback",
    parseWithSchema('{"poolAddress":"P","priceInQuote":1.5}', SolanaPriceSnapshotSchema, FB) === FB);

  check("17. * ObservedCandidate `{}` -> fallback (ancoră poolAddress+sampleCount)",
    parseWithSchema('{}', SolanaObservedCandidateSchema, FB) === FB);
  check("18. * ObservedCandidate fără sampleCount -> fallback",
    parseWithSchema('{"poolAddress":"P"}', SolanaObservedCandidateSchema, FB) === FB);

  // Payload-uri VALIDE cu ancorele prezente -> trec (nu fallback) — dovadă că ancora nu dă fals-negativ.
  check("19. Pool valid (ancore prezente) -> date",
    parseWithSchema<any>(VALID_POOL, SolanaPoolSchema, FB) !== FB);
  check("20. PriceSnapshot valid (ancore prezente, priceUsd null) -> date",
    parseWithSchema<any>('{"poolAddress":"P","priceInQuote":1.5,"priceUsd":null,"lastUpdatedAt":1700000000000}',
      SolanaPriceSnapshotSchema, FB) !== FB);
  check("21. ObservedCandidate valid (ancore prezente, baseSymbol null) -> date",
    parseWithSchema<any>(VALID_CAND, SolanaObservedCandidateSchema, FB) !== FB);
  check("22. * PriceSnapshot lastUpdatedAt string (ancoră greșit tipată) -> fallback",
    parseWithSchema('{"poolAddress":"P","priceInQuote":1.5,"lastUpdatedAt":"soon"}', SolanaPriceSnapshotSchema, FB) === FB);

  // --- 3. MOVERS: element validat prin SolanaMoverSchema ---------------------------
  check("23. Movers valid (mover complet) -> date",
    parseWithSchema<any>(
      '{"computedAt":1,"movers":[{"poolAddress":"P","program":"raydium","priceInQuote":2,"sampleCount":5,"currentAgeSec":10,"historyStatus":"READY","knownPool":true}]}',
      SolanaMoversSnapshotSchema, FB) !== FB);
  check("24. Movers cu mover `{}` -> trece (mover n-are ancoră, doar strict-când-prezent)",
    parseWithSchema<any>('{"computedAt":1,"movers":[{}]}', SolanaMoversSnapshotSchema, FB) !== FB);
  check("25. * Movers cu mover priceInQuote greșit tipat (string) -> snapshot fallback",
    parseWithSchema('{"computedAt":1,"movers":[{"priceInQuote":"nope"}]}', SolanaMoversSnapshotSchema, FB) === FB);
  check("26. * Movers cu mover poolAddress greșit tipat (number) -> snapshot fallback",
    parseWithSchema('{"movers":[{"poolAddress":123}]}', SolanaMoversSnapshotSchema, FB) === FB);
  check("27. * Movers cu mover historyStatus invalid -> snapshot fallback",
    parseWithSchema('{"movers":[{"historyStatus":"BOGUS"}]}', SolanaMoversSnapshotSchema, FB) === FB);
  check("28. * Movers movers=string -> fallback (nu array)",
    parseWithSchema('{"movers":"nope"}', SolanaMoversSnapshotSchema, FB) === FB);
  check("29. * Movers element non-obiect -> fallback",
    parseWithSchema('{"movers":[1,2]}', SolanaMoversSnapshotSchema, FB) === FB);

  // --- 4. Health / Launch / Activity / PricePoint (neschimbate de review) ----------
  check("30. Health updatedAt number OK",
    parseWithSchema<any>('{"updatedAt":1700000000000,"status":"OK"}', SolanaHealthSchema, FB) !== FB);
  check("31. Health updatedAt string OK (legacy)",
    parseWithSchema<any>('{"updatedAt":"2026-01-01"}', SolanaHealthSchema, FB) !== FB);
  check("32. * Health updatedAt boolean -> fallback",
    parseWithSchema('{"updatedAt":true}', SolanaHealthSchema, FB) === FB);
  check("33. Health gol {} OK (fără ancoră — health nu setează found)",
    parseWithSchema<any>('{}', SolanaHealthSchema, FB) !== FB);

  check("34. Launch valid OK",
    parseWithSchema<any>('{"symbol":"BONK","bondingCurveAddress":"Bc1"}', SolanaLaunchSchema, FB) !== FB);
  check("35. * Launch symbol=number -> fallback",
    parseWithSchema('{"symbol":7}', SolanaLaunchSchema, FB) === FB);

  check("36. Activity sampledQuoteIn5m string OK (BigInt-as-string)",
    parseWithSchema<any>('{"sampledSwaps5m":3,"sampledQuoteIn5m":"12345678901234567890"}', SolanaPoolActivitySchema, FB) !== FB);
  check("37. * Activity sampledQuoteIn5m number -> fallback (trebuie string)",
    parseWithSchema('{"sampledQuoteIn5m":123}', SolanaPoolActivitySchema, FB) === FB);

  check("38. PricePoint {p,ts} valid OK",
    parseWithSchema<any>('{"p":1.23,"ts":1700000000000}', SolanaPricePointSchema, FB) !== FB);
  check("39. * PricePoint fără p -> fallback (strict)",
    parseWithSchema('{"ts":1700000000000}', SolanaPricePointSchema, FB) === FB);
  check("40. * PricePoint p=string -> fallback",
    parseWithSchema('{"p":"1.23","ts":1}', SolanaPricePointSchema, FB) === FB);

  // --- 5. E8b: scheme EVM/worker cu CONTRACT NESTED COMPLET (review varu Blocker 2+3) ---
  // Payload-uri CANONICE complete (toate câmpurile required din @preflight/schema) pt. mutații.
  const VALID_STATE = JSON.stringify({
    symbol: "AAA", chain: "base", pairAddress: "0xp", tokenAddress: "0xt", dexType: "V3",
    currentPrice: 1.5, priceChange: { m5: 0, h1: 0, h24: 0 },
    phase: "NEW", pipelineState: "NONE", seenCount: 1,
    flow: { pressure: "BUYING", buys5m: 1, sells5m: 0, hasData: true, buyVol5m: 1, sellVol5m: 0, netVol5m: 1, buyVol5mUsd: null, sellVol5mUsd: null, netVol5mUsd: null },
    lp: { status: "STABLE", lpNet5m: 0, hasData: true, lpAdded5m: 0, lpRemoved5m: 0, removedPctOfPool: null },
    reserveUsd: 0, reserveEth: 0, reserveNative: 0, nativeSymbol: "ETH", liqStatus: "WEAK", poolCountSameToken: 1,
    firstSeenAt: null, lastSeenAt: null, pipelineEnteredAt: null, currentStateAgeSec: null, priceVsFirstSeenPct: null,
    hourUtc: 0, updatedAt: 1, lastMomentumVerdict: null, lastMomentumAt: null, attentionScore: null, monitoringTier: null,
    patternTags: null, risk: null,
    discovery: { primaryDiscoverySource: null, discoverySources: [], firstDiscoveredAt: null, lastDiscoveryAt: null },
  });
  const VALID_RISK = JSON.stringify({
    chain: "base", tokenAddress: "0xt", checkedAt: 1, source: "goplus", riskLevel: "LOW", confidence: "HIGH",
    flags: [], summary: "ok", isHoneypot: false, buyTaxPct: 0, sellTaxPct: 0, cannotSell: false, ownerRenounced: true,
    canChangeTax: false, canBlacklist: false, canMint: false, canPauseTrading: false, canChangeBalance: false,
    canTakeBackOwnership: false, tokenAgeMinutes: 10, missingData: [],
  });
  const VALID_MEM = JSON.stringify({
    pairAddress: "0xp", symbol: "AAA", tokenAddress: "0xt", firstSeen: 1, lastSeen: 2, seenCount: 1,
    priceAtFirstSeen: 1, highPrice: 2, lowPrice: 1, currentPrice: 1.5, phase: "NEW",
  });
  const VALID_CHAINCOV = JSON.stringify({
    trackedPairs: 1, observedMovers: 0,
    pipeline: { watching: 0, hot: 0, armed: 0, qualified: 0 },
    ws: { expectedWsSubscriptions: 0, watchingWithFlow: 0, hotWithFlow: 0, armedWithFlow: 0, coverageOnWatchPct: 0, coverageOnPipelinePct: 0 },
    observedMoverCoverage: { total: 0, inPipeline: 0, withFlow: 0, notInPipeline: 0 },
    topMoversNotWatched: [],
  });
  const VALID_GECKO = JSON.stringify({ lastResultCount: 0, emptyStreak: 0, lastFetchAt: 1, last429At: null, consecutiveEmpty: 0, status: "OK" });
  const VALID_DEX   = JSON.stringify({ lastFetchAgeSec: 5, last429AgeSec: null, lastResultCount: 10, status: "OK" });
  const VALID_SCAN  = JSON.stringify({ durationMs: 5, totalFetched: 10, processedPools: 3 });
  const VALID_SRC   = JSON.stringify({ source: "INDEXER_PRIMARY", fallbackUsed: false });
  const VALID_WATCH = JSON.stringify({ chain: "base", addedAt: 1, ageMs: 0, kind: "NEW", entryPrice: null, reason: null, symbol: null, phase: null, priceVsEntryPct: null, flowAgeMs: null, largestBuyEth: 0, avgBuyEth: 0, buySwapCount5m: 0, sellSwapCount5m: 0 });
  const VALID_HOT   = JSON.stringify({ chain: "base", promotedAt: 1, ageMs: 0, source: null, symbol: null, phase: null, flowAgeMs: null, largestBuyEth: 0, avgBuyEth: 0, buySwapCount5m: 0, sellSwapCount5m: 0, flow: { pressure: "BUYING", buys5m: 0, hasData: true, buyVol5m: 0, netVol5m: 0 } });
  const VALID_ARMED = JSON.stringify({ armedAt: 1, ageMs: 0, price: 1, score: 5, flowPressure: "BUYING", symbol: null, phase: null, chain: null });

  // PairStatesRecord — root `{}` valid; VALOAREA validată pe CONTRACTUL COMPLET.
  check("41. PairStatesRecord {} OK (hartă goală = chain viu fără pairs)",
    parseWithSchema<any>('{}', PairStatesRecordSchema, FB) !== FB);
  check("42. PairStatesRecord {pairKey: PairState canonic complet} OK",
    parseWithSchema<any>(`{"0xabc":${VALID_STATE}}`, PairStatesRecordSchema, FB) !== FB);
  check("43. * PairStatesRecord intrare {} -> fallback",
    parseWithSchema('{"0xabc":{}}', PairStatesRecordSchema, FB) === FB);
  check("44. * PairState fără phase/symbol/priceChange -> fallback (varu: contract complet)",
    parseWithSchema(`{"0xabc":{"chain":"base","pairAddress":"0xp","updatedAt":1,"flow":{"pressure":"BUYING","buys5m":0,"sells5m":0,"hasData":true,"buyVol5m":0,"sellVol5m":0,"netVol5m":0,"buyVol5mUsd":null,"sellVol5mUsd":null,"netVol5mUsd":null}}}`, PairStatesRecordSchema, FB) === FB);
  check("45. * PairState flow fără buys5m/volume fields -> fallback (varu: flow complet)",
    parseWithSchema(`{"0xabc":${VALID_STATE.replace(/"flow":\{[^}]*\}/, '"flow":{"pressure":"BUYING","hasData":true}')}}`, PairStatesRecordSchema, FB) === FB);
  check("46. * PairState flow.hasData ne-bool -> fallback",
    parseWithSchema(`{"0xabc":${VALID_STATE.replace('"hasData":true', '"hasData":"yes"')}}`, PairStatesRecordSchema, FB) === FB);
  check("47. * PairStatesRecord root array -> fallback",
    parseWithSchema('[1,2,3]', PairStatesRecordSchema, FB) === FB);
  check("48. * PairStatesRecord valoare primitivă -> fallback",
    parseWithSchema('{"0xabc":5}', PairStatesRecordSchema, FB) === FB);
  // varu R4: câmpurile required lipsă din schemă înainte (patternTags/risk/discovery) + enum-uri.
  check("48a. PairState cu risk complet (obiect) OK",
    parseWithSchema<any>(`{"0xabc":${VALID_STATE.replace('"risk":null', `"risk":${VALID_RISK}`)}}`, PairStatesRecordSchema, FB) !== FB);
  check("48b. * PairState risk:{} -> fallback (varu: {} truthy = riskCache fals prezent)",
    parseWithSchema(`{"0xabc":${VALID_STATE.replace('"risk":null', '"risk":{}')}}`, PairStatesRecordSchema, FB) === FB);
  check("48c. * PairState patternTags:\"oops\" -> fallback (varu: trebuie string[]|null)",
    parseWithSchema(`{"0xabc":${VALID_STATE.replace('"patternTags":null', '"patternTags":"oops"')}}`, PairStatesRecordSchema, FB) === FB);
  check("48d. * PairState discovery:\"oops\" -> fallback (varu: trebuie obiect)",
    parseWithSchema(`{"0xabc":${VALID_STATE.replace(/"discovery":\{[^}]*\}/, '"discovery":"oops"')}}`, PairStatesRecordSchema, FB) === FB);
  check("48e. * PairState discovery.discoverySources ne-array -> fallback (varu: allSources.filter)",
    parseWithSchema(`{"0xabc":${VALID_STATE.replace('"discoverySources":[]', '"discoverySources":"oops"')}}`, PairStatesRecordSchema, FB) === FB);
  check("48f. * PairState phase:\"BOGUS\" -> fallback (varu: enum, nu z.string)",
    parseWithSchema(`{"0xabc":${VALID_STATE.replace('"phase":"NEW"', '"phase":"BOGUS"')}}`, PairStatesRecordSchema, FB) === FB);
  check("48f-2. * PairState phase:\"ZOMBIE\" -> fallback (U6/NF-E33: faza legacy scoasă din enum)",
    parseWithSchema(`{"0xabc":${VALID_STATE.replace('"phase":"NEW"', '"phase":"ZOMBIE"')}}`, PairStatesRecordSchema, FB) === FB);
  check("48f-3. PairState cu chei win-tracking legacy tot OK (passthrough păstrează cheile ca extras — fwd-compat v8.0)",
    parseWithSchema<any>(`{"0xabc":${VALID_STATE.replace('"seenCount":1', '"seenCount":1,"wins24h":0,"losses24h":0,"badExits24h":0,"consecutiveLosses":0,"totalEntries":0,"lastEntryTime":0')}}`, PairStatesRecordSchema, FB) !== FB);
  check("48g. * PairState pipelineState:\"BOGUS\" -> fallback (varu: enum)",
    parseWithSchema(`{"0xabc":${VALID_STATE.replace('"pipelineState":"NONE"', '"pipelineState":"BOGUS"')}}`, PairStatesRecordSchema, FB) === FB);
  check("48h. * PairState dexType:\"BOGUS\" -> fallback (varu: enum)",
    parseWithSchema(`{"0xabc":${VALID_STATE.replace('"dexType":"V3"', '"dexType":"BOGUS"')}}`, PairStatesRecordSchema, FB) === FB);
  check("48i. * PairState lp.status:\"BOGUS\" -> fallback (varu: clasificare LP)",
    parseWithSchema(`{"0xabc":${VALID_STATE.replace('"status":"STABLE"', '"status":"BOGUS"')}}`, PairStatesRecordSchema, FB) === FB);
  check("48j. * PairState fără patternTags/risk/discovery -> fallback (chei required)",
    parseWithSchema('{"0xabc":{"symbol":"A","chain":"base","pairAddress":"0x","tokenAddress":"0xt","dexType":"V3","currentPrice":1,"priceChange":{"m5":0,"h1":0,"h24":0},"phase":"NEW","pipelineState":"NONE","seenCount":1,"totalEntries":0,"wins24h":0,"losses24h":0,"badExits24h":0,"consecutiveLosses":0,"lastEntryTime":0,"flow":{"pressure":"BUYING","buys5m":0,"sells5m":0,"hasData":true,"buyVol5m":0,"sellVol5m":0,"netVol5m":0,"buyVol5mUsd":null,"sellVol5mUsd":null,"netVol5mUsd":null},"lp":{"status":"STABLE","lpNet5m":0,"hasData":true,"lpAdded5m":0,"lpRemoved5m":0,"removedPctOfPool":null},"reserveUsd":0,"reserveEth":0,"reserveNative":0,"nativeSymbol":null,"liqStatus":"WEAK","poolCountSameToken":1,"firstSeenAt":null,"lastSeenAt":null,"pipelineEnteredAt":null,"currentStateAgeSec":null,"priceVsFirstSeenPct":null,"hourUtc":0,"updatedAt":1,"lastMomentumVerdict":null,"lastMomentumAt":null,"attentionScore":null,"monitoringTier":null}}', PairStatesRecordSchema, FB) === FB);

  // Watch/Hot/Armed — contract complet; doar ancorele -> fallback.
  check("49. WatchRecord canonic OK; doar {chain,addedAt} -> fallback (varu)",
    parseWithSchema<any>(`{"0x":${VALID_WATCH}}`, WatchRecordSchema, FB) !== FB &&
    parseWithSchema('{"0x":{"chain":"base","addedAt":1}}', WatchRecordSchema, FB) === FB);
  check("50. HotRecord canonic OK; doar {chain,promotedAt} -> fallback (varu)",
    parseWithSchema<any>(`{"0x":${VALID_HOT}}`, HotRecordSchema, FB) !== FB &&
    parseWithSchema('{"0x":{"chain":"base","promotedAt":1}}', HotRecordSchema, FB) === FB);
  check("51. ArmedRecord canonic OK; doar {armedAt,score} -> fallback (varu)",
    parseWithSchema<any>(`{"0x":${VALID_ARMED}}`, ArmedRecordSchema, FB) !== FB &&
    parseWithSchema('{"0x":{"armedAt":1,"score":5}}', ArmedRecordSchema, FB) === FB);

  // WorkerSnapshot — required complet; memory validată pe CONTRACT COMPLET.
  check("52. WorkerSnapshot complet valid OK",
    parseWithSchema<any>(`{"version":"v1","savedAt":1,"memory":{"0x":${VALID_MEM}},"poolReserveEth":{"0x":12.5}}`, WorkerSnapshotSchema, FB) !== FB);
  check("53. * WorkerSnapshot doar cu savedAt -> fallback (varu)",
    parseWithSchema('{"savedAt":1}', WorkerSnapshotSchema, FB) === FB);
  check("54. * WorkerSnapshot {} -> fallback",
    parseWithSchema('{}', WorkerSnapshotSchema, FB) === FB);
  check("55. * MemoryEntry doar pairAddress+symbol -> fallback (varu: contract complet)",
    parseWithSchema('{"version":"v1","savedAt":1,"memory":{"0x":{"pairAddress":"0x","symbol":"AAA"}},"poolReserveEth":{}}', WorkerSnapshotSchema, FB) === FB);
  check("55a. MemoryEntry canonic + discovery optionals valide OK",
    parseWithSchema<any>(`{"version":"v1","savedAt":1,"memory":{"0x":${VALID_MEM.replace(/}$/, ',"discoverySources":["INDEXER"],"firstDiscoveredAt":1}')}},"poolReserveEth":{}}`, WorkerSnapshotSchema, FB) !== FB);
  check("55b. * MemoryEntry.discoverySources:\"oops\" -> fallback (varu: allSources.filter → INTERNAL fals)",
    parseWithSchema(`{"version":"v1","savedAt":1,"memory":{"0x":${VALID_MEM.replace(/}$/, ',"discoverySources":"oops"}')}},"poolReserveEth":{}}`, WorkerSnapshotSchema, FB) === FB);
  check("56. * WorkerSnapshot poolReserveEth valoare ne-number -> fallback",
    parseWithSchema('{"version":"v1","savedAt":1,"memory":{},"poolReserveEth":{"0x":"12.5"}}', WorkerSnapshotSchema, FB) === FB);
  check("56a. * WorkerSnapshot memory phase legacy (ZOMBIE) -> fallback (U6/NF-E33: enum fără faze legacy și în worker_snapshot)",
    parseWithSchema(`{"version":"v1","savedAt":1,"memory":{"0x":${VALID_MEM.replace('"phase":"NEW"', '"phase":"ZOMBIE"')}},"poolReserveEth":{}}`, WorkerSnapshotSchema, FB) === FB);
  check("56b. WorkerSnapshot memory FĂRĂ câmpuri win-tracking -> OK (U6: cele 9 câmpuri scoase din contract)",
    parseWithSchema<any>(`{"version":"v1","savedAt":1,"memory":{"0x":${VALID_MEM}},"poolReserveEth":{}}`, WorkerSnapshotSchema, FB) !== FB);

  // PipelineCoverage — chains value = ChainCoverage CONTRACT COMPLET.
  check("57. PipelineCoverage valid OK",
    parseWithSchema<any>(`{"workerVersion":"v1","savedAt":1,"chains":{"base":${VALID_CHAINCOV}}}`, PipelineCoverageSchema, FB) !== FB);
  check("58. * PipelineCoverage {} -> fallback",
    parseWithSchema('{}', PipelineCoverageSchema, FB) === FB);
  check("59. * PipelineCoverage chains.base {} -> fallback (varu)",
    parseWithSchema('{"workerVersion":"v1","savedAt":1,"chains":{"base":{}}}', PipelineCoverageSchema, FB) === FB);
  check("60. * PipelineCoverage fără pipeline/ws/observedMoverCoverage -> fallback (varu)",
    parseWithSchema('{"workerVersion":"v1","savedAt":1,"chains":{"base":{"trackedPairs":1,"observedMovers":0,"topMoversNotWatched":[]}}}', PipelineCoverageSchema, FB) === FB);
  check("61. * topMoversNotWatched:[{}] -> fallback (varu: item validat, nu obiect gol)",
    parseWithSchema(`{"workerVersion":"v1","savedAt":1,"chains":{"base":${VALID_CHAINCOV.replace('"topMoversNotWatched":[]', '"topMoversNotWatched":[{}]')}}}`, PipelineCoverageSchema, FB) === FB);
  check("62. * PipelineCoverage topMoversNotWatched ne-array -> fallback",
    parseWithSchema(`{"workerVersion":"v1","savedAt":1,"chains":{"base":${VALID_CHAINCOV.replace('"topMoversNotWatched":[]', '"topMoversNotWatched":"x"')}}}`, PipelineCoverageSchema, FB) === FB);

  // ScannerStats — toate câmpurile principale required; valori validate pe CONTRACT COMPLET.
  const VALID_SCANNER = `{"savedAt":1,"discoverySource":"auto","scan":${VALID_SCAN},"chains":{"base":${VALID_GECKO}},"sourceByChain":{"base":${VALID_SRC}},"dexscreener":${VALID_DEX}}`;
  check("63. ScannerStats complet valid OK",
    parseWithSchema<any>(VALID_SCANNER, ScannerStatsSchema, FB) !== FB);
  check("64. * ScannerStats {} -> fallback",
    parseWithSchema('{}', ScannerStatsSchema, FB) === FB);
  check("65. * Gecko health doar cu status -> fallback (varu: lastResultCount/emptyStreak/… required)",
    parseWithSchema(`{"savedAt":1,"discoverySource":"auto","scan":${VALID_SCAN},"chains":{"base":{"status":"OK"}},"sourceByChain":{"base":${VALID_SRC}},"dexscreener":${VALID_DEX}}`, ScannerStatsSchema, FB) === FB);
  check("66. * ScannerStats scan.totalFetched string -> fallback (varu)",
    parseWithSchema(`{"savedAt":1,"discoverySource":"auto","scan":{"durationMs":5,"totalFetched":"oops","processedPools":3},"chains":{"base":${VALID_GECKO}},"sourceByChain":{"base":${VALID_SRC}},"dexscreener":${VALID_DEX}}`, ScannerStatsSchema, FB) === FB);
  check("67. * ScannerStats chains.base null -> fallback (varu)",
    parseWithSchema(`{"savedAt":1,"discoverySource":"auto","scan":${VALID_SCAN},"chains":{"base":null},"sourceByChain":{"base":${VALID_SRC}},"dexscreener":${VALID_DEX}}`, ScannerStatsSchema, FB) === FB);
  check("68. * ScannerStats dexscreener status invalid -> fallback (varu)",
    parseWithSchema(`{"savedAt":1,"discoverySource":"auto","scan":${VALID_SCAN},"chains":{"base":${VALID_GECKO}},"sourceByChain":{"base":${VALID_SRC}},"dexscreener":{"lastFetchAgeSec":5,"last429AgeSec":null,"lastResultCount":10,"status":"BOGUS"}}`, ScannerStatsSchema, FB) === FB);
  check("69. * ScannerStats dexscreener.lastFetchAgeSec string -> fallback (varu)",
    parseWithSchema(`{"savedAt":1,"discoverySource":"auto","scan":${VALID_SCAN},"chains":{"base":${VALID_GECKO}},"sourceByChain":{"base":${VALID_SRC}},"dexscreener":{"lastFetchAgeSec":"5","last429AgeSec":null,"lastResultCount":10,"status":"OK"}}`, ScannerStatsSchema, FB) === FB);
  check("70. * ScannerStats sourceByChain fără fallbackUsed -> fallback",
    parseWithSchema(`{"savedAt":1,"discoverySource":"auto","scan":${VALID_SCAN},"chains":{"base":${VALID_GECKO}},"sourceByChain":{"base":{"source":"INDEXER_PRIMARY"}},"dexscreener":${VALID_DEX}}`, ScannerStatsSchema, FB) === FB);

  // WorkerRuntime — chain/updatedAt/wsConnected TOATE required.
  check("71. WorkerRuntime valid OK",
    parseWithSchema<any>('{"chain":"base","updatedAt":1,"wsConnected":true}', WorkerRuntimeSchema, FB) !== FB);
  check("72. * WorkerRuntime fără wsConnected -> fallback (varu)",
    parseWithSchema('{"chain":"base","updatedAt":1}', WorkerRuntimeSchema, FB) === FB);
  check("73. * WorkerRuntime updatedAt string -> fallback",
    parseWithSchema('{"chain":"base","updatedAt":"now","wsConnected":true}', WorkerRuntimeSchema, FB) === FB);

  // --- 6. E8b Blocker 1: mergeChainRecords (corupt ≠ prezent; `any` DUPĂ parse reușit) ---
  const CH = ["base", "arbitrum", "ethereum"];
  const rCorrupt = mergeChainRecords<any>(["[1,2]", null, null], CH, PairStatesRecordSchema, "pair_states");
  check("74. * corrupt pair_states -> keyExists(any) false + keyPresentByChain.base false",
    rCorrupt.any === false && rCorrupt.presentByChain.base === false);
  const rEmpty = mergeChainRecords<any>(["{}", null, null], CH, PairStatesRecordSchema, "pair_states");
  check("75. valid pair_states {} -> keyExists(any) true + present.base true",
    rEmpty.any === true && rEmpty.presentByChain.base === true);
  check("76. absent pair_states -> present.arbitrum false",
    rEmpty.presentByChain.arbitrum === false);
  const rValid = mergeChainRecords<any>([`{"0xabc":${VALID_STATE}}`, null, null], CH, PairStatesRecordSchema, "pair_states");
  check("77. valid pair_states cu intrare -> merged are cheia + any true",
    rValid.any === true && (rValid.merged as any)["0xabc"] !== undefined);
  const rMixed = mergeChainRecords<any>([`{"0xa":${VALID_STATE}}`, "not json", null], CH, PairStatesRecordSchema, "pair_states");
  check("78. mixt [valid,corupt,absent] -> any true, present base=true/arbitrum=false, merged doar valid",
    rMixed.any === true && rMixed.presentByChain.base === true &&
    rMixed.presentByChain.arbitrum === false && Object.keys(rMixed.merged).length === 1);

  // --- 7. E8c: scheme reader — CONTRACT CANONIC (varu R2): {} nu e valid; enum-uri; price pozitiv ---
  const J = (x: unknown): string => JSON.stringify(x);
  const MOVER = {
    chain: "base", pairAddress: "0xabc", tokenAddress: null, symbol: "FOO", dexType: "V3",
    priceUsd: 1.5, reserveUsd: 1000, priceChange5m: 0.1, priceChange1h: null, priceChange24h: -0.2,
    direction: "UP", historyStatus: "READY", snapshotCount: 3, ts: 1710000000000,
  };
  const IDXPAIR = {
    chain: "base", dexId: "uniswap", pairAddress: "0xabc", token0: "0x0", token1: "0x1",
    blockNumber: 100, txHash: "0xtx", discoveredAt: 1, quotePriceSource: "CHAINLINK", priceStatus: "OK", pricedAt: 1,
  };
  const PCTX = {
    schemaVersion: "preflight-schema-v2", workerVersion: "1.0", symbol: "FOO", chain: "base",
    pairAddress: "0xabc", pipelineState: "HOT", phase: "TRENDING", liquidityStatus: "OK", reserveUsd: 1000,
    flow: { status: "BUYING", buyVol5m: 1, netVol5m: 1, buys5m: 2, sells5m: 1, hasData: true },
    entryRisk: "MEDIUM", riskFlags: [], opportunitySignals: [], workerObservation: "x", updatedAt: 1,
  };

  // MoversArraySchema (readTrendingMovers) — chain/dexType/direction/historyStatus enum strict (EVM-only)
  check("79. movers [valid] -> 1", parseWithSchema<unknown[]>(J([MOVER]), MoversArraySchema, []).length === 1);
  check("79a. movers [] gol -> [] valid", parseWithSchema<unknown[]>(J([]), MoversArraySchema, [{ x: 1 }]).length === 0);
  check("79b. * movers root non-array -> fallback", (parseWithSchema<any[]>(J(MOVER), MoversArraySchema, [FB])[0] as any) === FB);
  check("79c. * movers element fără priceUsd -> fallback", (parseWithSchema<any[]>(J([{ ...MOVER, priceUsd: undefined }]), MoversArraySchema, [FB])[0] as any) === FB);
  check("79d. * movers direction invalid -> fallback (enum)", (parseWithSchema<any[]>(J([{ ...MOVER, direction: "SIDEWAYS" }]), MoversArraySchema, [FB])[0] as any) === FB);
  check("79e. * movers chain invalid -> fallback (enum)", (parseWithSchema<any[]>(J([{ ...MOVER, chain: "polygon" }]), MoversArraySchema, [FB])[0] as any) === FB);
  check("79f. * movers dexType invalid -> fallback (enum)", (parseWithSchema<any[]>(J([{ ...MOVER, dexType: "CPMM" }]), MoversArraySchema, [FB])[0] as any) === FB);
  check("79g. movers tokenAddress null + câmp extra -> ok", parseWithSchema<unknown[]>(J([{ ...MOVER, extra: 1 }]), MoversArraySchema, []).length === 1);

  // QuotePriceSchema (readQuotePrices) — price POZITIV + updatedAt number
  check("80. quotePrice {price>0, updatedAt} -> ok", parseWithSchema<any>(J({ price: 1, updatedAt: 123 }), QuotePriceSchema, null)?.price === 1);
  check("80a. * quotePrice price:0 -> fallback (positive)", parseWithSchema(J({ price: 0, updatedAt: 1 }), QuotePriceSchema, null) === null);
  check("80b. * quotePrice price negativ -> fallback", parseWithSchema(J({ price: -5, updatedAt: 1 }), QuotePriceSchema, null) === null);
  check("80c. * quotePrice updatedAt string -> fallback (number)", parseWithSchema(J({ price: 1, updatedAt: "123" }), QuotePriceSchema, null) === null);
  check("80d. * quotePrice updatedAt lipsă -> fallback", parseWithSchema(J({ price: 1 }), QuotePriceSchema, null) === null);
  check("80e. * quotePrice price string -> fallback", parseWithSchema(J({ price: "1", updatedAt: 1 }), QuotePriceSchema, null) === null);
  check("80f. * quotePrice root array -> fallback", parseWithSchema(J([1, 2]), QuotePriceSchema, null) === null);

  // QuotePriceHealthEntrySchema (readQuotePriceHealth) = IndexedPair (ancore core + enum source/status)
  check("81. quoteHealth IndexedPair valid -> ok", parseWithSchema(J(IDXPAIR), QuotePriceHealthEntrySchema, null) !== null);
  check("81a. * quoteHealth {} -> fallback (ancore lipsă)", parseWithSchema(J({}), QuotePriceHealthEntrySchema, null) === null);
  check("81b. * quoteHealth fără chain (ancoră) -> fallback", parseWithSchema(J({ ...IDXPAIR, chain: undefined }), QuotePriceHealthEntrySchema, null) === null);
  check("81c. * quoteHealth quotePriceSource invalid enum -> fallback", parseWithSchema(J({ ...IDXPAIR, quotePriceSource: "GARBAGE" }), QuotePriceHealthEntrySchema, null) === null);
  check("81d. * quoteHealth priceStatus invalid enum -> fallback", parseWithSchema(J({ ...IDXPAIR, priceStatus: "WAT" }), QuotePriceHealthEntrySchema, null) === null);
  check("81e. quoteHealth doar ancore (fără câmpuri price) -> ok", parseWithSchema(J({ chain: "base", dexId: "u", pairAddress: "0x", token0: "0x", token1: "0x", blockNumber: 1, txHash: "0x", discoveredAt: 1 }), QuotePriceHealthEntrySchema, null) !== null);

  // PairContextSchema (readPairContext) — contract COMPLET
  check("82. pairContext canonic complet -> ok", parseWithSchema(J(PCTX), PairContextSchema, null) !== null);
  check("82a. * pairContext {} -> fallback (contract complet)", parseWithSchema(J({}), PairContextSchema, null) === null);
  check("82b. * pairContext fără symbol -> fallback", parseWithSchema(J({ ...PCTX, symbol: undefined }), PairContextSchema, null) === null);
  check("82c. * pairContext flow fără hasData -> fallback", parseWithSchema(J({ ...PCTX, flow: { status: "BUYING", buyVol5m: 1, netVol5m: 1, buys5m: 1, sells5m: 1 } }), PairContextSchema, null) === null);
  check("82d. * pairContext entryRisk invalid enum -> fallback", parseWithSchema(J({ ...PCTX, entryRisk: "SUPER" }), PairContextSchema, null) === null);
  check("82e. * pairContext array -> fallback", parseWithSchema(J([1]), PairContextSchema, null) === null);
  check("82f. pairContext lifecycle null -> ok (optional nullable)", parseWithSchema(J({ ...PCTX, lifecycle: null }), PairContextSchema, null) !== null);
  check("82g. * pairContext phase legacy (ZOMBIE) -> fallback (U6/NF-E33: doar 5 faze + UNKNOWN)", parseWithSchema(J({ ...PCTX, phase: "ZOMBIE" }), PairContextSchema, null) === null);
  check("82h. * pairContext phase legacy (SECOND_WAVE) -> fallback (U6)", parseWithSchema(J({ ...PCTX, phase: "SECOND_WAVE" }), PairContextSchema, null) === null);
  check("82i. pairContext phase UNKNOWN -> ok (U6: fallback din snapshots permis)", parseWithSchema(J({ ...PCTX, phase: "UNKNOWN" }), PairContextSchema, null) !== null);

  // resolveValidatedPairContext (leaf) — ambiguitate decisă DUPĂ validare (varu R2)
  const CTXRAW = J(PCTX);
  check("83. leaf 0 hits -> not found", resolveValidatedPairContext([]).context === null && resolveValidatedPairContext([]).matchedChain === null);
  check("83a. leaf 1 valid -> acel context + matchedChain",
    (() => { const r = resolveValidatedPairContext([{ raw: CTXRAW, chain: "base" }]); return r.context !== null && r.matchedChain === "base" && r.ambiguousChains.length === 0; })());
  check("83b. * leaf 1 valid + 1 corupt -> contextul VALID, NU ambiguous",
    (() => { const r = resolveValidatedPairContext([{ raw: CTXRAW, chain: "base" }, { raw: "not json", chain: "bsc" }]); return r.matchedChain === "base" && r.ambiguousChains.length === 0; })());
  check("83c. * leaf 1 valid + 1 `{}`-invalid -> contextul VALID, NU ambiguous",
    (() => { const r = resolveValidatedPairContext([{ raw: "{}", chain: "arbitrum" }, { raw: CTXRAW, chain: "base" }]); return r.matchedChain === "base" && r.ambiguousChains.length === 0; })());
  check("83d. * leaf 2 valide -> ambiguous",
    (() => { const r = resolveValidatedPairContext([{ raw: CTXRAW, chain: "base" }, { raw: J({ ...PCTX, chain: "bsc" }), chain: "bsc" }]); return r.context === null && r.ambiguousChains.length === 2; })());
  check("83e. * leaf toate corupte -> not found",
    resolveValidatedPairContext([{ raw: "x", chain: "base" }, { raw: "{}", chain: "bsc" }]).context === null);

  // --- 8. E8c-2: scheme pipeline (contract CANONIC) + mergeChainArrays (validare PE ELEMENT) ---
  const EVENT = { type: "PROMOTE", symbol: "F", chain: "base", pairAddress: "0x", from: "OBSERVED", to: "HOT", ts: 5 };
  const DROP = { schemaVersion: "v2", workerVersion: "1", chain: "base", pairAddress: "0x", symbol: "F", droppedAt: 3, wasIn: "HOT", dropReason: "flow", timeInPipelineMs: 100, flowAtDrop: { status: "BUYING", buys5m: 1, sells5m: 0 } };
  const MOM = { schemaVersion: "v2", workerVersion: "1", symbol: "F", chain: "base", pairAddress: "0x", detectedAt: 4, verdict: "VERTICAL_WATCH", moveType: "VERTICAL", momentumLevel: "HIGH", entryRisk: "MEDIUM", reason: "x", m5Pct: 1, h1Pct: 1, h24Pct: 1, reserveUsd: 1000, dexType: "V3", flow: { hasData: true, status: "BUYING", buyVol5m: 1, netVol5m: 1, buys5m: 1 }, riskFlags: [], pipelineState: "HOT", workerObservation: "obs" };
  const SIG = { schemaVersion: "v2", workerVersion: "1", symbol: "F", chain: "base", pairAddress: "0x", pipelineState: "WATCHING", watchKind: "MOMENTUM", enteredWatchAt: 1, watchAgeMs: 10, confidence: "HIGH", entryRisk: "LOW", flow: { status: "BUYING", buyVol5m: 1, netVol5m: 1, buys5m: 1, sells5m: 0 }, riskFlags: [], opportunitySignals: [], priceVsEntryPct: null, workerObservation: "obs", updatedAt: 7 };
  const QUAL = { schemaVersion: "v2", workerVersion: "1", symbol: "F", chain: "base", pairAddress: "0x", qualifiedAt: 6, confidence: "HIGH", entryRisk: "LOW", flow: { status: "BUYING", buyVol5m: 1, netVol5m: 1, buys5m: 1 }, riskFlags: [], opportunitySignals: [], workerObservation: "obs" };
  const LIFE = { chain: "base", pairAddress: "0x", lastOutcome: "QUALIFIED_EMITTED", lastOutcomeAt: 2, reason: "x", fromState: "ARMED" };
  const ok = (schema: any, x: unknown): boolean => schema.safeParse(x).success;

  // scheme individuale
  check("84. PipelineEvent valid OK; fără ts -> fail; reason optional OK",
    ok(PipelineEventSchema, EVENT) && !ok(PipelineEventSchema, { ...EVENT, ts: undefined }) && ok(PipelineEventSchema, { ...EVENT, reason: undefined }));
  check("85. Drop valid OK; * wasIn enum invalid -> fail; * fără flowAtDrop -> fail",
    ok(DropSchema, DROP) && !ok(DropSchema, { ...DROP, wasIn: "BOGUS" }) && !ok(DropSchema, { ...DROP, flowAtDrop: undefined }));
  check("85a. * Drop flowAtDrop.status enum invalid -> fail; priceAtDrop null OK",
    !ok(DropSchema, { ...DROP, flowAtDrop: { status: "X", buys5m: 1, sells5m: 0 } }) && ok(DropSchema, { ...DROP, priceAtDrop: null }));
  check("86. Momentum valid OK; * verdict invalid -> fail; * flow fără hasData -> fail",
    ok(MomentumEventSchema, MOM) && !ok(MomentumEventSchema, { ...MOM, verdict: "NOPE" }) && !ok(MomentumEventSchema, { ...MOM, flow: { status: "BUYING", buyVol5m: 1, netVol5m: 1, buys5m: 1 } }));
  check("86a. * Momentum dexType invalid -> fail; * momentumLevel invalid -> fail",
    !ok(MomentumEventSchema, { ...MOM, dexType: "CPMM" }) && !ok(MomentumEventSchema, { ...MOM, momentumLevel: "MEGA" }));
  check("87. SignalPipeline valid OK; * confidence invalid -> fail; priceVsEntryPct null OK",
    ok(SignalPipelineEntrySchema, SIG) && !ok(SignalPipelineEntrySchema, { ...SIG, confidence: "SUPER" }) && ok(SignalPipelineEntrySchema, { ...SIG, priceVsEntryPct: null }));
  check("87a. * SignalPipeline fără priceVsEntryPct (required nullable) -> fail; * flow fără sells5m -> fail",
    !ok(SignalPipelineEntrySchema, { ...SIG, priceVsEntryPct: undefined }) && !ok(SignalPipelineEntrySchema, { ...SIG, flow: { status: "BUYING", buyVol5m: 1, netVol5m: 1, buys5m: 1 } }));
  check("88. Qualified valid OK; * entryRisk invalid -> fail; * fără qualifiedAt -> fail",
    ok(QualifiedSignalSchema, QUAL) && !ok(QualifiedSignalSchema, { ...QUAL, entryRisk: "MEH" }) && !ok(QualifiedSignalSchema, { ...QUAL, qualifiedAt: undefined }));
  check("89. Lifecycle valid OK; * lastOutcome invalid -> fail; * fromState invalid -> fail",
    ok(LifecycleEntrySchema, LIFE) && !ok(LifecycleEntrySchema, { ...LIFE, lastOutcome: "WAT" }) && !ok(LifecycleEntrySchema, { ...LIFE, fromState: "OBSERVED" }));

  // mergeChainArrays — validare PE ELEMENT (filter valide, drop invalide)
  const mca = (raws: (string | null)[]) => mergeChainArrays<any>(raws, DropSchema, (d: any) => d.droppedAt, "test_drops");
  check("90. mca [valid, valid] pe 2 chain-uri -> merged 2, any true, allReadable true",
    (() => { const r = mca([J([DROP]), J([{ ...DROP, droppedAt: 9 }])]); return r.merged.length === 2 && r.any === true && r.allReadable === true; })());
  check("90a. * mca [valid, INVALID] element -> păstrează validul, drop invalidul, allReadable false",
    (() => { const r = mca([J([DROP, { ...DROP, wasIn: "BOGUS" }])]); return r.merged.length === 1 && r.allReadable === false; })());
  check("90b. * mca payload non-array -> skip, allReadable false",
    (() => { const r = mca([J({ x: 1 })]); return r.merged.length === 0 && r.allReadable === false; })());
  check("90c. * mca JSON invalid -> allReadable false",
    (() => { const r = mca(["not json"]); return r.allReadable === false; })());
  check("90d. mca toate null -> any false, merged 0, allReadable true (cheie absentă ≠ corupt)",
    (() => { const r = mca([null, null]); return r.any === false && r.merged.length === 0 && r.allReadable === true; })());
  check("90e. mca [] gol -> any true (cheie prezentă), merged 0, allReadable true",
    (() => { const r = mca([J([])]); return r.any === true && r.merged.length === 0 && r.allReadable === true; })());
  check("90f. mca sort newest-first pe tsOf (droppedAt DESC)",
    (() => { const r = mca([J([{ ...DROP, droppedAt: 1 }, { ...DROP, droppedAt: 9 }, { ...DROP, droppedAt: 5 }])]); return r.merged[0].droppedAt === 9 && r.merged[2].droppedAt === 1; })());
  check("90g. * mca tot arrayul invalid -> merged 0, any true, allReadable false",
    (() => { const r = mca([J([{ bad: 1 }, { bad: 2 }])]); return r.merged.length === 0 && r.any === true && r.allReadable === false; })());

  // mergeChainArrays.readableByIndex — drops-honesty sincronizat cu validarea pe element (varu R2)
  check("91. * readableByIndex [valid, INVALID] -> false (drop invalid) DAR validul rămâne în merged",
    (() => { const r = mca([J([DROP, { ...DROP, wasIn: "BOGUS" }])]); return r.readableByIndex[0] === false && r.merged.length === 1; })());
  check("91a. readableByIndex [] gol valid -> true", mca([J([])]).readableByIndex[0] === true);
  check("91b. readableByIndex [valid] all-valid -> true", mca([J([DROP])]).readableByIndex[0] === true);
  check("91c. * readableByIndex cheie absentă (null) -> false", mca([null]).readableByIndex[0] === false);
  check("91d. * readableByIndex JSON invalid -> false", mca(["not json"]).readableByIndex[0] === false);
  check("91e. * readableByIndex root non-array -> false", mca([J({ x: 1 })]).readableByIndex[0] === false);
  check("91f. * readableByIndex toate elementele invalide -> false", mca([J([{ bad: 1 }])]).readableByIndex[0] === false);
  check("91g. readableByIndex aliniat pe index [valid, partial, absent] -> [true,false,false]",
    (() => { const r = mca([J([DROP]), J([DROP, { ...DROP, dropReason: 123 }]), null]); return r.readableByIndex[0] === true && r.readableByIndex[1] === false && r.readableByIndex[2] === false; })());
  // NB: redis-reader consumă `recentDropsReadableByChain[c] = dropsM.readableByIndex[i]` → un chain cu drop
  // invalid dă readable=false → recentDropsReadable=false → pfDrops=null (nu listă parțială cu dropsConfidence HIGH).

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
