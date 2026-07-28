/**
 * workers/solana/src/index.ts
 * Entry point indexer-solana.
 * 8.0f: Token metadata enrichment async după pool insert.
 * 8.0g-a6: CLMM pool discovery live — CreatePool + CreateCustomizablePool → Redis.
 * 8.0g-b1: pump.fun shadow diagnostics — observa instructiuni + account layouts.
 * 8.0g-b3: pump.fun launch registry — CreateV2 → Redis (SET NX, no TTL) + async enrichment.
 * 8.0g-b4: fix fetcher — cauta in outer+inner (v0 tx outer vine ca ParsedInstruction).
 * 8.0g-b5: Jupiter exact match only, global 429 cooldown, enrichment delayed 30s/2m/10m.
 * 8.0g-b6: support legacy pump.fun Create shape=14 (alaturi de CreateV2 shape=16).
 * 8.0h-a:  migration linking — pump.fun launch → Raydium pool (via pairWriter → launchWriter).
 * 8.0h-b1: Raydium swap shadow classifier — CPMM + CLMM swap instruction stats + account layouts.
 * 8.0h-b2: Dry-run swap parser — pool/mint/flow/amounts din TX (zero Redis writes).
 * 8.0h-b3: Pool activity state — Redis per pool (sampledSwaps5m, sampledQuoteIn/Out5m, lastSwapAt).
 * 8.0h-b4: Price snapshots — priceInQuote + priceUsd din vault deltas per known pool.
 * 8.0h-b5: Sampled price history — ring buffer + ZSET index + movers computation (preflight:trending:movers:solana).
 * 8.0j:    SOL/USD oracle via Jupiter Price API v2 — priceUsd populat pentru WSOL-quoted pools.
 * 8.0k-a:  knownPool stale sync fix — pairWriter patch snapshot + moversTracker batch recheck.
 * 8.0k-b:  observed pool candidate promotion — swap-sampled pools promovate în registry după 3 samples/2min.
 * 8.0l:    MCP tools Solana branch — tp_pair_context + tp_preflight_safety Solana-aware.
 * 8.0m:    Debt sweep — registry permanent (no TTL), atomic cursor Lua, health clamp, defensive log match.
 * C6:      Coadă durabilă de discovery — candidatul e enqueue-uit ÎNAINTE de fetch/write; drain cu
 *          retry+dead-letter (crash-safe); OBSERVED vs PROCESSED slot; health onest (dead-letter/backlog).
 */

