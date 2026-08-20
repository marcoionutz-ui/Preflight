/**
 * lib/oauth/redirectMatch.test.ts — PH-2a GUARD (redirect matching, exact + RFC 8252 loopback port).
 */
import { redirectUriMatches, redirectUriMatchesAny } from "./redirectMatch";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2a — redirect matching (exact + loopback port RFC 8252)");

// ── exact-match implicit ──────────────────────────────────────────────────────
check("1. identic → match", redirectUriMatches("https://claude.ai/api/mcp/cb", "https://claude.ai/api/mcp/cb"));
check("2. ⭐ path diferit → NU (exact-match, fără prefix)", !redirectUriMatches("https://claude.ai/cb", "https://claude.ai/cb/evil"));
check("3. ⭐ host diferit → NU", !redirectUriMatches("https://claude.ai/cb", "https://evil.ai/cb"));
check("4. ⭐ scheme diferit → NU (https vs http)", !redirectUriMatches("https://app.example/cb", "http://app.example/cb"));
check("5. ⭐ query diferit → NU", !redirectUriMatches("https://a.co/cb?x=1", "https://a.co/cb?x=2"));
check("6. ⭐ port diferit pe HTTPS non-loopback → NU (excepția e doar loopback)", !redirectUriMatches("https://a.co:8443/cb", "https://a.co:9000/cb"));

// ── RFC 8252: port variabil DOAR pe IP-literal loopback ───────────────────────
check("7. ⭐⭐ 127.0.0.1 port diferit → MATCH (RFC 8252)", redirectUriMatches("http://127.0.0.1:51000/cb", "http://127.0.0.1:52000/cb"));
check("8. ⭐⭐ [::1] port diferit → MATCH", redirectUriMatches("http://[::1]:8080/cb", "http://[::1]:9090/cb"));
check("9. 127.0.0.1 port identic → MATCH", redirectUriMatches("http://127.0.0.1:3000/cb", "http://127.0.0.1:3000/cb"));
check("10. ⭐⭐ 127.0.0.1 path diferit + port diferit → NU (doar portul poate varia)", !redirectUriMatches("http://127.0.0.1:3000/cb", "http://127.0.0.1:4000/evil"));
check("11. ⭐⭐ 127.0.0.1 query diferit → NU", !redirectUriMatches("http://127.0.0.1:3000/cb?a=1", "http://127.0.0.1:4000/cb?a=2"));

// ── localhost NU beneficiază de excepție (Marco / RFC 8252 = doar IP-literal) ──
check("12. ⭐⭐⭐ localhost port diferit → NU (localhost e exact-match, nu IP-literal)", !redirectUriMatches("http://localhost:3000/cb", "http://localhost:4000/cb"));
check("13. localhost port identic → MATCH (exact)", redirectUriMatches("http://localhost:3000/cb", "http://localhost:3000/cb"));
check("14. ⭐ 127.0.0.1 registered vs localhost presented (port diferit) → NU (host diferă)", !redirectUriMatches("http://127.0.0.1:3000/cb", "http://localhost:4000/cb"));
check("15. ⭐ 127.0.0.1 vs [::1] → NU (IP-literale distincte)", !redirectUriMatches("http://127.0.0.1:3000/cb", "http://[::1]:3000/cb"));

// ── fail-closed prin isSafeRedirectUri ────────────────────────────────────────
check("16. ⭐ fragment în presented → NU (U7)", !redirectUriMatches("https://a.co/cb", "https://a.co/cb#x"));
check("17. ⭐ userinfo → NU (U7)", !redirectUriMatches("https://a.co/cb", "https://user:pass@a.co/cb"));
check("18. ⭐ javascript: → NU", !redirectUriMatches("https://a.co/cb", "javascript:alert(1)"));
check("19. ⭐ http non-loopback → NU (chiar identic, U7 îl respinge)", !redirectUriMatches("http://evil.co/cb", "http://evil.co/cb"));
check("20. non-URL → NU", !redirectUriMatches("https://a.co/cb", "not a url"));

// ── scheme custom native (desktop) ────────────────────────────────────────────
check("21. custom scheme identic → MATCH", redirectUriMatches("myapp://oauth/cb", "myapp://oauth/cb"));
check("22. ⭐ custom scheme diferit → NU", !redirectUriMatches("myapp://oauth/cb", "other://oauth/cb"));

// ── matchesAny (allowlist) ────────────────────────────────────────────────────
const allow = ["https://claude.ai/cb", "http://127.0.0.1:0/callback"];
check("23. ⭐ matchesAny: loopback cu alt port se potrivește pe intrarea 127.0.0.1", redirectUriMatchesAny(allow, "http://127.0.0.1:49213/callback"));
check("24. matchesAny: https exact se potrivește", redirectUriMatchesAny(allow, "https://claude.ai/cb"));
check("25. ⭐ matchesAny: necunoscut → NU", !redirectUriMatchesAny(allow, "http://127.0.0.1:49213/evil"));
check("26. matchesAny: allowlist gol → NU", !redirectUriMatchesAny([], "https://claude.ai/cb"));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
