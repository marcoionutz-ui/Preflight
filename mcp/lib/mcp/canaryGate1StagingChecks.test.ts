/**
 * lib/mcp/canaryGate1StagingChecks.test.ts — lotul OAuth staging, partea C: verdictele pure ale probei.
 */
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import * as C from "./canaryGate1StagingChecks";
import { mcpResponse, mcpErr, ERR, PREFLIGHT_OUTPUT_SCHEMA } from "./errors";
import type { McpCallResult } from "./canaryMcpClient";
import { planAuthCodeTokenIssuance } from "../oauth/authCodeIssuancePlan";
import { readAuthCodeIdentity } from "../oauth/authGrantIssuance";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
const code = (v: { ok: boolean; code?: string }): string => (v.ok ? "ok" : String(v.code));

console.log("lot OAuth staging C — canaryGate1StagingChecks (verdicte pure)");

const O = "https://preflight-staging.up.railway.app";
const raw = (status: number, body: unknown, headers: Record<string, string> = {}): C.RawHttp =>
  ({ status, headers, body: typeof body === "string" ? body : JSON.stringify(body) });

// ── E1: WWW-Authenticate + PRM + AS ──
{
  const good = `Bearer resource_metadata="${O}/.well-known/oauth-protected-resource", scope="read:basic"`;
  const p = C.parseWwwAuthenticate(good);
  check("1. ⭐⭐ parseWwwAuthenticate: schemă + parametri citați", p !== null && p.scheme === "Bearer" && p.params.scope === "read:basic");
  check("2. ⭐ parametru duplicat → null", C.parseWwwAuthenticate('Bearer scope="a", scope="b"') === null);
  check("3. ⭐⭐⭐ 401 + header corect → ok", code(C.checkDiscovery401(raw(401, "{}", { "www-authenticate": good }), O)) === "ok");
  check("4. ⭐⭐⭐ resource_metadata RELATIV (forma veche) → mismatch",
    code(C.checkDiscovery401(raw(401, "{}", { "WWW-Authenticate": 'Bearer resource_metadata="/.well-known/oauth-protected-resource"' }), O)) === "discovery_resource_metadata_mismatch");
  check("5. ⭐⭐ fără scope → discovery_scope_mismatch",
    code(C.checkDiscovery401(raw(401, "{}", { "www-authenticate": `Bearer resource_metadata="${O}/.well-known/oauth-protected-resource"` }), O)) === "discovery_scope_mismatch");
  check("6. ⭐⭐ 200 în loc de 401 → discovery_not_401", code(C.checkDiscovery401(raw(200, "{}", { "www-authenticate": good }), O)) === "discovery_not_401");
  check("7. ⭐ transport → discovery_transport", code(C.checkDiscovery401(null, O)) === "discovery_transport");

  check("8. ⭐⭐⭐ PRM corect → ok", code(C.checkPrm(raw(200, { resource: `${O}/api/mcp`, authorization_servers: [O] }), O)) === "ok");
  check("9. ⭐⭐ PRM resource greșit → prm_resource_mismatch", code(C.checkPrm(raw(200, { resource: `${O}/mcp`, authorization_servers: [O] }), O)) === "prm_resource_mismatch");

  const as = {
    issuer: O, authorization_endpoint: `${O}/authorize`, token_endpoint: `${O}/api/oauth/token`,
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"], code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
  };
  check("10. ⭐⭐⭐ AS corect → ok", code(C.checkAsMetadata(raw(200, as), O)) === "ok");
  check("11. ⭐⭐⭐ AS cu registration_endpoint (DCR) → refuz", code(C.checkAsMetadata(raw(200, { ...as, registration_endpoint: `${O}/register` }), O)) === "as_registration_endpoint_present");
  check("12. ⭐⭐⭐ AS fără flag CIMD → as_cimd_not_supported", code(C.checkAsMetadata(raw(200, { ...as, client_id_metadata_document_supported: undefined }), O)) === "as_cimd_not_supported");
  check("13. ⭐⭐ AS fără none → as_none_missing", code(C.checkAsMetadata(raw(200, { ...as, token_endpoint_auth_methods_supported: ["client_secret_post"] }), O)) === "as_none_missing");
  check("14. ⭐⭐ AS fără S256 → as_s256_missing", code(C.checkAsMetadata(raw(200, { ...as, code_challenge_methods_supported: ["plain"] }), O)) === "as_s256_missing");
}

