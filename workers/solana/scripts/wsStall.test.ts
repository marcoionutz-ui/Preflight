/**
 * scripts/wsStall.test.ts — D1 (Solana WS hard-stall watchdog).
 *
 * Testează funcția PURĂ `isWsStalled` (importată real). Fără Connection/timere/process.exit.
 * Semantica: hard stall ⇔ FIECARE program critic a tăcut > stallMs, unde vârsta de tăcere a unui program
 * niciodată văzut (`lastLogAgeMs === null`) = `subscriptionsAgeMs` (tăcut de la pornirea subscripțiilor).
 * Un subset tăcut (restul proaspete) = D2 (DEGRADED), nu hard stall.
 */

import { isWsStalled, type ProgramLiveness } from "../src/infra/wsWatchdog";

const STALL = 180_000; // 180s (> PROGRAM_STALE_MS din D2 = 90s)
const OLD_SESSION = STALL + 600_000; // sesiune matură (nu interferează cu programele non-null)

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

function p(program: string, critical: boolean, lastLogAgeMs: number | null): ProgramLiveness {
  return { program, critical, lastLogAgeMs };
}

const CLMM = "raydium_clmm", CPMM = "raydium_cpmm", PUMP = "pumpfun", AMM = "raydium_amm_v4";

function main(): void {
  console.log("D1 — wsWatchdog (Solana WS hard-stall)");

  // ── D1S.1: toate cele 4 critice reale tăcute > stall (oglindește producția, D4c: amm_v4 critic) → HARD STALL ──
  {
    const progs = [
      p(AMM, true, STALL + 30_000),  // D4c: amm_v4 e critic acum
      p(CLMM, true, STALL + 1),
      p(CPMM, true, STALL + 5_000),
      p(PUMP, true, STALL + 60_000),
    ];
    check("D1S.1. toate critice tăcute > stall → stalled", isWsStalled(progs, STALL, OLD_SESSION) === true);
  }

  // ── D1S.2: un singur critic tăcut, restul proaspete → NU stall (D2/DEGRADED) ──
  {
    const progs = [
      p(CLMM, true, STALL + 1),   // mort
      p(CPMM, true, 1_000),       // viu
      p(PUMP, true, 2_000),       // viu
    ];
    check("D1S.2. doar 1 critic tăcut (parțial) → NU stall", isWsStalled(progs, STALL, OLD_SESSION) === false);
  }

  // ── D1S.3: toate critice PROASPETE → NU stall ──
  {
    const progs = [
      p(CLMM, true, 1_000),
      p(CPMM, true, 500),
      p(PUMP, true, 9_000),
    ];
    check("D1S.3. toate critice proaspete → NU stall", isWsStalled(progs, STALL, OLD_SESSION) === false);
  }

  // ── D1S.4: TOATE critice null (socket mort de la startup) — depinde de vârsta sesiunii ──
  {
    const progs = [
      p(CLMM, true, null),
      p(CPMM, true, null),
      p(PUMP, true, null),
    ];
    check("D1S.4a. toate null, sesiune ÎNAINTE de prag (STALL-1) → NU stall", isWsStalled(progs, STALL, STALL - 1) === false);
    check("D1S.4b. toate null, sesiune DUPĂ prag (STALL+1) → stall", isWsStalled(progs, STALL, STALL + 1) === true);
  }

  // ── D1S.5: BLOCKER varu — un critic null NU maschează stall-ul total (2 vechi + 1 null) ──
  {
    const progs = [
      p(CLMM, true, STALL + 1),
      p(CPMM, true, STALL + 1),
      p(PUMP, true, null),        // niciodată văzut
    ];
    check("D1S.5a. 2 vechi + 1 null, sesiune DUPĂ prag → stall (null nu maschează)", isWsStalled(progs, STALL, STALL + 1) === true);
    check("D1S.5b. 2 vechi + 1 null, sesiune ÎNAINTE de prag → NU stall (null încă tânăr)", isWsStalled(progs, STALL, STALL - 1) === false);
  }

  // ── D1S.6: AMM V4 (critic acum, D4c) tăcut dar restul critice proaspete → NU stall (moarte PARȚIALĂ) ──
  {
    const progs = [
      p(AMM, true, STALL + 100_000), // critic mort de mult
      p(CLMM, true, 1_000),
      p(CPMM, true, 1_000),
      p(PUMP, true, 1_000),
    ];
    check("D1S.6. amm_v4 (critic) mort dar restul critice vii → NU stall (parțial, nu toate)", isWsStalled(progs, STALL, OLD_SESSION) === false);
  }

  // ── D1S.7: prag exact — un critic la lastLogAgeMs == stallMs → NU stall (strict >) ──
  {
    const progs = [
      p(CLMM, true, STALL),       // fix pe prag
      p(CPMM, true, STALL + 1),
      p(PUMP, true, STALL + 1),
    ];
    check("D1S.7. un critic fix pe prag (== stall) → NU stall (strict >)", isWsStalled(progs, STALL, OLD_SESSION) === false);
  }

  // ── D1S.7bis: null cu subscriptionsAgeMs == stallMs → NU stall (strict >) ──
  {
    const progs = [
      p(CLMM, true, null),
      p(CPMM, true, null),
      p(PUMP, true, null),
    ];
    check("D1S.7bis. toate null, sesiune == stall → NU stall (strict >)", isWsStalled(progs, STALL, STALL) === false);
  }

  // ── D1S.8: toate critice la stall+1 → stall ──
  {
    const progs = [
      p(CLMM, true, STALL + 1),
      p(CPMM, true, STALL + 1),
      p(PUMP, true, STALL + 1),
    ];
    check("D1S.8. toate critice la stall+1 → stalled", isWsStalled(progs, STALL, OLD_SESSION) === true);
  }

  // ── D1S.9: fără programe critice (toate non-critice) → NU stall ──
  {
    const progs = [
      p("diag_a", false, STALL + 1),
      p("diag_b", false, STALL + 1),
    ];
    check("D1S.9. niciun program critic → NU stall", isWsStalled(progs, STALL, OLD_SESSION) === false);
  }

  // ── D1S.10: listă goală → NU stall ──
  {
    check("D1S.10. listă goală → NU stall", isWsStalled([], STALL, OLD_SESSION) === false);
  }

  // ── D1S.11: non-critic viu NU blochează stall-ul criticelor → stall ──
  // (program non-critic SINTETIC — toate cele reale-s critice acum după D4c; funcția suportă încă flag-ul.)
  {
    const progs = [
      p("diag_only", false, 1_000), // non-critic viu (irelevant pt. stall)
      p(CLMM, true, STALL + 1),
      p(CPMM, true, STALL + 1),
      p(PUMP, true, STALL + 1),
    ];
    check("D1S.11. non-critic viu nu blochează stall-ul criticelor → stalled", isWsStalled(progs, STALL, OLD_SESSION) === true);
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
