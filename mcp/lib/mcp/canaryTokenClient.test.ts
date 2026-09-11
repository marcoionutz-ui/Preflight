/**
 * lib/mcp/canaryTokenClient.test.ts — PH-12 12.5b-1 (client /token, transport fake, pur). Anti-leak întărit (cgpt).
 */
import { exchangeAuthCode, refreshToken, buildForm, redactSecret, type PostForm, type TokenClientConfig } from "./canaryTokenClient";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

console.log("PH-12 12.5b-1 — canaryTokenClient (client /token, transport injectat)");

const CFG: TokenClientConfig = {
  tokenEndpoint: "http://127.0.0.1:8080/api/oauth/token",
  clientId:      "canary-client",
  resource:      "http://127.0.0.1:8080/api/mcp",
};

interface Captured { url: string; body: URLSearchParams; headers: Record<string, string>; }
function fakePost(status: number, bodyText: string, sink?: { last?: Captured }): PostForm {
  return async (url, body, headers) => {
    if (sink) sink.last = { url, body: new URLSearchParams(body), headers };
    return { status, text: async () => bodyText };
  };
}
const okToken = JSON.stringify({ access_token: "AT1", token_type: "Bearer", expires_in: 86400, refresh_token: "RT1", scope: "read:pair" });

async function main(): Promise<void> {
  // ── exchangeAuthCode: happy + body ──
  {
    const sink: { last?: Captured } = {};
    const r = await exchangeAuthCode(fakePost(200, okToken, sink), CFG, { code: "CODE", redirectUri: "http://127.0.0.1:5555/callback", codeVerifier: "VERIFIER" });
    check("1. ⭐⭐⭐ happy → ok + access/refresh/scope/expiresIn", r.ok === true && r.ok && r.accessToken === "AT1" && r.refreshToken === "RT1" && r.scope === "read:pair" && r.expiresIn === 86400 && r.tokenType === "Bearer");
    check("1b. ⭐⭐⭐ succes garantează refreshToken: string (tip + runtime)", r.ok && typeof r.refreshToken === "string" && r.refreshToken.length > 0);
    const b = sink.last!.body;
    check("2. ⭐⭐ body: grant_type=authorization_code", b.get("grant_type") === "authorization_code");
    check("3. ⭐⭐ body: code + code_verifier + redirect_uri exact", b.get("code") === "CODE" && b.get("code_verifier") === "VERIFIER" && b.get("redirect_uri") === "http://127.0.0.1:5555/callback");
    check("4. ⭐⭐ body: client_id + resource (audience RFC 8707)", b.get("client_id") === "canary-client" && b.get("resource") === CFG.resource);
    check("5. ⭐ URL = tokenEndpoint + Content-Type form-urlencoded", sink.last!.url === CFG.tokenEndpoint && /application\/x-www-form-urlencoded/.test(sink.last!.headers["Content-Type"]));
  }

  // ── HTTP error: allowlist cod, FĂRĂ error_description ──
  {
    const r = await exchangeAuthCode(fakePost(400, JSON.stringify({ error: "invalid_grant", error_description: "code expired SECRETLEAK" })), CFG, { code: "C", redirectUri: "R", codeVerifier: "V" });
    check("6. ⭐⭐⭐ non-200 → ok:false stage http, status 400, reason=cod OAuth allowlisted", r.ok === false && !r.ok && r.stage === "http" && r.status === 400 && r.reason === "HTTP 400 invalid_grant");
    check("6b. ⭐⭐⭐ ANTI-LEAK: error_description NU apare în reason", r.ok === false && !r.ok && !r.reason.includes("code expired") && !r.reason.includes("SECRETLEAK"));
  }
  {
    // Server ostil: cod ne-allowlisted (posibil purtător de date) → NU-l surfacem, doar statusul.
    const r = await exchangeAuthCode(fakePost(400, JSON.stringify({ error: "evil_code_with_SECRET", error_description: "x" })), CFG, { code: "C", redirectUri: "R", codeVerifier: "V" });
    check("7. ⭐⭐⭐ cod OAuth NE-allowlisted → reason doar 'HTTP 400' (nu ecouă codul inventat)", r.ok === false && !r.ok && r.reason === "HTTP 400");
  }
  {
    // Body ne-JSON (HTML/gunoi cu secret) → doar statusul.
    const r = await exchangeAuthCode(fakePost(500, "<html>internal error CODE=SECRETCODE</html>"), CFG, { code: "C", redirectUri: "R", codeVerifier: "V" });
    check("8. ⭐⭐⭐ body ne-JSON → reason doar 'HTTP 500' (nu ecouă body-ul)", r.ok === false && !r.ok && r.reason === "HTTP 500" && !r.reason.includes("SECRETCODE"));
  }

  // ── 200 dar răspuns invalid → assert fail-closed ──
  {
    const r = await exchangeAuthCode(fakePost(200, JSON.stringify({ access_token: "AT", token_type: "Bearer", expires_in: 86400, scope: "read:pair" })), CFG, { code: "C", redirectUri: "R", codeVerifier: "V" });
    check("9. ⭐⭐⭐ 200 fără refresh → ok:false stage assert (fluxul user cere refresh)", r.ok === false && !r.ok && r.stage === "assert" && /refresh_token lipsă/.test(r.reason));
  }
  {
    const r = await exchangeAuthCode(fakePost(200, "not json"), CFG, { code: "C", redirectUri: "R", codeVerifier: "V" });
    check("10. ⭐⭐ 200 malformat → ok:false stage assert (fail-closed)", r.ok === false && !r.ok && r.stage === "assert");
  }
  {
    const r = await exchangeAuthCode(fakePost(200, JSON.stringify({ access_token: "AT", token_type: "mac", expires_in: 86400, refresh_token: "RT", scope: "s" })), CFG, { code: "C", redirectUri: "R", codeVerifier: "V" });
    check("11. ⭐⭐ token_type non-Bearer → ok:false assert", r.ok === false && !r.ok && r.stage === "assert" && /Bearer/.test(r.reason));
  }
  {
    // Server ostil pune secretul în token_type (200) → assert reason NU-l reflectă (fix la rădăcină în releaseGate).
    const r = await exchangeAuthCode(fakePost(200, JSON.stringify({ access_token: "AT", token_type: "SECRETCODE", expires_in: 86400, refresh_token: "RT", scope: "s" })), CFG, { code: "C", redirectUri: "R", codeVerifier: "V" });
    check("11b. ⭐⭐⭐ ANTI-LEAK: token_type ostil (200) → reason fără secret", r.ok === false && !r.ok && r.stage === "assert" && !r.reason.includes("SECRETCODE"));
  }

  // ── ANTI-LEAK transport: mesajul erorii CONȚINE secretele → reason GENERIC ──
  {
    const leaky: PostForm = async () => { throw new Error("POST failed: code=SECRETCODE&code_verifier=SECRETVERIFIER&refresh_token=SECRETREFRESH"); };
    const r = await exchangeAuthCode(leaky, CFG, { code: "SECRETCODE", redirectUri: "R", codeVerifier: "SECRETVERIFIER" });
    check("12. ⭐⭐⭐ transport throw → ok:false stage http, status null, reason='transport error'", r.ok === false && !r.ok && r.stage === "http" && r.status === null && r.reason === "transport error");
    check("13. ⭐⭐⭐ ANTI-LEAK: mesajul necontrolat NU scurge code/verifier/refresh", r.ok === false && !r.ok && !/SECRET/.test(r.reason));
  }

  // ── refreshToken ──
  {
    const sink: { last?: Captured } = {};
    const rotated = JSON.stringify({ access_token: "AT2", token_type: "Bearer", expires_in: 86400, refresh_token: "RT2", scope: "read:pair" });
    const r = await refreshToken(fakePost(200, rotated, sink), CFG, { refreshToken: "RT1" });
    check("14. ⭐⭐⭐ refresh happy → ok + refreshToken: string nou", r.ok === true && r.ok && r.accessToken === "AT2" && typeof r.refreshToken === "string" && r.refreshToken === "RT2");
    const b = sink.last!.body;
    check("15. ⭐⭐ body: grant_type=refresh_token + refresh_token + client_id + resource", b.get("grant_type") === "refresh_token" && b.get("refresh_token") === "RT1" && b.get("client_id") === "canary-client" && b.get("resource") === CFG.resource);
  }
  {
    // reuse check (pasul 8): refresh vechi → 400 invalid_grant; description cu secret → absent.
    const r = await refreshToken(fakePost(400, JSON.stringify({ error: "invalid_grant", error_description: "revoked token SECRETREFRESH" })), CFG, { refreshToken: "OLD" });
    check("16. ⭐⭐⭐ refresh vechi respins → HTTP 400 invalid_grant (reuse-detection), FĂRĂ secret", r.ok === false && !r.ok && r.reason === "HTTP 400 invalid_grant" && !r.reason.includes("SECRETREFRESH"));
  }
  {
    const r = await refreshToken(fakePost(200, JSON.stringify({ access_token: "AT", token_type: "Bearer", expires_in: 86400, scope: "s" })), CFG, { refreshToken: "RT" });
    check("17. ⭐⭐⭐ rotație FĂRĂ refresh nou → ok:false assert (apelantul NU poate slăbi — nu există expectRefresh)", r.ok === false && !r.ok && r.stage === "assert" && /refresh_token lipsă/.test(r.reason));
  }
  {
    const leaky: PostForm = async () => { throw new Error("boom refresh_token=SECRETREFRESH"); };
    const r = await refreshToken(leaky, CFG, { refreshToken: "SECRETREFRESH" });
    check("18. ⭐⭐⭐ ANTI-LEAK refresh transport throw → reason generic, fără secret", r.ok === false && !r.ok && r.reason === "transport error" && !/SECRET/.test(r.reason));
  }

  // ── helpers puri ──
  check("19. buildForm encodează + escape (spații/&)", buildForm({ a: "x y", b: "1&2" }) === "a=x+y&b=1%262");
  check("20. ⭐⭐ redactSecret: len + prefix sha256, NU secretul", (() => { const r = redactSecret("supersecrettoken"); return /^len=16 sha256=[0-9a-f]{8}$/.test(r) && !r.includes("supersecrettoken"); })());
  check("21. redactSecret('') → len=0", redactSecret("") === "len=0");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("test crashed:", e); process.exit(1); });
