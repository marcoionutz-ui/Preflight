/**
 * scripts/beta1/harness/admissionSelfTest.ts — BETA-1, treapta 2: controalele PROPRII ale cazurilor de admitere.
 *
 * Rulează corpul REAL al cazurilor A2-* (`admissionBody`) prin runtime-ul și supraveghetorul reale, peste un WORKER
 * FALS (`fixtures/fakeAdmissionWorker.ts`), cu câte un defect injectat. Verifică faptul că harness-ul:
 *   A — (M12) pe falsul care urmează produsul REPARAT: toate cele cinci controale dau CONTROL_OK; F-V3 / F-V4 cu
 *       ținta marcată routing-only după `scan2` și readmisă (fără marker, cu datele celui de-al doilea răspuns) după
 *       `follow2`; D5 rămâne routing-only;
 *   B — (M12) comportamentul de dinainte de fix (`m12-unadmitted`: follow-refresh fără admitere): F-V3 / F-V4 dau
 *       CONTROL_FAILED cu motivul M1/M2 (coloana `baseline`), S/D5 rămân CONTROL_OK; helper care uită markerul
 *       (`readmit-keeps-marker`) sau nu suprascrie intrarea (`readmit-stale-data`) → F CONTROL_FAILED cu motivul exact —
 *       ambele trec de verificările de după `scan2`, deci doar `follow2` le prinde; (rev2, cgpt P2) baseline-ul e verificat
 *       COMPLET: baseline + swap / LP suplimentar tăcut, ținta în hartă cu filtre baseline, baseline + topic schimbat la
 *       follow2 → HARNESS_ERROR; filtrul COMPLET: topic în plus la scan2, eliminat la follow2, aceleași pool-uri →
 *       CONTROL_FAILED; LP suplimentar la fix → CONTROL_FAILED;
 *   C — bariera de reabonare (§3.1): rundă cu timer încă pending (joburile sunt 0), rundă parțială, timer care
 *       aruncă, cerere rămasă în pending, filtru la nod ≠ instantaneu → HARNESS_ERROR; rundă suprimată → trece;
 *       tipuri ABSENTE (rev3): absență legitimă după dezabonare → trece; subscripție veche rămasă (în worker sau la
 *       nod), dezabonare neconfirmată, tip prezis ACTIV dar absent → HARNESS_ERROR;
 *   D — amestec între coloane, în ambele ETAPE: la STATUT (F-V4 cu V3 activ — nicio coloană) → HARNESS_ERROR la
 *       bariera finală; la CONȚINUT (exemplul cgpt: ținta simultan în V2 și V3; statutul „v2 ACTIV, v3 ACTIV, v4
 *       ABSENT” = coloana „după fix” a lui F-V3, deci trece bariera) → HARNESS_ERROR la etapa de conținut, nu
 *       CONTROL_OK sau CONTROL_FAILED; umplutura într-un filtru la control → CONTROL_FAILED;
 *   E — montaj și rețea: fetch neservit, fetch în plus, țintă neadmisă în watch (scan și follow-refresh), D5 fără
 *       rebuild, timer / fetch la import → HARNESS_ERROR cu motivul exact; (rev2, cgpt P1) ținta urmărită DOAR pe alt
 *       chain (aceeași adresă) → HARNESS_ERROR de montaj, niciodată un verdict pe țintă; (rev2, cgpt P2) răspuns GoPlus
 *       primit, timerul de abort curățat, corpul necitit → bariera AȘTEAPTĂ, la termen HARNESS_ERROR; corpul eliberat
 *       mai târziu (invizibil observatorului de timere) → bariera continuă, CONTROL_OK; (rev3, cgpt P2) citire
 *       respinsă și ignorată de apelant → observatorul NU consumă eroarea: `unhandledRejection` → HARNESS_ERROR; aceeași
 *       respingere tratată de apelant → operația `failed`, fără excepție de proces, CONTROL_OK;
 *   F — martorul și totalurile (§4.1): martor lipsă / cu direcție greșită → HARNESS_ERROR; swap suplimentar pe altă
 *       cheie → CONTROL_FAILED (S și F); ținta neînregistrată → CONTROL_FAILED;
 *       geamăn livrat → HARNESS_ERROR;
 *   I — coerența definițiilor, a manifestului și a acoperirii defectelor (pur); I7–I8 (rev2): cheile de montaj poartă
 *       chain-ul; predicatul „fetch în zbor” acoperă exact stările necitite.
 *
 * NU importă nimic din `src/` și NU exercită workerul real: un rezultat verde spune doar că harness-ul decide corect.
 * Cod de ieșire: 0 = toate controalele au trecut; 3 = altfel.
 */