// ── „apel valid” ──
{
  const validate = C.makeSdkOutputSchemaValidator();
  // EXACT conversia cu care serverul SDK publică `outputSchema` (server/mcp.js, tools/list).
  const schema = toJsonSchemaCompat(PREFLIGHT_OUTPUT_SCHEMA, { strictUnions: true, pipeStrategy: "output" });
  // Forma EXACTĂ a lui tp_situation_report pe Redis GOL (fără worker): toate cheile null → stări goale.
  const empty = mcpResponse({
    text: "WORKER: ⚠️ offline or stale\nMARKET: ⚫ DEAD | buying:0% coverage:0%\nPIPELINE: watching:0 hot:0 armed:0 qualified:0\nSTATUS: Pipeline empty. Worker scanning.",
    freshnessSec: null, confidence: "LOW", coverageNote: "WS coverage 0% — flow data partial",
    warnings: ["Worker snapshot offline or stale", "WS coverage 0% — flow data partial"],
    dataQuality: { wsFlow: "absent" },
    evidence: { trackedPairs: 0, watching: 0, hot: 0, armed: 0, qualifiedActive: 0, qualifiedStale: 0, workerOnline: false, compression: { tracked: 0, watching: 0, hot: 0, priority: 0 } },
  });
  const okCall: McpCallResult = { ok: true, content: empty.content, isError: false, structuredContent: empty.structuredContent };
  check("15. ⭐⭐⭐ raportul pe Redis gol (ok:true) e VALID față de outputSchema (validatorul SDK)", code(C.checkValidToolCall(okCall, schema, validate)) === "ok");
  const err = mcpErr(ERR.REDIS_DOWN, "Redis not connected");
  check("16. ⭐⭐⭐ isError:true cu HTTP 200 → call_is_error", code(C.checkValidToolCall({ ok: true, content: err.content, isError: true }, schema, validate)) === "call_is_error");
  check("17. ⭐⭐ fără structuredContent → structured_missing", code(C.checkValidToolCall({ ok: true, content: [], isError: false }, schema, validate)) === "structured_missing");
  check("18. ⭐⭐ ok:false în structuredContent → structured_not_ok", code(C.checkValidToolCall({ ok: true, content: [], isError: false, structuredContent: { ok: false } }, schema, validate)) === "structured_not_ok");
  check("19. ⭐⭐⭐ ok:true dar formă invalidă (câmp extra, strict) → output_schema_invalid",
    code(C.checkValidToolCall({ ok: true, content: [], isError: false, structuredContent: { ...empty.structuredContent, extra: 1 } }, schema, validate)) === "output_schema_invalid");
  check("20. ⭐⭐ HTTP 401 → mcp_unauthorized", code(C.checkValidToolCall({ ok: false, stage: "http", status: 401, reason: "x" }, schema, validate)) === "mcp_unauthorized");
  check("21. ⭐ schemă necompilabilă → output_schema_unusable", validate({ type: 12 }, {}) === "error");
  check("22. ⭐⭐ findToolOutputSchema: găsește / absent / duplicat",
    C.findToolOutputSchema([{ name: "tp_situation_report", outputSchema: schema }], "tp_situation_report") === schema
    && C.findToolOutputSchema([{ name: "x" }], "tp_situation_report") === null
    && C.findToolOutputSchema([{ name: "t", outputSchema: {} }, { name: "t", outputSchema: {} }], "t") === null);
  check("23. ⭐⭐ checkCallRejected401: 401 ok, succes → call_not_rejected, 403 → wrong_status",
    code(C.checkCallRejected401({ ok: false, stage: "http", status: 401, reason: "" })) === "ok"
    && code(C.checkCallRejected401(okCall)) === "call_not_rejected"
    && code(C.checkCallRejected401({ ok: false, stage: "http", status: 403, reason: "" })) === "call_rejected_wrong_status");
}

