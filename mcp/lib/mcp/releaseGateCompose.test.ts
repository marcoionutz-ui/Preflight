/**
 * lib/mcp/releaseGateCompose.test.ts — PH-12 12.5c-4 (verdict pur al lanțului de release, hermetic).
 */
import { composeReleaseVerdict, type ReleaseParts, type ReleaseStage } from "./releaseGateCompose";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

console.log("PH-12 12.5c-4 — releaseGateCompose (verdict pur, booleeni-only)");

const ALL_OK: ReleaseParts = {
  gate1Ok: true, at2Captured: true, gate2Ok: true,
  workerBackstopOk: true, redisCleanupOk: true, supabaseCleanupOk: true,
};

// Ordinea de diagnostic (trebuie respectată de short-circuit).
const ORDER: ReleaseStage[] = ["gate1", "at2_capture", "gate2", "worker_cleanup", "redis_cleanup", "supabase_cleanup"];
// Cheia din ReleaseParts pentru fiecare etapă (ca să setăm un singur semnal fals).
const KEY: Record<ReleaseStage, keyof ReleaseParts> = {
  gate1: "gate1Ok", at2_capture: "at2Captured", gate2: "gate2Ok",
  worker_cleanup: "workerBackstopOk", redis_cleanup: "redisCleanupOk", supabase_cleanup: "supabaseCleanupOk",
};

function main(): void {
  // ── toate verzi → ok ──
  {
    const v = composeReleaseVerdict(ALL_OK);
    // Anti-leak-ul e STRUCTURAL (intrări booleene → niciun token poate intra); nota e un string static. Verificăm doar ok + notă prezentă.
    check("1. ⭐⭐⭐ toate 6 verzi → ok + notă prezentă", v.ok === true && typeof (v as { note: string }).note === "string" && (v as { note: string }).note.length > 0);
  }

  // ── fiecare semnal roșu singur → etapa lui ──
  for (const stage of ORDER) {
    const parts = { ...ALL_OK, [KEY[stage]]: false };
    const v = composeReleaseVerdict(parts);
    check(`2.${stage} ⭐⭐⭐ doar ${stage} roșu → stage ${stage}`, !v.ok && (v as { stage: ReleaseStage }).stage === stage);
  }

  // ── SHORT-CIRCUIT: mai multe roșii → numește PRIMA în ordine ──
  {
    const v = composeReleaseVerdict({ ...ALL_OK, gate2Ok: false, redisCleanupOk: false, supabaseCleanupOk: false });
    check("3. ⭐⭐⭐ gate2 + redis + supabase roșii → numește gate2 (prima în ordine)", !v.ok && (v as { stage: string }).stage === "gate2");
  }
  {
    const v = composeReleaseVerdict({ ...ALL_OK, gate1Ok: false, at2Captured: false, gate2Ok: false, workerBackstopOk: false, redisCleanupOk: false, supabaseCleanupOk: false });
    check("4. ⭐⭐⭐ TOATE roșii → numește gate1 (prima)", !v.ok && (v as { stage: string }).stage === "gate1");
  }
  {
    // worker_cleanup roșu ÎNAINTEA redis/supabase roșii (backstop e separat + are prioritate de diagnostic peste cleanup-uri).
    const v = composeReleaseVerdict({ ...ALL_OK, workerBackstopOk: false, redisCleanupOk: false });
    check("5. ⭐⭐⭐ worker_cleanup + redis roșii → worker_cleanup (backstop separat, prioritate)", !v.ok && (v as { stage: string }).stage === "worker_cleanup");
  }

  // ── backstop SEPARAT de gate2: gate2 verde dar backstop roșu → worker_cleanup (nu ascuns în gate2) ──
  {
    const v = composeReleaseVerdict({ ...ALL_OK, gate2Ok: true, workerBackstopOk: false });
    check("6. ⭐⭐⭐ gate2 verde DAR backstop roșu → worker_cleanup (NU mascat de gate2Ok)", !v.ok && (v as { stage: string }).stage === "worker_cleanup");
  }

  // ── AT2 capture ca etapă distinctă: gate1 verde dar AT2 necapturat → at2_capture ──
  {
    const v = composeReleaseVerdict({ ...ALL_OK, gate1Ok: true, at2Captured: false });
    check("7. ⭐⭐⭐ gate1 verde dar AT2 necapturat → at2_capture (nu gate1)", !v.ok && (v as { stage: string }).stage === "at2_capture");
  }

  // ── FAIL-CLOSED: orice non-`true` (undefined/garbage dintr-un runner buggy) → roșu, niciodată verde accidental ──
  {
    const v = composeReleaseVerdict({ ...ALL_OK, redisCleanupOk: undefined as unknown as boolean });
    check("8. ⭐⭐⭐ redisCleanupOk undefined → redis_cleanup (fail-closed, nu verde)", !v.ok && (v as { stage: string }).stage === "redis_cleanup");
  }
  {
    const v = composeReleaseVerdict({ ...ALL_OK, gate2Ok: "yes" as unknown as boolean });
    check("9. ⭐⭐⭐ gate2Ok truthy non-true ('yes') → gate2 (cere EXACT true)", !v.ok && (v as { stage: string }).stage === "gate2");
  }
  {
    const v = composeReleaseVerdict({} as unknown as ReleaseParts);
    check("10. ⭐⭐ parts gol → roșu gate1 (fail-closed pe toate absente)", !v.ok && (v as { stage: string }).stage === "gate1");
  }

  // ── ANTI-LEAK STRUCTURAL: verdictul nu conține niciun câmp în afară de {ok, stage?, reason?/note} ──
  {
    const v = composeReleaseVerdict({ ...ALL_OK, gate2Ok: false }) as Record<string, unknown>;
    const keys = Object.keys(v).sort().join(",");
    check("11. ⭐⭐⭐ forma verdictului roșu = exact {ok,reason,stage} (fără câmp care ar putea purta AT2)", keys === "ok,reason,stage");
    const okKeys = Object.keys(composeReleaseVerdict(ALL_OK) as Record<string, unknown>).sort().join(",");
    check("11b. ⭐⭐ forma verdictului verde = exact {note,ok}", okKeys === "note,ok");
  }

  console.log(`\n${passed}/${passed + failed} OK` + (failed ? `  —  ${failed} FAIL` : ""));
  if (failed) process.exit(1);
}

main();
