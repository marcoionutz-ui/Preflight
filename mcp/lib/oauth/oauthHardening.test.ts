/**
 * lib/oauth/oauthHardening.test.ts — U7 (OAuth hardening).
 *   A. resolveBaseUrl/normalizeBaseUrl/shouldWarnMissingBaseUrl (host-header poisoning: env canonic + warn prod)
 *   B. isSafeRedirectUri (https + custom + http-loopback; fără fragment/userinfo/http-nonloopback/scheme periculoase)
 *   C. AUTH_CODE_CONSUME_AND_ISSUE_LUA + classifyIssueResult (atomic issuance — ORDINEA SET-înainte-de-DEL, no-rollback)
 *   D. PROBĂ Redis reală: all-or-nothing — SET NX eșuat → COD PĂSTRAT (skip curat dacă Redis indisponibil)
 * Părțile A/B/C sunt PURE (tsx standalone). Partea D rulează pe Redis real (CI redis:7) sau skip.
 */
import { resolveBaseUrl, normalizeBaseUrl, shouldWarnMissingBaseUrl } from "./baseUrl";
import { isSafeRedirectUri } from "./redirectUri";
import { AUTH_CODE_CONSUME_AND_ISSUE_LUA, classifyIssueResult } from "../db/oauthAtomic";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

// Fake Headers (case-insensitive get, ca Web Headers).
function H(map: Record<string, string>): { get(n: string): string | null } {
  const lower: Record<string, string> = {};
  for (const k of Object.keys(map)) lower[k.toLowerCase()] = map[k];
  return { get: (n: string) => lower[n.toLowerCase()] ?? null };
}

// ── A. normalizeBaseUrl ───────────────────────────────────────────────────────
check("A1. https absolut → păstrat", normalizeBaseUrl("https://mcp.preflight.xyz") === "https://mcp.preflight.xyz");
check("A2. slash trailing → strip", normalizeBaseUrl("https://mcp.preflight.xyz/") === "https://mcp.preflight.xyz");
check("A3. slash-uri multiple → strip", normalizeBaseUrl("https://a.com///") === "https://a.com");
check("A4. http acceptat (dev)", normalizeBaseUrl("http://localhost:3000") === "http://localhost:3000");
check("A5. cu path prefix → păstrat (fără slash final)", normalizeBaseUrl("https://a.com/mcp/") === "https://a.com/mcp");
check("A6. * undefined → null", normalizeBaseUrl(undefined) === null);
check("A7. * gol → null", normalizeBaseUrl("") === null);
check("A8. * whitespace → null", normalizeBaseUrl("   ") === null);
check("A9. * non-URL → null", normalizeBaseUrl("not a url") === null);
check("A10. * ftp: → null (doar http/https)", normalizeBaseUrl("ftp://a.com") === null);
check("A11. * javascript: → null", normalizeBaseUrl("javascript:alert(1)") === null);
check("A12. trim aplicat", normalizeBaseUrl("  https://a.com  ") === "https://a.com");

// ── A. resolveBaseUrl (env canonic, imun la poisoning) ────────────────────────
check("A13. ⭐ PUBLIC_BASE_URL setat → folosit, IGNORĂ x-forwarded-host (imun poisoning)",
  resolveBaseUrl(H({ "x-forwarded-host": "evil.com", "x-forwarded-proto": "https" }), { PUBLIC_BASE_URL: "https://mcp.preflight.xyz" }) === "https://mcp.preflight.xyz");
check("A14. ⭐ PUBLIC_BASE_URL cu slash trailing → normalizat, tot ignoră headerele",
  resolveBaseUrl(H({ "x-forwarded-host": "evil.com" }), { PUBLIC_BASE_URL: "https://mcp.preflight.xyz/" }) === "https://mcp.preflight.xyz");
check("A15. env absent → fallback pe x-forwarded-host (dev/compat)",
  resolveBaseUrl(H({ "x-forwarded-host": "real.com", "x-forwarded-proto": "https" }), {}) === "https://real.com");
check("A16. env absent + doar host → host",
  resolveBaseUrl(H({ "host": "real.com" }), {}) === "https://real.com");
check("A17. env absent → proto default https",
  resolveBaseUrl(H({ "host": "real.com" }), {}).startsWith("https://"));