import type Redis from "ioredis";
import { getSolanaRpcUrl, getSolanaWsUrl, getSlot, getVersion, getConnection } from "./infra/rpc";
import { getRedis }                 from "./infra/redis";
import {
  readObservedSlot, advanceObservedSlot,
  readProcessedSlot, readLastProcessedAt, advanceProcessedSlot,
} from "./infra/cursor";
import { buildHealth, writeHealth } from "./infra/health";
import { recordProgramLog, snapshotProgramFreshness, computeProgramHealth, hasCriticalEvidence } from "./infra/programFreshness";
import { isWsStalled } from "./infra/wsWatchdog";
import { startLogSubscriptions, DISCOVERY_PROGRAM_HEALTH, type LogEvent } from "./discovery/logSubscriber";
import { runDiscoveryCallback } from "./discovery/discoveryCallback";
import { handleAmmV4Shadow, logAmmV4Stats, isScopedAmmV4InitLog } from "./discovery/ammV4Shadow";
import { fetchAmmV4Init } from "./discovery/ammV4Fetcher";
import { isCpmmInitLog, fetchCpmmInit } from "./discovery/txFetcher";
import { buildSolanaPool, writeSolanaPool, enrichSolanaPool } from "./discovery/pairWriter";
import type { PreflightSolanaProgram } from "@preflight/schema";
import { runCpmmBackfill }          from "./discovery/backfillCpmm";
import { handleClmmShadow, logClmmStats } from "./discovery/clmmShadow";
import { handleSwapShadow, logSwapStats } from "./discovery/swapShadow";
import { isClmmCreateLog, fetchClmmCreate } from "./discovery/clmmFetcher";
import { handlePumpfunShadow, logPumpfunStats } from "./discovery/pumpfunShadow";
import { isPumpfunCreateLog, fetchPumpfunCreate } from "./discovery/pumpfunFetcher";
import { buildLaunchRecord, writeLaunchRecord, enrichLaunchRecord } from "./discovery/launchWriter";
import { resolveTokenMeta }         from "./infra/tokenMetadata";
import { startSolPriceOracle }      from "./infra/solPriceOracle";
import {
  enqueueCandidate, claimDueCandidates, reclaimExpiredCandidates,
  markCandidateDone, markCandidateFailed, decodeCandidate, discoveryQueueStats,
  queueActionFor, quarantineUnsupported,
  DISC_LEASE_MS, DISC_DRAIN_BATCH, DISC_DRAIN_CONCURRENCY, DISC_DRAIN_INTERVAL_MS,
  type DiscoveryProgram, type DiscoveryCandidate, type CandidateOutcome,
} from "./discovery/discoveryQueue";
import {
  CHAIN, INDEXER_VERSION, POLL_INTERVAL_MS, KEY_PAIRS,
  PROGRAM_STALE_MS, PROGRAM_STARTUP_GRACE_MS, SOLANA_WS_STALL_MS,
} from "./config/constants";
import {
  RAYDIUM_AMM_V4, RAYDIUM_CLMM, RAYDIUM_CPMM, PUMPFUN_PROGRAM,
} from "./config/programs";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Dedupe ───────────────────────────────────────────────────────────────────
// C6 (fix varu — blocker): NU mai dedupăm in-proces ÎNAINTE de enqueue. Un dedupe in-memory care
// marca „văzut" înainte ca enqueue-ul Redis să confirme putea PIERDE candidatul: dacă enqueue pică,
// cheia era deja în set → o redelivery WS era respinsă → pierdut permanent. Acum ZADD NX din coadă
// (enqueueCandidate) e dedupe-ul AUTORITATIV — idempotent la redelivery (writeSolanaPool → "exists"),
// și nu marchează nimic „văzut" până Redis nu confirmă.

// ── Stats ────────────────────────────────────────────────────────────────────
const stats = { events: 0, cpmmTotal: 0, clmmTotal: 0, ammV4Total: 0, pumpfunTotal: 0, deduped: 0, candidates: 0, fetched: 0, inserted: 0, launchesInserted: 0, dead: 0, invalid: 0, unsupported: 0, errors: 0, callbackErrors: 0 };

function logStats(): void {
  console.log(
    "[SOLANA][STATS]"
    + " events=" + stats.events
    + " deduped=" + stats.deduped
    + " candidates=" + stats.candidates
    + " fetched=" + stats.fetched
    + " inserted=" + stats.inserted
    + " launchesInserted=" + stats.launchesInserted
    + " dead=" + stats.dead
    + " invalid=" + stats.invalid
    + " unsupported=" + stats.unsupported
    + " cpmmTotal=" + stats.cpmmTotal
    + " clmmTotal=" + stats.clmmTotal
    + " ammV4Total=" + stats.ammV4Total
    + " pumpfunTotal=" + stats.pumpfunTotal
    + " errors=" + stats.errors
    + " callbackErrors=" + stats.callbackErrors,
  );
  logClmmStats();
  logPumpfunStats();
  logSwapStats();
  logAmmV4Stats();
}

