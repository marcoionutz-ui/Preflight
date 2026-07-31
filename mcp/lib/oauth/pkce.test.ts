/**
 * lib/oauth/pkce.test.ts — E1 (PKCE strict, RFC 7636).
 *
 * Dovadă că validarea de format respinge exact ce trebuie: challenge non-S256 / malformat la /authorize și
 * code_verifier sub minimul de entropie / cu caractere nepermise la /token — fără să strice fluxul real
 * (challenge S256 canonic + verifier 43–128 unreserved trec). Leaf pur → rulează standalone în tsx.
 */
import { createHash } from "crypto";
import {
  PKCE_METHOD_S256,
  isValidCodeVerifier,
  isValidS256Challenge,
  validateAuthorizeChallenge,
} from "./pkce";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

// Verifier real, conform (43 caractere unreserved) + challenge-ul S256 canonic derivat din el.
const REAL_VERIFIER  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // 43 char, exemplu RFC 7636 §A
const REAL_CHALLENGE = createHash("sha256").update(REAL_VERIFIER).digest("base64url");

function main(): void {
console.log("E1 — PKCE strict (RFC 7636 format validation)");

// ── isValidS256Challenge ──────────────────────────────────────────────────────
check("1. challenge S256 canonic (43 base64url) e valid", isValidS256Challenge(REAL_CHALLENGE));
check("2. challenge de 43 base64url arbitrar e valid", isValidS256Challenge("A".repeat(43)));
check("3. ⭐ challenge gol → invalid", !isValidS256Challenge(""));
check("4. ⭐ challenge prea scurt (42) → invalid", !isValidS256Challenge("A".repeat(42)));
check("5. ⭐ challenge prea lung (44) → invalid", !isValidS256Challenge("A".repeat(44)));
check("6. ⭐ challenge cu padding base64 „=\" → invalid", !isValidS256Challenge("A".repeat(42) + "="));
check("7. ⭐ challenge cu „+\"/„/\" (base64 standard, nu url) → invalid",
  !isValidS256Challenge("A".repeat(41) + "+/"));
check("8. challenge cu tot alfabetul base64url (-_) → valid", isValidS256Challenge("a-b_" + "c".repeat(39)));
// varu R1: ultimul caracter poartă 2 biți de padding care trebuie să fie zero (SHA-256 = 256 biți în 43 char).
// „B" (index 1) are biți de trailing necanonici → nu poate fi rezultatul unei transformări S256 reale.
check("8b. ⭐ challenge cu trailing bits necanonici (ultim caracter „B\") → invalid",
  !isValidS256Challenge("A".repeat(42) + "B"));
check("8c. ultim caracter canonic (index ≡0 mod 4: A/E/Q/g/w/0/8) → valid pe fiecare",
  ["A", "E", "Q", "g", "w", "0", "8"].every(ch => isValidS256Challenge("A".repeat(42) + ch)));

// ── isValidCodeVerifier ───────────────────────────────────────────────────────
check("9. verifier real (43 unreserved) e valid", isValidCodeVerifier(REAL_VERIFIER));
check("10. verifier de exact 43 caractere → valid", isValidCodeVerifier("a".repeat(43)));
check("11. verifier de exact 128 caractere → valid", isValidCodeVerifier("a".repeat(128)));
check("12. ⭐ verifier de 42 caractere (sub minimul de entropie) → invalid", !isValidCodeVerifier("a".repeat(42)));
check("13. ⭐ verifier de 129 caractere (peste max) → invalid", !isValidCodeVerifier("a".repeat(129)));
check("14. ⭐ verifier gol → invalid", !isValidCodeVerifier(""));
check("15. toate cele 4 caractere speciale unreserved (-._~) sunt permise",
  isValidCodeVerifier("-._~" + "a".repeat(39)));
check("16. ⭐ verifier cu caracter nepermis (spațiu) → invalid", !isValidCodeVerifier("a".repeat(42) + " "));
check("17. ⭐ verifier cu caracter nepermis (/) → invalid", !isValidCodeVerifier("a".repeat(42) + "/"));

// ── validateAuthorizeChallenge (discriminant) ─────────────────────────────────
check("18. S256 + challenge canonic → ok:true", validateAuthorizeChallenge(REAL_CHALLENGE, "S256").ok === true);
check("19. ⭐ metoda „plain\" → ok:false (downgrade blocat)",
  validateAuthorizeChallenge(REAL_CHALLENGE, "plain").ok === false);
check("20. ⭐ metoda goală/absentă → ok:false", validateAuthorizeChallenge(REAL_CHALLENGE, "").ok === false);
check("21. ⭐ metoda „s256\" (case greșit) → ok:false", validateAuthorizeChallenge(REAL_CHALLENGE, "s256").ok === false);
check("22. ⭐ S256 dar challenge malformat → ok:false", validateAuthorizeChallenge("nope", "S256").ok === false);
check("23. reason e prezent pe ok:false (mesaj gata de afișat)", (() => {
  const r = validateAuthorizeChallenge("nope", "S256");
  return r.ok === false && typeof r.reason === "string" && r.reason.length > 0;
})());
check("24. PKCE_METHOD_S256 === \"S256\"", PKCE_METHOD_S256 === "S256");

// ── round-trip real (nu strică fluxul legit) ──────────────────────────────────
check("25. ⭐ round-trip: verifier valid → challenge valid → validateAuthorize ok",
  isValidCodeVerifier(REAL_VERIFIER)
  && isValidS256Challenge(REAL_CHALLENGE)
  && validateAuthorizeChallenge(REAL_CHALLENGE, "S256").ok === true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
