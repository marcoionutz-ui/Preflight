/**
 * lib/mcp/canaryPkce.test.ts — PH-12 12.5b-0 (PKCE client pur).
 *
 * Dovada cheie (fix cgpt): challenge-ul generat === `deriveS256Challenge(verifier)` — funcția REALĂ, PARTAJATĂ, pe care
 * `verifyCodeVerifier` (server) o folosește la verificare. Nu mai există oglindă locală duplicată: dacă derivarea se
 * schimbă vreodată, se schimbă în UN singur loc și testul + generatorul + serverul rămân aliniați automat.
 */
import { generatePkcePair, generateState } from "./canaryPkce";
import { isValidCodeVerifier, isValidS256Challenge, deriveS256Challenge } from "../oauth/pkce";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

console.log("PH-12 12.5b-0 — canaryPkce (PKCE S256 client + state, pur)");

const pair = generatePkcePair();

check("1. metoda === S256", pair.method === "S256");
check("2. ⭐ verifier trece isValidCodeVerifier (RFC 7636)", isValidCodeVerifier(pair.verifier));
check("3. ⭐ challenge trece isValidS256Challenge (canonic)", isValidS256Challenge(pair.challenge));
check("4. verifier = 43 caractere (32 bytes base64url)", pair.verifier.length === 43);
check("5. ⭐⭐⭐ challenge === deriveS256Challenge(verifier) — funcția REALĂ a serverului (o singură sursă)",
  pair.challenge === deriveS256Challenge(pair.verifier));
check("6. ⭐⭐ o pereche NE-corelată → challenge diferit (nu constantă)",
  deriveS256Challenge(generatePkcePair().verifier) !== pair.challenge);

// Unicitate + validitate pe o baterie (nu constantă).
const N = 200;
const verifiers = new Set<string>();
const challenges = new Set<string>();
let allValid = true;
for (let i = 0; i < N; i++) {
  const p = generatePkcePair();
  verifiers.add(p.verifier);
  challenges.add(p.challenge);
  if (!isValidCodeVerifier(p.verifier) || !isValidS256Challenge(p.challenge)) allValid = false;
  if (deriveS256Challenge(p.verifier) !== p.challenge) allValid = false; // parity cu serverul, pe fiecare
}
check("7. ⭐⭐ 200 perechi: verifieri UNICI", verifiers.size === N);
check("8. ⭐⭐ 200 perechi: challenge-uri UNICE", challenges.size === N);
check("9. ⭐⭐⭐ 200 perechi: TOATE valide + challenge === deriveS256Challenge(verifier)", allValid);

// state
const s = generateState();
check("10. state ne-gol", typeof s === "string" && s.length > 0);
check("11. state e base64url (charset)", /^[A-Za-z0-9_-]+$/.test(s));
const states = new Set<string>();
for (let i = 0; i < N; i++) states.add(generateState());
check("12. ⭐⭐ 200 state-uri UNICE", states.size === N);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