// ── Health loop ──────────────────────────────────────────────────────────────
// `subscriptionsStartedAt` (D2): grația de freshness se raportează la momentul PORNIRII subscripțiilor,
// NU la pornirea procesului — altfel un backfill lung (rulat înainte) ar consuma grația și programele
// abia conectate ar fi marcate stale imediat.
async function healthLoop(nodeVersion: string, subscriptionsStartedAt: number): Promise<void> {
  let statsTick = 0;
  const redis = getRedis();
  while (true) {
    try {
      const latestSlot = await getSlot();
      const [observedSlot, processedSlot, lastProcessedAt, queueStats] = await Promise.all([
        readObservedSlot(),
        readProcessedSlot(),
        readLastProcessedAt(),
        discoveryQueueStats(redis, CHAIN),
      ]);
      // D2: freshness per-program (subscripție WS) — un program CRITIC mort tăcut e detectat aici, chiar
      // dacă `behindSlots` rămâne mic pentru că alte programe avansează observed slot.
      const now = Date.now();
      const programHealth = computeProgramHealth(
        snapshotProgramFreshness(), DISCOVERY_PROGRAM_HEALTH,
        { now, startedAt: subscriptionsStartedAt, staleMs: PROGRAM_STALE_MS, graceMs: PROGRAM_STARTUP_GRACE_MS },
      );
      // D2 (edge restart): la un restart, `observedSlot` vine persistent din Redis (procesul vechi), dar
      // trackerul e gol → fără dovadă de viață din procesul CURENT, statusul e STARTING, nu OK-ul fantomă.
      const hasCurrentCriticalEvidence = hasCriticalEvidence(programHealth.perProgram);
      const health = buildHealth(
        latestSlot, observedSlot, processedSlot, lastProcessedAt, queueStats, programHealth, hasCurrentCriticalEvidence, nodeVersion,
      );
      await writeHealth(health);
      if (programHealth.staleCount > 0) {
        console.warn("[SOLANA] STALE PROGRAMS: " + programHealth.perProgram.filter(p => p.stale).map(p => p.program).join(","));
      }

      // D1: hard-stall al WS-ului. web3.js multiplexează toate subscripțiile onLogs peste UN singur socket;
      // dacă TOATE programele critice au tăcut > SOLANA_WS_STALL_MS, socketul comun e mort (nu o tăcere
      // parțială = D2/DEGRADED). Vârsta de tăcere a unui program niciodată văzut = vârsta sesiunii
      // (`now - subscriptionsStartedAt`) — altfel un critic rămas `null` ar masca stall-ul total pe veci,
      // inclusiv un socket mort de la startup. Reparația subscripție-cu-subscripție într-un proces wedged nu
      // ajută → scriem health-ul (mai sus, ca ops să vadă ultima stare) apoi exit(1) → process manager
      // repornește curat cu un Connection nou. Verificat DUPĂ writeHealth: ultima stare e persistată.
      if (isWsStalled(programHealth.perProgram, SOLANA_WS_STALL_MS, now - subscriptionsStartedAt)) {
        const diag = programHealth.perProgram.filter(p => p.critical).map(p => p.program + "=" + (p.lastLogAgeMs ?? (now - subscriptionsStartedAt)) + "ms").join(",");
        console.error(
          "[SOLANA] WS HARD STALL — toate programele critice tăcute > " + SOLANA_WS_STALL_MS + "ms (" + diag + ")"
          + " → exit(1) pentru reconnect curat via process manager",
        );
        process.exit(1);
      }

      const behind = observedSlot !== null ? Math.max(0, latestSlot - observedSlot) : "?";
      console.log(
        "[SOLANA] latest:" + latestSlot
        + " | observed:" + (observedSlot ?? "null")
        + " | behind:" + behind
        + " | q(pend/proc/dead):" + queueStats.pending + "/" + queueStats.processing + "/" + queueStats.dead
        + " | status:" + health.status,
      );

      if (++statsTick % 6 === 0) logStats();
    } catch (err) {
      console.error("[SOLANA] health loop error:", (err as Error).message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// ── Write comun pt. pool-urile Raydium (cpmm/clmm/amm_v4) ─────────────────────
// `parsed` e param CONST (non-null) → narrowing-ul se păstrează în callback-ul async. (Un `let result`
// verificat cu `if (!result)` și apoi capturat într-un `.then()` ar da „'result' is possibly null" la tsc.)
async function writeDiscoveredPool(
  program:   PreflightSolanaProgram,
  parsed:    { poolAddress: string; mint0: string; mint1: string },
  slot:      number,
  signature: string,
): Promise<CandidateOutcome> {
  const pool = buildSolanaPool(parsed.poolAddress, parsed.mint0, parsed.mint1, slot, signature, program, "LIVE");

  const outcome = await writeSolanaPool(pool);
  if (outcome === "error") return { kind: "retry" };

  if (outcome === "inserted") {
    stats.inserted++;
    console.log(
      "[SOLANA][POOL] " + program + " inserted"
      + " pool=" + parsed.poolAddress.slice(0, 8) + "..."
      + " base=" + pool.baseMint.slice(0, 8) + "..."
      + " quote=" + pool.quoteMint.slice(0, 8) + "..."
      + " quoteType=" + pool.quoteType
      + " slot=" + slot,
    );
    // Enrichment async — non-blocking, nu întârzie drain-ul
    Promise.all([
      resolveTokenMeta(pool.baseMint),
      resolveTokenMeta(pool.quoteMint),
    ]).then(([baseMeta, quoteMeta]) => {
      console.log(
        "[SOLANA][META] enriched"
        + " pool=" + parsed.poolAddress.slice(0, 8) + "..."
        + " base=" + baseMeta.symbol + "(" + baseMeta.source + ")"
        + " quote=" + quoteMeta.symbol + "(" + quoteMeta.source + ")",
      );
      return enrichSolanaPool(pool, baseMeta, quoteMeta);
    }).catch((err: Error) => {
      console.error("[SOLANA][META] enrichment error:", err.message);
    });
  }
  return { kind: "written" };
}

// ── Procesare candidat (dispatch pe program) ──────────────────────────────────
// Întoarce un `CandidateOutcome`; `queueActionFor` (pur) mapează la acțiunea pe coadă (vezi drain):
//   written     — record scris durabil → ack + avansează PROCESSED slot
//   retry       — write "error" / excepție / fetch UNAVAILABLE → markFailed (backoff → dead-letter la MAX)
//   invalid     — tx ADUS dar sigur nu-i o creare → ACK. pump.fun: FAILED_TX/NO_PUMPFUN_IX/NO_CREATE_IX;
//                 AMM V4 (D4c): FAILED_TX; cpmm/clmm: n/a (fetcher-ele întorc doar {…}|null).
//   unsupported — quarantine durabil + ACK (posibilă variantă nouă = creare reală; păstrează dovada, NU
//                 dead-letter). pump.fun (NF3.1): KNOWN_LAYOUT_GUARDS_FAILED/UNKNOWN_CREATE_DISCRIMINATOR;
//                 AMM V4 (D4c): AMBIGUOUS_INIT2/UNKNOWN_INIT2_LAYOUT/KNOWN_LAYOUT_GUARDS_FAILED/INIT2_EVIDENCE_MISMATCH.
// Înainte, `null` conflă „RPC n-a livrat" cu „nu-i candidat" ȘI cu „variantă nouă" → dead-letter fals ca
// „pierdere reală" (health DEGRADED blocat) SAU variante reale aruncate tăcut.
async function processCandidate(
  connection: ReturnType<typeof getConnection>,
  candidate:  DiscoveryCandidate,
): Promise<CandidateOutcome> {
  const { program, slot, signature } = candidate;
  stats.fetched++;
  try {
    if (program === "pumpfun") {
      const fetched = await fetchPumpfunCreate(connection, signature);
      if (fetched.status === "unavailable") return { kind: "retry" }; // RPC n-a livrat → tranzitoriu

      if (fetched.status === "unsupported") {
        // Instrucțiune pump.fun găsită dar neparsată → posibilă variantă nouă (account count-ul NU e versiunea).
        // NU o arunca ca invalid — o marcăm `unsupported` → drain-ul o pune în quarantine durabil.
        console.warn(
          "[SOLANA][PUMPFUN][UNSUPPORTED] sig=" + signature.slice(0, 12)
          + " reason=" + fetched.reason
          + " accountCounts=" + fetched.accountCounts.join(",")
          + " (posibilă variantă nouă → quarantine) slot=" + slot,
        );
        return { kind: "unsupported", accountCounts: fetched.accountCounts, reason: fetched.reason };
      }

      if (fetched.status === "invalid") {
        // Sigur nu-i o creare de indexat: NO_PUMPFUN_IX (0 ix pump.fun) / NO_CREATE_IX (doar buy/sell/extend,
        // niciun discriminator de creare + logul nu zice Create) / FAILED_TX (tx eșuată). → ACK.
        console.log(
          "[SOLANA][PUMPFUN][INVALID] sig=" + signature.slice(0, 12)
          + " reason=" + fetched.reason + " slot=" + slot,
        );
        return { kind: "invalid" };
      }

      const result  = fetched.result;
      const launch  = buildLaunchRecord(result, slot, signature);
      const outcome = await writeLaunchRecord(launch);
      if (outcome === "error") return { kind: "retry" };

      if (outcome === "inserted") {
        stats.launchesInserted++;
        console.log(
          "[SOLANA][LAUNCH] pumpfun inserted"
          + " mint=" + result.mint.slice(0, 8) + "..."
          + " bondingCurve=" + result.bondingCurveAddress.slice(0, 8) + "..."
          + " creator=" + result.creatorAddress.slice(0, 8) + "..."
          + " shape=" + result.instructionShape + " accounts=" + result.instructionAccountCount
          + " slot=" + slot,
        );
        // Enrichment async — non-blocking, delayed (30s/2m/10m), logging in launchWriter
        enrichLaunchRecord(launch).catch((err: Error) => {
          console.error("[SOLANA][LAUNCH][META] enrichment error:", err.message);
        });
      }
      return { kind: "written" };
    }

    // ── AMM V4 (D4c): fetch DISCRIMINAT — NU moștenește bug-ul null-polisemic reparat la pump.fun (NF3).
    // `unavailable`→retry, `invalid`(FAILED_TX)→ACK, `unsupported`(layout nou/ambiguu/guard picat/evidence-mismatch)→
    // quarantine durabil (dovadă), `ok`→scrie. Fără asta, un upgrade Raydium ar fi mers retry→dead-letter fals.
    if (program === "raydium_amm_v4") {
      const fetched = await fetchAmmV4Init(connection, signature);
      if (fetched.status === "unavailable") return { kind: "retry" };
      if (fetched.status === "invalid") {
        console.log("[SOLANA][AMMV4][INVALID] sig=" + signature.slice(0, 12) + " reason=" + fetched.reason + " slot=" + slot);
        return { kind: "invalid" };
      }
      if (fetched.status === "unsupported") {
        console.warn(
          "[SOLANA][AMMV4][UNSUPPORTED] sig=" + signature.slice(0, 12)
          + " reason=" + fetched.reason + " accountCounts=" + fetched.accountCounts.join(",")
          + " (posibil layout Raydium nou → quarantine) slot=" + slot,
        );
        return { kind: "unsupported", accountCounts: fetched.accountCounts, reason: fetched.reason };
      }
      return writeDiscoveredPool(program, fetched.result, slot, signature);
    }

    // ── CPMM | CLMM — fetcher-ele întorc {poolAddress,mint0,mint1}|null (null = tranzitoriu → retry).
    // SWITCH exhaustiv (fix bug latent `non-CPMM → CLMM`): pumpfun + amm_v4 tratate mai sus (return).
    let result: { poolAddress: string; mint0: string; mint1: string } | null;
    switch (program) {
      case "raydium_cpmm": result = await fetchCpmmInit(connection, signature);  break;
      case "raydium_clmm": result = await fetchClmmCreate(connection, signature); break;
      default: {
        const _never: never = program;
        console.error("[SOLANA][DISC-QUEUE] program necunoscut în processCandidate: " + String(_never));
        return { kind: "invalid" };
      }
    }
    if (!result) return { kind: "retry" };
    return writeDiscoveredPool(program, result, slot, signature);
  } catch (err) {
    stats.errors++;
    console.error(
      "[SOLANA][DISC-QUEUE] process error " + program + " sig=" + signature.slice(0, 12) + ":",
      (err as Error).message,
    );
    return { kind: "retry" };
  }
}

// ── Drain coadă discovery (background, guard + interval) ───────────────────────
async function drainDiscoveryQueue(
  redis:      Redis,
  connection: ReturnType<typeof getConnection>,
): Promise<void> {
  const now = Date.now();

  // 1) recuperare crash: lease-uri expirate → înapoi în pending
  const reclaimed = await reclaimExpiredCandidates(redis, CHAIN, now);
  if (reclaimed > 0) {
    console.log("[SOLANA][DISC-QUEUE] reclaimed=" + reclaimed + " (lease expirat → pending)");
  }

  // 2) claim ATOMIC due din pending
  const members = await claimDueCandidates(redis, CHAIN, now, DISC_LEASE_MS, DISC_DRAIN_BATCH);
  if (members.length === 0) return;

  // 3) worker-pool cu concurență mărginită (nu DRAIN_BATCH simultan)
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < members.length) {
      const member    = members[idx++];
      const candidate = decodeCandidate(member);
      if (!candidate) {
        // membru corupt (n-ar trebui să existe) — scoate-l, nu-l lăsa blocat în processing
        await markCandidateDone(redis, CHAIN, member);
        console.error("[SOLANA][DISC-QUEUE] membru corupt, scos: " + member.slice(0, 40));
        continue;
      }

      const res    = await processCandidate(connection, candidate);
      const action = queueActionFor(res); // policy PURĂ (testabilă)

      if (action === "fail") {
        const outcome = await markCandidateFailed(redis, CHAIN, member);
        if (outcome === "dead") {
          stats.dead++;
          console.error(
            "[SOLANA][DISC-QUEUE] DEAD-LETTER " + candidate.program
            + " sig=" + candidate.signature.slice(0, 12)
            + " slot=" + candidate.slot + " (după MAX încercări — pierdere reală, health DEGRADED)",
          );
        }
        continue;
      }

      if (action === "ack") {
        // NF3: sigur nu-i o creare → ACK (scoate din coadă), FĂRĂ processedSlot, FĂRĂ dead. Nu poluează health.
        stats.invalid++;
        await markCandidateDone(redis, CHAIN, member);
        continue;
      }

      if (action === "quarantine_ack" && res.kind === "unsupported") {
        // NF3: variantă necunoscută → păstrează dovada în quarantine durabil ÎNAINTE de ACK. Dacă scrierea
        // în quarantine EȘUEAZĂ, NU face ACK — lasă membrul în processing → lease expiră → reclaim → retry.
        // Altfel (ACK după HSET eșuat) am pierde exact dovada pe care voiam s-o protejăm.
        try {
          await quarantineUnsupported(redis, CHAIN, candidate, res.accountCounts, res.reason);
        } catch (err) {
          console.error(
            "[SOLANA][DISC-QUEUE] quarantine write FAILED — lăsat în processing pt. reclaim: "
            + (err as Error).message,
          );
          continue; // fără ACK
        }
        stats.unsupported++;
        await markCandidateDone(redis, CHAIN, member);
        continue;
      }

      // "ack_advance" (written) → ack + avansează PROCESSED slot (record durabil prezent).
      await markCandidateDone(redis, CHAIN, member);
      await advanceProcessedSlot(candidate.slot).catch((err: Error) => {
        console.error("[SOLANA][DISC-QUEUE] advanceProcessedSlot error:", err.message);
      });
    }
  };

  const poolSize = Math.min(DISC_DRAIN_CONCURRENCY, members.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("[SOLANA] indexer-solana " + INDEXER_VERSION + " starting");
  console.log("[SOLANA] chain=" + CHAIN);
  console.log("[SOLANA] rpc=" + getSolanaRpcUrl().slice(0, 50) + "...");
  console.log("[SOLANA] ws=" + getSolanaWsUrl().slice(0, 50) + "...");
  console.log(
    "[SOLANA] programs:"
    + " raydium_amm=" + RAYDIUM_AMM_V4.slice(0, 8) + "..."
    + " clmm=" + RAYDIUM_CLMM.slice(0, 8) + "..."
    + " cpmm=" + RAYDIUM_CPMM.slice(0, 8) + "..."
    + " pumpfun=" + PUMPFUN_PROGRAM.slice(0, 8) + "...",
  );

  const redis = getRedis();
  const pairsCount = await redis.zcard(KEY_PAIRS);
  console.log("[SOLANA] redis OK | indexed_pairs=" + pairsCount);

  let nodeVersion = "unknown";
  try {
    nodeVersion = await getVersion();
    console.log("[SOLANA] node version: " + nodeVersion);
  } catch (_err) {
    console.warn("[SOLANA] getVersion() failed -- continuing");
  }

  const connection = getConnection();

  // 8.0j: SOL/USD price oracle — fetch imediat + refresh 30s
  startSolPriceOracle();

  // Smoke test metadata — validează Jupiter API la fiecare startup
  // wSOL (KNOWN) + JTO (Jupiter path) — confirmare rapidă fără să așteptăm un pool nou
  // JTO (Jito) ales intenționat: nu e în KNOWN_MINTS, deci testează Jupiter API end-to-end
  resolveTokenMeta("So11111111111111111111111111111111111111112").then(m =>
    console.log("[SOLANA][META] smoke wSOL: symbol=" + m.symbol + " decimals=" + m.decimals + " source=" + m.source),
  ).catch(() => {});
  resolveTokenMeta("jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL").then(m =>
    console.log("[SOLANA][META] smoke JTO: symbol=" + m.symbol + " decimals=" + m.decimals + " source=" + m.source),
  ).catch(() => {});

  // Backfill snapshot — rulează înainte de WS subscription
  // Activat cu SOLANA_BACKFILL_ENABLED=1
  await runCpmmBackfill(connection);

  // C6: candidatul e ENQUEUE-uit durabil (nu procesat inline fire-and-forget). Drain-ul
  // background face fetch→write→ack cu retry+dead-letter, crash-safe.
  const enqueueDiscovery = (program: DiscoveryProgram, signature: string, slot: number): void => {
    // Fix varu (blocker): stats.candidates DOAR la enqueue confirmat nou (added); redelivery pe care
    // NX o respinge → deduped. Retry scurt: WS nu oferă replay, deci un enqueue eșuat = candidat
    // pierdut — câteva reîncercări reduc fereastra. Garanția reală: „durabil DUPĂ ACK Redis".
    const attempt = (tries: number): void => {
      enqueueCandidate(redis, CHAIN, { program, slot, signature })
        .then(added => { if (added) stats.candidates++; else stats.deduped++; })
        .catch((err: Error) => {
          if (tries > 0) { setTimeout(() => attempt(tries - 1), 500); return; }
          stats.errors++;
          console.error("[SOLANA][DISC-QUEUE] enqueue error (renunț după retries):", err.message);
        });
    };
    attempt(3);
  };

  // D2: ancoră grația de freshness la momentul PORNIRII subscripțiilor (după backfill), nu la start proces.
  const subscriptionsStartedAt = Date.now();
  // E23: dispatch pipeline (cele 4 ramuri de discovery) — funcție locală injectată în boundary-ul de
  // containment `runDiscoveryCallback` (discovery/discoveryCallback.ts). Închide peste
  // `connection` / `enqueueDiscovery` / `stats` (locale în main).
  const dispatchDiscoveryEvent = (event: LogEvent): void => {
    // ── AMM V4 pipeline (D4c — promovat din shadow) ──────────────────────────
    // Creare DIRECTĂ de pool AMM V4 (Initialize2 nativ, tag 1 / 21 conturi) — sursă RARĂ (1 creare în fereastra
    // auditată de ~14h, validată Dune D4a.1) dar reală. Shadow-ul rămâne (bounded, self-sampling) pt.
    // observabilitatea layout-ului. Gate SCOPED pe invocation-stack: enqueue DOAR când Initialize2 e emis
    // cât timp AMM V4 e pe VÂRFUL stivei ȘI invocarea reușește (evită swap-urile care menționează AMM V4).
    // Fetcher-ul determinist din drain (fetchAmmV4Init) reconfirmă tag 1 / 21 conturi înainte de registry write.
    if (event.program === "raydium_amm_v4") {
      stats.ammV4Total++;
      handleAmmV4Shadow(connection, event.signature, event.slot, event.logs);
      if (!isScopedAmmV4InitLog(event.logs, RAYDIUM_AMM_V4)) return;
      enqueueDiscovery("raydium_amm_v4", event.signature, event.slot);
      return;
    }

    // ── pump.fun launch pipeline (8.0g-b6) ───────────────────────────────────
    if (event.program === "pumpfun") {
      stats.pumpfunTotal++;
      handlePumpfunShadow(connection, event.signature, event.slot, event.logs);
      if (!isPumpfunCreateLog(event.logs)) return;
      enqueueDiscovery("pumpfun", event.signature, event.slot);
      return;
    }

    // ── CLMM pipeline (8.0g-a6) ──────────────────────────────────────────────
    if (event.program === "raydium_clmm") {
      stats.clmmTotal++;
      // Shadow mereu — stats + sample tx logging
      handleClmmShadow(connection, event.signature, event.slot, event.logs);
      // Swap shadow (8.0h-b1) — observa swap instructions in paralel cu pool creation
      handleSwapShadow(connection, event.signature, event.slot, event.logs, "clmm");

      // Pipeline real — doar pentru pool creation events
      if (!isClmmCreateLog(event.logs)) return;
      enqueueDiscovery("raydium_clmm", event.signature, event.slot);
      return;
    }

    // ── CPMM pipeline (8.0h-b1) ──────────────────────────────────────────────
    if (event.program === "raydium_cpmm") {
      stats.cpmmTotal++;
      // Swap activity shadow — parses sampled swaps, writes activity only for known pools
      handleSwapShadow(connection, event.signature, event.slot, event.logs, "cpmm");
      if (!isCpmmInitLog(event.logs)) return;
      enqueueDiscovery("raydium_cpmm", event.signature, event.slot);
      return;
    }
  };

  // E23: boundary de crash-containment pentru onLogs — TOT callback-ul (liveness INCLUS) rulează în
  // try; un throw sincron oriunde e prins (callbackErrors++ + log), procesul supraviețuiește. Vezi
  // discovery/discoveryCallback.ts + scripts/discoveryCallback.test.ts.
  startLogSubscriptions(connection, (event) =>
    runDiscoveryCallback(event, {
      recordProgramLog,
      advanceObservedSlot,
      dispatch: dispatchDiscoveryEvent,
      stats,
      now: Date.now,
    }),
  );

  // Drain background — guard per-proces + interval (non-blocant, ca schedulerele C3/C2 din EVM)
  let drainInFlight = false;
  setInterval(() => {
    if (drainInFlight) return;
    drainInFlight = true;
    drainDiscoveryQueue(redis, connection)
      .catch((err: Error) => console.error("[SOLANA][DISC-QUEUE] drain error:", err.message))
      .finally(() => { drainInFlight = false; });
  }, DISC_DRAIN_INTERVAL_MS);

  await healthLoop(nodeVersion, subscriptionsStartedAt);
}

main().catch((err) => {
  console.error("[SOLANA] fatal:", err);
  process.exit(1);
});