// ── /token ──
{
  check("24. ⭐⭐⭐ 400 invalid_grant fără token → ok", code(C.checkTokenRefusal({ status: 400, body: '{"error":"invalid_grant","error_description":"x"}' }, { status: 400, error: "invalid_grant" })) === "ok");
  check("25. ⭐⭐⭐ corp cu access_token (chiar pe 400) → refusal_body_has_token",
    code(C.checkTokenRefusal({ status: 400, body: '{"error":"invalid_grant","access_token":"AT"}' }, { status: 400, error: "invalid_grant" })) === "refusal_body_has_token");
  check("26. ⭐⭐⭐ 200 cu tokenuri (refresh legacy acceptat) → refusal_body_has_token",
    code(C.checkTokenRefusal({ status: 200, body: '{"access_token":"A","refresh_token":"R"}' }, { status: 400, error: "invalid_grant" })) === "refusal_body_has_token");
  check("27. ⭐⭐ 401 invalid_client așteptat, primit 400 → refusal_wrong_status", code(C.checkTokenRefusal({ status: 400, body: '{"error":"invalid_client"}' }, { status: 401, error: "invalid_client" })) === "refusal_wrong_status");
  check("28. ⭐⭐ eroare OAuth greșită → refusal_wrong_error", code(C.checkTokenRefusal({ status: 400, body: '{"error":"invalid_request"}' }, { status: 400, error: "invalid_grant" })) === "refusal_wrong_error");
  const cc = C.parseClientCredentialsResponse({ status: 200, body: '{"access_token":"AT1","token_type":"Bearer","expires_in":86400,"scope":"read:basic"}' });
  check("29. ⭐⭐ client_credentials 200 → access token", cc.ok && cc.accessToken === "AT1");
  check("30. ⭐⭐ client_credentials 401 → cc_invalid_client", code(C.parseClientCredentialsResponse({ status: 401, body: "{}" })) === "cc_invalid_client");
  check("31. ⭐⭐⭐ scope user ≠ read:basic → token_scope_mismatch",
    code(C.checkUserToken({ ok: true, accessToken: "a", refreshToken: "r", tokenType: "Bearer", expiresIn: 1, scope: "read:basic read:all" })) === "token_scope_mismatch"
    && code(C.checkUserToken({ ok: true, accessToken: "a", refreshToken: "r", tokenType: "Bearer", expiresIn: 1, scope: "read:basic" })) === "ok");
}

