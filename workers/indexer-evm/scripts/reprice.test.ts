/**
 * scripts/reprice.test.ts — C3 (selecția pt. re-pricing periodic)
 *
 * Verifică `selectPairsToReprice`: exclude neenrichuitele + prețurile proaspete,
 * sortează cele mai vechi întâi, cap la batch, tratează pricedAt lipsă ca cel mai vechi.
 *
 * Rulează: npm run test:c3   (tsx scripts/reprice.test.ts)
 */
import { selectPairsToReprice } from "../src/discovery/pairRegistry";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else       { failed++; console.log("  ❌ " + name); }
}

type P = { id: string; metadataStatus?: string; pricedAt?: number };

function run() {
  console.log("C3 — selectPairsToReprice\n");
  const now = 1_000_000;
  const STALE = 45_000;

  const pairs: P[] = [
    { id: "A", metadataStatus: "OK",      pricedAt: now - 100_000 }, // enriched, stale
    { id: "B", metadataStatus: "OK",      pricedAt: now - 60_000  }, // enriched, stale
    { id: "C", metadataStatus: "OK",      pricedAt: now - 10_000  }, // enriched, PROASPĂT (10s<45s)
    { id: "D",                            pricedAt: now - 100_000 }, // NEenrichuit (fără metadataStatus)
    { id: "E", metadataStatus: "PARTIAL", pricedAt: now - 50_000  }, // enriched, stale
    { id: "F", metadataStatus: "OK"                               }, // enriched, FĂRĂ pricedAt → cel mai vechi
  ];

  const sel = selectPairsToReprice(pairs, now, STALE, 3);
  const ids = sel.map(p => p.id);

  check("1. cap la batch=3", sel.length === 3);
  check("2. exclude proaspătul C", !ids.includes("C"));
  check("3. exclude neenrichuitul D", !ids.includes("D"));
  check("4. pricedAt lipsă (F) e tratat ca cel mai vechi → primul", ids[0] === "F");
  check("5. sortare stalest-first (F, A, B)", ids.join(",") === "F,A,B");
  check("6. E (stale, dar depășit de cap) exclus", !ids.includes("E"));

  // fără cap: toate cele 4 stale-enriched, în ordine
  const all = selectPairsToReprice(pairs, now, STALE, 100).map(p => p.id);
  check("7. fără cap → toate 4 stale-enriched", all.join(",") === "F,A,B,E");

  // niciun stale → gol
  const freshOnly: P[] = [{ id: "X", metadataStatus: "OK", pricedAt: now - 1_000 }];
  check("8. niciun stale → []", selectPairsToReprice(freshOnly, now, STALE, 10).length === 0);

  // prag exact: age == staleMs → inclus (>=)
  const boundary: P[] = [{ id: "Y", metadataStatus: "OK", pricedAt: now - STALE }];
  check("9. age == staleMs → inclus (>=)", selectPairsToReprice(boundary, now, STALE, 10).length === 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
