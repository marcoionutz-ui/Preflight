/**
 * scripts/cursorFailClosed.test.ts — C4 (cursor EVM fail-closed)
 *
 * Verifică că readCursor/writeCursor NU mai colapsează eroarea Redis / valoarea coruptă
 * într-un „first-run" (care ar reseta cursorul + sări blocuri) și că writeCursor semnalează
 * eșecul prin `false` (ca apelantul să nu avanseze health/cursor fals).
 *
 * Rulează: npm run test:c4   (tsx scripts/cursorFailClosed.test.ts)
 */
import { readCursor, writeCursor } from "../src/infra/cursor";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else       { failed++; console.log("  ❌ " + name); }
}

// mock client structural (get/set), configurabil
function mkClient(opts: {
  getVal?: string | null;
  getThrows?: boolean;
  setThrows?: boolean;
  onSet?: (k: string, v: string) => void;
}): any {
  return {
    get: async (_k: string) => {
      if (opts.getThrows) throw new Error("redis down");
      return opts.getVal ?? null;
    },
    set: async (k: string, v: string) => {
      if (opts.setThrows) throw new Error("redis down");
      opts.onSet?.(k, v);
      return "OK";
    },
  };
}

async function run() {
  console.log("C4 — cursor fail-closed\n");

  // ── readCursor ────────────────────────────────────────────────────────────
  // 1. valoare validă → ok:true + număr
  const r1 = await readCursor("base", mkClient({ getVal: "12345" }));
  check("1. cursor valid → {ok:true, value:12345}", r1.ok === true && r1.value === 12345);

  // 2. cheie absentă (null) → ok:true + value:null (first run legit)
  const r2 = await readCursor("base", mkClient({ getVal: null }));
  check("2. cheie absentă → {ok:true, value:null}", r2.ok === true && r2.value === null);

  // 3. eroare Redis → ok:false (NU null/first-run) — bugul central H2
  const r3 = await readCursor("base", mkClient({ getThrows: true }));
  check("3. eroare Redis → {ok:false} (NU first-run)", r3.ok === false);

  // 4. valoare coruptă (non-numerică) → ok:false (fail-closed, nu reset)
  const r4 = await readCursor("base", mkClient({ getVal: "abc" }));
  check("4. valoare coruptă 'abc' → {ok:false}", r4.ok === false);

  // 4b. string gol → ok:false (Redis nu întoarce '' pt cheie absentă → anomalie)
  const r4b = await readCursor("base", mkClient({ getVal: "" }));
  check("4b. valoare '' → {ok:false} (nu o trata ca absență)", r4b.ok === false);

  // 4c-e. validare STRICTĂ (parseInt ar accepta aceste valori corupte)
  const r4c = await readCursor("base", mkClient({ getVal: "123abc" }));
  check("4c. valoare parțial numerică '123abc' → {ok:false}", r4c.ok === false);
  const r4d = await readCursor("base", mkClient({ getVal: "12.5" }));
  check("4d. valoare fracționară '12.5' → {ok:false}", r4d.ok === false);
  const r4e = await readCursor("base", mkClient({ getVal: "-1" }));
  check("4e. cursor negativ '-1' → {ok:false}", r4e.ok === false);
  const r4f = await readCursor("base", mkClient({ getVal: "0" }));
  check("4f. '0' e valid → {ok:true, value:0}", r4f.ok === true && r4f.value === 0);

  // 5. fără client (Redis neconfigurat) → ok:false (fail-closed: fără persistență ≠ first-run)
  const r5 = await readCursor("base", null);
  check("5. fără Redis → {ok:false} (fail-closed)", r5.ok === false);

  // 6. distincție cheie: eroare ≠ absență (regresie H2)
  check("6. eroare și absență au rezultate DISTINCTE",
    r2.ok === true && r3.ok === false);

  // ── writeCursor ───────────────────────────────────────────────────────────
  // 7. scriere reușită → true, cu cheia/valoarea corecte
  let wroteKey = "", wroteVal = "";
  const w7 = await writeCursor("arbitrum", 555, mkClient({ onSet: (k, v) => { wroteKey = k; wroteVal = v; } }));
  check("7a. writeCursor reușit → true", w7 === true);
  check("7b. cheia corectă (preflight:indexer:cursor:arbitrum)", wroteKey === "preflight:indexer:cursor:arbitrum");
  check("7c. valoarea = String(block)", wroteVal === "555");

  // 8. scriere eșuată → false (apelantul NU avansează)
  const w8 = await writeCursor("arbitrum", 555, mkClient({ setThrows: true }));
  check("8. writeCursor eșuat → false", w8 === false);

  // 9. fără client → false (fail-closed: fără persistență nu pretindem succes)
  const w9 = await writeCursor("arbitrum", 555, null);
  check("9. fără Redis → false (fail-closed)", w9 === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error("test harness error:", e); process.exit(1); });