check("A18. env absent → x-forwarded-proto respectat",
  resolveBaseUrl(H({ "x-forwarded-host": "real.com", "x-forwarded-proto": "http" }), {}) === "http://real.com");
check("A19. * PUBLIC_BASE_URL INVALID → fallback pe header (nu-l folosi orbește)",
  resolveBaseUrl(H({ "x-forwarded-host": "real.com" }), { PUBLIC_BASE_URL: "garbage" }) === "https://real.com");

// ── A. shouldWarnMissingBaseUrl (A1: warning în producție) ────────────────────
check("A20. ⭐ prod + PUBLIC_BASE_URL lipsă → warn", shouldWarnMissingBaseUrl({ NODE_ENV: "production" }) === true);
check("A21. ⭐ prod + PUBLIC_BASE_URL invalid → warn", shouldWarnMissingBaseUrl({ NODE_ENV: "production", PUBLIC_BASE_URL: "garbage" }) === true);
check("A22. * prod + PUBLIC_BASE_URL valid → NU warn", shouldWarnMissingBaseUrl({ NODE_ENV: "production", PUBLIC_BASE_URL: "https://a.com" }) === false);
check("A23. * dev + lipsă → NU warn (doar producția)", shouldWarnMissingBaseUrl({ NODE_ENV: "development" }) === false);
check("A24. * NODE_ENV absent + lipsă → NU warn", shouldWarnMissingBaseUrl({}) === false);

// ── B. isSafeRedirectUri ──────────────────────────────────────────────────────
check("B1. https non-loopback → OK", isSafeRedirectUri("https://claude.ai/api/mcp/callback") === true);
check("B2. https cu query → OK", isSafeRedirectUri("https://claude.ai/cb?x=1") === true);
check("B3. scheme custom native (myapp://) → OK", isSafeRedirectUri("myapp://oauth/callback") === true);
check("B4. http loopback localhost → OK", isSafeRedirectUri("http://localhost:3000/cb") === true);
check("B5. http loopback 127.0.0.1 → OK", isSafeRedirectUri("http://127.0.0.1:8080/cb") === true);
check("B6. http loopback [::1] → OK", isSafeRedirectUri("http://[::1]:3000/cb") === true);
check("B7. * http non-loopback → RESPINS (clear text)", isSafeRedirectUri("http://claude.ai/cb") === false);
check("B8. * javascript: → RESPINS", isSafeRedirectUri("javascript:alert(1)") === false);
check("B9. * data: → RESPINS", isSafeRedirectUri("data:text/html,<script>x</script>") === false);
check("B10. * file: → RESPINS", isSafeRedirectUri("file:///etc/passwd") === false);
check("B11. * vbscript: → RESPINS", isSafeRedirectUri("vbscript:msgbox(1)") === false);
check("B12. * fragment (#) → RESPINS (RFC 6749 §3.1.2)", isSafeRedirectUri("https://claude.ai/cb#frag") === false);
check("B13. * userinfo user:pass@ → RESPINS", isSafeRedirectUri("https://user:pass@claude.ai/cb") === false);
check("B14. * userinfo doar user → RESPINS", isSafeRedirectUri("https://user@claude.ai/cb") === false);
check("B15. * non-URL → RESPINS", isSafeRedirectUri("not a url") === false);
check("B16. * gol → RESPINS", isSafeRedirectUri("") === false);
check("B17. https loopback tot OK (nu restricționăm https la loopback)", isSafeRedirectUri("https://localhost/cb") === true);
check("B18. http uppercase host loopback → OK (case-insensitive)", isSafeRedirectUri("http://LOCALHOST/cb") === true);

// ── C. atomic issuance — ORDINE + clasificator ────────────────────────────────
const setIdx = AUTH_CODE_CONSUME_AND_ISSUE_LUA.indexOf("SET");
const delIdx = AUTH_CODE_CONSUME_AND_ISSUE_LUA.indexOf("DEL");
check("C1. ⭐⭐ SET (token) ÎNAINTE de DEL (cod) — no-rollback safe (nu ardem codul dacă SET pică)",
  setIdx > 0 && delIdx > 0 && setIdx < delIdx);
