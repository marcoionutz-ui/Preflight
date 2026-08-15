/**
 * lib/mcp/wording.test.ts — PH-15 (wording de poziționare/compliance în suprafața user-facing).
 *
 * varu a flag-uit termeni care sugerează recomandare de tranzacție („signal", „entry blocked", „opportunity",
 * `OK_TO_INVESTIGATE") în output-ul MCP + demo-ul public. Preflight e un strat de OBSERVARE, nu de semnalizare de
 * intrare. Acest test e un GUARD DE SURSĂ: citește fișierele reale și cade dacă vreun termen interzis reapare în
 * suprafața pe care o vede agentul/user-ul. NU atinge contractul worker→Redis (câmpul `opportunitySignals` din
 * scheme rămâne; doar CHEIA DE OUTPUT e neutralizată la boundary → `observedPatterns`, citind din `e.opportunitySignals`).
 *
 * cwd = pachetul mcp (npm rulează scriptul din dir-ul pachetului), deci căile sunt relative la mcp.
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

function main(): void {
console.log("PH-15 — wording user-facing neutralizat (guard de sursă)");

const whyNot   = readFileSync("lib/mcp/tools/tp_why_not.ts", "utf8");
const agent    = readFileSync("lib/mcp/tools/tp_agent_brief.ts", "utf8");
const situation= readFileSync("lib/mcp/tools/tp_situation_report.ts", "utf8");
const safety   = readFileSync("lib/mcp/tools/tp_preflight_safety.ts", "utf8");
const wpipe    = readFileSync("lib/mcp/tools/tp_worker_pipeline.ts", "utf8");
const types    = readFileSync("lib/mcp/types.ts", "utf8");
const report   = readFileSync("lib/reports/pair-context-report.ts", "utf8");
const demo     = readFileSync("app/demo/pair/[chain]/[address]/page.tsx", "utf8");

// ── Termeni INTERZIȘI în suprafața user-facing ──
check("1. tp_why_not: fara 'Absence of a signal' (-> activity)", !/Absence of a signal/.test(whyNot));
check("2. tp_why_not: fara 'entry blocked' (-> not tracked)", !/entry blocked/i.test(whyNot));
check("3. tp_agent_brief: fara 'flow signals' (-> flow data)", !/flow signals/i.test(agent));
check("4. tp_situation_report: fara 'flow signals' (-> flow data)", !/flow signals/i.test(situation));
check("5. tp_preflight_safety: fara 'risk signals' (-> risk indicators)", !/risk signals/i.test(safety));
check("6. tp_worker_pipeline: fara cheia de OUTPUT 'opportunitySignals:' (-> observedPatterns:)", !/opportunitySignals:/.test(wpipe));
check("7. types.ts: fara 'OK_TO_INVESTIGATE' in agentVerdict (-> NO_SAFETY_BLOCKERS)", !/OK_TO_INVESTIGATE/.test(types));
check("8. pair-context-report: fara campul 'lpSignal' (-> lpStatus)", !/lpSignal/.test(report));
check("9. demo public: fara label/'lpSignal' (-> lp status / lpStatus)", !/lpSignal/.test(demo) && !/lp signal/i.test(demo));

// ── Neutralizările POZITIVE trebuie să existe (nu doar absența) ──
check("10. tp_worker_pipeline emite `observedPatterns:` (x2: live + armed)", (wpipe.match(/observedPatterns:/g) ?? []).length >= 2);
check("11. ⭐ tp_worker_pipeline încă CITEȘTE `e.opportunitySignals` (contract worker→Redis intact)", /observedPatterns:\s*e\.opportunitySignals/.test(wpipe));
check("12. report emite `lpStatus`, demo citește `avail.lpStatus`", /lpStatus:/.test(report) && /avail\.lpStatus/.test(demo));
check("13. types.ts agentVerdict conține NO_SAFETY_BLOCKERS", /agentVerdict[\s\S]{0,80}NO_SAFETY_BLOCKERS/.test(types));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