import path from "node:path";
import { runCaseProcess, verdictFor, type RunnableCase, type SupervisorOptions } from "./supervisor";
import type { CaseVerdict, Outcome } from "./caseProtocol";
import { ADMISSION_DEFS, ADMISSION_IDS, admissionDefsSelfCheck, pairKeys, baseKey, fetchInFlight } from "../cases/admissionDefs";
import type { FetchBodyState } from "./netGuard";
import { ADMISSION_CASES, ADMISSION_ENV, ADMISSION_FILE } from "../runAdmission";
import { A2_FAULTS, parseA2Faults } from "./fixtures/fakeAdmissionWorker";
import fs from "node:fs";

const FAKE_CASE = path.join(__dirname, "fixtures", "fakeAdmissionCase.ts");
const OPTS: SupervisorOptions = { deadlineMs: 60_000, fixedEnv: { ...ADMISSION_ENV } };
const CONCURRENCY = 4;

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failures.push(name); console.log("  ❌ " + name + (detail ? `\n       ${detail}` : "")); }
}

interface Scenario {
  section: string;
  name: string;
  caseId: string;
  fault: string;
  tamper?: string;
  outcome: Outcome;
  /** Fragmente care TREBUIE să apară în motive (toate). */
  reasons?: string[];
  /** Verificare suplimentară pe verdict (observații). */
  extra?: (v: CaseVerdict) => string | null;
}

const obs = (v: CaseVerdict): Record<string, unknown> => v.observations as Record<string, unknown>;
/** Readmiterea după routing-only (M12 rev2): hartă corectă după scan2 și follow2, marker după scan2, fără marker după follow2, date proaspete. */
const readmitted = (v: CaseVerdict, kind: "v3" | "v4"): string | null => {
  const o = obs(v);
  const e = o.targetMapEntry as { priceUsd?: number; reserveUsd?: number } | null;
  const ok = o.targetMapAfterScan2 === kind && o.targetMapAfterFollow2 === kind && o.targetRoutingAfterScan2 === true
    && o.targetRoutingOnly === false && e?.priceUsd === 0.6 && e?.reserveUsd === 700000 && o.filtersUnchangedByFollow2 === true
    && Array.isArray(o.targetOtherChainMaps) && (o.targetOtherChainMaps as unknown[]).length === 0;
  return ok ? null : `readmitere neconfirmată în observații: ${JSON.stringify({ a: o.targetMapAfterScan2, b: o.targetMapAfterFollow2, r2: o.targetRoutingAfterScan2, r: o.targetRoutingOnly, e })}`;
};
const steps = (v: CaseVerdict): Record<string, { rounds: number; unsubscribes: number }> =>
  ((v.observations as { steps?: Record<string, { rounds: number; unsubscribes: number }> }).steps ?? {});

