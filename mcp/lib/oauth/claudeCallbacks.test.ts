/**
 * lib/oauth/claudeCallbacks.test.ts — lotul OAuth staging (design rev3 §3): politica EXACTĂ a callback-urilor Claude.
 *
 * Acoperă: cele două valori acceptate; refuzul oricărei variații (slash final, cale în plus, query, fragment, http,
 * host uppercase, spații, port explicit, loopback/localhost, prefix) și al valorilor non-string; lista e înghețată.
 */
import { CLAUDE_CALLBACKS, isClaudeCallback } from "./claudeCallbacks";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const AI  = "https://claude.ai/api/mcp/auth_callback";
const COM = "https://claude.com/api/mcp/auth_callback";

function main(): void {
console.log("OAuth staging — isClaudeCallback (potrivire exactă, două valori)");

// ── lista ─────────────────────────────────────────────────────────────────────────
check("1. ⭐⭐ CLAUDE_CALLBACKS = exact cele două valori, în ordinea canonică",
  CLAUDE_CALLBACKS.length === 2 && CLAUDE_CALLBACKS[0] === AI && CLAUDE_CALLBACKS[1] === COM);
check("2. ⭐ CLAUDE_CALLBACKS e înghețată (nu se poate extinde la runtime)", Object.isFrozen(CLAUDE_CALLBACKS));

// ── pozitive ──────────────────────────────────────────────────────────────────────
check("3. ⭐⭐⭐ claude.ai callback → true", isClaudeCallback(AI));
check("4. ⭐⭐⭐ claude.com callback → true", isClaudeCallback(COM));

// ── negative: variații de șir ─────────────────────────────────────────────────────
check("5. ⭐⭐⭐ slash final → false", !isClaudeCallback(AI + "/"));
check("6. ⭐⭐⭐ cale în plus (/x) → false", !isClaudeCallback(AI + "/x"));
check("7. ⭐⭐⭐ query → false", !isClaudeCallback(AI + "?a=1"));
check("8. ⭐⭐ query gol (?) → false", !isClaudeCallback(AI + "?"));
check("9. ⭐⭐⭐ fragment → false", !isClaudeCallback(AI + "#f"));
check("10. ⭐⭐⭐ http:// → false", !isClaudeCallback("http://claude.ai/api/mcp/auth_callback"));
check("11. ⭐⭐ host uppercase → false (fără case folding)", !isClaudeCallback("https://Claude.ai/api/mcp/auth_callback"));
check("12. ⭐⭐ schemă uppercase → false", !isClaudeCallback("HTTPS://claude.ai/api/mcp/auth_callback"));
check("13. ⭐⭐ cale uppercase → false", !isClaudeCallback("https://claude.ai/api/mcp/Auth_Callback"));
check("14. ⭐⭐ spațiu înainte → false (fără trim)", !isClaudeCallback(" " + AI));
check("15. ⭐⭐ spațiu/newline după → false (fără trim)", !isClaudeCallback(AI + " ") && !isClaudeCallback(AI + "\n"));
check("16. ⭐⭐ port explicit :443 → false (fără normalizare)", !isClaudeCallback("https://claude.ai:443/api/mcp/auth_callback"));
check("17. ⭐⭐ subdomeniu (www.claude.ai) → false", !isClaudeCallback("https://www.claude.ai/api/mcp/auth_callback"));
check("18. ⭐⭐ host-sufix atacator (claude.ai.evil.com) → false", !isClaudeCallback("https://claude.ai.evil.com/api/mcp/auth_callback"));
check("19. ⭐⭐ userinfo (user@claude.ai) → false", !isClaudeCallback("https://user@claude.ai/api/mcp/auth_callback"));
check("20. ⭐⭐ prefix (fără auth_callback) → false", !isClaudeCallback("https://claude.ai/api/mcp/"));
check("21. ⭐⭐ vechiul callback (/api/mcp/callback) → false", !isClaudeCallback("https://claude.ai/api/mcp/callback"));

// ── negative: loopback (Claude Code, în afara beta-ului) ──────────────────────────
check("22. ⭐⭐⭐ http://localhost/callback → false", !isClaudeCallback("http://localhost/callback"));
check("23. ⭐⭐⭐ http://127.0.0.1:port/callback → false", !isClaudeCallback("http://127.0.0.1:51234/callback"));
check("24. ⭐⭐ http://[::1]/callback → false", !isClaudeCallback("http://[::1]:8976/callback"));
check("25. ⭐⭐ localhost cu calea Claude → false", !isClaudeCallback("http://localhost/api/mcp/auth_callback"));

// ── negative: non-string ──────────────────────────────────────────────────────────
check("26. ⭐⭐ non-string (undefined/null/number/obiect/array) → false",
  !isClaudeCallback(undefined) && !isClaudeCallback(null) && !isClaudeCallback(42)
  && !isClaudeCallback({ toString: () => AI }) && !isClaudeCallback([AI]));
check("27. ⭐ String obiect (new String) → false (doar primitive)", !isClaudeCallback(new String(AI)));
check("28. ⭐ șir gol → false", !isClaudeCallback(""));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
