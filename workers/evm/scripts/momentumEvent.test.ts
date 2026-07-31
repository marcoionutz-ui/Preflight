/**
 * scripts/momentumEvent.test.ts — E34 (WATCHING path: sell-count REAL, nu fabricat 0).
 *
 * ⚠️ IMPORT-HEAVY: importă `buildMomentumEventEntry` din `preflight-redis.ts`, care importă la rândul lui valori
 * runtime din `@preflight/schema` (REDIS_KEYS/SCHEMA_VERSION) + `./redisArrays` (→ `config/chains`). Deci NU rulează
 * standalone în container (lanț de importuri nerezolvabil fără workspace-ul instalat) — rulează la gate-ul lui Marco
 * și în CI (`--workspaces`), unde pachetele sunt link-uite. Logica PURĂ de observație e verificată separat, local,
 * în `observation.test.ts` (21/21). Aici dovedim DOAR firul: `flowSells5m` (arg) → `deriveFlowStatus` + `flowCounts`.
 *
 * `buildMomentumEventEntry` e pur (construiește un obiect, fără I/O la load) → apelabil direct.
 */
import { buildMomentumEventEntry } from "../src/lib/preflight-redis";
import type { MomentumEvent } from "../src/risk/momentum";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

// Mock minimal — doar câmpurile citite de buildMomentumEventEntry contează; restul, cast (e un mock de test,
// nu cod de producție — spre deosebire de vechiul `(ctx as any).flow` care ascundea un bug real la runtime).
function mockEvent(riskFlags: string[] = []): MomentumEvent {
  return {
    verdict:       "MOMENTUM",
    moveType:      "UNKNOWN",
    momentumLevel: "NONE",
    entryRisk:     "MEDIUM",
    reason:        "",
    m5Pct: 0, h1Pct: 0, h24Pct: 0,
    reserveUsd:    50_000,
    hasWsFlow:     true,
    riskFlags,
  } as unknown as MomentumEvent;
}

// Calea WATCHING: buildMomentumEventEntry(..., flowBuys5m, flowSells5m, workerVersion).
function watchObs(buys5m: number, sells5m: number): string {
  const entry = buildMomentumEventEntry(
    mockEvent(), "SYM", "base", "0xpair", "V2",
    /* flowHasData */ true, /* buyVol5m */ 0, /* netVol5m */ 0,
    buys5m, sells5m, "test-worker",
  );
  return entry.workerObservation;
}

const BUY_ONLY = "No sell pressure observed — buying-only flow in current window.";
function count(hay: string, needle: string): number { return hay.split(needle).length - 1; }

function main(): void {
console.log("E34 — buildMomentumEventEntry (WATCHING, sell-count real)");

// ⭐ 5 buy / 2 sell → NU fabrică „buying-only" (bugul: înainte sells era hardcodat 0 → fals buying-only).
const mixed = watchObs(5, 2);
check("1. * 5 buys / 2 sells -> NU buying-only", !mixed.includes(BUY_ONLY));

// ⭐ 5 buy / 0 sell → EXACT o propoziție buying-only.
const buyOnly = watchObs(5, 0);
check("2. * 5 buys / 0 sells -> buying-only prezent", buyOnly.includes(BUY_ONLY));
check("3. * 5 buys / 0 sells -> EXACT o propozitie buying-only", count(buyOnly, BUY_ONLY) === 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
