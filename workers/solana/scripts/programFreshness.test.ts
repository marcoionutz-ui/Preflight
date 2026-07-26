/**
 * scripts/programFreshness.test.ts — D2.
 *
 * Testează logica PURĂ per-program (funcțiile reale importate): tracker (`recordProgramLog`), staleness
 * cu criticalitate (`computeProgramHealth` — DOUĂ contoare: toate stale vs critice stale), și escaladarea
 * de status (`resolveDegradedStatus`). Config-ul de programe e importat din SURSA REALĂ
 * (`DISCOVERY_PROGRAM_HEALTH`) → dacă cineva schimbă din greșeală criticalitatea în producție, testele pică.
 * Fără RPC/Redis/timp real (`now`/`startedAt` injectate).
 */

import {
  recordProgramLog, snapshotProgramFreshness, resetProgramFreshness,
  computeProgramHealth, resolveDegradedStatus, resolveSolanaStatus, hasCriticalEvidence,
  type ExpectedProgram, type ProgramHealthEntry,
} from "../src/infra/programFreshness";
import { DISCOVERY_PROGRAM_HEALTH } from "../src/discovery/logSubscriber";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

// CONFIG REALĂ (nu redefinită manual) — legată de producție.
const PROGRAMS: readonly ExpectedProgram[] = DISCOVERY_PROGRAM_HEALTH;
const critOf = (p: string) => PROGRAMS.find(e => e.program === p)?.critical;
const CRIT_ONLY: readonly ExpectedProgram[] = [{ program: "pumpfun", critical: true }];
const STALE = 90_000, GRACE = 120_000, START = 1_000_000;
const entry = (r: ReturnType<typeof computeProgramHealth>, p: string) => r.perProgram.find(e => e.program === p)!;

