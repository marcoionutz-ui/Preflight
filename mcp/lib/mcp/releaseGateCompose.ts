/**
 * lib/mcp/releaseGateCompose.ts — PH-12 12.5c-4 (verdictul PUR al lanțului de release compus).
 *
 * Dovada REALĂ a întregului release chain (nu două gate-uri verzi rulate separat): un singur runner compune
 *   fixture(plan:"starter") → Gate 1 live (login→consent→token→MCP→refresh→rotație `mcp_rotated`) → captează AT2 privat
 *   → Gate 2 live (worker Base WS-live + strict health + `tp_worker_snapshot` + `tp_health_check`/WS + teardown confirmat)
 *   → cleanup Redis țintit → cleanup Supabase.
 * ACEST modul e DOAR verdictul final, PUR, peste BOOLEENI.
 *
 * ⭐ ANTI-LEAK PRIN TIP (lock Marco): `composeReleaseVerdict` primește EXCLUSIV booleeni — NICIODATĂ tokenul AT2, un
 *   raport, un mesaj de eroare sau o valoare de rețea. AT2 nu poate intra STRUCTURAL în verdict/diagnostic. Runnerul
 *   derivă fiecare boolean din rezultatul respectiv (Gate 1/Gate 2/backstop/Redis/Supabase) ȘI ține AT2 doar într-o
 *   variabilă privată (pasată lui Gate 2 ca argument) + în ledger (exclusiv pentru cleanup) — nici într-un log, nici aici.
 *
 * ⭐ SHORT-CIRCUIT = DOAR alegerea verdictului, NU a cleanup-urilor (lock Marco #1): runnerul AȘTEAPTĂ COMPLET backstop-ul
 *   workerului + cleanup Redis + cleanup Supabase INDIFERENT dacă Gate 1/Gate 2 au picat (toate în `finally`), abia apoi
 *   cheamă funcția asta cu booleenii deja rezolvați. Ordinea de mai jos e DOAR ordinea de DIAGNOSTIC (prima roșie numită).
 *
 * ⭐ `workerBackstopOk` e SEPARAT de `gate2Ok` (lock Marco #2): `runGate2` include deja oprirea normală a workerului, dar
 *   backstop-ul dovedește INDEPENDENT că registrul runnerului nu mai conține un grup POSIBIL ORFAN (consumator Alchemy).
 *   Nu-l ascundem în `gate2Ok`.
 *
 * ⭐ APELAT DOAR după ce `runWithGate1Fixture(...)` s-a încheiat COMPLET: rezultatul cleanup-ului Supabase există abia
 *   după finally-ul wrapper-ului exterior (corpul fixture-ului produce Gate 1/Gate 2/backstop/Redis; wrapper-ul adaugă
 *   Supabase). Verdictul se compune la sfârșit, cu toate cele 6 semnale.
 */

// Etapele lanțului, în ordinea de DIAGNOSTIC (nu de execuție a cleanup-urilor — acelea rulează toate).
export type ReleaseStage =
  | "gate1"
  | "at2_capture"
  | "gate2"
  | "worker_cleanup"
  | "redis_cleanup"
  | "supabase_cleanup";

/**
 * Cele 6 semnale ale lanțului, ca BOOLEENI (AT2 nu apare — anti-leak prin tip). Fiecare = rezultatul respectiv redus
 * la ok/ne-ok de către runner:
 *   - `gate1Ok`           — `runGate1` verde end-to-end (inclusiv `mcp_rotated`).
 *   - `at2Captured`       — AT2 a fost capturat dintr-un `refresh` VALID + `ok` (rotația a produs un access nou).
 *   - `gate2Ok`           — `runGate2(AT2)` verde (worker Base + strict health + date reale + WS subs + stop normal).
 *   - `workerBackstopOk`  — backstop INDEPENDENT: registrul runnerului nu mai are niciun grup posibil orfan (dovedit).
 *   - `redisCleanupOk`    — cleanup Redis țintit complet (ștergere + dovadă de absență).
 *   - `supabaseCleanupOk` — cleanup Supabase fără reziduu (fixture curățat).
 */
export interface ReleaseParts {
  gate1Ok:           boolean;
  at2Captured:       boolean;
  gate2Ok:           boolean;
  workerBackstopOk:  boolean;
  redisCleanupOk:    boolean;
  supabaseCleanupOk: boolean;
}

export type ReleaseVerdict =
  | { ok: true;  note: string }
  | { ok: false; stage: ReleaseStage; reason: string };

// Mesaje STATICE per etapă (zero valori — anti-leak).
const STAGE_REASON: Record<ReleaseStage, string> = {
  gate1:            "Gate 1 (login→consent→token→MCP→refresh→rotație mcp_rotated) NU e verde",
  at2_capture:      "AT2 NU a fost capturat dintr-un refresh valid+ok (rotația n-a produs un access nou)",
  gate2:            "Gate 2 (worker Base WS-live + strict health + tp_worker_snapshot + tp_health_check/WS) NU e verde",
  worker_cleanup:   "backstop worker: un grup POSIBIL ORFAN a rămas în registru (teardown neconfirmat — consumator Alchemy)",
  redis_cleanup:    "cleanup Redis țintit INCOMPLET (ștergere sau dovadă de absență)",
  supabase_cleanup: "cleanup Supabase a lăsat REZIDUU (fixture ne-curățat)",
};

/**
 * Verdictul PUR al lanțului de release. Verde DOAR dacă TOATE cele 6 semnale sunt EXACT `true`. Fail-closed: orice
 * non-`true` (inclusiv `undefined` dintr-un runner buggy) e tratat ca ROȘU — niciodată verde accidental. La eșec,
 * numește PRIMA etapă roșie în ordinea de diagnostic (gate1 → at2_capture → gate2 → worker_cleanup → redis_cleanup →
 * supabase_cleanup); celelalte semnale s-au evaluat oricum (runnerul le-a așteptat complet). Fără AT2/token/raport aici.
 */
export function composeReleaseVerdict(p: ReleaseParts): ReleaseVerdict {
  // `!== true` (nu `!x`) → fail-closed pe orice valoare non-boolean-true venită dintr-un runner.
  const order: ReleaseStage[] = ["gate1", "at2_capture", "gate2", "worker_cleanup", "redis_cleanup", "supabase_cleanup"];
  const value: Record<ReleaseStage, boolean> = {
    gate1:            p.gate1Ok === true,
    at2_capture:      p.at2Captured === true,
    gate2:            p.gate2Ok === true,
    worker_cleanup:   p.workerBackstopOk === true,
    redis_cleanup:    p.redisCleanupOk === true,
    supabase_cleanup: p.supabaseCleanupOk === true,
  };
  for (const stage of order) {
    if (!value[stage]) return { ok: false, stage, reason: STAGE_REASON[stage] };
  }
  return {
    ok: true,
    note: "release chain VERDE end-to-end: Gate 1 → AT2 capturat → Gate 2 → worker teardown confirmat → Redis curat → Supabase curat",
  };
}