check("C2. SET folosește NX (write-if-absent → semnal de eșec la collision)", AUTH_CODE_CONSUME_AND_ISSUE_LUA.includes("'NX'"));
check("C3. SET are EX (TTL pe token)", AUTH_CODE_CONSUME_AND_ISSUE_LUA.includes("'EX'"));
check("C4. return -2 pe SET eșuat (ramura care păstrează codul)", AUTH_CODE_CONSUME_AND_ISSUE_LUA.includes("return -2"));
check("C5. classifyIssueResult 1 → issued", classifyIssueResult(1) === "issued");
check("C6. ⭐ classifyIssueResult -2 → write_failed (retry, NU already_used)", classifyIssueResult(-2) === "write_failed");
check("C7. classifyIssueResult 0 → already_used", classifyIssueResult(0) === "already_used");
check("C8. classifyIssueResult -1 → already_used (fail-closed)", classifyIssueResult(-1) === "already_used");

// ── D. PROBĂ Redis reală — all-or-nothing (skip curat dacă indisponibil) ──────
// Împachetat în IIFE async: tsx transformă în CJS (fără top-level await). Sumarul final e la capătul IIFE-ului.
void (async () => {
  console.log("\nU7 — atomic issuance pe Redis real (skip curat dacă indisponibil)");
  let redis: import("ioredis").default | null = null;
  try {
    const { default: Redis } = await import("ioredis");
    const url = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL || "redis://127.0.0.1:6379";
    redis = new Redis(url, { lazyConnect: true, connectTimeout: 800, maxRetriesPerRequest: 1, retryStrategy: () => null });
    await redis.connect();
  } catch {
    console.log("  ⚠️  Redis indisponibil — SKIP partea D.");
    redis = null;
  }
  if (redis) {
    try {
      const CODE = "u7:test:code";
      const TOK  = "u7:test:token";
      const raw  = JSON.stringify({ client_id: "c", scopes: ["read:basic"] });
      const val  = JSON.stringify({ token: "payload" });

      // Happy path: SET token (NX) apoi DEL cod.
      await redis.set(CODE, raw); await redis.del(TOK);
      const r1 = await redis.eval(AUTH_CODE_CONSUME_AND_ISSUE_LUA, 2, CODE, TOK, raw, val, "60");
      check("D1. happy → return 1", Number(r1) === 1);
      check("D2. happy → token scris cu valoarea corectă", (await redis.get(TOK)) === val);
      check("D3. happy → token are TTL (>0)", (await redis.ttl(TOK)) > 0);
      check("D4. happy → codul consumat (șters)", (await redis.get(CODE)) === null);

      // ⭐ Collision: token key deja există → SET NX eșuează → COD PĂSTRAT (finding B1).
      await redis.set(CODE, raw); await redis.set(TOK, "PRE-EXISTING");
      const r2 = await redis.eval(AUTH_CODE_CONSUME_AND_ISSUE_LUA, 2, CODE, TOK, raw, val, "60");
      check("D5. ⭐ SET NX eșuează → return -2 (write_failed)", Number(r2) === -2);
      check("D6. ⭐⭐ COD PĂSTRAT (NU ars fără token) — B1 închis", (await redis.get(CODE)) === raw);
      check("D7. token neschimbat (nu suprascris)", (await redis.get(TOK)) === "PRE-EXISTING");

      // Blob mismatch → -1, cod păstrat, token NEscris.
      await redis.set(CODE, raw); await redis.del(TOK);
      const r3 = await redis.eval(AUTH_CODE_CONSUME_AND_ISSUE_LUA, 2, CODE, TOK, '{"other":true}', val, "60");
      check("D8. blob mismatch → -1", Number(r3) === -1);
      check("D9. blob mismatch → cod păstrat + token NEscris", (await redis.get(CODE)) === raw && (await redis.get(TOK)) === null);

      // Code gone → 0, token NEscris.
      await redis.del(CODE); await redis.del(TOK);
      const r4 = await redis.eval(AUTH_CODE_CONSUME_AND_ISSUE_LUA, 2, CODE, TOK, raw, val, "60");
      check("D10. cod absent → 0 (already_used)", Number(r4) === 0);
      check("D11. cod absent → token NEscris", (await redis.get(TOK)) === null);

      await redis.del(CODE); await redis.del(TOK);
    } finally {
      redis.disconnect();
    }
  }

  console.log(`\n[oauthHardening.test] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