const SCENARIOS: Scenario[] = [
  // A — falsul urmează produsul REPARAT (M12)
  { section: "A", name: "A2-S-V3 → CONTROL_OK, cu o rundă completă la scan1", caseId: "A2-S-V3", fault: "none", outcome: "CONTROL_OK",
    extra: v => steps(v).scan1?.rounds === 1 ? null : `runde la scan1: ${String(steps(v).scan1?.rounds)}` },
  { section: "A", name: "A2-S-V4 → CONTROL_OK", caseId: "A2-S-V4", fault: "none", outcome: "CONTROL_OK" },
  { section: "A", name: "A2-D5 → CONTROL_OK (ținta routing-only după un scan nevid fără ea; rămâne și după follow2)", caseId: "A2-D5", fault: "none", outcome: "CONTROL_OK",
    extra: v => obs(v).targetRoutingAfterScan2 === true && obs(v).targetRoutingOnly === true ? null : "ținta nemarcată routing-only" },
  { section: "A", name: "A2-F-V3 → CONTROL_OK: în v3PoolMap, marcată după scan2, readmisă fără marker și cu datele proaspete după follow2", caseId: "A2-F-V3", fault: "none", outcome: "CONTROL_OK",
    extra: v => readmitted(v, "v3") },
  { section: "A", name: "A2-F-V4 → CONTROL_OK: în v4PoolMap, marcată după scan2, readmisă fără marker și cu datele proaspete după follow2", caseId: "A2-F-V4", fault: "none", outcome: "CONTROL_OK",
    extra: v => readmitted(v, "v4") },
  // B — comportamentul de dinainte de fix și helperi greșiți
  { section: "B", name: "M1 de dinainte de fix (follow-refresh fără admitere): A2-F-V3 → CONTROL_FAILED cu motivul M1", caseId: "A2-F-V3", fault: "m12-unadmitted", outcome: "CONTROL_FAILED",
    reasons: ["comportamentul M1/M2 de dinainte de fix", "adresa în filtrul V2, absentă din V3; swapul V3 nelivrat"] },
  { section: "B", name: "M2 de dinainte de fix: A2-F-V4 → CONTROL_FAILED cu motivul M2", caseId: "A2-F-V4", fault: "m12-unadmitted", outcome: "CONTROL_FAILED",
    reasons: ["comportamentul M1/M2 de dinainte de fix", "poolId-ul în niciun filtru"] },
  { section: "B", name: "fără admitere, A2-S-V3 rămâne CONTROL_OK", caseId: "A2-S-V3", fault: "m12-unadmitted", outcome: "CONTROL_OK" },
  { section: "B", name: "fără admitere, A2-D5 rămâne CONTROL_OK", caseId: "A2-D5", fault: "m12-unadmitted", outcome: "CONTROL_OK" },
  { section: "B", name: "helper care uită markerul: A2-F-V3 → CONTROL_FAILED (doar follow2 îl prinde)", caseId: "A2-F-V3", fault: "readmit-keeps-marker", outcome: "CONTROL_FAILED",
    reasons: ["markerul routing-only nu a dispărut după readmitere (follow2)"],
    extra: v => obs(v).targetRoutingAfterScan2 === true && obs(v).targetMapAfterScan2 === "v3" ? null : "verificările de după scan2 nu erau îndeplinite" },
  { section: "B", name: "helper care uită markerul: A2-F-V4 → CONTROL_FAILED", caseId: "A2-F-V4", fault: "readmit-keeps-marker", outcome: "CONTROL_FAILED",
    reasons: ["markerul routing-only nu a dispărut după readmitere (follow2)"] },
  { section: "B", name: "helper care nu suprascrie intrarea: A2-F-V3 → CONTROL_FAILED (date vechi după follow2)", caseId: "A2-F-V3", fault: "readmit-stale-data", outcome: "CONTROL_FAILED",
    reasons: ["intrarea din hartă nu are datele celui de-al doilea răspuns: {\"priceUsd\":0.5,\"reserveUsd\":600000}"],
    extra: v => obs(v).targetRoutingAfterScan2 === true && obs(v).targetRoutingOnly === false ? null : "markerul nu s-a comportat ca la fix" },
  { section: "B", name: "helper care nu suprascrie intrarea: A2-F-V4 → CONTROL_FAILED", caseId: "A2-F-V4", fault: "readmit-stale-data", outcome: "CONTROL_FAILED",
    reasons: ["intrarea din hartă nu are datele celui de-al doilea răspuns"] },
  // B (M12 rev2, cgpt P2) — baseline-ul verificat COMPLET: orice abatere de la baseline-ul cunoscut → HARNESS_ERROR
  { section: "B", name: "rev2: baseline M1 + swap suplimentar tăcut pe altă cheie → HARNESS_ERROR (nu CONTROL_FAILED)", caseId: "A2-F-V3", fault: "m12-unadmitted+extra-swap", outcome: "HARNESS_ERROR",
    reasons: ["stare baseline (M1/M2) incoerentă", "total swapuri 2, linii de swap 1 (baseline cere exact 1 — martorul)"] },
  { section: "B", name: "rev2: baseline M1 + eveniment LP suplimentar tăcut → HARNESS_ERROR", caseId: "A2-F-V3", fault: "m12-unadmitted+extra-lp", outcome: "HARNESS_ERROR",
    reasons: ["stare baseline (M1/M2) incoerentă", "evenimente LP: 1, linii LP: 0 (se cer 0)"] },
  { section: "B", name: "rev2: ținta în v3PoolMap, dar filtre baseline (F-V3) → HARNESS_ERROR, nu „comportamentul M1”", caseId: "A2-F-V3", fault: "target-mapped-baseline-filters", outcome: "HARNESS_ERROR",
    reasons: ["stare baseline (M1/M2) incoerentă", "ținta în hartă: după scan2 v3, după follow2 v3 (baseline: niciuna)"] },
  { section: "B", name: "rev2: ținta în v4PoolMap, dar filtre baseline (F-V4) → HARNESS_ERROR", caseId: "A2-F-V4", fault: "target-mapped-baseline-filters", outcome: "HARNESS_ERROR",
    reasons: ["stare baseline (M1/M2) incoerentă", "ținta în hartă: după scan2 v4, după follow2 v4 (baseline: niciuna)"] },
  { section: "B", name: "rev2: baseline M1 + topic suplimentar la scan2, eliminat la follow2 → HARNESS_ERROR", caseId: "A2-F-V3", fault: "m12-unadmitted+scan2-extra-topic", outcome: "HARNESS_ERROR",
    reasons: ["stare baseline (M1/M2) incoerentă", "filtrele active s-au schimbat la follow2"] },
  // B (M12 rev2, cgpt P2) — filtrul COMPLET: topic în plus la scan2, eliminat la follow2, ACELEAȘI pool-uri → pică
  { section: "B", name: "rev2: fix + topic suplimentar la scan2, eliminat la follow2, aceleași pool-uri → CONTROL_FAILED", caseId: "A2-F-V3", fault: "scan2-extra-topic", outcome: "CONTROL_FAILED",
    reasons: ["filtrele active s-au schimbat la follow2"],
    extra: v => {
      const st = (v.observations as { steps?: Record<string, { pools: unknown; filters: unknown }> }).steps ?? {};
      const samePools = JSON.stringify(st.scan2?.pools) === JSON.stringify(st.follow2?.pools);
      const diffFilters = JSON.stringify(st.scan2?.filters) !== JSON.stringify(st.follow2?.filters);
      return samePools && diffFilters && obs(v).targetMapAfterFollow2 === "v3" ? null : `regresia nu izolează topicul: pool-uri egale ${samePools}, filtre diferite ${diffFilters}`;
    } },
  { section: "B", name: "rev2: fix + eveniment LP suplimentar tăcut → CONTROL_FAILED", caseId: "A2-F-V3", fault: "extra-lp", outcome: "CONTROL_FAILED",
    reasons: ["evenimente LP: 1, linii LP: 0 (se cer 0)"] },
  // C — bariera
  { section: "C", name: "joburi zero, dar timerul de 1100 ms al rundei rămâne pending → HARNESS_ERROR la termen", caseId: "A2-S-V3", fault: "round-pending", outcome: "HARNESS_ERROR",
    reasons: ["barieră scan1: timere neîncheiate la termen (activeJobCount nu e criteriu)", "1100ms stare=pending"] },
  { section: "C", name: "rundă parțială (2 din 3 timere) → HARNESS_ERROR", caseId: "A2-S-V3", fault: "round-partial", outcome: "HARNESS_ERROR",
    reasons: ["barieră scan1: rundă de reabonare parțială — 2 timer(e) 500ms/800ms"] },
  { section: "C", name: "timerul rundei aruncă → HARNESS_ERROR", caseId: "A2-S-V3", fault: "round-throws", outcome: "HARNESS_ERROR",
    reasons: ["(800ms) nu a rulat complet: stare=threw", "excepție injectată"] },
  { section: "C", name: "rundă suprimată (zero timere) → bariera trece fără să le aștepte → CONTROL_OK", caseId: "A2-S-V3", fault: "round-suppressed", outcome: "CONTROL_OK",
    extra: v => Object.values(steps(v)).every(s => s.rounds === 0) ? null : "runde observate deși suprimate" },
  { section: "C", name: "cerere rămasă în pending → HARNESS_ERROR", caseId: "A2-S-V3", fault: "pending-left", outcome: "HARNESS_ERROR",
    reasons: ["barieră scan1: subscripțiile nu ajung la o stare coerentă: cereri rămase în pending"] },
  { section: "C", name: "filtrul activ la nod ≠ instantaneul confirmat → HARNESS_ERROR", caseId: "A2-S-V3", fault: "node-filter-mismatch", outcome: "HARNESS_ERROR",
    reasons: ["v3: filtrul activ la nod (1 pool-uri) ≠ instantaneul confirmat în worker"] },
  { section: "C", name: "absență legitimă: V2 activ la scan1, dezabonat și confirmat la scan2 → bariera trece → CONTROL_OK", caseId: "A2-S-V3", fault: "transient-v2", outcome: "CONTROL_OK",
    extra: v => steps(v).scan2?.unsubscribes === 1 ? null : `dezabonări la scan2: ${String(steps(v).scan2?.unsubscribes)}` },
  { section: "C", name: "subscripție veche rămasă activă ÎN WORKER când contractul cere absența → HARNESS_ERROR", caseId: "A2-S-V3", fault: "transient-v2-keep-worker", outcome: "HARNESS_ERROR",
    reasons: ["barieră finală: starea stabilă (v2 ACTIV, v3 ACTIV, v4 ABSENT) nu corespunde niciunei coloane"] },
  { section: "C", name: "subscripție veche rămasă activă LA NOD (dezabonare netrimisă) → HARNESS_ERROR", caseId: "A2-S-V3", fault: "transient-v2-keep-node", outcome: "HARNESS_ERROR",
    reasons: ["barieră scan2", "v2: 1 subscripție(i) activă(e) la nod fără intrare activă în worker"] },
  { section: "C", name: "dezabonare trimisă, neconfirmată de nod → HARNESS_ERROR", caseId: "A2-S-V3", fault: "transient-v2-bad-unsub", outcome: "HARNESS_ERROR",
    reasons: ["dezabonare neconfirmată de nod: 0xbad"] },
  { section: "C", name: "tip prezis ACTIV (v3), dar absent → HARNESS_ERROR", caseId: "A2-S-V3", fault: "never-subscribe-v3", outcome: "HARNESS_ERROR",
    reasons: ["barieră finală: starea stabilă (v2 ABSENT, v3 ABSENT, v4 ABSENT) nu corespunde niciunei coloane"] },
  // D — amestec între coloane
  { section: "D", name: "amestec la STATUT: F-V4 cu V3 activ (nicio coloană) → HARNESS_ERROR la bariera finală", caseId: "A2-F-V4", fault: "spurious-v3", outcome: "HARNESS_ERROR",
    reasons: ["barieră finală: starea stabilă (v2 ACTIV, v3 ACTIV, v4 ACTIV) nu corespunde niciunei coloane"] },
  { section: "D", name: "amestec la CONȚINUT (cgpt): ținta simultan în V2 și V3 trece bariera de statut și e respinsă la etapa de conținut → HARNESS_ERROR", caseId: "A2-F-V3", fault: "mix-v2-v3", outcome: "HARNESS_ERROR",
    reasons: ["ținta e simultan în filtrele V2 și V3 (amestec între coloane)", "detectat la etapa de conținut, după barieră"] },
  { section: "D", name: "umplutura într-un filtru la control → CONTROL_FAILED", caseId: "A2-S-V3", fault: "spurious-v3", outcome: "CONTROL_FAILED",
    reasons: ["umplutura (nu e în watch) apare într-un filtru"] },
  // E — montaj, rețea, import
  { section: "E", name: "fetch neservit → HARNESS_ERROR", caseId: "A2-S-V3", fault: "unserved-fetch", outcome: "HARNESS_ERROR",
    reasons: ["fetch scan1: 1 apel(uri) neservite de fixture"] },
  { section: "E", name: "fetch în plus pe un URL servit → HARNESS_ERROR (contorul per URL)", caseId: "A2-S-V3", fault: "extra-fetch", outcome: "HARNESS_ERROR",
    reasons: ["fetch scan1: apeluri per URL diferite de predicție", "trending_pools?page=1 ×2 (prezis ×1)"] },
  { section: "E", name: "ținta neadmisă în watch la scan → HARNESS_ERROR montaj", caseId: "A2-S-V3", fault: "not-admitted", outcome: "HARNESS_ERROR",
    reasons: ["montaj scan1: activeWatch = []"] },
  { section: "E", name: "ținta neadmisă în watch la follow-refresh → HARNESS_ERROR montaj, nu „reprodus”", caseId: "A2-F-V3", fault: "not-admitted", outcome: "HARNESS_ERROR",
    reasons: ["montaj follow: activeWatch"] },
  { section: "E", name: "D5 fără rebuild la al doilea scan → HARNESS_ERROR montaj", caseId: "A2-D5", fault: "d5-no-rebuild", outcome: "HARNESS_ERROR",
    reasons: ["montaj scan2: scanul a păstrat hărțile fără rebuild"] },
  { section: "E", name: "rev2 P1: F-V4 cu ținta urmărită DOAR pe arbitrum (aceeași adresă) → HARNESS_ERROR montaj, niciodată un verdict pe țintă", caseId: "A2-F-V4", fault: "watch-other-chain", outcome: "HARNESS_ERROR",
    reasons: ["montaj follow: activeWatch = [base:", "arbitrum:0xa4a4", "identitate chain + adresă"] },
  { section: "E", name: "rev2 P1: S-V3 cu ținta urmărită DOAR pe arbitrum → HARNESS_ERROR montaj la scan1", caseId: "A2-S-V3", fault: "watch-other-chain", outcome: "HARNESS_ERROR",
    reasons: ["montaj scan1: activeWatch = [arbitrum:0xa3a3"] },
  { section: "E", name: "rev2 P2: răspuns GoPlus primit, timer curățat, corp necitit → bariera așteaptă; la termen HARNESS_ERROR", caseId: "A2-S-V3", fault: "body-pending", outcome: "HARNESS_ERROR",
    reasons: ["barieră scan1: fetch în zbor la termen (timerele pasului sunt încheiate — nu sunt criteriu)", "token_security/8453?contract_addresses=0xf0000000000000000000000000000000000000b1 corp=unread"] },
  { section: "E", name: "rev2 P2: corpul eliberat după 1,5 s (fără timer observat) → bariera continuă după citire → CONTROL_OK", caseId: "A2-S-V3", fault: "body-delayed", outcome: "CONTROL_OK",
    extra: v => {
      const s1 = ((v.observations as { steps?: Record<string, { fetchInFlightAtReturn?: number }> }).steps ?? {}).scan1;
      return (s1?.fetchInFlightAtReturn ?? 0) >= 1 ? null : `fetch în zbor la întoarcerea pasului scan1: ${String(s1?.fetchInFlightAtReturn)} (se cere ≥ 1: bariera a avut ce aștepta)`;
    } },
  { section: "E", name: "rev3 P2: citirea corpului respinsă și IGNORATĂ de apelant → unhandledRejection detectat → HARNESS_ERROR", caseId: "A2-S-V3", fault: "body-reject-ignored", outcome: "HARNESS_ERROR",
    // E3 poartă mesajul erorii, nu felul ei; singura sursă a acestui TypeError e citirea `formData()` respinsă și
    // ignorată, care nu poate ajunge la proces decât ca `unhandledRejection`.
    reasons: ["E3. excepții de proces: TypeError: Content-Type was not one of \"multipart/form-data\""] },
  { section: "E", name: "rev3 P2: aceeași respingere TRATATĂ de apelant → operația „failed”, fără excepție, bariera nu se blochează → CONTROL_OK", caseId: "A2-S-V3", fault: "body-reject-handled", outcome: "CONTROL_OK",
    extra: v => {
      const st = (v.observations as { fetchBodyStates?: Record<string, number> }).fetchBodyStates ?? {};
      return st.failed === 1 && !st.unread && !st.reading && !st.stream ? null : `stări fetch: ${JSON.stringify(st)} (se cere exact 1 failed, nimic în zbor)`;
    } },
  { section: "E", name: "timer la import → HARNESS_ERROR", caseId: "A2-S-V3", fault: "import-timer", outcome: "HARNESS_ERROR",
    reasons: ["timer creat la import"] },
  { section: "E", name: "fetch la import → HARNESS_ERROR", caseId: "A2-S-V3", fault: "import-fetch", outcome: "HARNESS_ERROR",
    reasons: ["apel fetch la import"] },
  // F — martor și totaluri
  { section: "F", name: "martor lipsă → HARNESS_ERROR (niciodată un verdict pe țintă)", caseId: "A2-F-V3", fault: "missing-witness", outcome: "HARNESS_ERROR",
    reasons: ["fluxul nu e dovedit funcțional", "martorul înregistrat: []"] },
  { section: "F", name: "martor cu direcție greșită → HARNESS_ERROR", caseId: "A2-F-V3", fault: "witness-flip", outcome: "HARNESS_ERROR",
    reasons: ["martorul înregistrat: [{\"isBuy\":false"] },
  { section: "F", name: "swap suplimentar pe altă cheie, la control → CONTROL_FAILED", caseId: "A2-S-V3", fault: "extra-swap", outcome: "CONTROL_FAILED",
    reasons: ["swapuri pe (alte chei): 1 (se cer 0)"] },
  { section: "F", name: "swap suplimentar pe altă cheie, la F (control cu martor) → CONTROL_FAILED", caseId: "A2-F-V3", fault: "extra-swap", outcome: "CONTROL_FAILED",
    reasons: ["swapuri pe (alte chei): 1 (se cer 0)"] },
  { section: "F", name: "ținta neînregistrată la control → CONTROL_FAILED", caseId: "A2-S-V3", fault: "no-record-target", outcome: "CONTROL_FAILED",
    reasons: ["swapul țintei înregistrat: []"] },
  { section: "F", name: "geamăn livrat → HARNESS_ERROR", caseId: "A2-F-V3", fault: "none", tamper: "deliver-twin", outcome: "HARNESS_ERROR",
    reasons: ["geamănul negativ (topic străin) a fost trimis de nod"] },
];