// ── E4 / E2n / E3n ──
{
  const CB = "https://claude.ai/api/mcp/auth_callback";
  const exp = { redirectUri: CB, expectedState: "ST", issuer: O };
  const loc = (q: Record<string, string>, base = CB): string => `${base}?${new URLSearchParams(q).toString()}`;
  const good = C.checkClaudeCallbackCapture(loc({ code: "CODE", state: "ST", iss: O }), exp);
  check("32. ⭐⭐⭐ captură validă → codul (doar în memorie)", good.ok && good.code === "CODE");
  check("33. ⭐⭐⭐ state greșit → capture_state_mismatch", code(C.checkClaudeCallbackCapture(loc({ code: "C", state: "X", iss: O }), exp)) === "capture_state_mismatch");
  check("34. ⭐⭐⭐ iss lipsă → capture_iss_mismatch", code(C.checkClaudeCallbackCapture(loc({ code: "C", state: "ST" }), exp)) === "capture_iss_mismatch");
  check("35. ⭐⭐⭐ altă țintă (…/auth_callback/x) → capture_wrong_target", code(C.checkClaudeCallbackCapture(loc({ code: "C", state: "ST", iss: O }, `${CB}/x`), exp)) === "capture_wrong_target");
  check("36. ⭐⭐ error=access_denied → capture_error_returned", code(C.checkClaudeCallbackCapture(loc({ error: "access_denied", state: "ST", iss: O }), exp)) === "capture_error_returned");
  check("37. ⭐⭐ verdictul nu conține codul", !JSON.stringify(C.checkClaudeCallbackCapture(loc({ code: "SECRETCODE", state: "X", iss: O }), exp)).includes("SECRETCODE"));

  const denied = loc({ error: "access_denied", state: "ST", iss: O });
  check("38. ⭐⭐⭐ E2n: fără consimțământ, fără capturi, fără entitlement → ok",
    code(C.checkUnentitledRefusal({ approveVisible: false, captures: [], entitlementFound: false, exp })) === "ok");
  check("39. ⭐⭐ E2n: access_denied interceptat → ok", code(C.checkUnentitledRefusal({ approveVisible: false, captures: [denied], entitlementFound: false, exp })) === "ok");
  check("40. ⭐⭐⭐ E2n: cod emis → unentitled_code_issued", code(C.checkUnentitledRefusal({ approveVisible: false, captures: [loc({ code: "C", state: "ST", iss: O })], entitlementFound: false, exp })) === "unentitled_code_issued");
  check("41. ⭐⭐⭐ E2n: buton Approve afișat → unentitled_consent_rendered", code(C.checkUnentitledRefusal({ approveVisible: true, captures: [], entitlementFound: false, exp })) === "unentitled_consent_rendered");
  check("42. ⭐⭐⭐ E2n: entitlement creat → unentitled_entitlement_created", code(C.checkUnentitledRefusal({ approveVisible: false, captures: [], entitlementFound: true, exp })) === "unentitled_entitlement_created");

  check("43. ⭐⭐⭐ E3n: 400 local, fără redirect → ok", code(C.checkLocalRefusal({ startStatus: 400, redirectLocation: null, approveVisible: false, offsiteCaptures: 0 })) === "ok");
  check("44. ⭐⭐⭐ E3n: redirect → refusal_redirected", code(C.checkLocalRefusal({ startStatus: null, redirectLocation: "http://localhost/callback?error=x", approveVisible: false, offsiteCaptures: 0 })) === "refusal_redirected");
  check("45. ⭐⭐ E3n: 200 (nu 400) → refusal_not_400", code(C.checkLocalRefusal({ startStatus: 200, redirectLocation: null, approveVisible: false, offsiteCaptures: 0 })) === "refusal_not_400");

  const hop1 = C.nextHop({ status: 307, headers: { location: "/api/oauth/authorize/start?x=1" }, body: "" }, `${O}/authorize?x=1`, O);
  check("46. ⭐⭐ nextHop: 307 relativ → same_origin absolut", hop1.kind === "same_origin" && hop1.url === `${O}/api/oauth/authorize/start?x=1`);
  const hop2 = C.nextHop({ status: 302, headers: { location: "http://localhost/callback?error=a" }, body: "" }, `${O}/api/oauth/authorize/start`, O);
  check("47. ⭐⭐⭐ nextHop: redirect spre loopback → offsite (NU urmat)", hop2.kind === "offsite");
  const hop3 = C.nextHop({ status: 200, headers: {}, body: '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/api/oauth/authorize/start?a=1&amp;b=2"/>' }, `${O}/authorize`, O);
  check("48. ⭐⭐ nextHop: meta-refresh Next → same_origin (entități decodate)", hop3.kind === "same_origin" && hop3.url === `${O}/api/oauth/authorize/start?a=1&b=2`);
  check("49. ⭐ nextHop: 400 → final", C.nextHop({ status: 400, headers: {}, body: "x" }, `${O}/api/oauth/authorize/start`, O).kind === "final");
}

