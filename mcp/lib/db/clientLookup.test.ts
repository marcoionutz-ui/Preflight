/**
 * lib/db/clientLookup.test.ts — NF4 (classifyClientLookup: not_found vs unavailable).
 *
 * `getClientById` conflă „client inexistent" cu „eroare Supabase" în `null`. `classifyClientLookup` le separă:
 * error prezent → unavailable (503); data null fără error → not_found (401); data prezent → found. Leaf pur.
 */
import { classifyClientLookup } from "./clientLookup";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

// Stub minimal de client (forma exactă nu contează pt. clasificator).
const CLIENT = { client_id: "c1", secret_rotated_at: "v1" } as any;

function main(): void {
console.log("NF4 — classifyClientLookup (found | not_found | unavailable)");

// found: data prezent, fără eroare.
const found = classifyClientLookup(CLIENT, null);
check("1. data prezent + fără eroare → found", found.status === "found" && (found as any).client === CLIENT);

// not_found: 0 rânduri (.maybeSingle → data null, error null).
check("2. ⭐ data null + error null (0 rânduri) → not_found", classifyClientLookup(null, null).status === "not_found");
check("3. data undefined + error undefined → not_found", classifyClientLookup(undefined, undefined).status === "not_found");

// unavailable: eroare Supabase reală — NU „not_found".
const unavail = classifyClientLookup(null, { message: "ECONNREFUSED to supabase" });
check("4. ⭐ error prezent (data null) → unavailable (NU not_found)", unavail.status === "unavailable");
check("5. unavailable păstrează reason din error.message", unavail.status === "unavailable" && unavail.reason === "ECONNREFUSED to supabase");
check("6. error fără message → unavailable + reason fallback", (() => {
  const r = classifyClientLookup(null, {});
  return r.status === "unavailable" && r.reason === "supabase_error";
})());

// ⭐ eroarea are PRIORITATE peste data: dacă backend-ul a dat și eroare, NU pretinde „found" pe date parțiale.
check("7. ⭐ error prezent CHIAR cu data → unavailable (eroarea câștigă, nu found)", classifyClientLookup(CLIENT, { message: "partial failure" }).status === "unavailable");

// ⭐ dovada NF4: not_found și unavailable sunt DISTINCTE (înainte ambele → null → 401).
const a = classifyClientLookup(null, null);
const b = classifyClientLookup(null, { message: "down" });
check("8. ⭐ not_found ≠ unavailable (nu mai sunt ambele null/401)", a.status !== b.status);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