function main(): void {
  console.log("D2 — programFreshness (health per-program, criticalitate, două contoare)");

  // ── D2.config: config-ul real are criticalitatea corectă (legare la producție) ──
  {
    check("D2.config-a. AMM V4 este critical (D4c: are pipeline live)", critOf("raydium_amm_v4") === true);
    check("D2.config-b. CLMM critical", critOf("raydium_clmm") === true);
    check("D2.config-c. CPMM critical", critOf("raydium_cpmm") === true);
    check("D2.config-d. pumpfun critical", critOf("pumpfun") === true);
    check("D2.config-e. exact 4 programe", PROGRAMS.length === 4);
  }

  // ── D2.1: toate proaspete → niciun contor stale ──
  {
    resetProgramFreshness();
    const now = START + 200_000;
    for (const { program } of PROGRAMS) recordProgramLog(program, 100, now - 1_000);
    const r = computeProgramHealth(snapshotProgramFreshness(), PROGRAMS, { now, startedAt: START, staleMs: STALE, graceMs: GRACE });
    check("D2.1a. staleCount 0 + staleCriticalCount 0", r.staleCount === 0 && r.staleCriticalCount === 0);
    check("D2.1b. lastLogAgeMs ≈ 1000", entry(r, "pumpfun").lastLogAgeMs === 1_000);
    check("D2.1c. fiecare entry are flag critical", entry(r, "pumpfun").critical === true && entry(r, "raydium_amm_v4").critical === true);
  }

  // ── D2.2 (BUG central): un program CRITIC mort tăcut, restul vii → detectat PARȚIAL ──
  {
    resetProgramFreshness();
    const now = START + 300_000;
    recordProgramLog("raydium_amm_v4", 500, now - 2_000);
    recordProgramLog("raydium_clmm",   501, now - 2_000);
    recordProgramLog("raydium_cpmm",   502, now - 2_000);
    recordProgramLog("pumpfun",        400, now - 100_000);
    const r = computeProgramHealth(snapshotProgramFreshness(), PROGRAMS, { now, startedAt: START, staleMs: STALE, graceMs: GRACE });
    check("D2.2a. staleCount 1 + staleCriticalCount 1", r.staleCount === 1 && r.staleCriticalCount === 1);
    check("D2.2b. pumpfun e stale", entry(r, "pumpfun").stale === true);
    check("D2.2c. clmm NU e stale (viu)", entry(r, "raydium_clmm").stale === false);
    check("D2.2d. status → DEGRADED", resolveDegradedStatus("OK", { degradedBySignal: false, staleCriticalCount: r.staleCriticalCount }) === "DEGRADED");
  }

  // ── D2.3: prag exact staleMs (`>`, nu `>=`) ──
  {
    resetProgramFreshness();
    const now = START + 500_000;
    recordProgramLog("pumpfun", 1, now - STALE);
    recordProgramLog("raydium_clmm", 1, now - STALE - 1);
    const r = computeProgramHealth(snapshotProgramFreshness(), [{ program: "pumpfun", critical: true }, { program: "raydium_clmm", critical: true }], { now, startedAt: START, staleMs: STALE, graceMs: GRACE });
    check("D2.3a. age == staleMs → NU stale", entry(r, "pumpfun").stale === false);
    check("D2.3b. age == staleMs+1 → stale", entry(r, "raydium_clmm").stale === true);
  }

  // ── D2.4: niciodată văzut — grație de pornire + ambele contoare ──
  {
    resetProgramFreshness();
    const r1 = computeProgramHealth(snapshotProgramFreshness(), PROGRAMS, { now: START + GRACE - 1, startedAt: START, staleMs: STALE, graceMs: GRACE });
    check("D2.4a. în grație → nimic stale", r1.staleCount === 0 && r1.staleCriticalCount === 0);
    check("D2.4b. lastLogAgeMs = null", entry(r1, "pumpfun").lastLogAgeMs === null && entry(r1, "pumpfun").lastSlot === null);
    const r2 = computeProgramHealth(snapshotProgramFreshness(), PROGRAMS, { now: START + GRACE + 1, startedAt: START, staleMs: STALE, graceMs: GRACE });
    check("D2.4c. după grație → staleCount 4, staleCriticalCount 4 (toate critice acum, D4c)", r2.staleCount === 4 && r2.staleCriticalCount === 4);
    check("D2.4d. amm_v4 stale ȘI critic (D4c)", entry(r2, "raydium_amm_v4").stale === true && entry(r2, "raydium_amm_v4").critical === true);
  }

  // ── D2.5: un program viu, restul niciodată ──
  {
    resetProgramFreshness();
    const now = START + GRACE + 5_000;
    recordProgramLog("pumpfun", 10, now - 1_000);
    const r = computeProgramHealth(snapshotProgramFreshness(), PROGRAMS, { now, startedAt: START, staleMs: STALE, graceMs: GRACE });
    check("D2.5a. pumpfun viu → NU stale", entry(r, "pumpfun").stale === false);
    check("D2.5b. staleCount 3, staleCriticalCount 3 (clmm+cpmm+amm_v4 toate critice, D4c)", r.staleCount === 3 && r.staleCriticalCount === 3);
  }

  // ── D2.6: recordProgramLog ține MAX slot + actualizează lastLogAt ──
  {
    resetProgramFreshness();
    recordProgramLog("pumpfun", 500, 1_000);
    recordProgramLog("pumpfun", 480, 2_000);
    const snap = snapshotProgramFreshness();
    check("D2.6a. lastSlot = max (500)", snap.get("pumpfun")!.lastSlot === 500);
    check("D2.6b. lastLogAt = cel mai nou (2000)", snap.get("pumpfun")!.lastLogAt === 2_000);
    recordProgramLog("pumpfun", 600, 3_000);
    check("D2.6c. slot mai mare → actualizat (600)", snapshotProgramFreshness().get("pumpfun")!.lastSlot === 600);
  }

  // ── D2.7: snapshot imuabil ──
  {
    resetProgramFreshness();
    recordProgramLog("pumpfun", 1, 1_000);
    const snap = snapshotProgramFreshness();
    recordProgramLog("pumpfun", 2, 2_000);
    check("D2.7. snapshot rămâne la starea de la momentul luării", snap.get("pumpfun")!.lastSlot === 1);
  }

  // ── D2.8: program CRITIC stale + status de bază OK → DEGRADED ──
  {
    check("D2.8a. OK + critic stale → DEGRADED", resolveDegradedStatus("OK", { degradedBySignal: false, staleCriticalCount: 1 }) === "DEGRADED");
    check("D2.8b. STARTING + critic stale → DEGRADED", resolveDegradedStatus("STARTING", { degradedBySignal: false, staleCriticalCount: 2 }) === "DEGRADED");
    check("D2.8c. OK + degradedBySignal → DEGRADED", resolveDegradedStatus("OK", { degradedBySignal: true, staleCriticalCount: 0 }) === "DEGRADED");
  }

  // ── D2.9 (D4c): AMM V4 e acum CRITIC → stale → DEGRADED (înainte non-critic → OK) ──
  {
    resetProgramFreshness();
    const now = START + GRACE + 10_000; // amm_v4 niciodată → stale
    recordProgramLog("raydium_clmm", 1, now - 1_000);
    recordProgramLog("raydium_cpmm", 1, now - 1_000);
    recordProgramLog("pumpfun", 1, now - 1_000);
    const r = computeProgramHealth(snapshotProgramFreshness(), PROGRAMS, { now, startedAt: START, staleMs: STALE, graceMs: GRACE });
    check("D2.9a. amm_v4 stale", entry(r, "raydium_amm_v4").stale === true);
    check("D2.9b. staleCount 1 + staleCriticalCount 1 (amm_v4 e critic acum)", r.staleCount === 1 && r.staleCriticalCount === 1);
    check("D2.9c. status → DEGRADED (amm_v4 critic stale)", resolveDegradedStatus("OK", { degradedBySignal: false, staleCriticalCount: r.staleCriticalCount }) === "DEGRADED");
  }

  // ── D2.9d (ONESTITATE two-counter — cu program non-critic SINTETIC, fiindcă toate cele reale-s critice acum):
  //    codul ÎNCĂ distinge staleCount (toate) de staleCriticalCount (doar critice) → un diagnostic-only stale
  //    NU degradează statusul. Regression protection pt. cele două contoare. ──
  {
    resetProgramFreshness();
    const now = START + GRACE + 10_000;
    recordProgramLog("pumpfun", 1, now - 1_000); // critic viu
    const synth = [{ program: "pumpfun", critical: true }, { program: "diag_only", critical: false }];
    const r = computeProgramHealth(snapshotProgramFreshness(), synth, { now, startedAt: START, staleMs: STALE, graceMs: GRACE });
    check("D2.9d. non-critic (sintetic) stale → staleCount 1 DAR staleCriticalCount 0 (payload onest)",
      r.staleCount === 1 && r.staleCriticalCount === 0);
    check("D2.9e. status OK (non-critic stale NU degradează)",
      resolveDegradedStatus("OK", { degradedBySignal: false, staleCriticalCount: r.staleCriticalCount }) === "OK");
  }

  // ── D2.10: critic stale + status de bază BEHIND → rămâne BEHIND ──
  {
    check("D2.10a. BEHIND + critic stale → rămâne BEHIND", resolveDegradedStatus("BEHIND", { degradedBySignal: false, staleCriticalCount: 1 }) === "BEHIND");
    check("D2.10b. DEGRADED + critic stale → rămâne DEGRADED", resolveDegradedStatus("DEGRADED", { degradedBySignal: false, staleCriticalCount: 1 }) === "DEGRADED");
    check("D2.10c. BEHIND fără semnale → rămâne BEHIND", resolveDegradedStatus("BEHIND", { degradedBySignal: false, staleCriticalCount: 0 }) === "BEHIND");
  }

  // ── D2.11: liveness per-callback (mirror index.ts): tx eșuată → freshness ȘI observed slot, dar nu pipeline ──
  {
    resetProgramFreshness();
    let observedAdvances = 0, pipelineRuns = 0;
    const handleEvent = (program: string, slot: number, now: number, succeeded: boolean) => {
      recordProgramLog(program, slot, now); // freshness: orice callback
      observedAdvances++;                    // observed slot: orice callback (ÎNAINTE de gate)
      if (!succeeded) return;                // gate pipeline
      pipelineRuns++;
    };
    handleEvent("pumpfun", 10, 5_000, false); // tx eșuată
    check("D2.11a. tx eșuată → freshness actualizat", snapshotProgramFreshness().get("pumpfun")!.lastLogAt === 5_000);
    check("D2.11b. tx eșuată → observed slot avansează (liveness WS)", observedAdvances === 1);
    check("D2.11c. tx eșuată → pipeline NU rulează", pipelineRuns === 0);
    handleEvent("pumpfun", 11, 6_000, true);  // tx reușită
    check("D2.11d. tx reușită → pipeline rulează", pipelineRuns === 1);
  }

  // ── D2.12: grație ancorată la pornirea SUBSCRIPȚIILOR, nu a procesului ──
  {
    resetProgramFreshness();
    const processStart = START;
    const subStart = START + 300_000;
    const now = subStart + GRACE - 1;
    const rProcess = computeProgramHealth(snapshotProgramFreshness(), CRIT_ONLY, { now, startedAt: processStart, staleMs: STALE, graceMs: GRACE });
    check("D2.12a. ancorat la processStart → stale (greșit)", rProcess.staleCriticalCount === 1);
    const rSub = computeProgramHealth(snapshotProgramFreshness(), CRIT_ONLY, { now, startedAt: subStart, staleMs: STALE, graceMs: GRACE });
    check("D2.12b. ancorat la subStart → NU stale (corect)", rSub.staleCount === 0 && rSub.staleCriticalCount === 0);
  }

  // ── hasCriticalEvidence: doar programele critice trebuie să fi livrat în procesul curent ──
  {
    const mk = (program: string, critical: boolean, seen: boolean): ProgramHealthEntry =>
      ({ program, critical, lastLogAgeMs: seen ? 1_000 : null, lastSlot: seen ? 10 : null, stale: false });
    check("evidence-a. toate criticele văzute → true", hasCriticalEvidence([mk("clmm", true, true), mk("pumpfun", true, true)]) === true);
    check("evidence-b. un critic ne-văzut → false", hasCriticalEvidence([mk("clmm", true, true), mk("pumpfun", true, false)]) === false);
    check("evidence-c. non-critic ne-văzut nu contează → true", hasCriticalEvidence([mk("amm_v4", false, false), mk("pumpfun", true, true)]) === true);
  }

  // ── D2.13 (edge restart): cursor persistent + zero dovadă curentă → STARTING, nu OK ──
  {
    const s = resolveSolanaStatus({ hasCurrentCriticalEvidence: false, observedSlot: 400_000_000, slotStatus: "OK", degradedBySignal: false, staleCriticalCount: 0 });
    check("D2.13. cursor vechi + zero dovadă curentă → STARTING (nu OK fantomă)", s === "STARTING");
  }

  // ── D2.14: toate criticele au dovadă curentă → statusul normal de slot ──
  {
    check("D2.14a. dovadă curentă + slot OK → OK", resolveSolanaStatus({ hasCurrentCriticalEvidence: true, observedSlot: 400_000_000, slotStatus: "OK", degradedBySignal: false, staleCriticalCount: 0 }) === "OK");
    check("D2.14b. dovadă curentă + slot BEHIND → BEHIND", resolveSolanaStatus({ hasCurrentCriticalEvidence: true, observedSlot: 400_000_000, slotStatus: "BEHIND", degradedBySignal: false, staleCriticalCount: 0 }) === "BEHIND");
    check("D2.14c. observedSlot null (chiar cu dovadă) → STARTING", resolveSolanaStatus({ hasCurrentCriticalEvidence: true, observedSlot: null, slotStatus: "OK", degradedBySignal: false, staleCriticalCount: 0 }) === "STARTING");
  }

  // ── D2.15: lipsește un program critic ÎN grație → STARTING ──
  {
    resetProgramFreshness();
    const now = START + GRACE - 1; // în grație
    recordProgramLog("raydium_amm_v4", 1, now - 1_000);
    recordProgramLog("raydium_clmm",   1, now - 1_000);
    recordProgramLog("raydium_cpmm",   1, now - 1_000);
    // pumpfun (critic) NU a livrat încă
    const r = computeProgramHealth(snapshotProgramFreshness(), PROGRAMS, { now, startedAt: START, staleMs: STALE, graceMs: GRACE });
    const s = resolveSolanaStatus({ hasCurrentCriticalEvidence: hasCriticalEvidence(r.perProgram), observedSlot: 400_000_000, slotStatus: "OK", degradedBySignal: false, staleCriticalCount: r.staleCriticalCount });
    check("D2.15a. critic lipsă în grație → fără dovadă curentă", hasCriticalEvidence(r.perProgram) === false);
    check("D2.15b. status → STARTING (nu stale încă)", s === "STARTING");
  }

  // ── D2.16: lipsește un program critic DUPĂ grație → DEGRADED ──
  {
    resetProgramFreshness();
    const now = START + GRACE + 1; // după grație
    recordProgramLog("raydium_amm_v4", 1, now - 1_000);
    recordProgramLog("raydium_clmm",   1, now - 1_000);
    recordProgramLog("raydium_cpmm",   1, now - 1_000);
    // pumpfun (critic) NU a livrat → după grație e stale critic
    const r = computeProgramHealth(snapshotProgramFreshness(), PROGRAMS, { now, startedAt: START, staleMs: STALE, graceMs: GRACE });
    const s = resolveSolanaStatus({ hasCurrentCriticalEvidence: hasCriticalEvidence(r.perProgram), observedSlot: 400_000_000, slotStatus: "OK", degradedBySignal: false, staleCriticalCount: r.staleCriticalCount });
    check("D2.16a. critic lipsă după grație → staleCriticalCount ≥ 1", r.staleCriticalCount >= 1);
    check("D2.16b. status → DEGRADED (STARTING escaladat)", s === "DEGRADED");
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