// ── rânduri ──
{
  const T0 = Date.parse("2026-11-03T10:00:00Z");
  const DAY = 86_400_000;
  const ent = { user_id: "U", plan: "free_trial", scopes: ["read:basic"], rate_limit_per_minute: 10, rate_limit_per_day: 500, status: "active", access_expires_at: new Date(T0 + 14 * DAY + 1000).toISOString() };
  check("50. ⭐⭐⭐ entitlement răscumpărat (≈ +14 zile) → ok", code(C.checkRedeemedEntitlement(ent, "U", T0, T0 + 5000, 14)) === "ok");
  check("51. ⭐⭐ expirare +30 zile → entitlement_expiry_off", code(C.checkRedeemedEntitlement({ ...ent, access_expires_at: new Date(T0 + 30 * DAY).toISOString() }, "U", T0, T0 + 5000, 14)) === "entitlement_expiry_off");
  check("52. ⭐⭐ expirare null → entitlement_expiry_off", code(C.checkRedeemedEntitlement({ ...ent, access_expires_at: null }, "U", T0, T0, 14)) === "entitlement_expiry_off");
  check("53. ⭐⭐ scope read:all → entitlement_shape", code(C.checkRedeemedEntitlement({ ...ent, scopes: ["read:all"] }, "U", T0, T0, 14)) === "entitlement_shape");
  check("54. ⭐⭐ invitație răscumpărată de user → ok; de altul → invite_redeemed_by_other",
    code(C.checkInviteRedeemed({ invite_id: "I", redeemed_at: "2026-11-03T10:00:00Z", redeemed_by: "U" }, "I", "U")) === "ok"
    && code(C.checkInviteRedeemed({ invite_id: "I", redeemed_at: "2026-11-03T10:00:00Z", redeemed_by: "V" }, "I", "U")) === "invite_redeemed_by_other"
    && code(C.checkInviteRedeemed({ invite_id: "I", redeemed_at: null, redeemed_by: null }, "I", "U")) === "invite_not_redeemed");
  check("55. ⭐⭐⭐ grant-uri: toate revoked + unul pe CIMD → ok; unul activ → grant_still_active",
    code(C.checkGrantsRevoked([{ client_id: "CIMD", status: "revoked" }], "CIMD")) === "ok"
    && code(C.checkGrantsRevoked([{ client_id: "CIMD", status: "revoked" }, { client_id: "CIMD", status: "active" }], "CIMD")) === "grant_still_active"
    && code(C.checkGrantsRevoked([], "CIMD")) === "grant_none_for_client");
  const cimd = { client_id: "CIMD", client_type: "public", token_endpoint_auth_method: "none", status: "active", grant_types: ["authorization_code", "refresh_token"], redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], expires_at: null };
  check("56. ⭐⭐⭐ rândul CIMD provizionat → ok; fără redirect-ul probei → cimd_redirect_missing",
    code(C.checkCimdRegistrationRow(cimd, "CIMD", "https://claude.ai/api/mcp/auth_callback", T0)) === "ok"
    && code(C.checkCimdRegistrationRow({ ...cimd, redirect_uris: ["https://claude.com/api/mcp/auth_callback"] }, "CIMD", "https://claude.ai/api/mcp/auth_callback", T0)) === "cimd_redirect_missing"
    && code(C.checkCimdRegistrationRow({ ...cimd, client_type: "confidential" }, "CIMD", "https://claude.ai/api/mcp/auth_callback", T0)) === "cimd_not_public");
  const legacy = { client_id: "tp_1", user_id: "U", name: "n", plan: "free_trial", scopes: ["read:basic"], status: "active", created_at: "c", admin_authorized_at: "2026-11-03T10:00:00Z", admin_authorized_by: "x", secret_rotated_at: "r" };
  const v1 = C.parseLegacyClientView(legacy)!;
  const v2 = C.parseLegacyClientView({ ...legacy, admin_authorized_at: null, admin_authorized_by: null })!;
  check("57. ⭐⭐⭐ rând E0a: doar autorizarea retrasă → ok", code(C.checkLegacyRowStable(v1, v2)) === "ok");
  check("58. ⭐⭐⭐ rând E0a: status schimbat → legacy_row_status_changed", code(C.checkLegacyRowStable(v1, C.parseLegacyClientView({ ...legacy, status: "revoked", admin_authorized_at: null, admin_authorized_by: null })!)) === "legacy_row_status_changed");
  check("59. ⭐⭐ rând E0a: încă autorizat → legacy_row_still_authorized", code(C.checkLegacyRowStable(v1, v1)) === "legacy_row_still_authorized");
  check("60. ⭐ parseLegacyClientView: fără secret_rotated_at → null", C.parseLegacyClientView({ ...legacy, secret_rotated_at: undefined }) === null);
}

