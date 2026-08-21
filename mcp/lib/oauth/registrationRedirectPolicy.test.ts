/**
 * lib/oauth/registrationRedirectPolicy.test.ts — PH-2a GUARD (allowlist pozitiv de redirect).
 */
import { isAllowedRegistrationRedirect } from "./registrationRedirectPolicy";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2a — registrationRedirectPolicy (allowlist pozitiv)");

// ── permise ──────────────────────────────────────────────────────────────────
check("1. ⭐ https orice host → OK",            isAllowedRegistrationRedirect("https://claude.ai/cb") === true);
check("2. ⭐ http loopback 127.0.0.1 → OK",     isAllowedRegistrationRedirect("http://127.0.0.1:8080/cb") === true);
check("3. ⭐ http [::1] → OK",                  isAllowedRegistrationRedirect("http://[::1]:53211/cb") === true);
check("4. http localhost → OK",                 isAllowedRegistrationRedirect("http://localhost:3000/cb") === true);
check("5. ⭐⭐ custom native reverse-domain → OK", isAllowedRegistrationRedirect("com.example.app:/oauth2redirect") === true);
check("6. custom native cu authority → OK",     isAllowedRegistrationRedirect("com.example.app://cb/done") === true);

// ── respinse: scheme neacoperite (cgpt #6) ───────────────────────────────────
check("7. ⭐⭐⭐ ftp → RESPINS",                 isAllowedRegistrationRedirect("ftp://host/cb") === false);
check("8. ⭐⭐⭐ mailto → RESPINS",              isAllowedRegistrationRedirect("mailto:me@x.io") === false);
check("9. ⭐⭐⭐ ws → RESPINS",                  isAllowedRegistrationRedirect("ws://host/cb") === false);
check("10. ⭐⭐⭐ wss → RESPINS",                isAllowedRegistrationRedirect("wss://host/cb") === false);
check("11. file → RESPINS",                     isAllowedRegistrationRedirect("file:///etc/passwd") === false);

// ── respinse: U7 (blocked/fragment/userinfo/http-non-loopback) ───────────────
check("12. ⭐ javascript → RESPINS",            isAllowedRegistrationRedirect("javascript:alert(1)") === false);
check("13. ⭐ http non-loopback → RESPINS",     isAllowedRegistrationRedirect("http://evil.example.com/cb") === false);
check("14. https cu fragment → RESPINS (U7)",   isAllowedRegistrationRedirect("https://ok.io/cb#x") === false);
check("15. https cu userinfo → RESPINS (U7)",   isAllowedRegistrationRedirect("https://u:p@ok.io/cb") === false);

// ── respinse: schemă custom fără punct (nu e reverse-domain) ──────────────────
check("16. ⭐⭐ myapp:// (fără punct) → RESPINS", isAllowedRegistrationRedirect("myapp://cb") === false);

// ── respinse: input degenerat ────────────────────────────────────────────────
check("17. gol → RESPINS",                      isAllowedRegistrationRedirect("") === false);
check("18. whitespace → RESPINS",               isAllowedRegistrationRedirect("   ") === false);
check("19. neparseabil → RESPINS",              isAllowedRegistrationRedirect("not a url") === false);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
