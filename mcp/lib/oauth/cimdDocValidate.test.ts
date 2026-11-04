/**
 * lib/oauth/cimdDocValidate.test.ts — lotul OAuth staging (design rev3 §2, §3, §9 S0): validatorul documentului CIMD.
 *
 * Acoperă: documentul valid → rândul exact (public/none/{authorization_code, refresh_token}, redirect_uris = ∩
 * CLAUDE_CALLBACKS în ordinea canonică, client_name); refuzurile pe URL-ul client_id (schemă, host, userinfo, fragment,
 * port, cale, formă necanonică), pe document (non-obiect, secret, client_id diferit, auth method, grant_types — inclusiv
 * implicitul RFC 7591 —, redirect_uris); motive statice care nu ecouă conținutul documentului; helper-ul de log S0;
 * plus un guard de sursă pe metadata AS (ambele copii anunță CIMD, fără registration_endpoint); predicatul
 * `isClaudeCimdClientId` (revocarea din dashboard, §6) = aceeași regulă de URL. cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";
import {
  validateCimdDocument, claudeCimdClientIdLogFields, toCimdProvisionRow, diffCimdProvisionRow, type CimdValidation,
  isClaudeCimdClientId,
} from "./cimdDocValidate";
import { CLAUDE_CALLBACKS } from "./claudeCallbacks";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const CID = "https://claude.ai/oauth/claude-mcp-client-metadata";
const AI  = "https://claude.ai/api/mcp/auth_callback";
const COM = "https://claude.com/api/mcp/auth_callback";

function mkDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CID,
    client_name: "Claude",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    redirect_uris: [AI, COM],
    ...over,
  };
}
function without(key: string): Record<string, unknown> {
  const d = mkDoc();
  delete d[key];
  return d;
}
const refused = (r: CimdValidation, reason: string): boolean => !r.ok && r.reason === reason;

function main(): void {
console.log("OAuth staging — validateCimdDocument (provizionare CIMD fixată, pur)");

// ── SUCCES ────────────────────────────────────────────────────────────────────────
{
  const r = validateCimdDocument(mkDoc(), CID);
  check("1. ⭐⭐⭐ document valid → ok", r.ok);
  if (r.ok) {
    const g = r.registration;
    check("2. ⭐⭐⭐ rândul: client_id = URL, public, none, {authorization_code, refresh_token}",
      g.client_id === CID && g.client_type === "public" && g.token_endpoint_auth_method === "none"
      && JSON.stringify(g.grant_types) === JSON.stringify(["authorization_code", "refresh_token"]));
    check("3. ⭐⭐⭐ redirect_uris = ambele callback-uri, în ordinea CLAUDE_CALLBACKS",
      JSON.stringify(g.redirect_uris) === JSON.stringify([...CLAUDE_CALLBACKS]));
    check("4. ⭐ client_name păstrat", g.client_name === "Claude");
  }
}
{
  const r = validateCimdDocument(mkDoc({ redirect_uris: ["http://localhost:3000/cb", COM, "https://evil.example/cb", AI + "/"] }), CID);
  check("5. ⭐⭐⭐ redirect_uris = DOAR intersecția (fără loopback/străin/variante), ordine canonică",
    r.ok && JSON.stringify(r.registration.redirect_uris) === JSON.stringify([COM]));
}
{
  const r = validateCimdDocument(mkDoc({ redirect_uris: [COM, AI, AI] }), CID);
  check("6. ⭐⭐ ordinea din document și duplicatele nu contează → [ai, com]",
    r.ok && JSON.stringify(r.registration.redirect_uris) === JSON.stringify([AI, COM]));
}
{
  const r = validateCimdDocument(mkDoc({ grant_types: ["refresh_token", "authorization_code", "client_credentials"] }), CID);
  check("7. ⭐⭐ grant_types în plus în document → rândul are EXACT {authorization_code, refresh_token}",
    r.ok && JSON.stringify(r.registration.grant_types) === JSON.stringify(["authorization_code", "refresh_token"]));
}
check("8. ⭐⭐ client_id pe claude.com → ok", validateCimdDocument(mkDoc({ client_id: "https://claude.com/x/meta.json" }), "https://claude.com/x/meta.json").ok);

// ── client_name ───────────────────────────────────────────────────────────────────
{
  const n = (v: unknown): string | null | "ERR" => {
    const r = validateCimdDocument(v === undefined ? without("client_name") : mkDoc({ client_name: v }), CID);
    return r.ok ? r.registration.client_name : "ERR";
  };
  check("9. ⭐ client_name absent → null", n(undefined) === null);
  check("10. ⭐ client_name non-string / gol → null", n(42) === null && n(null) === null && n("") === null && n(["Claude"]) === null);
  check("11. ⭐ client_name 200 caractere → păstrat; 201 → null", n("a".repeat(200)) === "a".repeat(200) && n("a".repeat(201)) === null);
  check("12. ⭐ client_name cu caractere de control → null", n("Cla\nude") === null && n("x\u0000") === null);
}

// ── URL-ul client_id ──────────────────────────────────────────────────────────────
const U = (url: string) => validateCimdDocument(mkDoc({ client_id: url }), url);
check("13. ⭐⭐ client_id gol / neparsabil → client_id_url_invalid",
  refused(U(""), "client_id_url_invalid") && refused(U("not a url"), "client_id_url_invalid"));
check("14. ⭐⭐⭐ http: → client_id_url_not_https", refused(U("http://claude.ai/oauth/meta"), "client_id_url_not_https"));
check("15. ⭐⭐⭐ host străin → client_id_url_host_not_claude", refused(U("https://evil.example/oauth/meta"), "client_id_url_host_not_claude"));
check("16. ⭐⭐⭐ subdomeniu / sufix → client_id_url_host_not_claude",
  refused(U("https://www.claude.ai/oauth/meta"), "client_id_url_host_not_claude")
  && refused(U("https://claude.ai.evil.com/oauth/meta"), "client_id_url_host_not_claude")
  && refused(U("https://anthropic.com/oauth/meta"), "client_id_url_host_not_claude"));
check("17. ⭐⭐⭐ userinfo → client_id_url_has_userinfo",
  refused(U("https://user@claude.ai/oauth/meta"), "client_id_url_has_userinfo")
  && refused(U("https://user:pw@claude.ai/oauth/meta"), "client_id_url_has_userinfo"));
check("18. ⭐⭐⭐ fragment (inclusiv „#” gol) → client_id_url_has_fragment",
  refused(U("https://claude.ai/oauth/meta#x"), "client_id_url_has_fragment")
  && refused(U("https://claude.ai/oauth/meta#"), "client_id_url_has_fragment"));
check("19. ⭐⭐ port explicit → client_id_url_has_port", refused(U("https://claude.ai:8443/oauth/meta"), "client_id_url_has_port"));
check("20. ⭐⭐ fără cale → client_id_url_no_path",
  refused(U("https://claude.ai/"), "client_id_url_no_path") && refused(U("https://claude.ai"), "client_id_url_no_path"));
check("21. ⭐⭐ formă necanonică (host uppercase, :443, segmente ..) → client_id_url_not_canonical",
  refused(U("https://Claude.ai/oauth/meta"), "client_id_url_not_canonical")
  && refused(U("https://claude.ai:443/oauth/meta"), "client_id_url_not_canonical")
  && refused(U("https://claude.ai/a/../oauth/meta"), "client_id_url_not_canonical"));
check("22. ⭐⭐ URL-ul e verificat ÎNAINTE de document (document invalid + URL invalid → motivul URL-ului)",
  refused(validateCimdDocument(null, "http://claude.ai/x"), "client_id_url_not_https"));

// ── documentul ────────────────────────────────────────────────────────────────────
check("23. ⭐⭐⭐ document non-obiect (null/array/string/număr) → document_not_object",
  refused(validateCimdDocument(null, CID), "document_not_object") && refused(validateCimdDocument([mkDoc()], CID), "document_not_object")
  && refused(validateCimdDocument(JSON.stringify(mkDoc()), CID), "document_not_object") && refused(validateCimdDocument(7, CID), "document_not_object"));
check("24. ⭐ instanță de clasă (nu obiect simplu) → document_not_object",
  refused(validateCimdDocument(new (class { client_id = CID; })(), CID), "document_not_object"));
check("25. ⭐⭐ document cu client_secret → document_contains_secret",
  refused(validateCimdDocument(mkDoc({ client_secret: "s" }), CID), "document_contains_secret")
  && refused(validateCimdDocument(mkDoc({ client_secret_expires_at: 0 }), CID), "document_contains_secret"));
check("26. ⭐⭐⭐ client_id din document ≠ URL → client_id_mismatch",
  refused(validateCimdDocument(mkDoc({ client_id: "https://claude.ai/oauth/other" }), CID), "client_id_mismatch"));
check("27. ⭐⭐⭐ client_id diferit doar prin slash final / lipsă → client_id_mismatch (șir exact)",
  refused(validateCimdDocument(mkDoc({ client_id: CID + "/" }), CID), "client_id_mismatch")
  && refused(validateCimdDocument(without("client_id"), CID), "client_id_mismatch"));
check("28. ⭐⭐⭐ token_endpoint_auth_method ≠ none (sau absent = implicit client_secret_basic) → refuz",
  refused(validateCimdDocument(mkDoc({ token_endpoint_auth_method: "client_secret_post" }), CID), "token_endpoint_auth_method_not_none")
  && refused(validateCimdDocument(without("token_endpoint_auth_method"), CID), "token_endpoint_auth_method_not_none")
  && refused(validateCimdDocument(mkDoc({ token_endpoint_auth_method: "None" }), CID), "token_endpoint_auth_method_not_none"));
check("29. ⭐⭐⭐ grant_types absent → implicit [authorization_code] (RFC 7591) → grant_types_missing_refresh_token",
  refused(validateCimdDocument(without("grant_types"), CID), "grant_types_missing_refresh_token"));
check("30. ⭐⭐ grant_types non-array / cu non-string / null → grant_types_invalid",
  refused(validateCimdDocument(mkDoc({ grant_types: "authorization_code refresh_token" }), CID), "grant_types_invalid")
  && refused(validateCimdDocument(mkDoc({ grant_types: ["authorization_code", 1] }), CID), "grant_types_invalid")
  && refused(validateCimdDocument(mkDoc({ grant_types: null }), CID), "grant_types_invalid"));
check("31. ⭐⭐⭐ grant_types fără authorization_code → grant_types_missing_authorization_code",
  refused(validateCimdDocument(mkDoc({ grant_types: ["refresh_token"] }), CID), "grant_types_missing_authorization_code"));
check("32. ⭐⭐⭐ grant_types fără refresh_token → grant_types_missing_refresh_token",
  refused(validateCimdDocument(mkDoc({ grant_types: ["authorization_code"] }), CID), "grant_types_missing_refresh_token"));
check("33. ⭐⭐ redirect_uris absent / non-array / cu non-string → redirect_uris_invalid",
  refused(validateCimdDocument(without("redirect_uris"), CID), "redirect_uris_invalid")
  && refused(validateCimdDocument(mkDoc({ redirect_uris: AI }), CID), "redirect_uris_invalid")
  && refused(validateCimdDocument(mkDoc({ redirect_uris: [AI, 5] }), CID), "redirect_uris_invalid"));
check("34. ⭐⭐⭐ redirect_uris fără niciun callback Claude exact → redirect_uris_no_claude_callback",
  refused(validateCimdDocument(mkDoc({ redirect_uris: [] }), CID), "redirect_uris_no_claude_callback")
  && refused(validateCimdDocument(mkDoc({ redirect_uris: ["http://localhost/callback", AI + "/x", " " + AI, "https://Claude.ai/api/mcp/auth_callback"] }), CID), "redirect_uris_no_claude_callback"));

// ── motive statice (fără ecou din document) ───────────────────────────────────────
{
  const MARK = "MARKER-xyz-123";
  const rs = [
    validateCimdDocument(mkDoc({ client_id: MARK }), CID),
    validateCimdDocument(mkDoc({ token_endpoint_auth_method: MARK }), CID),
    validateCimdDocument(mkDoc({ grant_types: [MARK] }), CID),
    validateCimdDocument(mkDoc({ redirect_uris: [MARK] }), CID),
    validateCimdDocument(mkDoc(), "https://claude.ai/" + MARK + "#f"),
  ];
  check("35. ⭐⭐ niciun motiv de refuz nu conține conținut din document / URL",
    rs.every((r) => !r.ok && !JSON.stringify(r).includes(MARK)));
}

// ── helper-ul de log S0 ──────────────────────────────────────────────────────────
{
  const f = claudeCimdClientIdLogFields("https://claude.ai/oauth/meta?secret=1#frag");
  check("36. ⭐⭐⭐ log S0: claude.ai https → origin + path, FĂRĂ query/fragment",
    f !== null && f.origin === "https://claude.ai" && f.path === "/oauth/meta" && !JSON.stringify(f).includes("secret"));
  const g = claudeCimdClientIdLogFields("https://user:pw@claude.com/x");
  check("37. ⭐⭐ log S0: claude.com → ok, userinfo NU apare", g !== null && g.origin === "https://claude.com" && !JSON.stringify(g).includes("pw"));
  check("38. ⭐⭐⭐ log S0: http / host străin / sufix / opac / non-string → null",
    claudeCimdClientIdLogFields("http://claude.ai/x") === null
    && claudeCimdClientIdLogFields("https://evil.example/x") === null
    && claudeCimdClientIdLogFields("https://claude.ai.evil.com/x") === null
    && claudeCimdClientIdLogFields("c1") === null
    && claudeCimdClientIdLogFields("") === null
    && claudeCimdClientIdLogFields(undefined) === null);
  const h = claudeCimdClientIdLogFields("https://claude.ai/" + "a".repeat(500));
  check("39. ⭐ log S0: calea plafonată la 200 de caractere", h !== null && h.path.length === 200);
  const nl = claudeCimdClientIdLogFields("https://claude.ai/a\nb c");
  check("40. ⭐ log S0: calea fără newline/spații brute (percent-encodată de URL)", nl === null || (!nl.path.includes("\n") && !nl.path.includes(" ")));
}

// ── rândul de provizionare + diff idempotent ──────────────────────────────────────
{
  const r = validateCimdDocument(mkDoc(), CID);
  if (!r.ok) { check("44. fixture valid", false); } else {
    const row = toCimdProvisionRow(r.registration);
    check("44. ⭐⭐⭐ rândul de provizionare: status active, expires_at null",
      row.status === "active" && row.expires_at === null && row.client_id === CID && row.client_type === "public");
    const dbSame = { ...row, grant_types: ["refresh_token", "authorization_code"], redirect_uris: [COM, AI], registration_id: "x", created_at: "t" };
    check("45. ⭐⭐⭐ diff: rând existent identic (ordine diferită în array-uri, coloane în plus) → [] (idempotent)",
      diffCimdProvisionRow(dbSame, row).length === 0);
    const d1 = diffCimdProvisionRow({ ...row, redirect_uris: [AI] }, row);
    check("46. ⭐⭐ diff: redirect_uris diferite → exact câmpul redirect_uris", d1.length === 1 && d1[0].field === "redirect_uris");
    const d2 = diffCimdProvisionRow({ ...row, status: "revoked", expires_at: "2030-01-01T00:00:00Z", client_name: "Other" }, row);
    check("47. ⭐⭐ diff: status / expires_at / client_name diferite → toate trei raportate",
      d2.length === 3 && ["status", "expires_at", "client_name"].every((f) => d2.some((x) => x.field === f)));
    check("48. ⭐⭐ diff: rând non-obiect / gol → toate câmpurile diferă (fail-closed)",
      diffCimdProvisionRow(null, row).length === 8 && diffCimdProvisionRow({}, row).length === 8);
    check("49. ⭐ diff: grant_types cu duplicat lipsă de refresh → diferă",
      diffCimdProvisionRow({ ...row, grant_types: ["authorization_code", "authorization_code"] }, row).some((x) => x.field === "grant_types"));
  }
}

// ── guard de sursă: metadata AS (ambele copii) anunță CIMD, fără registration_endpoint ──
{
  const oam    = readFileSync("app/.well-known/oauth-authorization-server/route.ts", "utf8");
  const oamApi = readFileSync("app/api/.well-known/oauth-authorization-server/route.ts", "utf8");
  check("41. ⭐⭐⭐ AS metadata (ambele) anunță client_id_metadata_document_supported: true",
    /client_id_metadata_document_supported:\s*true/.test(oam) && /client_id_metadata_document_supported:\s*true/.test(oamApi));
  check("42. ⭐⭐⭐ AS metadata (ambele) anunță `none` la token_endpoint_auth_methods_supported",
    /token_endpoint_auth_methods_supported:[^\n]*"none"/.test(oam) && /token_endpoint_auth_methods_supported:[^\n]*"none"/.test(oamApi));
  check("43. ⭐⭐⭐ AS metadata (ambele) NU au registration_endpoint (fără DCR)",
    !/registration_endpoint/.test(oam) && !/registration_endpoint/.test(oamApi));
}

// ── isClaudeCimdClientId (revocarea din dashboard, §6): aceeași regulă ca URL-ul din validateCimdDocument ──
check("50. ⭐⭐⭐ client_id CIMD claude.ai / claude.com → true",
  isClaudeCimdClientId(CID) && isClaudeCimdClientId("https://claude.com/oauth/claude-mcp-client-metadata"));
check("51. ⭐⭐⭐ legacy tp_… / alt public https / sufix de host / http → false",
  !isClaudeCimdClientId("tp_0123abcd") && !isClaudeCimdClientId("https://other.example/meta")
  && !isClaudeCimdClientId("https://claude.ai.evil.com/x") && !isClaudeCimdClientId("https://evilclaude.ai/x")
  && !isClaudeCimdClientId("http://claude.ai/x"));
check("52. ⭐⭐⭐ userinfo / port (inclusiv :443 explicit) / fragment / fără cale → false",
  !isClaudeCimdClientId("https://u:p@claude.ai/x") && !isClaudeCimdClientId("https://claude.ai:8443/x")
  && !isClaudeCimdClientId("https://claude.ai:443/x") && !isClaudeCimdClientId("https://claude.ai/x#f")
  && !isClaudeCimdClientId("https://claude.ai/") && !isClaudeCimdClientId("https://claude.ai"));
check("53. ⭐⭐ host uppercase / necanonic / non-string → false",
  !isClaudeCimdClientId("https://Claude.ai/x") && !isClaudeCimdClientId("https://claude.ai/a/../x")
  && !isClaudeCimdClientId(undefined) && !isClaudeCimdClientId(null) && !isClaudeCimdClientId(42) && !isClaudeCimdClientId(""));
check("54. ⭐⭐⭐ predicatul == acceptarea URL-ului de validateCimdDocument (o singură regulă)",
  [CID, "https://claude.com/x", "https://claude.ai:443/x", "https://u@claude.ai/x", "tp_1", "https://claude.ai/"]
    .every((u) => isClaudeCimdClientId(u) === U(u).ok)); // document valid → singurul refuz posibil e pe URL

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