// ── E0e: fixture-ul legacy are exact forma clientului, iar planner-ul de produs îl acceptă ca `legacy` ──
{
  const p = C.buildLegacyFixtureAuthCode({ clientId: "tp_x", scopes: ["read:all"], resource: `${O}/api/mcp`, codeChallenge: "a".repeat(43), nowMs: 1 });
  check("61. ⭐⭐⭐ identitatea codului fixture = legacy_client (fără claim-uri user)", readAuthCodeIdentity(p).kind === "legacy_client");
  const plan = planAuthCodeTokenIssuance({ payload: p, clientId: "tp_x", credentialVersion: "2026-11-03T10:00:00Z", audience: `${O}/api/mcp`, issuedAt: 2, rejectLegacy: false });
  check("62. ⭐⭐⭐ planner-ul de produs → plan legacy (forma emisă de ramura legacy)", plan.kind === "legacy" && plan.access.client_id === "tp_x" && plan.access.audience === `${O}/api/mcp`);
}

// ── E14 ──
{
  const denied = { status: 401, body: '{"code":"42501","message":"permission denied for table beta_invites"}' };
  check("63. ⭐⭐⭐ 401/403 + 42501 → denied", C.classifyPostgrestNegative(denied) === "denied" && C.classifyPostgrestNegative({ status: 403, body: '{"code":"42501"}' }) === "denied");
  check("64. ⭐⭐ 200 [] → zero_rows; 200 [row] → rows; 200 \"redeemed\" → rows",
    C.classifyPostgrestNegative({ status: 200, body: "[]" }) === "zero_rows"
    && C.classifyPostgrestNegative({ status: 200, body: '[{"a":1}]' }) === "rows"
    && C.classifyPostgrestNegative({ status: 200, body: '"redeemed"' }) === "rows");
  check("65. ⭐⭐⭐ 404 PGRST202 / 400 / transport → unexpected (nu afirmăm refuzul)",
    C.classifyPostgrestNegative({ status: 404, body: '{"code":"PGRST202"}' }) === "unexpected"
    && C.classifyPostgrestNegative({ status: 400, body: "{}" }) === "unexpected" && C.classifyPostgrestNegative(null) === "unexpected");
  check("66. ⭐⭐⭐ control RPC: 200 \"redeemed\" → ok; \"already_redeemed\" → control_failed",
    code(C.checkRpcControl({ status: 200, body: '"redeemed"' })) === "ok" && code(C.checkRpcControl({ status: 200, body: '"already_redeemed"' })) === "control_failed");
  check("67. ⭐⭐⭐ control rând: exact rândul țintit → ok; 0 rânduri / alt id → control_failed",
    code(C.checkSingleRowControl({ status: 200, body: '[{"invite_id":"I"}]' }, "invite_id", "I")) === "ok"
    && code(C.checkSingleRowControl({ status: 200, body: "[]" }, "invite_id", "I")) === "control_failed"
    && code(C.checkSingleRowControl({ status: 200, body: '[{"invite_id":"J"}]' }, "invite_id", "I")) === "control_failed");
  const ctlOk = { ok: true } as const;
  const ctlBad = { ok: false, code: "control_failed" } as const;
  check("68. ⭐⭐⭐ caz: control picat → control_failed chiar dacă negativele par refuzate",
    code(C.decideRightsCase({ control: ctlBad, anon: "zero_rows", user: "zero_rows", allowZeroRows: true, unchanged: true })) === "control_failed");
  check("69. ⭐⭐⭐ caz RPC: zero_rows NU e acceptat (doar denied)",
    code(C.decideRightsCase({ control: ctlOk, anon: "zero_rows", user: "denied", allowZeroRows: false, unchanged: true })) === "anon_not_denied");
  check("70. ⭐⭐⭐ caz update: anon denied + user zero_rows + neschimbat → ok",
    code(C.decideRightsCase({ control: ctlOk, anon: "denied", user: "zero_rows", allowZeroRows: true, unchanged: true })) === "ok");
  check("71. ⭐⭐⭐ caz: user are drept → user_not_denied", code(C.decideRightsCase({ control: ctlOk, anon: "denied", user: "rows", allowZeroRows: true, unchanged: true })) === "user_not_denied");
  check("72. ⭐⭐⭐ caz: refuzat dar rândul s-a schimbat → state_changed", code(C.decideRightsCase({ control: ctlOk, anon: "denied", user: "denied", allowZeroRows: true, unchanged: false })) === "state_changed");
  check("73. ⭐ sameJson: ordine de chei irelevantă; undefined ≠", C.sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }) && !C.sameJson(undefined, undefined) && !C.sameJson({ a: 1 }, { a: 2 }));
}

