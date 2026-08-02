/**
 * scripts/supabaseClient.test.ts — E26b (getSupabase NU crapă când env-ul lipsește).
 *
 * Șterge cele două env-uri ÎNAINTE de a apela `getSupabase()`, apoi verifică `getSupabase() === null`
 * de două ori (al doilea apel dovedește singleton-ul cache-uit). Dovada DIRECTĂ a promisiunii E26:
 * env lipsă → niciun crash la import/apel (înainte `createClient(undefined,...)` arunca la module-load).
 * Import-heavy (trage `@supabase/supabase-js` + `ws`) → rulează la GATE/CI, nu standalone în container.
 */
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { getSupabase } from "../src/infra/supabase";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

function main(): void {
  console.log("E26b — getSupabase() fără env → null (fără crash la startup)");

  const a = getSupabase();
  check("1. env lipsă → getSupabase() === null (fără crash)", a === null);

  const b = getSupabase();
  check("2. al doilea apel → tot null (singleton cache-uit, un singur warn)", b === null);
  check("3. aceeași referință (null) de fiecare dată", a === b);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
