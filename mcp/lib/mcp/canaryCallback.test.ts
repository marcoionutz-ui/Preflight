/**
 * lib/mcp/canaryCallback.test.ts — PH-12 12.5b-0 (parse + verify callback OAuth, pur). Fail-closed complet (fix cgpt).
 */
import { parseCallbackParams, verifyCallback } from "./canaryCallback";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

console.log("PH-12 12.5b-0 — canaryCallback (parse + verify, pur)");

const ISS = "http://localhost:8080";

// ── parse ──
const okCode = parseCallbackParams("code=abc123&state=st1&iss=" + encodeURIComponent(ISS));
check("A1. cod+state+iss → kind code", okCode.kind === "code" && okCode.code === "abc123" && okCode.state === "st1" && okCode.iss === ISS);

const fromUrl = parseCallbackParams(`http://127.0.0.1:53187/callback?code=xyz&state=st2&iss=${encodeURIComponent(ISS)}`);
check("A2. URL absolut → kind code (query extras corect)", fromUrl.kind === "code" && fromUrl.code === "xyz" && fromUrl.state === "st2");

const withQ = parseCallbackParams("?code=q&state=s");
check("A3. query cu `?` la început → code, iss null", withQ.kind === "code" && withQ.iss === null);

const errCb = parseCallbackParams("error=access_denied&error_description=User%20denied&state=st3&iss=" + encodeURIComponent(ISS));
check("A4. ⭐ error → kind error + description decodat", errCb.kind === "error" && errCb.error === "access_denied" && errCb.error_description === "User denied");

const bothCodeErr = parseCallbackParams("error=server_error&code=shouldignore&state=s");
check("A5. ⭐⭐⭐ code ȘI error simultan → malformed (răspuns contradictoriu, NU interpretat ca error)",
  bothCodeErr.kind === "malformed");

check("A6. ⭐ cod fără state → malformed", parseCallbackParams("code=abc").kind === "malformed");
check("A7. ⭐ nici code nici error → malformed", parseCallbackParams("state=only").kind === "malformed");
check("A8. gol → malformed", parseCallbackParams("").kind === "malformed");
check("A9. non-string → malformed", parseCallbackParams(undefined as unknown as string).kind === "malformed");
check("A10. code gol ('') → malformed", parseCallbackParams("code=&state=s").kind === "malformed");

// fail-closed nou (fix cgpt P2)
check("A11. ⭐⭐⭐ parametru DUPLICAT (code de 2 ori) → malformed (RFC 6749: cel mult o dată)",
  parseCallbackParams("code=a&code=b&state=s").kind === "malformed");
check("A12. ⭐⭐⭐ state DUPLICAT → malformed", parseCallbackParams("code=a&state=s1&state=s2").kind === "malformed");
check("A13. ⭐⭐⭐ state whitespace-only → malformed (nu trece ca prezent)",
  parseCallbackParams("code=a&state=%20%20").kind === "malformed");
check("A14. ⭐⭐⭐ code whitespace-only → malformed", parseCallbackParams("code=%20&state=s").kind === "malformed");
const errDup = parseCallbackParams("error=access_denied&error=server_error&state=s");
check("A15. ⭐⭐ error DUPLICAT → malformed", errDup.kind === "malformed");
const wsIss = parseCallbackParams("code=a&state=s&iss=%20%20");
check("A16. ⭐⭐ iss whitespace-only → tratat ca absent (iss null), tot kind code", wsIss.kind === "code" && wsIss.iss === null);

// fix cgpt P2 (valori opace NEnormalizate): whitespace EXTERIOR pe o valoare opacă → malformed (nu se curăță tăcut).
check("A17. ⭐⭐⭐ state=%20expected%20 (whitespace exterior) → malformed (NU normalizat la 'expected')",
  parseCallbackParams("code=abc&state=%20expected%20").kind === "malformed");
check("A18. ⭐⭐⭐ code=%20abc%20 (whitespace exterior) → malformed",
  parseCallbackParams("code=%20abc%20&state=s").kind === "malformed");
check("A19. ⭐⭐⭐ iss cu whitespace exterior (%20ISS%20) → malformed",
  parseCallbackParams(`code=a&state=s&iss=%20${encodeURIComponent(ISS)}%20`).kind === "malformed");
check("A20. ⭐⭐ valoarea brută e PĂSTRATĂ (state cu spațiu INTERIOR, fără exterior) → kind code, state exact brut",
  (() => { const p = parseCallbackParams("code=a&state=ab%20cd"); return p.kind === "code" && p.state === "ab cd"; })());

// ── verify ──
const goodParsed = parseCallbackParams("code=THECODE&state=expected&iss=" + encodeURIComponent(ISS));
const vOk = verifyCallback(goodParsed, { expectedState: "expected", issuer: ISS });
check("B1. ⭐⭐⭐ state + iss corecte → ok, code întors", vOk.ok === true && vOk.ok && vOk.code === "THECODE");

check("B2. ⭐⭐⭐ state mismatch → fail (CSRF/crossed)",
  verifyCallback(goodParsed, { expectedState: "WRONG", issuer: ISS }).ok === false);
check("B3. ⭐⭐⭐ iss mismatch → fail (AS mixup)",
  verifyCallback(goodParsed, { expectedState: "expected", issuer: "http://evil.example" }).ok === false);

const noIss = parseCallbackParams("code=c&state=expected");
check("B4. ⭐⭐⭐ iss lipsă + requireIss (default) → fail (RFC 9207)",
  verifyCallback(noIss, { expectedState: "expected", issuer: ISS }).ok === false);
check("B5. ⭐⭐ iss lipsă + requireIss:false → ok (relaxat explicit)",
  verifyCallback(noIss, { expectedState: "expected", issuer: ISS, requireIss: false }).ok === true);

// error kind: gărzile state/iss se aplică ÎNAINTE (fix cgpt P2)
const vErrGood = verifyCallback(errCb, { expectedState: "st3", issuer: ISS });
check("B6. ⭐⭐⭐ error cu state+iss corecte → fail cu reason=eroarea de autorizare (nu sare peste verificare)",
  vErrGood.ok === false && !vErrGood.ok && /access_denied/.test(vErrGood.reason));
const vErrState = verifyCallback(errCb, { expectedState: "OTHER", issuer: ISS });
check("B7. ⭐⭐⭐ error cu state GREȘIT → fail cu reason=state mismatch (posibil injectat), NU surfăsat orbește",
  vErrState.ok === false && !vErrState.ok && /state mismatch/.test(vErrState.reason));
const errNoIss = parseCallbackParams("error=access_denied&state=st3");
check("B8. ⭐⭐ error fără iss + requireIss → fail pe iss (garda se aplică și pe error)",
  verifyCallback(errNoIss, { expectedState: "st3", issuer: ISS }).ok === false);

check("B9. ⭐ malformed → fail", verifyCallback(parseCallbackParams("code=x"), { expectedState: "s", issuer: ISS }).ok === false);
check("B10. ⭐⭐ expectedState gol → fail (nu putem verifica round-trip-ul)",
  verifyCallback(goodParsed, { expectedState: "", issuer: ISS }).ok === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