// ── login PKCE: rândul capturat de Send Email Hook ──
{
  const EMAIL = "gate1-x-a@d.test";
  const CBK = `${O}/auth/callback`;
  const UID = "00000000-0000-4000-8000-000000000001";
  const m = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ id: 7, user_id: UID, email: EMAIL, email_action_type: "signup", token_hash: "pkce_abc", redirect_to: CBK, ...over });
  const exp = { email: EMAIL, afterId: 0, callbackUrl: CBK };
  const good = C.checkCapturedMail([m()], exp);
  check("74. ⭐⭐⭐ un rând proaspăt, pkce_, signup, redirect = callback → ok", good.ok && good.mail.id === 7 && good.mail.user_id === UID);
  check("75. ⭐⭐⭐ niciun rând / doar rânduri vechi (id ≤ afterId) → mail_capture_absent",
    code(C.checkCapturedMail([], exp)) === "mail_capture_absent" && code(C.checkCapturedMail([m()], { ...exp, afterId: 7 })) === "mail_capture_absent");
  check("76. ⭐⭐⭐ două rânduri proaspete → mail_capture_multiple", code(C.checkCapturedMail([m(), m({ id: 8 })], exp)) === "mail_capture_multiple");
  check("77. ⭐⭐⭐ token fără prefix pkce_ (flux implicit) → mail_token_not_pkce",
    code(C.checkCapturedMail([m({ token_hash: "abc" })], exp)) === "mail_token_not_pkce" && code(C.checkCapturedMail([m({ token_hash: "pkce_" })], exp)) === "mail_token_not_pkce");
  check("78. ⭐⭐ email_action_type recovery → mail_action_unexpected; magiclink ok",
    code(C.checkCapturedMail([m({ email_action_type: "recovery" })], exp)) === "mail_action_unexpected" && C.checkCapturedMail([m({ email_action_type: "magiclink" })], exp).ok);
  check("79. ⭐⭐⭐ redirect_to = Site URL → mail_redirect_unexpected", code(C.checkCapturedMail([m({ redirect_to: `${O}/` })], exp)) === "mail_redirect_unexpected");
  check("80. ⭐⭐ rând malformat (user_id non-uuid / id lipsă) → mail_capture_shape",
    code(C.checkCapturedMail([m({ user_id: "u1" })], exp)) === "mail_capture_shape" && code(C.checkCapturedMail([m({ id: null })], exp)) === "mail_capture_shape");
  check("81. ⭐⭐ rândul altui email e ignorat (nu e „proaspăt”)", code(C.checkCapturedMail([m({ email: "other@d.test" })], exp)) === "mail_capture_absent");
  check("82. ⭐ maxCaptureId: 0 pe gol, max pe rânduri, null pe corupt",
    C.maxCaptureId([]) === 0 && C.maxCaptureId([m({ id: 3 }), m({ id: 9 })]) === 9 && C.maxCaptureId([{ id: "x" }]) === null);
  if (good.ok) {
    const v = new URL(C.buildVerifyUrl("https://ref.supabase.co", good.mail));
    check("83. ⭐⭐⭐ linkul /auth/v1/verify: token + type + redirect_to exact, pe Supabase-ul vetat",
      v.origin === "https://ref.supabase.co" && v.pathname === "/auth/v1/verify" && v.searchParams.get("token") === "pkce_abc"
      && v.searchParams.get("type") === "signup" && v.searchParams.get("redirect_to") === CBK);
  }
  check("84. ⭐⭐ cookie-uri: verifier PKCE; sesiune simplă sau fragmentată; verifier ≠ sesiune",
    C.hasPkceVerifierCookie(["sb-r-auth-token-code-verifier"], "r") && C.hasSessionCookie(["sb-r-auth-token"], "r")
    && C.hasSessionCookie(["sb-r-auth-token.0", "sb-r-auth-token.1"], "r") && !C.hasSessionCookie(["sb-r-auth-token-code-verifier"], "r")
    && !C.hasSessionCookie(["sb-other-auth-token"], "r"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