async function runScenario(s: Scenario): Promise<{ s: Scenario; v: CaseVerdict | null; err: string | null }> {
  const def = ADMISSION_DEFS[s.caseId];
  const c: RunnableCase = {
    id: s.caseId, kind: def.kind, section: def.section, file: FAKE_CASE,
    args: [`--fault=${s.fault}`, ...(s.tamper ? [`--tamper=${s.tamper}`] : [])],
  };
  try {
    const p = await runCaseProcess(c, OPTS);
    if (p.unreaped) return { s, v: null, err: `terminare neconfirmată (pid ${String(p.pid)})` };
    return { s, v: verdictFor({ id: c.id, kind: c.kind, section: c.section }, p), err: null };
  } catch (e) {
    return { s, v: null, err: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  // ── I — coerență (pur) ──────────────────────────────────────────────────────────────────────────────────────
  console.log("I — coerența definițiilor și a manifestului");
  const defProblems = admissionDefsSelfCheck();
  check("I1 definițiile și fixture-urile sunt coerente", defProblems.length === 0, defProblems.join("; "));
  check("I2 manifestul runAdmission = exact cele cinci cazuri, în ordinea definițiilor, pe fișierul cazurilor reale",
    ADMISSION_CASES.map(c => c.id).join(",") === ADMISSION_IDS.join(",") && ADMISSION_CASES.every(c => c.file === ADMISSION_FILE && fs.existsSync(c.file)));
  check("I3 felul cazurilor (M12): toate cele cinci sunt controale",
    ADMISSION_CASES.every(c => c.kind === "control") && ADMISSION_CASES.length === 5);
  check("I4 mediul fix: LIVE, doar base, Gecko forțat", ADMISSION_ENV.PREFLIGHT_MODE === "LIVE" && ADMISSION_ENV.ENABLED_CHAINS === "base" && ADMISSION_ENV.DISCOVERY_SOURCE === "gecko");
  // M12 rev2: defectele compuse (`a+b`) contează pe componente; fiecare scenariu trebuie să se parseze.
  const badFaults = SCENARIOS.filter(s => parseA2Faults(s.fault) === null).map(s => s.fault);
  check("I5a fiecare defect al scenariilor (inclusiv compus) e cunoscut de fals", badFaults.length === 0, badFaults.join(", "));
  const used = new Set(SCENARIOS.flatMap(s => parseA2Faults(s.fault) ?? []));
  const unused = A2_FAULTS.filter(f => !used.has(f));
  check("I5 fiecare defect al falsului e folosit de cel puțin un scenariu", unused.length === 0, unused.join(", "));
  check("I5b un defect compus cu o componentă necunoscută e respins", parseA2Faults("m12-unadmitted+nu-exista") === null && parseA2Faults("none") !== null);
  const d5 = ADMISSION_DEFS["A2-D5"];
  check("I6 D5: al doilea scan e nevid, fără țintă, doar cu umplutura (fără preț → nu intră în watch)",
    d5.scan2.length === 1 && String(d5.scan2[0].attributes.address) !== d5.target.pair && Number(d5.scan2[0].attributes.base_token_price_usd) === 0);
  {
    // I7 (rev2, cgpt P1): contraexemplul — aceeași adresă, numai pe arbitrum. Doar adresa ar coincide; cheia completă nu.
    const addr = ADMISSION_DEFS["A2-F-V4"].target.pair;
    const onlyOther = { entries: (): Array<[{ chain: string; address: string }, unknown]> => [[{ chain: "arbitrum", address: addr.toUpperCase().replace("0X", "0x") }, {}]] };
    const keys = pairKeys(onlyOther);
    check("I7 cheile de montaj poartă chain-ul: ținta numai pe arbitrum ≠ ținta pe Base (adresa singură ar coincide)",
      keys.length === 1 && keys[0] !== baseKey(addr) && keys[0] === `arbitrum:${addr.toLowerCase()}`, keys.join(","));
  }
  {
    // I8 (rev2, cgpt P2): în zbor = exact stările fără citire încheiată a corpului; refuzul e terminat (eșec).
    const all: FetchBodyState[] = ["unread", "reading", "stream", "read", "failed", "refused"];
    const flying = all.filter(b => fetchInFlight({ seq: 1, url: "u", body: b }));
    check("I8 „fetch în zbor” = unread, reading, stream (timerul nu intră în predicat)", flying.join(",") === "unread,reading,stream", flying.join(","));
  }

  // ── A–F — procese de caz peste workerul fals ────────────────────────────────────────────────────────────────
  const results: Array<{ s: Scenario; v: CaseVerdict | null; err: string | null }> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < SCENARIOS.length) { const s = SCENARIOS[next++]; results.push(await runScenario(s)); }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  for (const section of ["A", "B", "C", "D", "E", "F"]) {
    console.log(`${section}`);
    for (const s of SCENARIOS.filter(x => x.section === section)) {
      const r = results.find(x => x.s === s);
      if (!r || !r.v) { check(`${s.name}`, false, r?.err ?? "nerulat"); continue; }
      const v = r.v;
      const all = v.reasons.join(" | ");
      const missing = (s.reasons ?? []).filter(x => !all.includes(x));
      const extra = s.extra ? s.extra(v) : null;
      const noObsOnHarness = v.outcome !== "HARNESS_ERROR" || Object.keys(v.observations).length === 0;
      check(`${s.name}`, v.outcome === s.outcome && missing.length === 0 && extra === null && noObsOnHarness,
        `rezultat ${String(v.outcome)}; lipsă din motive: ${missing.join(" / ") || "—"}; ${extra ?? ""}; motive: ${all.slice(0, 600)}`);
    }
  }
}

main()
  .catch((e: unknown) => { failures.push("excepție în admissionSelfTest: " + (e instanceof Error ? e.message : String(e))); })
  .finally(() => {
    console.log("");
    console.log(`${passed} trecute, ${failures.length} eșuate`);
    console.log(failures.length === 0
      ? "admissionSelfTest: OK. Validează DOAR harness-ul treptei 2, peste un worker FALS; nu spune nimic despre workerul real sau despre BETA-1."
      : "admissionSelfTest: EȘEC");
    process.exitCode = failures.length === 0 ? 0 : 3;
  });
