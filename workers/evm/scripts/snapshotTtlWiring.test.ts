/**
 * scripts/snapshotTtlWiring.test.ts — E24 (wiring: TTL derivat ajunge la TOATE snapshot-urile per-scan).
 *
 * `snapshotTtl.test.ts` dovedește FORMULA (helper → 240 în DEV). Ăsta dovedește WIRING-ul: că fiecare comandă
 * Redis pentru snapshot-urile rescrise la fiecare scan primește EX = ttlSec (240), iar TTL-urile intenționat mai
 * lungi (momentum_events / recent_drops = 600) rămân neschimbate. Folosește un pipeline FAKE care înregistrează
 * argumentele `set(...)`, nu Redis real.
 *
 * IMPORT-HEAVY (importă preflight-redis.ts / coverageSnapshot.ts → @preflight/schema + stores) → rulează la
 * gate/CI (typecheck + `npm --prefix workers/evm test`), nu standalone în container. Separat de snapshotTtl.test.ts
 * (leaf pur) exact ca observation.test.ts vs momentumEvent.test.ts la E34.
 */
import type { Redis } from "ioredis";
import { writePreflightRedis, type PreflightPairContext } from "../src/lib/preflight-redis";
import { writeCoverageSnapshot } from "../src/pipeline/coverageSnapshot";
import {
  REDIS_KEYS,
  type PreflightMomentumEvent, type PreflightSignalPipelineEntry,
  type PreflightQualifiedSignal, type PreflightDrop,
} from "@preflight/schema";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

type SetCall = { key: string; ex: number | undefined };

function makeFakeRedis(): { r: Redis; calls: SetCall[] } {
  const calls: SetCall[] = [];
  const pipe = {
    set(key: string, _value: string, ...rest: unknown[]): unknown {
      const ex = rest[0] === "EX" ? (rest[1] as number) : undefined;
      calls.push({ key, ex });
      return pipe;
    },
    exec: async (): Promise<unknown[]> => [],
  };
  const r = { pipeline: () => pipe } as unknown as Redis;
  return { r, calls };
}

const TTL = 240; // ce ar întoarce snapshotTtlSec(BUDGET.scanIntervalMs) în DEV

async function main(): Promise<void> {
  console.log("E24 wiring — toate snapshot-urile per-scan primesc EX = ttlSec (240), long-TTL rămân 600");

  const now = Date.now();

  // ── writePreflightRedis: signal_pipeline / qualified_signals / pair_context = ttlSec; momentum / drops = 600 ──
  {
    const { r, calls } = makeFakeRedis();
    await writePreflightRedis(r, {
      workerVersion: "test",
      now,
      momentumEventsBuffer: [{ chain: "base", detectedAt: now } as unknown as PreflightMomentumEvent],
      signalPipeline:       [{ chain: "base" } as unknown as PreflightSignalPipelineEntry],
      qualifiedSignals:     [{ chain: "base" } as unknown as PreflightQualifiedSignal],
      recentDrops:          [{ chain: "base", droppedAt: now } as unknown as PreflightDrop],
      pairContextMap:       { "base:0xabc": { chain: "base", pairAddress: "0xabc" } as unknown as PreflightPairContext },
      ttlSec: TTL,
    });

    const exOf = (key: string) => calls.find(c => c.key === key)?.ex;

    check("1. * signal_pipeline -> EX 240 (era 120)",   exOf(REDIS_KEYS.signalPipeline("base"))   === TTL);
    check("2. * qualified_signals -> EX 240 (era 120)", exOf(REDIS_KEYS.qualifiedSignals("base")) === TTL);
    check("3. * pair_context -> EX 240 (era 120)",      exOf(REDIS_KEYS.pairContext("base", "0xabc")) === TTL);
    // Regresie: TTL-urile intenționat lungi NU se ating.
    check("4. * momentum_events -> EX 600 (neschimbat)", exOf(REDIS_KEYS.momentumEvents("base")) === 600);
    check("5. * recent_drops -> EX 600 (neschimbat)",    exOf(REDIS_KEYS.recentDrops("base"))    === 600);
    // Niciun EX 120 rămas pe vreo cheie scrisă de writePreflightRedis.
    check("6. * NICIUN snapshot cu EX 120 rămas", !calls.some(c => c.ex === 120));
  }

  // ── writeCoverageSnapshot: pipeline_coverage = ttlSec ──
  {
    const { r, calls } = makeFakeRedis();
    await writeCoverageSnapshot(r, {}, TTL);
    const covCalls = calls.filter(c => c.key === REDIS_KEYS.pipelineCoverage("base"));
    check("7. * pipeline_coverage(base) scris cu EX 240", covCalls.length > 0 && covCalls.every(c => c.ex === TTL));
    check("8. * niciun pipeline_coverage cu EX 120", !calls.some(c => c.ex === 120));
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
}

main();
