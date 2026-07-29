/**
 * lib/mcp/dropsConfidence.test.ts — E15 (tp_recent_pipeline_drops afirmă „No drops" HIGH fără date reale).
 *
 * `classifyEmptyDrops` dă HIGH DOAR când datele sunt citibile (per-chain) ȘI worker-ul e proaspăt (agregat pe cel
 * mai slab chain CUNOSCUT — `isWorkerFresh`); absent/corupt/worker-stale → LOW + warning. Plus `dedupeByPair`
 * chain-scoped (integrare directă).
 */
import { classifyEmptyDrops, isWorkerFresh } from "./health-freshness";
import { dedupeByPair } from "./dedupe";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

console.log("E15 — classifyEmptyDrops (HIGH cere date citibile + worker proaspăt)");

// 1. citibil + fresh → HIGH.
{
  const r = classifyEmptyDrops({ dropsReadable: true, workerFresh: true, minutesBack: 10 });
  check("1a. readable + fresh → HIGH", r.confidence === "HIGH");
  check("1b. text «No pipeline drops»", r.text.includes("No pipeline drops"));
  check("1c. fereastra (10)", r.text.includes("10"));
  check("1d. fără warnings", r.warnings === undefined);
}
// 2. !readable → LOW + warning.
{
  const r = classifyEmptyDrops({ dropsReadable: false, workerFresh: true, minutesBack: 10 });
  check("2a. !readable → LOW", r.confidence === "LOW");
  check("2b. warning prezent", Array.isArray(r.warnings) && r.warnings.length === 1);
  check("2c. text «unknown» nu «clean»", /unknown/i.test(r.text) && /not\b/i.test(r.text));
  check("2d. text absent/unreadable/corrupt", /absent|unreadable|corrupt/i.test(r.text));
}
// 3. worker stale → LOW.
{
  const r = classifyEmptyDrops({ dropsReadable: true, workerFresh: false, minutesBack: 10 });
  check("3a. worker stale → LOW", r.confidence === "LOW");
  check("3b. warning stale", Array.isArray(r.warnings) && /stale|unobserved/i.test(r.warnings[0]));
}
// 4. ambele false → LOW.
check("4. !readable + !fresh → LOW", classifyEmptyDrops({ dropsReadable: false, workerFresh: false, minutesBack: 10 }).confidence === "LOW");

console.log("\nE15 — isWorkerFresh (agregat pe cel mai slab chain CUNOSCUT, varu R4)");

const NOW = 1_000_000_000_000;

// 5. ⭐ Base 5s + BSC 8m, ambele cunoscute → NU fresh (chain mort nu se ascunde).
check("5. base fresh + bsc mort (cunoscut) → NU fresh", isWorkerFresh(NOW, { base: NOW - 5_000, bsc: NOW - 8 * 60_000 }, ["base", "bsc"]) === false);
// 6. toate proaspete → fresh.
check("6. toate <60s → fresh", isWorkerFresh(NOW, { base: NOW - 5_000, arbitrum: NOW - 10_000 }, ["base", "arbitrum"]) === true);
// 7. ⭐ chain cunoscut fără snapshot → NU fresh.
check("7. bsc cunoscut fără snapshot → NU fresh", isWorkerFresh(NOW, { base: NOW - 5_000 }, ["base", "bsc"]) === false);
// 8. knownChains gol → NU fresh.
check("8. known gol → NU fresh", isWorkerFresh(NOW, { base: NOW - 5_000 }, []) === false);
// 9. exact pe prag (60s) → NU fresh (strict <).
check("9. base exact 60s → NU fresh", isWorkerFresh(NOW, { base: NOW - 60_000 }, ["base"]) === false);

console.log("\nE15 — dedupeByPair (chain-scoped, integrare directă — varu)");

// 10. ⭐ aceeași adresă pe chain-uri diferite → 2 rezultate (NU comprimate).
{
  const out = dedupeByPair(
    [{ pairAddress: "0xabc", chain: "base", droppedAt: 100 },
     { pairAddress: "0xabc", chain: "arbitrum", droppedAt: 200 }],
    "droppedAt",
  );
  check("10. base:0xabc + arbitrum:0xabc → 2 rezultate", out.length === 2);
}
// 11. aceeași adresă + același chain → 1 rezultat, _eventCount 2, păstrează cel mai recent.
{
  const out = dedupeByPair(
    [{ pairAddress: "0xAbC", chain: "base", droppedAt: 100, tag: "old" },
     { pairAddress: "0xabc", chain: "base", droppedAt: 300, tag: "new" }],
    "droppedAt",
  );
  check("11a. base:0xabc ×2 → 1 rezultat", out.length === 1);
  check("11b. _eventCount = 2", out[0]._eventCount === 2);
  check("11c. păstrează cel mai recent (300/new)", out[0].droppedAt === 300 && (out[0] as any).tag === "new");
}
// 12. fără pairAddress → skip.
check("12. fără pairAddress → skip (0)", dedupeByPair([{ pairAddress: null, chain: "base", droppedAt: 1 }], "droppedAt").length === 0);
// 13. fără chain → fallback pe adresă (aceeași adresă fără chain se comprimă).
{
  const out = dedupeByPair(
    [{ pairAddress: "0xabc", droppedAt: 1 }, { pairAddress: "0xABC", droppedAt: 2 }],
    "droppedAt",
  );
  check("13. fără chain → 1 rezultat (fallback adresă lowercase)", out.length === 1 && out[0]._eventCount === 2);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
