/**
 * lib/mcp/releaseGateReport.test.ts — PH-12 12.5d-1 (raport structurat + verdict; PUR).
 *
 * Proprietăți dovedite:
 *  - `parseReleaseParts` fail-closed strict (obiect + EXACT 6 booleeni; orice abatere → null).
 *  - `buildReleaseReport` deleagă DECIZIA lui `composeReleaseVerdict` (paritate ok + blamedStage pe cele 64 de combinații).
 *  - anti-leak PRIN STRUCTURĂ: raportul + StageRow poartă DOAR enums+booleeni (fără `reason`/`label` liber).
 *  - `parseReleaseReportJson` fail-closed pe artefactul emis: reconstruiește canonicul prin buildReleaseReport și ACCEPTĂ
 *    DOAR dacă e identic (round-trip); orice deviație (inclusiv reason FALSIFICAT) → null (RESPINS, nu normalizat).
 *  - `releaseExitCode` onest (0 doar pe verde).
 */
import { composeReleaseVerdict, type ReleaseParts, type ReleaseStage } from "./releaseGateCompose";
import {
  parseReleaseParts, buildReleaseReport, buildReleaseReportFromRaw, releaseExitCode,
  renderReleaseReportText, renderReleaseReportJson, parseReleaseReportJson, releaseReportReason,
  RELEASE_STAGE_LABEL, RELEASE_REPORT_VERSION, type ReleaseReport,
} from "./releaseGateReport";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const ALL_TRUE: ReleaseParts = {
  gate1Ok: true, at2Captured: true, gate2Ok: true,
  workerBackstopOk: true, redisCleanupOk: true, supabaseCleanupOk: true,
};
const KEYS: (keyof ReleaseParts)[] = [
  "gate1Ok", "at2Captured", "gate2Ok", "workerBackstopOk", "redisCleanupOk", "supabaseCleanupOk",
];
const KEY_TO_STAGE: Record<keyof ReleaseParts, ReleaseStage> = {
  gate1Ok: "gate1", at2Captured: "at2_capture", gate2Ok: "gate2",
  workerBackstopOk: "worker_cleanup", redisCleanupOk: "redis_cleanup", supabaseCleanupOk: "supabase_cleanup",
};

