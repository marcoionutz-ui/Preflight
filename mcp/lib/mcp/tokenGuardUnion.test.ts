/**
 * lib/mcp/tokenGuardUnion.test.ts — PH-2 step 10.5a frunza 3 (tokenGuard union-parse + accesori siguri pe union).
 *
 * `parseStoredToken` deleagă acum la modelul discriminat (`parseStoredTokenPayload`): un access token USER
 * (subject_kind="user", FĂRĂ credential_version) trece ca `valid` în loc să fie respins la parse; formele client/legacy
 * rămân valide identic; cross-claim-urile (blob hibrid) + user fără family_id rămân respinse (fail-closed în model).
 * Accesorii `tokenCredentialVersion`/`tokenFamilyId` dau acces sigur pe union la câmpurile care nu-s pe toți membrii,
 * ca `resolveAuth` să compileze pe union PĂSTRÂND comportamentul client/legacy. Guard de sursă pe cablaj (authPolicy
 * folosește accesorii, nu accesul brut; oauth-tokens lărgește payload-ul validat). cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";
import { parseStoredToken } from "./tokenGuard";
import {
  parseStoredTokenPayload,
  tokenCredentialVersion,
  tokenFamilyId,
  type StoredTokenPayload,
} from "../oauth/tokenPayloadModel";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

// ── forme canonice ────────────────────────────────────────────────────────────────
const userObj = {
  subject_kind: "user", user_id: "u1", grant_id: "g1", entitlement_version: 2, client_id: "c1",
  scopes: ["read:pair"], issued_at: 1, audience: "https://x/api/mcp", family_id: "f1",
};
const clientObj = {
  subject_kind: "client", client_id: "c1", scopes: ["read:all"], issued_at: 1,
  credential_version: "cv", audience: "https://x/api/mcp",
};
const legacyObj = {
  client_id: "c1", scopes: ["read:all"], issued_at: 1, credential_version: "cv",
  audience: "https://x/api/mcp", family_id: "f1",
};
const legacyNoFamily = { client_id: "c1", scopes: ["read:all"], issued_at: 1, credential_version: "cv" };

function nn(v: StoredTokenPayload | null): StoredTokenPayload { if (!v) throw new Error("null payload în test"); return v; }

function main(): void {
console.log("PH-2 step 10.5a — tokenGuard union-parse + accesori (pur + guard de sursă)");

// ── parseStoredToken: delegare la modelul discriminat ─────────────────────────────
check("1. ⭐⭐⭐ USER stocat (fără credential_version) → valid + subject_kind='user' (nu mai e respins la parse)",
  (() => { const r = parseStoredToken(JSON.stringify(userObj)); return r.status === "valid" && r.payload.subject_kind === "user"; })());
check("2. ⭐⭐ CLIENT nou → valid + subject_kind='client'",
  (() => { const r = parseStoredToken(JSON.stringify(clientObj)); return r.status === "valid" && r.payload.subject_kind === "client"; })());
check("3. ⭐⭐ LEGACY (fără subject_kind) → valid + subject_kind absent",
  (() => { const r = parseStoredToken(JSON.stringify(legacyObj)); return r.status === "valid" && r.payload.subject_kind === undefined; })());
check("4. ⭐⭐ '{}' → invalid (fără client_id, legacy guard cade)", parseStoredToken("{}").status === "invalid");
check("5. ⭐⭐ 'null' → invalid", parseStoredToken("null").status === "invalid");
check("6. ⭐⭐ JSON stricat → invalid", parseStoredToken("not json").status === "invalid");
check("7. ⭐⭐⭐ HIBRID (client-shaped + user_id injectat) → invalid (cross-claim respins de model)",
  parseStoredToken(JSON.stringify({ ...legacyObj, user_id: "u1" })).status === "invalid");
check("8. ⭐⭐⭐ USER fără family_id (draft, nu stocat) → invalid (nerevocabil, nu-l acceptăm)",
  (() => {
    const draft = { subject_kind: "user", user_id: "u1", grant_id: "g1", entitlement_version: 2, client_id: "c1", scopes: ["read:pair"], issued_at: 1, audience: "https://x/api/mcp" };
    return parseStoredToken(JSON.stringify(draft)).status === "invalid";
  })());
check("9. ⭐⭐ USER cu credential_version injectat (claim interzis) → invalid",
  parseStoredToken(JSON.stringify({ ...userObj, credential_version: "cv" })).status === "invalid");

// ── accesori siguri pe union ──────────────────────────────────────────────────────
const userP = nn(parseStoredTokenPayload(userObj));
const clientP = nn(parseStoredTokenPayload(clientObj));
const legacyP = nn(parseStoredTokenPayload(legacyObj));
const legacyNF = nn(parseStoredTokenPayload(legacyNoFamily));

check("10. ⭐⭐⭐ tokenCredentialVersion(USER) → undefined (nu poartă credential_version)", tokenCredentialVersion(userP) === undefined);
check("11. ⭐⭐ tokenCredentialVersion(CLIENT) → 'cv'", tokenCredentialVersion(clientP) === "cv");
check("12. ⭐⭐ tokenCredentialVersion(LEGACY) → 'cv'", tokenCredentialVersion(legacyP) === "cv");
check("13. ⭐⭐⭐ tokenFamilyId(CLIENT) → undefined (M2M nu are familie)", tokenFamilyId(clientP) === undefined);
check("14. ⭐⭐ tokenFamilyId(USER) → 'f1' (revocabil prin familie)", tokenFamilyId(userP) === "f1");
check("15. ⭐⭐ tokenFamilyId(LEGACY cu family) → 'f1'", tokenFamilyId(legacyP) === "f1");
check("16. ⭐ tokenFamilyId(LEGACY fără family) → undefined (grandfather)", tokenFamilyId(legacyNF) === undefined);

// ── guard de sursă: cablajul folosește accesorii, nu accesul brut ────────────────
const authPolicy = readFileSync("lib/mcp/authPolicy.ts", "utf8");
const tokens     = readFileSync("lib/db/oauth-tokens.ts", "utf8");
const guard      = readFileSync("lib/mcp/tokenGuard.ts", "utf8");

check("17. ⭐⭐⭐ authPolicy folosește tokenFamilyId(v.payload) (nu v.payload.family_id brut)",
  /tokenFamilyId\(v\.payload\)/.test(authPolicy) && !/v\.payload\.family_id/.test(authPolicy));
check("18. ⭐⭐⭐ authPolicy folosește tokenCredentialVersion(v.payload) (nu v.payload.credential_version brut)",
  /tokenCredentialVersion\(v\.payload\)/.test(authPolicy) && !/v\.payload\.credential_version/.test(authPolicy));
check("19. ⭐⭐ authPolicy importă accesorii din tokenPayloadModel",
  /import\s*\{[^}]*tokenCredentialVersion[^}]*tokenFamilyId[^}]*\}\s*from\s*"\.\.\/oauth\/tokenPayloadModel"/.test(authPolicy));
check("20. ⭐⭐⭐ oauth-tokens: TokenValidation payload lărgit la StoredTokenPayload",
  /payload:\s*StoredTokenPayload/.test(tokens) && /import type \{ StoredTokenPayload \} from "\.\.\/oauth\/tokenPayloadModel"/.test(tokens));
check("21. ⭐⭐⭐ tokenGuard: parseStoredToken deleagă la parseStoredTokenPayload (o singură sursă de discriminare)",
  /const payload = parseStoredTokenPayload\(parsed\)/.test(guard) && /payload:\s*StoredTokenPayload/.test(guard));
check("22. ⭐ authPolicy păstrează gate-ul de rotație (comportament client/legacy neschimbat)",
  /!credentialVersion \|\| credentialVersion !== client\.secret_rotated_at/.test(authPolicy));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
