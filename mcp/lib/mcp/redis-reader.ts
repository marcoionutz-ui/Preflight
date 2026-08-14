/**
 * lib/mcp/redis-reader.ts
 * Redis reads + helper functions — preflight:* first, supreme:* fallback
 */

import { getRedis }  from "@/lib/db/redis";
import type {
  PairState, MemoryEntry, WatchEntry, HotEntry,
  ArmedEntry, WorkerSnapshot, MarketRegime,
  PipelineEvent, RedisContext, LifecycleEntry, PipelineCoverage, ScannerStats,
} from "./types";
import {
  REDIS_KEYS,
  SCHEMA_VERSION,
  PREFLIGHT_EVM_CHAINS,
  normalizeChainId,
  pairKey,
  // NF2/U9: boundary de normalizare a launch-urilor legacy (înlocuiește `JSON.parse ... as
  // PreflightSolanaLaunch`). `classify...` întoarce outcome-ul (pt. log pe rejected) + value union|null.
  classifySolanaLaunchNormalization,
  type PreflightWorkerRuntime, type PreflightEvmChain, type MarketRegime as PreflightMarketRegime,
  type PreflightMarketContext, type PreflightDrop,
  type PreflightMomentumEvent, type PreflightSignalPipelineEntry, type PreflightQualifiedSignal,
  type PreflightSolanaPool, type PreflightObservedCandidate, type PreflightSolanaQuoteType,
  type PreflightSolanaLaunch,
  type PreflightSolanaPriceSnapshot, type PreflightSolanaPricePoint,
  type PreflightSolanaProgram, type PreflightSolanaHistoryStatus,
  type PreflightSolanaMover, type PreflightSolanaMoversSnapshot,
  type PreflightSolanaHealth, type PreflightSolanaPoolActivity,
} from "@preflight/schema";
import { safeAgeSec, quotePriceCurrentAgeSec, pricePoolsWindowStart } from "./freshness";
import { adjustMoverReadTime } from "./moverReadTime";
import { resolveWsRuntime } from "./health-freshness";
import { parseWithSchema, mergeChainRecords, mergeChainArrays } from "./safeParse";
import {
  SolanaHealthSchema, SolanaMoversSnapshotSchema, SolanaPoolSchema,
  SolanaPriceSnapshotSchema, SolanaPoolActivitySchema,
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
import {
  PipelineEventSchema, DropSchema, MomentumEventSchema,
  SignalPipelineEntrySchema, QualifiedSignalSchema, LifecycleEntrySchema,
} from "./schemas/pipeline";

// E8a+E8b: `safeJson` (validare sintaxă + cast oarb) a fost înlocuit COMPLET de `parseWithSchema`.
// E8c-1: citirile care foloseau `JSON.parse` BRUT direct (ratate de completitudinea E8b care numărase
// doar site-urile safeJson) sunt validate cu Zod: readTrendingMovers/readQuotePrices/readQuotePriceHealth/
// readPairContext (./schemas/reader). E8c-2: `mergeChainArrays` (./safeParse) validează PE ELEMENT cele 6
// array-uri pipeline cu ./schemas/pipeline. Nu mai există niciun `JSON.parse` nevalidat pe granițele Redis.

// ── Redis read ────────────────────────────────────────────────────────────────

export async function readAllRedis(): Promise<RedisContext | null> {
  const r = getRedis();
  if (!r) return null;

  // B4: pair_states/active_watch/hot_candidates/armed_entries/worker_snapshot sunt
  // chain-scoped (o cheie per-chain) → MGET peste PREFLIGHT_EVM_CHAINS + merge mai jos.
  const evmChains = PREFLIGHT_EVM_CHAINS;
  // B4d-2: market_regime/market_context NU se mai citesc din Redis — se derivă la read-time
  // mai jos din pair_states-urile merge-uite + worker_runtime (heartbeat WS per-chain).
  const [
    statesRaws, watchRaws, hotRaws, armedRaws, snapshotRaws,
    eventsRaws, dropsRaws,
    pfMomentumRaws, pfPipelineRaws, pfQualifiedRaws,
    pfCoverageRaws, pfScannerStatsRaws, pfLifecycleRaws,
    workerRuntimeRaws,
  ] = await Promise.all([
    r.mget(...evmChains.map(c => REDIS_KEYS.pairStates(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.activeWatch(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.hotCandidates(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.armedEntries(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.workerSnapshot(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.pipelineEvents(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.recentDrops(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.momentumEvents(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.signalPipeline(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.qualifiedSignals(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.pipelineCoverage(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.scannerStats(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.lifecycle(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.workerRuntime(c))),
  ]);

  const now = Date.now();

  // B4: merge cheile per-chain (keysets pairKey B3 → chain-disjuncte, Object.assign nu pierde nimic).
  // `mergeChainRecords` (leaf): `any`/`presentByChain` setate DOAR după parse REUȘIT — un payload corupt
  // (Zod respinge) NU e „cheie prezentă" și nu devine afirmație de piață (fix varu Blocker 1). Fiecare hartă
  // are schema PROPRIE care validează VALORILE consumate (fix varu Blocker 2).
  const statesM = mergeChainRecords<PairState>(statesRaws, evmChains, PairStatesRecordSchema, "pair_states");
  const watchM  = mergeChainRecords<WatchEntry>(watchRaws, evmChains, WatchRecordSchema, "active_watch");
  const hotM    = mergeChainRecords<HotEntry>(hotRaws, evmChains, HotRecordSchema, "hot_candidates");
  const armedM  = mergeChainRecords<ArmedEntry>(armedRaws, evmChains, ArmedRecordSchema, "armed_entries");

  // worker_snapshot: {memory, poolReserveEth, savedAt, version} → merge sub-obiectele
  // (savedAt = cel mai recent între chain-uri).
  // E14 (varu R2/B4): pe lângă merge (savedAt=max), ținem savedAt PER-CHAIN. Merged savedAt=max ascunde un
  // chain activ mort (Base 5s + BSC 8m → agregat 5s → „online" fals). Tool-ul agregă pe cel mai SLAB chain activ.
  // lint: forma RAW citită din snapshot (passthrough-ul zod păstrează câmpurile, dar tipul
  // WorkerSnapshot nu le expune direct) — tipizată local ca să înlocuim `(snap as any).câmp`.
  interface RawSnapshotChain {
    memory?:         Record<string, unknown>;
    poolReserveEth?: Record<string, unknown>;
    savedAt?:        number;
    version?:        string;
  }
  const mergeSnapshot = (raws: (string | null)[]): { snapshot: WorkerSnapshot | null; savedAtByChain: Record<string, number> } => {
    const memory:         Record<string, unknown> = {};
    const poolReserveEth: Record<string, unknown> = {};
    const savedAtByChain: Record<string, number> = {};
    let savedAt: number | null = null;
    let version: string | null = null;
    let any = false;
    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i];
      if (raw == null) continue;
      const snap = parseWithSchema<RawSnapshotChain | null>(raw, WorkerSnapshotSchema, null, "worker_snapshot");
      if (!snap) continue;
      any = true;
      Object.assign(memory,         snap.memory ?? {});
      Object.assign(poolReserveEth, snap.poolReserveEth ?? {});
      const sv = snap.savedAt;
      if (typeof sv === "number" && Number.isFinite(sv)) {
        savedAtByChain[evmChains[i]] = sv;
        if (savedAt === null || sv > savedAt) {
          savedAt = sv;
          version = snap.version ?? null; // versiunea vine din snapshot-ul cel mai NOU
        }
      } else if (savedAt === null) {
        version = version ?? snap.version ?? null; // fallback: niciun savedAt numeric
      }
    }
    return { snapshot: any ? ({ memory, poolReserveEth, savedAt, version } as unknown as WorkerSnapshot) : null, savedAtByChain };
  };
  const { snapshot: snapshotMerged, savedAtByChain: snapshotSavedAtByChain } = mergeSnapshot(snapshotRaws);

  // B4b: array-urile sunt chain-scoped (o cheie per-chain) → MGET + merge global newest-first.
  // E8c-2: `mergeChainArrays` (leaf în ./safeParse) validează acum PE ELEMENT cu schema per-tip —
  // elementele invalide sunt filtrate (un event corupt nu pierde toată lista chain-ului), array/JSON
  // corupt → allReadable=false. `any` = prezența cheii (semantica E15 / pfX-nullability, neschimbată).
  const eventsM    = mergeChainArrays<PipelineEvent>(eventsRaws, PipelineEventSchema, e => e.ts, "pipeline_events");
  const dropsM     = mergeChainArrays<PreflightDrop>(dropsRaws, DropSchema, d => d.droppedAt, "recent_drops");
  const momentumM  = mergeChainArrays<PreflightMomentumEvent>(pfMomentumRaws, MomentumEventSchema, m => m.detectedAt, "pf_momentum");
  const pipelineM  = mergeChainArrays<PreflightSignalPipelineEntry>(pfPipelineRaws, SignalPipelineEntrySchema, p => p.updatedAt, "pf_pipeline");
  const qualifiedM = mergeChainArrays<PreflightQualifiedSignal>(pfQualifiedRaws, QualifiedSignalSchema, q => q.qualifiedAt, "pf_qualified");
  const lifecycleM = mergeChainArrays<LifecycleEntry>(pfLifecycleRaws, LifecycleEntrySchema, l => l.lastOutcomeAt, "pf_lifecycle");

  // B4c: pipeline_coverage chain-scoped → MGET + merge pe sub-obiectul `chains`
  // (keysets chain-disjuncte, o intrare per chain), savedAt=max, version din cel mai nou.
  interface RawCoverageChain {
    chains?:        Record<string, unknown>;
    savedAt?:       number;
    workerVersion?: string;
  }
  const mergeCoverage = (raws: (string | null)[]): { merged: PipelineCoverage | null; any: boolean } => {
    const chains: Record<string, unknown> = {};
    let savedAt: number | null = null;
    let version: string | null = null;
    let any = false;
    for (const raw of raws) {
      if (raw == null) continue;
      const snap = parseWithSchema<RawCoverageChain | null>(raw, PipelineCoverageSchema, null, "pf_pipeline_coverage");
      if (!snap) continue;
      any = true;
      Object.assign(chains, snap.chains ?? {});
      const sv = snap.savedAt;
      if (typeof sv === "number" && (savedAt === null || sv > savedAt)) {
        savedAt = sv;
        version = snap.workerVersion ?? null;
      } else if (savedAt === null) {
        version = version ?? snap.workerVersion ?? null;
      }
    }
    return { merged: any ? ({ workerVersion: version, savedAt, chains } as unknown as PipelineCoverage) : null, any };
  };
  const coverageM = mergeCoverage(pfCoverageRaws);

  // B4d-1: scanner_stats chain-scoped → MGET + merge ONEST (nu newest-wins silențios):
  // `chains`/`sourceByChain` = Object.assign (chain-disjuncte); scan totaluri = SUMĂ pe
  // chain-uri (writer-ul scrie felii LOCALE), durationMs = max; dexscreener = statusul cel
  // mai SEVER (o problemă pe orice chain iese la suprafață); discoverySource = comun sau
  // "mixed"; savedAt = max. null dacă nicio cheie.
  const DEX_SEVERITY: Record<string, number> = { OK: 0, STARTING: 1, DEGRADED: 2, RATE_LIMITED: 3 };
  interface RawDexscreener {
    status:          string;
    lastFetchAgeSec: number | null;
    last429AgeSec:   number | null;
    [k: string]:     unknown;   // passthrough — extrasele se păstrează la `...dex`
  }
  interface RawScannerChain {
    chains?:          Record<string, unknown>;
    sourceByChain?:   Record<string, unknown>;
    scan?:            { totalFetched?: number; processedPools?: number; durationMs?: number };
    savedAt?:         number;
    discoverySource?: string;
    dexscreener?:     RawDexscreener;
  }
  const mergeScannerStats = (raws: (string | null)[]): { merged: ScannerStats | null; any: boolean } => {
    const chains: Record<string, unknown> = {};
    const sourceByChain: Record<string, unknown> = {};
    let totalFetched = 0, processedPools = 0, durationMs = 0;
    let savedAt: number | null = null;
    let discoverySource: string | null = null, discoveryMixed = false;
    let dex: RawDexscreener | null = null, dexRank = -1, dexSavedAt: number | null = null;
    let any = false;
    for (const raw of raws) {
      if (raw == null) continue;
      const st = parseWithSchema<RawScannerChain | null>(raw, ScannerStatsSchema, null, "pf_scanner_stats");
      if (!st) continue;
      any = true;
      Object.assign(chains,        st.chains ?? {});
      Object.assign(sourceByChain, st.sourceByChain ?? {});
      const sc = st.scan ?? {};
      totalFetched   += Number(sc.totalFetched   ?? 0);
      processedPools += Number(sc.processedPools ?? 0);
      durationMs      = Math.max(durationMs, Number(sc.durationMs ?? 0));
      const sv = st.savedAt;
      const svNum = typeof sv === "number" ? sv : null;
      if (svNum !== null) savedAt = savedAt === null ? svNum : Math.max(savedAt, svNum);
      const ds = st.discoverySource;
      if (ds != null) { if (discoverySource === null) discoverySource = ds; else if (discoverySource !== ds) discoveryMixed = true; }
      const d = st.dexscreener;
      if (d) {
        const rank = DEX_SEVERITY[d.status ?? ""] ?? 0;
        // la severitate egală, preferă health-ul cel mai PROASPĂT (nu primul în ordinea chain-urilor)
        const shouldReplace = rank > dexRank || (rank === dexRank && svNum !== null && (dexSavedAt === null || svNum > dexSavedAt));
        if (shouldReplace) { dexRank = rank; dex = d; dexSavedAt = svNum; }
      }
    }
    if (!any) return { merged: null, any };
    // `dex` provine de la workerul cu statusul cel mai sever (poate MAI VECHI decât savedAt
    // global). age-at-write e relativ la dexSavedAt; tp_health_check adaugă (now - savedAt
    // global) → fără reancorare ar subestima vârsta. Offset = savedAt_global - dexSavedAt.
    const dexAgeOffsetSec = savedAt !== null && dexSavedAt !== null ? Math.max(0, Math.round((savedAt - dexSavedAt) / 1000)) : 0;
    const mergedDex = dex ? {
      ...dex,
      lastFetchAgeSec: dex.lastFetchAgeSec === null ? null : dex.lastFetchAgeSec + dexAgeOffsetSec,
      last429AgeSec:   dex.last429AgeSec   === null ? null : dex.last429AgeSec   + dexAgeOffsetSec,
    } : null;
    return { merged: ({
      savedAt,
      discoverySource: discoveryMixed ? "mixed" : (discoverySource ?? "auto"),
      scan: { durationMs, totalFetched, processedPools },
      chains,
      sourceByChain,
      dexscreener: mergedDex,
    } as unknown as ScannerStats), any };
  };
  const scannerM = mergeScannerStats(pfScannerStatsRaws);

  // ── B4d-2: market_context + market_regime DERIVATE la read-time ─────────────────
  // Nu mai există writer global (evită last-writer-wins la split). Derivăm din states-urile
  // per-chain merge-uite + heartbeat-ul WS per-chain (worker_runtime).
  // CHEIA MGET = autoritatea pt. chain (nu payload-ul — altfel worker_runtime:base cu
  // {chain:"bsc"} ar adopta un chain străin, exact bug-ul B4a). updatedAt lipsă/NaN/viitor
  // sau expirat (>120s) = ignorat.
  const wsConnectedChains: PreflightEvmChain[] = [];
  const scanOnlyChains:    PreflightEvmChain[] = [];
  // D1 (health onestitate): vârste WS per-chain, ajustate la `now` (workerul publică vârsta la updatedAt-ul lui).
  const wsRuntimeByChain: Record<string, {
    wsConnected: boolean; lastPongAgeSec: number | null; lastWsMessageAgeSec: number | null;
    subs: {
      v2: { confirmed: boolean; poolCount: number; lastMessageAgeSec: number | null; confirmedAgeSec: number | null } | null;
      v3: { confirmed: boolean; poolCount: number; lastMessageAgeSec: number | null; confirmedAgeSec: number | null } | null;
      v4: { confirmed: boolean; poolCount: number; lastMessageAgeSec: number | null; confirmedAgeSec: number | null } | null;
    } | null;
  }> = {};
  const chainsActive:      PreflightEvmChain[] = [];
  const runtimeUpdatedAts: number[] = [];
  const RUNTIME_MAX_AGE_MS = 120_000;
  for (let i = 0; i < workerRuntimeRaws.length; i++) {
    const raw = workerRuntimeRaws[i];
    if (raw == null) continue;
    const keyChain = evmChains[i];
    const wr = parseWithSchema<Partial<PreflightWorkerRuntime> | null>(raw, WorkerRuntimeSchema, null, `worker_runtime:${keyChain}`);
    if (!wr) continue;
    // D1: validare + normalizare WS-liveness (chain-guard, updatedAt, viitor/expirat, vârste ajustate la `now`)
    // extrasă în `resolveWsRuntime` (health-freshness) — pură + unit-testată. P2: vârstă negativă → null (nu „acum").
    const wsrt = resolveWsRuntime(wr, keyChain, now, {
      maxAgeMs:       RUNTIME_MAX_AGE_MS,
      futureSkewMs:   30_000,
      normalizeChain: normalizeChainId,
    });
    if (!wsrt) continue;
    runtimeUpdatedAts.push(wsrt.updatedAt);
    chainsActive.push(keyChain);
    if (wsrt.wsConnected) wsConnectedChains.push(keyChain);
    else scanOnlyChains.push(keyChain);
    wsRuntimeByChain[keyChain] = {
      wsConnected:         wsrt.wsConnected,
      lastPongAgeSec:      wsrt.lastPongAgeSec,
      lastWsMessageAgeSec: wsrt.lastWsMessageAgeSec,
      subs:                wsrt.subs, // Part B: per-kind (v2/v3/v4) sau null (worker vechi)
    };
  }
  // Port 1:1 al deriveMarketContext (workers/evm/src/pipeline/marketContext.ts) pe states merge-uite.
  const mcVals    = Object.values(statesM.merged) as Array<{ flow?: { hasData?: boolean; pressure?: string }; updatedAt?: number }>;
  const mcTotal   = mcVals.length;
  const mcWithFlow = mcVals.filter(v => v?.flow?.hasData);
  const mcBuying  = mcWithFlow.filter(v => v?.flow?.pressure === "BUYING").length;
  const mcSelling = mcWithFlow.filter(v => v?.flow?.pressure === "SELLING").length;
  const buyingPctAll    = mcTotal ? Math.round(mcBuying  / mcTotal * 100) : 0;
  const sellingPctAll   = mcTotal ? Math.round(mcSelling / mcTotal * 100) : 0;
  const noWsPct         = mcTotal ? Math.round((mcTotal - mcWithFlow.length) / mcTotal * 100) : 100;
  const derivedCoverage = mcTotal ? Math.round(mcWithFlow.length / mcTotal * 100) : 0;
  const derivedRegime: PreflightMarketRegime =
    buyingPctAll > 30     ? "RISK_ON"  :
    sellingPctAll > 20    ? "RISK_OFF" :
    derivedCoverage < 20  ? "DEAD"     :
    "MIXED";
  const momentumLast10m = momentumM.merged.filter(m => now - m.detectedAt < 10 * 60_000).length;
  // marketHasData = DOAR pair_states real. Un worker viu fără snapshot de piață NU e "piață
  // moartă" (asta ar fi date indisponibile); heartbeat-ul completează doar chains/WS, nu
  // autorizează derivarea regimului. Un pair_states:{} valid tot dă DEAD (snapshot real, 0 perechi).
  const marketHasData = statesM.any;
  // Freshness din SURSE (nu falsifica "fresh"/now): cel mai vechi updatedAt al state-urilor;
  // fallback runtime/snapshot. pfMarket.updatedAt = timestampul datelor; regime.calculatedAt = now.
  const stateUpdatedAts = mcVals.map(v => Number(v?.updatedAt)).filter(Number.isFinite);
  // E13: NU inventa un timestamp "acum" când nu există niciunul. Ultimul `?? now` transforma absența
  // completă a unei surse de timp într-un timestamp perfect proaspăt → contextQuality "fresh" fals.
  // Corect: dacă nici state, nici runtime, nici snapshot.savedAt (finit) nu există → null (necunoscut).
  const snapshotAt = Number(snapshotMerged?.savedAt);
  const marketSourceAt: number | null =
    stateUpdatedAts.length   > 0 ? Math.min(...stateUpdatedAts) :
    runtimeUpdatedAts.length > 0 ? Math.min(...runtimeUpdatedAts) :
    Number.isFinite(snapshotAt) ? snapshotAt : null;
  // E13: safeAgeSec — sursă absentă/coruptă sau SERIOS în viitor → null → contextQuality "stale" (conservator), nu "fresh".
  const marketAgeSec = safeAgeSec(now, marketSourceAt);
  const contextQuality = marketAgeSec === null ? "stale" : marketAgeSec < 45 ? "fresh" : marketAgeSec < 90 ? "aging" : "stale";
  const derivedMarket: PreflightMarketContext | null = marketHasData ? {
    schemaVersion:         SCHEMA_VERSION,
    workerVersion:         snapshotMerged?.version ?? "unknown",
    regime:                derivedRegime,
    buyingPct:             buyingPctAll,
    sellingPct:            sellingPctAll,
    flowCoveragePct:       derivedCoverage,
    trackedPairs:          mcTotal,
    chainsActive,
    momentumEventsLast10m: momentumLast10m,
    contextQuality,
    updatedAt:             marketSourceAt ?? 0,
  } : null;
  const derivedRegimeObj: MarketRegime | null = marketHasData ? {
    regime:            derivedRegime,
    buyingPctAll,
    sellingPctAll,
    noWsPct,
    flowCoveragePct:   derivedCoverage,
    hotCount:          Object.keys(hotM.merged).length,
    armedCount:        Object.keys(armedM.merged).length,
    wsConnectedChains,
    scanOnlyChains,
    trackedPairs:      mcTotal,
    pairsWithWsFlow:   mcWithFlow.length,
    calculatedAt:      now,
  } : null;

  // E14/E15 (varu R4): model KNOWN vs LIVE. knownChains = ORICE amprentă worker (runtime/snapshot/states);
  // liveChains = heartbeat proaspăt (chainsActive). Un chain cunoscut care a MURIT (heartbeat expirat) NU
  // dispare din health — altfel worstActive(...) ar vedea doar chain-ul viu și ar raporta fals „fresh".
  const knownChains: string[] = [];
  for (let i = 0; i < evmChains.length; i++) {
    if (workerRuntimeRaws[i] != null || snapshotRaws[i] != null || statesRaws[i] != null) knownChains.push(evmChains[i]);
  }
  // states: cel mai nou updatedAt PER-CHAIN (din raw-ul per-chain, înainte de merge) — pt. agregare weakest-link
  // (o stare Base proaspătă nu trebuie să mascheze stările BSC vechi).
  const statesNewestAtByChain: Record<string, number> = {};
  for (let i = 0; i < statesRaws.length; i++) {
    const raw = statesRaws[i];
    if (raw == null) continue;
    // E8b (varu Blocker 1): fallback `null` → un payload CORUPT NU e „prezent sănătos", deci NU primește
    // proxy-ul de liveness din snapshot (altfel un pair_states corupt ar revendica prospețime fals).
    const obj = parseWithSchema<Record<string, { updatedAt?: number }> | null>(raw, PairStatesRecordSchema, null, "pair_states");
    if (obj === null) continue;
    let newest = 0;
    for (const st of Object.values(obj)) { const u = Number(st?.updatedAt); if (Number.isFinite(u)) newest = Math.max(newest, u); }
    if (newest > 0) {
      statesNewestAtByChain[evmChains[i]] = newest;
    } else {
      // E14 (varu R4): cheie PREZENTĂ dar fără pair-uri (`{}` sănătos — un chain viu care momentan n-are pairs).
      // Fără proxy, un chain sănătos gol ar lipsi din agregare → statesAgg incomplet → pair_states fals „unknown".
      // Folosim savedAt-ul worker_snapshot per-chain ca proxy de liveness (cheie absentă rămâne missing: `continue`).
      const snapAt = snapshotSavedAtByChain[evmChains[i]];
      if (typeof snapAt === "number" && Number.isFinite(snapAt)) statesNewestAtByChain[evmChains[i]] = snapAt;
    }
  }
  // recent_drops: readability PER-CHAIN. E8c-2 (varu R2): SINCRONIZAT cu validarea PE ELEMENT — folosim
  // `dropsM.readableByIndex` (aceeași schemă `DropSchema`), NU un `Array.isArray(JSON.parse)` root-only care
  // rata drop-urile invalide filtrate → `pfDrops` parțial + `dropsConfidence:HIGH` pe date corupte. Absent pe
  // un chain CUNOSCUT / JSON-invalid / non-array / orice element invalid → false (nu revendicăm „zero drops").
  const recentDropsReadableByChain: Record<string, boolean> = {};
  for (let i = 0; i < evmChains.length; i++) {
    recentDropsReadableByChain[evmChains[i]] = dropsM.readableByIndex[i] ?? false;
  }
  const recentDropsReadable = knownChains.length > 0 && knownChains.every(c => recentDropsReadableByChain[c] === true);

  // E14 (varu R4): prezența PER-CHAIN a cheilor agregate. `keyExists.*` e „există pe ≥1 chain" → o cheie prezentă
  // pe Base dar LIPSĂ pe BSC (chain cunoscut) ar raporta fals prospețime din snapshot-urile globale fresh. Urmărim
  // prezența per-chain (ca la recent_drops) → tool-ul cere prezență pe TOATE chain-urile cunoscute înainte de a
  // revendica prospețime; altfel quality "unknown". (pair_states e guvernată separat de proxy-ul snapshot de mai sus.)
  // E8b (varu Blocker 1): prezența = payload PARSAT cu succes (din mergeChainRecords.presentByChain), NU
  // `raw != null` — un payload corupt nu revendică prezență/prospețime.
  const keyPresentByChain = {
    pair_states:    statesM.presentByChain,
    active_watch:   watchM.presentByChain,
    hot_candidates: hotM.presentByChain,
    armed_entries:  armedM.presentByChain,
  };

  return {
    now,
    states:   statesM.merged,
    watch:    watchM.merged,
    hot:      hotM.merged,
    armed:    armedM.merged,
    snapshot: snapshotMerged,
    // Was `pfMarketRaw ?? regimeRaw` — pfMarketRaw is preflight:market_context
    // JSON (schemaVersion/regime/buyingPct/chainsActive/...), a completely
    // different shape from the legacy MarketRegime interface
    // (buyingPctAll/hotCount/wsConnectedChains/...) this field claims to be.
    // Whenever market_context existed (i.e. almost always), `regime` here
    // silently held a mistyped PreflightMarketContext instead of a
    // MarketRegime — harmless in practice only because every consumer used
    // to merge `pfMarket ?? regime as any` and prefer pfMarket first. Now
    // parses only its own key, and every consumer reads per-field fallbacks
    // (`pfMarket?.x ?? regime?.x`) instead of merging the two shapes.
    regime:   derivedRegimeObj,
    events:   eventsM.merged,
    drops:   dropsM.merged,
    pfMarket:         derivedMarket,
    pfMomentum:       momentumM.any ? momentumM.merged : null,
    pfPipeline:       pipelineM.any ? pipelineM.merged : null,
    pfQualified:      qualifiedM.any ? qualifiedM.merged : null,
    // E15 (varu R4 cleanup): pfDrops non-null DOAR când recent_drops e citibilă pe TOATE chain-urile cunoscute
    // (recentDropsReadable). Vechiul `dropsM.any && dropsM.allReadable` sărea cheia absentă pe un chain cunoscut
    // (allReadable ignoră null-urile) → putea da date PARȚIALE (Base valid, BSC cheie lipsă). Acum protejăm și
    // ceilalți consumatori, nu doar tp_recent_pipeline_drops (care verifică separat recentDropsReadable).
    pfDrops: recentDropsReadable ? dropsM.merged : null,
    // E15: readable = TOATE chain-urile cunoscute au recent_drops prezentă ȘI JSON array valid (per-chain).
    recentDropsReadable,
    recentDropsReadableByChain,
    // E14 (varu R4): snapshot savedAt per-chain + states newest per-chain + known/live chains → tool-ul agregă
    // prospețimea pe cel mai slab chain CUNOSCUT (nu max, care ascunde un chain mort), și expune runtime-heartbeat-missing.
    snapshotSavedAtByChain,
    statesNewestAtByChain,
    keyPresentByChain,
    knownChains,
    liveChains: chainsActive,
    wsRuntimeByChain,
    pipelineCoverage: coverageM.merged,
    scannerStats:     scannerM.merged,
    pfLifecycle:      lifecycleM.any ? lifecycleM.merged : null,
    keyExists: {
      pair_states:          statesM.any,
      active_watch:         watchM.any,
      hot_candidates:       hotM.any,
      armed_entries:        armedM.any,
      worker_snapshot:      snapshotMerged !== null,
      market_regime:        derivedRegimeObj !== null,
      pipeline_events:      eventsM.any,
      recent_drops:         dropsM.any,
      pf_market:            derivedMarket !== null,
      pf_momentum:          momentumM.any,
      pf_pipeline:          pipelineM.any,
      pf_qualified:         qualifiedM.any,
      pf_drops:             dropsM.any,
      pf_pipeline_coverage: coverageM.any,
      pf_scanner_stats:     scannerM.any,
      pf_lifecycle:         lifecycleM.any,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// E14/E15: freshnessLabel + safeMinAge mutate în ./health-freshness (frunză testabilă, cu guard-uri
// viitor/non-finit) — re-exportate aici pentru compat cu importurile existente din tools.
export { freshnessLabel, safeMinAge } from "./health-freshness";

export function formatAge(ms: number): string {
  if (ms < 60_000)   return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3600_000)}h`;
}

// Native currency symbol pe chain — folosit de formatEth() ca să nu mai
// afișeze " ETH" hardcodat pe chain-uri non-Ethereum (ex: BSC arată BNB).
export function nativeSymbolForChain(chain: string | null | undefined): string {
  switch (chain?.toLowerCase()) {
    case "bsc":      return "BNB";
    case "eth":
    case "ethereum":
    case "base":
    case "arbitrum": return "ETH";
    // Chain necunoscut/nenormalizat — "native" în loc de a eticheta greșit
    // cu ETH; consistent cu restul aplicației care preferă "nu știu" în loc
    // de o afirmație falsă (vezi coverage=SAMPLED, confidence LOW etc).
    default:         return "native";
  }
}

export function formatEth(val: number, chain?: string | null): string {
  return `${val.toFixed(3)} ${nativeSymbolForChain(chain)}`;
}

export function formatVol(usd: number | null | undefined, legacyNativeEq: number): string {
  if (typeof usd === "number" && Number.isFinite(usd)) {
    const sign = usd < 0 ? "-" : "";
    const abs  = Math.abs(usd);
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  }
  return `${legacyNativeEq.toFixed(3)} nativeEq`;
}

export function getPipelineState(
  // B3f: `key` e `pairKey(chain, addr)` — hărțile sunt keyed pe pairKey.
  // Callerii cu adresă brută rezolvă cheia întâi (resolvePairChain); callerii
  // care iterează pasează cheia iterată (care ESTE pairKey).
  key:   string,
  watch: Record<string, WatchEntry>,
  hot:   Record<string, HotEntry>,
  armed: Record<string, ArmedEntry>,
): "WATCHING" | "HOT" | "ARMED" | "NONE" {
  if (armed[key]) return "ARMED";
  if (hot[key])   return "HOT";
  if (watch[key]) return "WATCHING";
  return "NONE";
}

// B3f: events/drops sunt ARRAY-uri multi-chain — un match pe adresă brută poate
// prinde evenimentul de pe alt chain (aceeași adresă pe base ȘI arbitrum). Ambele
// tipuri au `.chain` (required), deci matchuim pe identitatea completă pairKey.
export function findLastEventForPair(chain: string, addr: string, events: PipelineEvent[]): PipelineEvent | null {
  const key = pairKey(chain, addr);
  return events.find(e => e.chain != null && pairKey(e.chain, e.pairAddress) === key) ?? null;
}

export function findLastDropForPair(chain: string, addr: string, drops: PreflightDrop[]): PreflightDrop | null {
  const key = pairKey(chain, addr);
  return drops.find(d => d.chain != null && pairKey(d.chain, d.pairAddress) === key) ?? null;
}

/**
 * B3f: rezolvă chain-ul unei adrese din array-uri istorice (events/drops/
 * lifecycle) — folosit când adresa NU mai e în live maps (ex. pair dropat, pt.
 * care `resolvePairChain` pe hărți nu găsește chain-ul). Întoarce chain-urile
 * canonice DISTINCTE care conțin adresa; caller-ul decide: 1 → îl folosește,
 * >1 → ambiguu (cere chain), 0 → not-found. Items fără `.chain` sunt ignorate.
 */
export function chainsForAddressInArrays(
  addr: string,
  arrays: Array<ReadonlyArray<{ pairAddress?: string | null; chain?: string | null }> | null | undefined>,
): string[] {
  const norm  = addr.toLowerCase();
  const found = new Set<string>();
  for (const arr of arrays) {
    for (const item of arr ?? []) {
      if (item.chain && (item.pairAddress ?? "").toLowerCase() === norm) {
        found.add(normalizeChainId(item.chain));
      }
    }
  }
  return [...found];
}

/**
 * Rezultatul căutării pair_context. Faza B2: cheile sunt chain-scoped, deci
 * lookup-ul fără chain poate găsi aceeași adresă pe >1 chain EVM. În loc să
 * alegem tăcut primul (coliziunea exact pe care B2 o elimină), raportăm
 * ambiguitatea ca să cerem chain explicit.
 */
export interface PairContextLookup {
  // Lint pair-context batch: `context` tipizat `Record<string, unknown> | null` (ca schemas/reader.ts:123);
  // consumatorul (pair-context-report.ts) îl îngustează la un view local (`PfContextView`) pt. accesele pfCtx.*.
  context:         Record<string, unknown> | null;
  matchedChain:    string | null;
  ambiguousChains: string[];
}

export async function readPairContext(addr: string, chain?: string): Promise<PairContextLookup> {
  const r = getRedis();
  if (!r) return { context: null, matchedChain: null, ambiguousChains: [] };
  try {
    // Cu chain (hint din tool) → GET direct pe cheia chain-scoped.
    if (chain) {
      const canonicalChain = normalizeChainId(chain);
      const key = REDIS_KEYS.pairContext(canonicalChain, addr);
      const raw = await r.get(key);
      // E8c: context validat „e OBIECT" (primitiv/array/corupt → null). matchedChain reflectă parse-ul
      // REUȘIT — un payload prezent dar corupt = not-found (nu revendicăm un chain fără context valid).
      const ctx = raw ? parseWithSchema<Record<string, unknown> | null>(raw, PairContextSchema, null, key) : null;
      return { context: ctx, matchedChain: ctx ? canonicalChain : null, ambiguousChains: [] };
    }
    // Fără chain → probăm chain-urile EVM cunoscute printr-un singur MGET
    // (pair_context e scris DOAR de worker-evm pt. perechi EVM).
    const keys = PREFLIGHT_EVM_CHAINS.map(c => REDIS_KEYS.pairContext(c, addr));
    const raws = await r.mget(...keys);
    const hits = raws
      .map((raw, i) => ({ raw, chain: PREFLIGHT_EVM_CHAINS[i] as string }))
      .filter((x): x is { raw: string; chain: string } => x.raw !== null);
    // E8c (varu R2): validează hit-urile ÎNAINTE de a decide ambiguitatea (0/1/>1 pe VALIDE, nu pe orice
    // raw nenul — un JSON corupt pe alt chain nu mai produce fals AMBIGUOUS_PAIR).
    return resolveValidatedPairContext(hits);
  } catch {
    return { context: null, matchedChain: null, ambiguousChains: [] };
  }
}

/**
 * B3f: hărțile live in-process (states/watch/hot/armed/snapshot.memory/
 * poolReserveEth) sunt acum keyed pe `pairKey(chain, addr)`. Un lookup cu
 * adresă brută (de la user sau dintr-un array cu pairAddress) trebuie să
 * cunoască chain-ul ca să construiască cheia.
 *
 * - Cu `hint` (chain din tool) → construim direct `pairKey(hint, addr)`.
 * - Fără hint → probăm chain-urile EVM: construim `pairKey(c, addr)` și
 *   verificăm prezența în oricare din hărțile date. Dacă adresa apare pe
 *   >1 chain raportăm ambiguitatea (NU alegem tăcut primul — aceeași regulă
 *   ca `readPairContext`). Fără hit → `key: null` (lookup-urile cad pe
 *   not-found, exact ca înainte).
 *
 * `maps` = hărțile pairKey-keyed pe care se va face lookup (indexate cu cheia
 * întoarsă); e suficient să dai câteva (ex. states/watch/hot/armed/memory).
 */
export function resolvePairChain(
  addr: string,
  maps: Array<Record<string, unknown> | null | undefined>,
  hint?: string | null,
): { chain: string | null; key: string | null; ambiguousChains: string[] } {
  if (hint) {
    const c = normalizeChainId(hint);
    return { chain: c, key: pairKey(c, addr), ambiguousChains: [] };
  }
  const found: string[] = [];
  for (const c of PREFLIGHT_EVM_CHAINS) {
    const k = pairKey(c, addr);
    if (maps.some(m => m != null && m[k] !== undefined)) found.push(c);
  }
  if (found.length === 1) return { chain: found[0], key: pairKey(found[0], addr), ambiguousChains: [] };
  if (found.length > 1)   return { chain: null,     key: null,                    ambiguousChains: found };
  return { chain: null, key: null, ambiguousChains: [] };
}

// ── Pas 7B helpers ────────────────────────────────────────────────────────────

/**
 * Formatează un procent cu cap și protecție NaN/Infinity/null.
 */
export function formatPct(
  v:   number | null | undefined,
  cap = 9999,
): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "N/A";
  if (v >  cap) return `>${cap}%`;
  if (v < -cap) return `<-${cap}%`;
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/**
 * Derivă calitatea WS flow pentru un tool — pair-level sau global.
 * hasPairFlow: true dacă pair-ul specific are flow.hasData
 * coveragePct: flowCoveragePct global (0-100)
 */
export function wsFlowQuality(
  hasPairFlow: boolean,
  coveragePct: number | null | undefined,
): "present" | "partial" | "absent" {
  if (hasPairFlow) return "present";
  if ((coveragePct ?? 0) > 0) return "partial";
  return "absent";
}

/**
 * Combină freshness + coverage în confidence.
 * hasDirectFlow = true: pair-ul are WS flow real → nu penaliza pentru coverage global mic.
 */
export function combineConfidence(
  freshnessSec:  number | null,
  coveragePct:   number | null | undefined,
  hasDirectFlow = false,
): "LOW" | "MEDIUM" | "HIGH" {
  const freshnessConfidence: "LOW" | "MEDIUM" | "HIGH" =
    freshnessSec !== null && freshnessSec < 45 ? "HIGH"   :
    freshnessSec !== null && freshnessSec < 90 ? "MEDIUM" :
    "LOW";

  // Pair cu flow direct — nu penaliza pentru coverage global mic
  if (hasDirectFlow) return freshnessConfidence;

  const cov = coveragePct ?? null;
  if (cov === null) return freshnessConfidence;
  if (cov < 20) return "LOW";
  if (cov < 50 && freshnessConfidence === "HIGH") return "MEDIUM";
  return freshnessConfidence;
}

// dedupeByPair mutat în ./dedupe (leaf testabil, chain-scoped) — re-exportat aici pentru compat cu importurile
// existente (`import { dedupeByPair } from "../redis-reader"`).
export { dedupeByPair } from "./dedupe";

export { type MemoryEntry, type PairState };

// ── 6.11: Quote price health readers ─────────────────────────────────────────

// ── Oracle freshness (Chainlink cache keys) ───────────────────────────────────

export interface QuoteOracleEntry {
  price:   number;
  ageSec:  number;
  fresh:   boolean;   // ageSec < 300 (TTL Chainlink cache)
  source:  "CHAINLINK" | "MISSING";
}

const CHAINLINK_CHAINS: Array<{ chain: string; symbol: string }> = [
  { chain: "ethereum", symbol: "ETH" },
  { chain: "base",     symbol: "ETH" },
  { chain: "arbitrum", symbol: "ETH" },
  { chain: "bsc",      symbol: "BNB" },
];

/**
 * Citește Chainlink cache keys și raportează oracle freshness per chain.
 * Nu spune câte pairs folosesc sursa asta — pentru aia e readQuotePriceHealth().
 */
export async function readQuoteOracleHealth(): Promise<Record<string, Record<string, QuoteOracleEntry>>> {
  const r = getRedis();
  if (!r) return {};
  const now    = Date.now();
  const result: Record<string, Record<string, QuoteOracleEntry>> = {};
  try {
    const keys = CHAINLINK_CHAINS.map(({ chain, symbol }) =>
      `preflight:indexer:quoteprice:${chain}:${symbol}`,
    );
    const values = await r.mget(...keys);
    for (let i = 0; i < CHAINLINK_CHAINS.length; i++) {
      const { chain, symbol } = CHAINLINK_CHAINS[i];
      const raw = values[i];
      if (!result[chain]) result[chain] = {};
      if (!raw) {
        result[chain][symbol] = { price: 0, ageSec: -1, fresh: false, source: "MISSING" };
        continue;
      }
      // E8c: validare de formă — `price` = ANCORĂ (număr). Payload non-obiect / price non-number →
      // null → tratat ca MISSING (nu preț garbage). `updatedAt` rămâne tolerat (number|string|lipsă).
      const p = parseWithSchema<{ price: number; updatedAt?: number | string } | null>(
        raw, QuotePriceSchema, null, `preflight:indexer:quoteprice:${chain}:${symbol}`,
      );
      if (p === null) {
        result[chain][symbol] = { price: 0, ageSec: -1, fresh: false, source: "MISSING" };
        continue;
      }
      // E13: clamp la ≥0 — un updatedAt din viitor (clock skew) nu mai dă ageSec negativ. `fresh` cere
      // updatedAt valid ȘI <300s (ts lipsă/invalid/viitor-serios → safeAgeSec null → NEfresh, nu „0s proaspăt").
      const ageSec = safeAgeSec(now, Number.isFinite(Number(p.updatedAt)) ? Number(p.updatedAt) : null);
      result[chain][symbol] = { price: p.price, ageSec: ageSec ?? -1, fresh: ageSec !== null && ageSec < 300, source: "CHAINLINK" };
    }
  } catch { /* ignoră Redis errors */ }
  return result;
}

// ── Pair-level quote source distribution ─────────────────────────────────────

export interface QuotePriceChainHealth {
  sampleSize:    number;
  sources:       Record<string, number>;  // CHAINLINK/STATIC_STABLE/ENV_FALLBACK/UNKNOWN → count
  priceStatuses: Record<string, number>;  // OK/NO_QUOTE/QUOTE_PRICE_UNKNOWN/... → count
  maxAgeSec:     number | null;           // max quotePriceAgeSec din sample
  warnings:      string[];
}

const QUOTE_HEALTH_CHAINS = ["ethereum", "base", "arbitrum", "bsc"] as const;
const QUOTE_SAMPLE_SIZE   = 500;

/**
 * Samplez top QUOTE_SAMPLE_SIZE pairs din indexer registry per chain (by ts ZSET).
 * Numără distribuția quotePriceSource și priceStatus — fără SCAN, safe.
 */
export async function readQuotePriceHealth(): Promise<Record<string, QuotePriceChainHealth>> {
  const r = getRedis();
  if (!r) return {};
  const now = Date.now();
  const result: Record<string, QuotePriceChainHealth> = {};

  for (const chain of QUOTE_HEALTH_CHAINS) {
    try {
      const addrs = await r.zrevrange(`preflight:indexed:pairs:ts:${chain}`, 0, QUOTE_SAMPLE_SIZE - 1);
      if (!addrs.length) continue;

      const pipe = r.pipeline();
      for (const addr of addrs) pipe.get(`preflight:indexed:pair:${chain}:${addr}`);
      const results = await pipe.exec();
      if (!results) continue;

      const sources:       Record<string, number> = {};
      const priceStatuses: Record<string, number> = {};
      let maxAgeSec:     number | null = null;
      let parsed         = 0;
      let unknownOkCount = 0;

      for (const [err, raw] of results) {
        if (err || !raw) continue;
        // E8c: validare de formă (câmpuri opționale tipate) — un `quotePriceSource:123`/`priceStatus:{}`
        // nu se mai scurge în distribuția sources/priceStatuses; payload non-obiect → skip (fost `catch`).
        const p = parseWithSchema<{
          quotePriceSource?:    string;
          quotePriceAgeSec?:    number;   // E11: frozen age-at-enrichment (fallback pt. intrări legacy)
          quotePriceCheckedAt?: number;   // E11: timestamp ABSOLUT — vârsta CURENTĂ = now - checkedAt
          pricedAt?:            number;   // E11: pt. fallback-ul legacy — frozen + timpul scurs de la pricedAt
          priceStatus?:         string;
        } | null>(raw as string, QuotePriceHealthEntrySchema, null);
        if (p === null) continue; // payload malformat → skip
        parsed++;
        const src = p.quotePriceSource ?? "UNKNOWN";
        const ps  = p.priceStatus ?? "MISSING";
        sources[src]       = (sources[src] ?? 0) + 1;
        priceStatuses[ps]  = (priceStatuses[ps] ?? 0) + 1;
        if (src === "UNKNOWN" && ps === "OK") unknownOkCount++;
        // E11: vârsta CURENTĂ (checkedAt absolut, îmbătrânește) — nu age-at-write înghețat care ascundea staleness.
        const age = quotePriceCurrentAgeSec(p, now);
        if (age !== null) {
          maxAgeSec = maxAgeSec === null ? age : Math.max(maxAgeSec, age);
        }
      }

      const warnings: string[] = [];
      const envCount        = sources["ENV_FALLBACK"] ?? 0;
      if (unknownOkCount > 0)                           warnings.push(`${unknownOkCount} OK-priced pairs with UNKNOWN quote source`);
      if (envCount > parsed * 0.1 && parsed > 10)      warnings.push(`${envCount} pairs using ENV_FALLBACK (>${Math.round(envCount / parsed * 100)}%)`);
      if (maxAgeSec !== null && maxAgeSec > 600)        warnings.push(`max current quote-price age=${maxAgeSec}s — possible stale prices`);

      result[chain] = { sampleSize: parsed, sources, priceStatuses, maxAgeSec, warnings };
    } catch { /* ignoră chain errors */ }
  }

  return result;
}

// ── 6.10: Trending movers reader ─────────────────────────────────────────────

export interface MoverEntry {
  chain:          string;
  pairAddress:    string;
  tokenAddress:   string | null;
  symbol:         string;
  dexType:        string;
  priceUsd:       number;
  reserveUsd:     number;
  priceChange5m:  number | null;
  priceChange1h:  number | null;
  priceChange24h: number | null;
  direction:      "UP" | "DOWN" | "FLAT";
  historyStatus:  "WARMING_UP" | "PARTIAL" | "READY";
  snapshotCount:  number;
  ts:             number;
}

/**
 * Citește movers per chain din preflight:trending:movers:{chain}.
 * Returnează [] dacă nu există date (shadow mode sau primul ciclu).
 */
export async function readTrendingMovers(chain: string): Promise<MoverEntry[]> {
  const r = getRedis();
  if (!r) return [];
  try {
    const raw = await r.get(REDIS_KEYS.trendingMovers(chain));
    if (!raw) return [];
    // E8c: ARRAY de MoverEntry validat (enum direction/historyStatus). Payload non-array/malformat → [].
    return parseWithSchema<MoverEntry[]>(raw, MoversArraySchema, [], REDIS_KEYS.trendingMovers(chain));
  } catch { return []; }
}

// ── 8.0i: Solana indexer readers ─────────────────────────────────────────────

export interface SolanaHealthData {
  workerOnline:   boolean;
  slot:           number | null;
  cursor:         number | null;
  blocksBehind:   number | null;
  status:         "OK" | "DEGRADED" | "BEHIND" | "STARTING" | "OFFLINE";
  indexerVersion: string | null;
  ageSec:         number | null;
}

export interface SolanaIndexerStats {
  health:              SolanaHealthData;
  indexedPools:        number;
  indexedLaunches:     number;
  trackedPricePools:   number;
  moversStatus:        "READY" | "EMPTY" | "STALE";
  moversCount:         number;
  moversComputedAgeSec: number | null;
  coverage:            "SAMPLED";
}

export interface SolanaMoverItem {
  poolAddress:      string;
  // "unknown"/"UNKNOWN" sunt fallback-uri defensive de coercion (Redis poate
  // avea date malformate dintr-o versiune veche de worker) — nu valori reale
  // scrise vreodată de moversTracker.ts.
  program:          PreflightSolanaProgram | "unknown";
  baseSymbol:       string;
  quoteSymbol:      string;
  priceInQuote:     number;
  priceUsd:         number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  sampleCount:      number;
  historyStatus:    PreflightSolanaHistoryStatus | "UNKNOWN";
  knownPool:        boolean;
  currentAgeSec:    number;
}

export interface SolanaMoversData {
  computedAgeSec: number;
  totalTracked:   number;
  coverage:       "SAMPLED";
  source:         "SWAP_VAULT_DELTA";
  items:          SolanaMoverItem[];
}

export interface SolanaRecentPool {
  poolAddress: string;
  program:     string;
  baseSymbol:  string | null;
  quoteSymbol: string | null;
  quoteType:   PreflightSolanaQuoteType | null;
  discoveredAt: number;
}

export interface SolanaRecentLaunch {
  mint:        string;
  symbol:      string | null;
  bondingCurve: string | null;
  discoveredAt: number;
}

/**
 * Citeste health + stats indexer Solana fara KEYS scan.
 * Toate citirile sunt ZCARD / GET directe.
 */
export async function readSolanaIndexerStats(now: number): Promise<SolanaIndexerStats> {
  const r = getRedis();
  if (!r) {
    return {
      health: { workerOnline: false, slot: null, cursor: null, blocksBehind: null, status: "OFFLINE", indexerVersion: null, ageSec: null },
      indexedPools: 0, indexedLaunches: 0, trackedPricePools: 0,
      moversStatus: "EMPTY", moversCount: 0, moversComputedAgeSec: null,
      coverage: "SAMPLED",
    };
  }

  const [healthRaw, indexedPools, indexedLaunches, trackedPricePools, moversRaw] = await Promise.all([
    r.get("preflight:indexer:health:solana"),
    r.zcard("preflight:indexed:pairs:solana"),
    r.zcard("preflight:indexed:launches:solana"),
    // E12: NU zcard (ZSET-ul price:pools nu se prune-uiește → număr monoton, supra-raportat). Numărăm doar
    // pool-urile ACTIVE în ultimele 2h (score = lastUpdatedAt ms). Worker-ul prune-uiește restul (ZREMRANGEBYSCORE).
    r.zcount("preflight:solana:price:pools", pricePoolsWindowStart(now), "+inf"),
    r.get("preflight:trending:movers:solana"),
  ]);

  let health: SolanaHealthData;
  if (!healthRaw) {
    health = { workerOnline: false, slot: null, cursor: null, blocksBehind: null, status: "OFFLINE", indexerVersion: null, ageSec: null };
  } else {
    // fallback null => tratat identic cu !healthRaw mai jos (un blob corupt
    // nu trebuie să crape tot chain report-ul, doar să arate Solana OFFLINE).
    // Partial<> — nominal shape e PreflightSolanaHealth, dar tratăm fiecare câmp ca
    // posibil lipsă/malformat (SolanaHealthSchema lasă câmpurile lejere/passthrough).
    const h = parseWithSchema<Partial<PreflightSolanaHealth> | null>(healthRaw, SolanaHealthSchema, null, "preflight:indexer:health:solana");
    if (!h) {
      health = { workerOnline: false, slot: null, cursor: null, blocksBehind: null, status: "OFFLINE", indexerVersion: null, ageSec: null };
    } else {
      // SolanaHealthSchema acceptă updatedAt ca number|string (nu-i verifică VALIDITATEA)
      // — dacă updatedAt lipsește sau e un timestamp invalid, Date.parse/getTime dă NaN, care
      // altfel s-ar fi scurs în ageSec/workerOnline/status fără avertisment.
      const rawUpdatedAt = h.updatedAt;
      const updatedAtMs  = typeof rawUpdatedAt === "number"
        ? rawUpdatedAt
        : Date.parse(String(rawUpdatedAt ?? ""));
      // E13: safeAgeSec — updatedAt serios în viitor → null → workerOnline false / status OFFLINE (nu „0s online").
      const ageSec = safeAgeSec(now, Number.isFinite(updatedAtMs) ? updatedAtMs : null);

      // Redis poate conține orice string pe `status` — SolanaHealthSchema îl lasă
      // `z.string()` (passthrough), NU enum. Fără check-ul de aici, o valoare stray
      // (ex: dintr-o versiune veche de worker) s-ar scurge mai departe ca
      // "status" invalid în raport.
      const validStatuses = new Set<SolanaHealthData["status"]>(
        ["OK", "DEGRADED", "BEHIND", "STARTING", "OFFLINE"],
      );
      const rawStatus    = String(h.status ?? "STARTING");
      const parsedStatus = validStatuses.has(rawStatus as SolanaHealthData["status"])
        ? (rawStatus as SolanaHealthData["status"])
        : "STARTING";

      health = {
        workerOnline:   ageSec !== null && ageSec < 5 * 60,
        slot:           h.latestSlot  ?? null,
        cursor:         h.cursorSlot  ?? null,
        blocksBehind:   h.behindSlots ?? null,
        status:         ageSec === null || ageSec >= 5 * 60 ? "OFFLINE" : parsedStatus,
        indexerVersion: h.indexerVersion ?? null,
        ageSec,
      };
    }
  }

  let moversStatus: "READY" | "EMPTY" | "STALE" = "EMPTY";
  let moversCount = 0;
  let moversComputedAgeSec: number | null = null;

  if (moversRaw) {
    const snap = parseWithSchema<{ computedAt?: number; movers?: unknown[] } | null>(
      moversRaw, SolanaMoversSnapshotSchema, null, "preflight:trending:movers:solana",
    );
    if (snap) {
      // computedAt lipsă/invalid nu trebuie să dea o vârstă falsă de ~56 ani
      // (now - 0) — tratăm asta la fel ca "fără date", nu ca "extrem de stale".
      const computedAt = typeof snap.computedAt === "number" && Number.isFinite(snap.computedAt)
        ? snap.computedAt
        : null;

      // E13: safeAgeSec — computedAt serios în viitor → null → moversStatus EMPTY (nu READY fals).
      moversComputedAgeSec = safeAgeSec(now, computedAt);
      moversCount   = Array.isArray(snap.movers) ? snap.movers.length : 0;
      moversStatus  = moversComputedAgeSec === null
        ? "EMPTY"
        : moversComputedAgeSec > 10 * 60 ? "STALE" : moversCount > 0 ? "READY" : "EMPTY";
    }
  }

  return { health, indexedPools, indexedLaunches, trackedPricePools, moversStatus, moversCount, moversComputedAgeSec, coverage: "SAMPLED" };
}

/**
 * Citeste sampled Solana movers din preflight:trending:movers:solana.
 * Returneaza null daca nu exista date sau sunt stale (>10m).
 */
export async function readSolanaMovers(now: number, topN = 5): Promise<SolanaMoversData | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get("preflight:trending:movers:solana");
    if (!raw) return null;
    // Partial<> — nominal shape e PreflightSolanaMoversSnapshot, dar tratăm
    // fiecare câmp ca posibil lipsă/malformat (Redis poate avea date scrise
    // de o versiune veche de worker) — de-a asta coercion-ul manual de mai jos
    // rămâne, chiar tipat; SolanaMoversSnapshotSchema validează forma, nu fiecare câmp intern.
    const snap = parseWithSchema<Partial<PreflightSolanaMoversSnapshot> | null>(raw, SolanaMoversSnapshotSchema, null, "preflight:trending:movers:solana");
    if (!snap) return null;
    // computedAt lipsă/invalid → NaN s-ar fi scurs mai departe fără să
    // treacă de verificarea de staleness de mai jos (NaN > 600 e false).
    // Tratăm ca "fără date", la fel ca healthRaw lipsă.
    if (typeof snap.computedAt !== "number" || !Number.isFinite(snap.computedAt)) return null;
    // E13: safeAgeSec — computedAt serios în viitor → null → tratat ca „fără date" (return null), nu READY.
    const computedAgeSec = safeAgeSec(now, snap.computedAt);
    if (computedAgeSec === null || computedAgeSec > 10 * 60) return null;

    return {
      computedAgeSec,
      totalTracked: snap.totalTracked ?? 0,
      coverage:     "SAMPLED",
      source:       "SWAP_VAULT_DELTA",
      items: (snap.movers ?? []).slice(0, topN).map((m: Partial<PreflightSolanaMover>) => {
        // E38: currentAgeSec/historyStatus au fost calculate la compute-time; adaugă offset-ul read-time
        // (computedAgeSec) și re-derivă STALE dacă vârsta efectivă trece pragul de 10m.
        const adjusted = adjustMoverReadTime(
          Number(m.currentAgeSec ?? 0),
          m.historyStatus ?? "UNKNOWN",
          computedAgeSec,
        );
        return {
          poolAddress:      String(m.poolAddress ?? ""),
          program:          m.program ?? "unknown",
          baseSymbol:       String(m.baseSymbol  ?? "?"),
          quoteSymbol:      String(m.quoteSymbol ?? "?"),
          priceInQuote:     Number(m.priceInQuote ?? 0),
          priceUsd:         typeof m.priceUsd         === "number" ? m.priceUsd         : null,
          priceChange5mPct: typeof m.priceChange5mPct === "number" ? m.priceChange5mPct : null,
          priceChange1hPct: typeof m.priceChange1hPct === "number" ? m.priceChange1hPct : null,
          sampleCount:      Number(m.sampleCount   ?? 0),
          historyStatus:    adjusted.historyStatus,
          knownPool:        Boolean(m.knownPool),
          currentAgeSec:    adjusted.currentAgeSec,
        };
      }),
    };
  } catch { return null; }
}

/**
 * Citeste ultimele N pooluri + launche-uri indexate pe Solana.
 * Foloseste ZREVRANGE (score = discoveredAt ms) — fara KEYS.
 */
export async function readSolanaRecentActivity(topN = 5): Promise<{
  recentPools:   SolanaRecentPool[];
  recentLaunches: SolanaRecentLaunch[];
}> {
  const r = getRedis();
  if (!r) return { recentPools: [], recentLaunches: [] };
  try {
    const [poolAddrs, launchMints] = await Promise.all([
      r.zrevrange("preflight:indexed:pairs:ts:solana",   0, topN - 1, "WITHSCORES"),
      r.zrevrange("preflight:indexed:launches:ts:solana", 0, topN - 1, "WITHSCORES"),
    ]);

    // WITHSCORES returneaza [addr, score, addr, score, ...] alternating
    const poolPairs:   [string, number][] = [];
    const launchPairs: [string, number][] = [];
    for (let i = 0; i < poolAddrs.length;   i += 2) poolPairs.push([poolAddrs[i],   Number(poolAddrs[i + 1])]);
    for (let i = 0; i < launchMints.length; i += 2) launchPairs.push([launchMints[i], Number(launchMints[i + 1])]);

    // Fetch metadata in parallel
    const [poolRaws, launchRaws] = await Promise.all([
      poolPairs.length   ? r.mget(poolPairs.map(([addr])  => `preflight:indexed:pair:solana:${addr}`))   : Promise.resolve([]),
      launchPairs.length ? r.mget(launchPairs.map(([mint]) => `preflight:indexed:launch:solana:${mint}`)) : Promise.resolve([]),
    ]);

    const recentPools: SolanaRecentPool[] = poolPairs.map(([addr, ts], i) => {
      const meta = poolRaws[i] ? parseWithSchema<PreflightSolanaPool | null>(poolRaws[i], SolanaPoolSchema, null, `preflight:indexed:pair:solana:${addr}`) : null;
      return {
        poolAddress:  addr,
        program:      meta?.program     ?? "unknown",
        baseSymbol:   meta?.baseSymbol  ?? null,
        quoteSymbol:  meta?.quoteSymbol ?? null,
        quoteType:    meta?.quoteType   ?? null,
        discoveredAt: ts,
      };
    });

    const recentLaunches: SolanaRecentLaunch[] = launchPairs.map(([mint, ts], i) => {
      // NF2/U9: normalizează recordul (legacy sau curent) în union-ul curent — NU mai facem `as
      // PreflightSolanaLaunch` peste un JSON.parse (cast care supra-promitea pt. cele ~13.980 legacy).
      // Un record de neîntors (câmp factual lipsă / graduation contradictorie) → null + warn (fail-closed,
      // ca vechiul parseWithSchema). Un legacy valid → normalizat determinist (PUMPFUN/RAYDIUM), fără invenție.
      let meta: PreflightSolanaLaunch | null = null;
      if (launchRaws[i]) {
        const norm = classifySolanaLaunchNormalization(launchRaws[i]);
        meta = norm.value;
        if (norm.outcome === "rejected") {
          console.warn(`[REDIS NORMALIZE] key:preflight:indexed:launch:solana:${mint} — rejected (${norm.reason}), using null`);
        }
      }
      return {
        mint,
        symbol:       meta?.symbol ?? null,
        // `bondingCurve` (fără sufix) nu a fost niciodată scris de launchWriter.ts —
        // doar `bondingCurveAddress`. Fallback-ul vechi (`?? meta?.bondingCurve`)
        // era cod mort; eliminat. Cu meta acum tipat, un `bondingCurve` inexistent
        // ar da eroare tsc, nu o valoare `undefined` tăcută.
        bondingCurve: meta?.bondingCurveAddress ?? null,
        discoveredAt: ts,
      };
    });

    return { recentPools, recentLaunches };
  } catch { return { recentPools: [], recentLaunches: [] }; }
}

// ── 8.0l: Solana per-pool context ────────────────────────────────────────────

export interface SolanaPoolContext {
  poolAddress:       string;
  // Toate câmpurile tipate acum contra @preflight/schema — registry/
  // observedCandidate (6a), priceSnapshot/recentHistory (6c), activity (6d).
  registry:          PreflightSolanaPool | null;
  priceSnapshot:     PreflightSolanaPriceSnapshot | null;
  activity:          PreflightSolanaPoolActivity | null;
  recentHistory:     PreflightSolanaPricePoint[];
  observedCandidate: PreflightObservedCandidate | null;
  dataAgeSec:        number | null;
}

/**
 * Citeste tot ce stim despre un pool Solana: registry + price snapshot + activity + history.
 * Toate citirile sunt GET directe - fara KEYS scan.
 */
export async function readSolanaPoolContext(
  poolAddress: string,
  now:         number,
): Promise<SolanaPoolContext> {
  const r = getRedis();
  if (!r) {
    return {
      poolAddress, registry: null, priceSnapshot: null,
      activity: null, recentHistory: [], observedCandidate: null, dataAgeSec: null,
    };
  }

  const [regRaw, snapRaw, actRaw, histRaws, candRaw] = await Promise.all([
    r.get(`preflight:indexed:pair:solana:${poolAddress}`),
    r.get(`preflight:solana:price:${poolAddress}`),
    r.get(`preflight:solana:activity:${poolAddress}`),
    r.lrange(`preflight:solana:price:history:${poolAddress}`, 0, 9),
    r.get(`preflight:solana:observed_candidate:${poolAddress}`),
  ]);

  const registry      = regRaw  ? parseWithSchema<PreflightSolanaPool | null>(regRaw,  SolanaPoolSchema, null, `preflight:indexed:pair:solana:${poolAddress}`) : null;
  const priceSnapshot = snapRaw ? parseWithSchema<PreflightSolanaPriceSnapshot | null>(snapRaw, SolanaPriceSnapshotSchema, null, `preflight:solana:price:${poolAddress}`) : null;
  const activity       = actRaw ? parseWithSchema<PreflightSolanaPoolActivity | null>(actRaw, SolanaPoolActivitySchema, null, `preflight:solana:activity:${poolAddress}`) : null;
  const recentHistory = histRaws
    .map(h => parseWithSchema<PreflightSolanaPricePoint | null>(h, SolanaPricePointSchema, null))
    .filter((h): h is PreflightSolanaPricePoint => h !== null);
  const observedCandidate = candRaw ? parseWithSchema<PreflightObservedCandidate | null>(candRaw, SolanaObservedCandidateSchema, null, `preflight:solana:observed_candidate:${poolAddress}`) : null;

  const lastUpdatedAt =
    typeof priceSnapshot?.lastUpdatedAt === "number" &&
    Number.isFinite(priceSnapshot.lastUpdatedAt)
      ? priceSnapshot.lastUpdatedAt
      : null;
  // E13: safeAgeSec — un timestamp SERIOS în viitor (clock skew, bug de scriere) → null (necunoscut), NU 0.
  // Vechea variantă (Math.max(0,…)) transforma „30s în viitor" în „0s" → trecea drept HIGH confidence în
  // pair-context-report.ts (`dataAgeSec < 45`). Acum viitorul → null → NU HIGH.
  const dataAgeSec = safeAgeSec(now, lastUpdatedAt);

  return { poolAddress, registry, priceSnapshot, activity, recentHistory, observedCandidate, dataAgeSec };
}