function main(): void {
  console.log("PH-12 12.5d-1 — releaseGateReport (raport structurat + verdict, PUR)");

  // ── A. parseReleaseParts — fail-closed strict ──────────────────────────────
  check("A1. ⭐⭐⭐ toate 6 booleeni valide → ReleaseParts (nu null)", parseReleaseParts({ ...ALL_TRUE }) !== null);
  check("A1b. valori mixte (false-uri) tot parsează (booleeni valizi)",
    parseReleaseParts({ ...ALL_TRUE, gate1Ok: false, gate2Ok: false }) !== null);
  for (const k of KEYS) {
    const missing: Record<string, unknown> = { ...ALL_TRUE }; delete missing[k];
    check(`A2.${k} ⭐⭐⭐ câmp LIPSĂ → null (fail-closed)`, parseReleaseParts(missing) === null);
    const nonBool: Record<string, unknown> = { ...ALL_TRUE }; nonBool[k] = 1;
    check(`A3.${k} ⭐⭐ non-boolean (number) → null`, parseReleaseParts(nonBool) === null);
  }
  check("A4. ⭐⭐⭐ cheie ÎN PLUS (chiar cu cei 6 corecți) → null (fără câmp străin care ar purta un secret)",
    parseReleaseParts({ ...ALL_TRUE, at2Token: "sekret" }) === null);
  check("A5. ⭐⭐ undefined pe un câmp → null", parseReleaseParts({ ...ALL_TRUE, gate2Ok: undefined }) === null);
  check("A6. ⭐⭐ string 'true' NU e boolean → null", parseReleaseParts({ ...ALL_TRUE, gate1Ok: "true" }) === null);
  check("A7. ⭐⭐ array → null", parseReleaseParts([true, true, true, true, true, true]) === null);
  check("A8. ⭐⭐ null → null", parseReleaseParts(null) === null);
  check("A9. ⭐⭐ non-obiect (number) → null", parseReleaseParts(42) === null);
  check("A10. ⭐⭐ obiect gol → null", parseReleaseParts({}) === null);
  check("A11. ⭐⭐ proprietate pe prototip NU contează (hasOwnProperty) → null",
    parseReleaseParts(Object.create({ gate1Ok: true })) === null);

  // ── B. buildReleaseReport — verde + STRUCTURĂ pură ─────────────────────────
  const green = buildReleaseReport(ALL_TRUE);
  check("B1. ⭐⭐⭐ toate true → ok", green.kind === "verdict" && green.ok === true);
  check("B2. ⭐⭐ verde → blamedStage null", green.kind === "verdict" && green.blamedStage === null);
  check("B3. ⭐⭐ verde → 6 rânduri, toate ok",
    green.kind === "verdict" && green.stages.length === 6 && green.stages.every((s) => s.ok));
  check("B4. ⭐⭐⭐ raportul NU are câmp de text liber (doar kind/ok/blamedStage/stages)",
    green.kind === "verdict" && Object.keys(green).sort().join(",") === "blamedStage,kind,ok,stages");
  check("B5. ⭐⭐⭐ StageRow are EXACT {id,ok} (fără `label` liber — anti-leak prin structură)",
    green.kind === "verdict" && green.stages.every((s) => Object.keys(s).sort().join(",") === "id,ok"));

  // ── C. buildReleaseReport — o etapă roșie (fiecare) ────────────────────────
  for (const k of KEYS) {
    const parts: ReleaseParts = { ...ALL_TRUE, [k]: false };
    const rep = buildReleaseReport(parts);
    const stage = KEY_TO_STAGE[k];
    check(`C.${k} ⭐⭐⭐ singura roșie → ok false + blamedStage=${stage}`,
      rep.kind === "verdict" && rep.ok === false && rep.blamedStage === stage);
    check(`C.${k} rândul etapei e ❌, restul ✅`,
      rep.kind === "verdict" && rep.stages.find((s) => s.id === stage)!.ok === false &&
      rep.stages.filter((s) => s.id !== stage).every((s) => s.ok));
  }

  // ── D. multiple roșii → prima în ordine de diagnostic ──────────────────────
  const multi = buildReleaseReport({ ...ALL_TRUE, gate2Ok: false, redisCleanupOk: false, supabaseCleanupOk: false });
  check("D1. ⭐⭐⭐ gate2+redis+supabase roșii → blamedStage=gate2 (prima în ordine)",
    multi.kind === "verdict" && multi.blamedStage === "gate2");
  check("D2. ⭐⭐ toate cele 3 roșii apar ca ❌ în rânduri (nu doar prima)",
    multi.kind === "verdict" && ["gate2", "redis_cleanup", "supabase_cleanup"].every(
      (id) => multi.stages.find((s) => s.id === id)!.ok === false));
  const worker = buildReleaseReport({ ...ALL_TRUE, gate2Ok: true, workerBackstopOk: false, redisCleanupOk: false });
  check("D3. ⭐⭐⭐ backstop separat: gate2 verde DAR backstop roșu → blamedStage=worker_cleanup (nu mascat de gate2)",
    worker.kind === "verdict" && worker.blamedStage === "worker_cleanup");

  // ── E. paritate DECIZIE cu composeReleaseVerdict pe o baterie exhaustivă (2^6) ──
  let parityOk = true;
  for (let mask = 0; mask < 64; mask++) {
    const parts: ReleaseParts = {
      gate1Ok:           (mask & 1)  !== 0,
      at2Captured:       (mask & 2)  !== 0,
      gate2Ok:           (mask & 4)  !== 0,
      workerBackstopOk:  (mask & 8)  !== 0,
      redisCleanupOk:    (mask & 16) !== 0,
      supabaseCleanupOk: (mask & 32) !== 0,
    };
    const v = composeReleaseVerdict(parts);
    const r = buildReleaseReport(parts);
    if (r.kind !== "verdict") { parityOk = false; break; }
    if (r.ok !== v.ok) { parityOk = false; break; }
    const expectedBlame = v.ok ? null : v.stage;
    if (r.blamedStage !== expectedBlame) { parityOk = false; break; }
  }
  check("E1. ⭐⭐⭐ paritate ok+blamedStage cu composeReleaseVerdict pe TOATE cele 64 de combinații", parityOk);

  // ── F. reason DERIVAT static (fără text liber) ─────────────────────────────
  check("F1. ⭐⭐ reason verde = notă STATICĂ (identică pt. orice raport verde)",
    releaseReportReason(green) === releaseReportReason(buildReleaseReport(ALL_TRUE)) && releaseReportReason(green).includes("VERDE"));
  check("F2. ⭐⭐⭐ reason roșu DERIVAT din blamedStage (conține id-ul + eticheta statică)",
    releaseReportReason(multi).includes("gate2") && releaseReportReason(multi).includes(RELEASE_STAGE_LABEL.gate2));
  check("F3. ⭐⭐ reason malformed = mesaj STATIC", releaseReportReason(buildReleaseReportFromRaw({})).includes("malformate"));

  // ── G. malformed (raw untyped) ─────────────────────────────────────────────
  const mal = buildReleaseReportFromRaw({ gate1Ok: true }); // câmpuri lipsă
  check("G1. ⭐⭐⭐ raw malformat → raport malformed + ok false", mal.kind === "malformed" && mal.ok === false);
  const good = buildReleaseReportFromRaw({ ...ALL_TRUE });
  check("G2. ⭐⭐ raw valid → verdict (nu malformed)", good.kind === "verdict" && good.ok === true);
  const malStar = buildReleaseReportFromRaw({ ...ALL_TRUE, at2Token: "AT2-SECRET" });
  check("G3. ⭐⭐⭐ raw cu câmp străin (posibil token) → malformed (câmpul străin NU trece)", malStar.kind === "malformed");

  // ── H. exit code onest ─────────────────────────────────────────────────────
  check("H1. ⭐⭐⭐ verde → exit 0", releaseExitCode(green) === 0);
  check("H2. ⭐⭐⭐ roșu → exit 1", releaseExitCode(multi) === 1);
  check("H3. ⭐⭐⭐ malformed → exit 1", releaseExitCode(mal) === 1);

  // ── I. rendering ───────────────────────────────────────────────────────────
  const jsonGreen = renderReleaseReportJson(green);
  check("I1. ⭐⭐ JSON verde: ok true, malformed false, blamedStage null, 6 stages",
    jsonGreen.ok === true && jsonGreen.malformed === false && jsonGreen.blamedStage === null && jsonGreen.stages.length === 6);
  check("I2. ⭐⭐⭐ JSON stages au EXACT {id,ok} (fără reason per rând — fără câmp care ar purta un secret)",
    jsonGreen.stages.every((s) => Object.keys(s).sort().join(",") === "id,ok"));
  check("I3. ⭐⭐ JSON top-level are EXACT cheile așteptate (formă stabilă + version)",
    Object.keys(jsonGreen).sort().join(",") === "blamedStage,malformed,ok,reason,stages,version");
  check("I7. ⭐⭐⭐ JSON poartă discriminatorul de versiune (version === RELEASE_REPORT_VERSION)",
    jsonGreen.version === RELEASE_REPORT_VERSION && RELEASE_REPORT_VERSION === 1);
  const jsonRed = renderReleaseReportJson(multi);
  check("I4. ⭐⭐⭐ JSON roșu: blamedStage=gate2 + ok false", jsonRed.blamedStage === "gate2" && jsonRed.ok === false);
  const textRed = renderReleaseReportText(multi);
  check("I5. ⭐⭐ TEXT roșu conține markerul de eșec + etapa vinovată + eticheta DERIVATĂ",
    textRed.includes("ROȘU @ gate2") && textRed.includes("❌") && textRed.includes(RELEASE_STAGE_LABEL.gate2));
  const textGreen = renderReleaseReportText(green);
  check("I6. ⭐⭐ TEXT verde conține markerul de succes + toate ✅",
    textGreen.includes("VERDE") && (textGreen.match(/✅/g) || []).length >= 6);

  // ── J. parseReleaseReportJson — validator fail-closed pe artefactul emis (fix cgpt) ──
  const rtGreen = parseReleaseReportJson(jsonGreen);
  const rtRed   = parseReleaseReportJson(jsonRed);
  const rtMal   = parseReleaseReportJson(renderReleaseReportJson(mal));
  check("J1. ⭐⭐⭐ ROUND-TRIP: render→parse verde → egal (deep)", JSON.stringify(rtGreen) === JSON.stringify(jsonGreen));
  check("J2. ⭐⭐⭐ ROUND-TRIP: render→parse roșu → egal", JSON.stringify(rtRed) === JSON.stringify(jsonRed));
  check("J3. ⭐⭐⭐ ROUND-TRIP: render→parse malformed → egal", JSON.stringify(rtMal) === JSON.stringify(renderReleaseReportJson(mal)));
  check("J4. ⭐⭐ non-obiect / array / null → null",
    parseReleaseReportJson(null) === null && parseReleaseReportJson([]) === null && parseReleaseReportJson("x") === null);
  check("J5. ⭐⭐⭐ cheie LIPSĂ → null", parseReleaseReportJson({ ok: true, malformed: false, blamedStage: null, stages: [] }) === null);
  check("J6. ⭐⭐⭐ cheie ÎN PLUS → null", parseReleaseReportJson({ ...jsonGreen, extra: 1 }) === null);
  check("J7. ⭐⭐ ok non-boolean → null", parseReleaseReportJson({ ...jsonGreen, ok: "yes" }) === null);
  check("J8. ⭐⭐⭐ blamedStage invalid (stage inexistent) → null",
    parseReleaseReportJson({ ...jsonRed, blamedStage: "bogus" }) === null);
  check("J9. ⭐⭐⭐ stage cu id invalid → null",
    parseReleaseReportJson({ ...jsonGreen, stages: [{ id: "nope", ok: true }, ...jsonGreen.stages.slice(1)] }) === null);
  check("J10. ⭐⭐ stage cu formă greșită ({id,ok,extra}) → null",
    parseReleaseReportJson({ ...jsonGreen, stages: [{ id: "gate1", ok: true, x: 1 }, ...jsonGreen.stages.slice(1)] }) === null);
  check("J11. ⭐⭐⭐ verdict cu ≠6 stages → null", parseReleaseReportJson({ ...jsonGreen, stages: jsonGreen.stages.slice(0, 5) }) === null);
  check("J12. ⭐⭐⭐ stage-uri în ORDINE greșită → null",
    parseReleaseReportJson({ ...jsonGreen, stages: [...jsonGreen.stages].reverse() }) === null);
  check("J13. ⭐⭐⭐ ok:true DAR o etapă roșie (input inconsistent cu structura) → null (canonic ok:false)",
    parseReleaseReportJson({ ...jsonGreen, stages: jsonGreen.stages.map((s, i) => i === 2 ? { ...s, ok: false } : s) }) === null);
  check("J14. ⭐⭐⭐ ok:false DAR toate etapele verzi → null (canonic ok:true)",
    parseReleaseReportJson({ ...jsonGreen, ok: false, blamedStage: "gate1" }) === null);
  check("J15. ⭐⭐⭐ blamedStage ≠ cel canonic (redis când gate2 e roșu) → null",
    parseReleaseReportJson({ ...jsonRed, blamedStage: "redis_cleanup" }) === null);
  check("J16. ⭐⭐ malformed:true cu stages ne-goale → null",
    parseReleaseReportJson({ ok: false, malformed: true, blamedStage: null, reason: "x", stages: jsonGreen.stages }) === null);
  check("J17. ⭐⭐ malformed:true cu ok:true → null",
    parseReleaseReportJson({ ok: true, malformed: true, blamedStage: null, reason: "x", stages: [] }) === null);
  // ANTI-LEAK: un artefact cu reason FALSIFICAT (token) NU e normalizat — e RESPINS (→ null).
  const tampered = { ...jsonRed, reason: "AT2-SECRET-abc123 leaked here" };
  check("J18. ⭐⭐⭐ reason FALSIFICAT (token) în artefact → null (RESPINS, NU normalizat)",
    parseReleaseReportJson(tampered) === null);
  check("J19. ⭐⭐ reason non-string → null", parseReleaseReportJson({ ...jsonGreen, reason: 42 }) === null);
  check("J20. ⭐⭐ reason gol/orice string ≠ canonic → null (chiar fără token, un reason diferit e respins)",
    parseReleaseReportJson({ ...jsonGreen, reason: "" }) === null);
  // control pozitiv: un roșu real (blamedStage=worker_cleanup) round-trip-uiește.
  check("J21. ⭐⭐ control pozitiv: artefact roșu VALID (worker_cleanup) → acceptat + egal",
    JSON.stringify(parseReleaseReportJson(renderReleaseReportJson(worker))) === JSON.stringify(renderReleaseReportJson(worker)));
  check("J22. ⭐⭐⭐ version GREȘITĂ → null (discriminator fail-closed)",
    parseReleaseReportJson({ ...jsonGreen, version: 2 }) === null && parseReleaseReportJson({ ...jsonGreen, version: "1" }) === null);
  const noVer: Record<string, unknown> = { ...jsonGreen }; delete noVer.version;
  check("J23. ⭐⭐⭐ version LIPSĂ → null", parseReleaseReportJson(noVer) === null);

  // ── K. frontiera `.mjs`: raport contradictoriu / nestructural → RESPINS la malformed, zero eco de token (fix cgpt) ──
  // token în blamedStage + input contradictoriu (ok:true cu gate2 roșu) → NU e normalizat, e RESPINS; token neapărut.
  const garbageBlame = { kind: "verdict", ok: true, blamedStage: "AT2-SECRET-tok",
    stages: jsonGreen.stages.map((s, i) => i === 2 ? { ...s, ok: false } : s) } as unknown as ReleaseReport;
  check("K1. ⭐⭐⭐ TEXT: blamedStage token + contradictoriu → malformed, token NU e ecouat",
    !renderReleaseReportText(garbageBlame).includes("AT2-SECRET") && renderReleaseReportText(garbageBlame).includes("MALFORMED"));
  check("K2. ⭐⭐⭐ JSON: → malformed, blamedStage null, fără token",
    (() => { const j = renderReleaseReportJson(garbageBlame); return j.malformed === true && j.blamedStage === null && !JSON.stringify(j).includes("AT2-SECRET"); })());
  const garbageId = { kind: "verdict", ok: false, blamedStage: "gate1", stages: [{ id: "TOKEN-id", ok: false }] } as unknown as ReleaseReport;
  check("K3. ⭐⭐⭐ stage.id token (stages non-canonice) → malformed; token NU e ecouat (text + JSON)",
    !renderReleaseReportText(garbageId).includes("TOKEN-id") && !JSON.stringify(renderReleaseReportJson(garbageId)).includes("TOKEN-id") &&
    renderReleaseReportJson(garbageId).malformed === true);
  check("K4. ⭐⭐⭐ releaseExitCode pe raport nestructural (stages goale) → 1 (fail-closed)",
    releaseExitCode({ kind: "verdict", ok: true, blamedStage: "GARBAGE", stages: [] } as unknown as ReleaseReport) === 1);
  check("K5. ⭐⭐ releaseReportReason pe raport contradictoriu → static (fără token)",
    !releaseReportReason(garbageBlame).includes("AT2-SECRET"));
  check("K6. ⭐⭐ control: raport verde valid → render neschimbat (canonicalizarea e no-op pe consistent)",
    renderReleaseReportText(green).includes("VERDE") && renderReleaseReportJson(green).ok === true);

  // ── L. CONTRADICȚIA e RESPINSĂ, nu normalizată (fix cgpt): stages determină canonicul, inputul acceptat DOAR dacă identic ──
  const contradTrue = { kind: "verdict", ok: true, blamedStage: null,
    stages: green.kind === "verdict" ? green.stages.map((s, i) => i === 2 ? { ...s, ok: false } : s) : [] } as unknown as ReleaseReport;
  check("L1. ⭐⭐⭐ ok:true DAR o etapă roșie → RESPINS (releaseExitCode 1, nu 0 fals)", releaseExitCode(contradTrue) === 1);
  check("L2. ⭐⭐⭐ același → JSON malformed (RESPINS, NU recalculat la roșu-verdict)",
    (() => { const j = renderReleaseReportJson(contradTrue); return j.malformed === true && j.blamedStage === null; })());
  check("L3. ⭐⭐⭐ invers: ok:false DAR toate verzi → RESPINS (exit 1, NU normalizat la verde)",
    releaseExitCode({ kind: "verdict", ok: false, blamedStage: "gate1", stages: jsonGreen.stages } as unknown as ReleaseReport) === 1);
  check("L4. ⭐⭐⭐ blamedStage GREȘIT (redis când gate2 e roșu, ok:false corect) → RESPINS (malformed)",
    renderReleaseReportJson({ kind: "verdict", ok: false, blamedStage: "redis_cleanup",
      stages: jsonRed.stages } as unknown as ReleaseReport).malformed === true);
  // control POZITIV: un raport hand-built CONSISTENT (ok/blamedStage = canonicul din stages) e ACCEPTAT nealterat.
  check("L5. ⭐⭐⭐ raport CONSISTENT hand-built (ok:false, blamedStage=gate2, gate2 roșu) → ACCEPTAT (blamedStage gate2)",
    (() => { const j = renderReleaseReportJson({ kind: "verdict", ok: false, blamedStage: "gate2",
      stages: jsonGreen.stages.map((s, i) => i === 2 ? { ...s, ok: false } : s) } as unknown as ReleaseReport);
      return j.malformed === false && j.ok === false && j.blamedStage === "gate2"; })());
  // chei EXACTE (accept-only-if-identical): un câmp străin (posibil token) pe raport SAU pe un rând → RESPINS (malformed).
  check("L5a. ⭐⭐⭐ cheie ÎN PLUS pe raportul verdict (ex. at2Token) → malformed (RESPINS)",
    renderReleaseReportJson({ kind: "verdict", ok: true, blamedStage: null, stages: green.kind === "verdict" ? green.stages : [],
      at2Token: "AT2-SECRET" } as unknown as ReleaseReport).malformed === true);
  check("L5b. ⭐⭐⭐ cheie ÎN PLUS pe un rând de etapă ({id,ok,x}) → malformed (RESPINS)",
    renderReleaseReportJson({ kind: "verdict", ok: true, blamedStage: null,
      stages: (green.kind === "verdict" ? green.stages : []).map((s, i) => i === 0 ? { ...s, x: "AT2-SECRET" } : s) } as unknown as ReleaseReport).malformed === true);
  check("L5c. ⭐⭐ câmpul străin NU e ecouat nici în text nici în JSON",
    (() => { const bad = { kind: "verdict", ok: true, blamedStage: null, stages: green.kind === "verdict" ? green.stages : [],
      at2Token: "AT2-SECRET" } as unknown as ReleaseReport;
      return !renderReleaseReportText(bad).includes("AT2-SECRET") && !JSON.stringify(renderReleaseReportJson(bad)).includes("AT2-SECRET"); })());
  // freeze: harta de etichete e ÎNGHEȚATĂ → un consumator nu o poate muta ca să otrăvească render-ul.
  let mutationBlocked = true;
  try { (RELEASE_STAGE_LABEL as Record<string, string>).gate1 = "PWNED-<script>"; } catch { /* strict mode aruncă */ }
  mutationBlocked = RELEASE_STAGE_LABEL.gate1 !== "PWNED-<script>";
  check("L6. ⭐⭐⭐ RELEASE_STAGE_LABEL e Object.freeze (mutarea de consumator e blocată)",
    Object.isFrozen(RELEASE_STAGE_LABEL) && mutationBlocked);

  console.log(`\n${passed}/${passed + failed} OK` + (failed ? `  —  ${failed} FAIL` : ""));
  if (failed > 0) process.exit(1);
}

main();
