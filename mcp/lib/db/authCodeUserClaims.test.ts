/**
 * lib/db/authCodeUserClaims.test.ts — PH-2 step 10.3b-iii GUARD (AuthCodePayload + claim-uri user, pur).
 *
 * KEY (cgpt): `isAuthCodePayload` (via `peekAuthCode`) e SINGURUL gate înainte de consum; `/token` nu re-verifică
 * identitatea până la 10.4. Deci all-or-nothing + semantica se impun CHIAR AICI: toate trei absente = legacy valid;
 * toate trei prezente + valide = user valid; orice parțial/invalid → `false` / `parseAuthCode(...) === null`.
 */
import { isAuthCodePayload, parseAuthCode } from "./oauthAtomic";
import { readAuthCodeIdentity } from "../oauth/authGrantIssuance";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const base = { client_id: "c1", scopes: ["read:all"], redirect_uri: "https://claude.ai/cb", code_challenge: "cc", code_challenge_method: "S256", issued_at: 1, resource: "https://x/api/mcp" };
const withUser = { ...base, user_id: "u1", grant_id: "g1", entitlement_version: 2 };

function main(): void {
console.log("PH-2 step 10.3b-iii — AuthCodePayload + claim-uri user (boundary all-or-nothing, pur)");

// ── absent all → legacy valid; complet valid → user valid ───────────────────────
check("1. ⭐⭐⭐ base FĂRĂ claim-uri user → valid (legacy/client)", isAuthCodePayload(base));
check("2. ⭐⭐⭐ base + toate cele 3 claim-uri valide → valid (user)", isAuthCodePayload(withUser));

// ── PARȚIAL → false (boundary, NU trece drept legacy) ───────────────────────────
check("3. ⭐⭐⭐ DOAR user_id (fără grant_id/version) → false", !isAuthCodePayload({ ...base, user_id: "u1" }));
check("4. ⭐⭐⭐ user_id + grant_id, fără entitlement_version → false", !isAuthCodePayload({ ...base, user_id: "u1", grant_id: "g1" }));
check("5. ⭐⭐⭐ DOAR entitlement_version → false", !isAuthCodePayload({ ...base, entitlement_version: 2 }));

// ── semantic invalid → false ────────────────────────────────────────────────────
check("6. ⭐⭐⭐ user_id gol → false", !isAuthCodePayload({ ...withUser, user_id: "" }));
check("7. ⭐⭐ grant_id gol → false", !isAuthCodePayload({ ...withUser, grant_id: "" }));
check("8. ⭐⭐⭐ entitlement_version 0 → false", !isAuthCodePayload({ ...withUser, entitlement_version: 0 }));
check("9. ⭐⭐⭐ entitlement_version negativ → false", !isAuthCodePayload({ ...withUser, entitlement_version: -1 }));
check("10. ⭐⭐⭐ entitlement_version fracționar → false", !isAuthCodePayload({ ...withUser, entitlement_version: 1.5 }));
check("11. ⭐⭐⭐ entitlement_version NaN → false", !isAuthCodePayload({ ...withUser, entitlement_version: NaN }));
check("12. ⭐⭐ user_id ne-string → false", !isAuthCodePayload({ ...withUser, user_id: 42 }));
check("13. ⭐⭐ entitlement_version ne-număr → false", !isAuthCodePayload({ ...withUser, entitlement_version: "2" }));
check("14. ⭐ base încă cere câmpurile de bază (fără redirect_uri) → false", !isAuthCodePayload({ ...withUser, redirect_uri: "" }));

// ── parseAuthCode: parțial/invalid → null (peekAuthCode → absent) ────────────────
{
  const p = parseAuthCode(JSON.stringify(withUser));
  check("15. ⭐⭐⭐ parseAuthCode pe user complet → păstrează claim-urile", p !== null && p.user_id === "u1" && p.grant_id === "g1" && p.entitlement_version === 2);
}
check("16. ⭐⭐⭐ parseAuthCode pe PARȚIAL (user_id fără grant_id) → null (nu trece drept legacy)", parseAuthCode(JSON.stringify({ ...base, user_id: "u1" })) === null);
check("17. ⭐⭐⭐ parseAuthCode pe entitlement_version 0 → null", parseAuthCode(JSON.stringify({ ...withUser, entitlement_version: 0 })) === null);
check("18. ⭐⭐ parseAuthCode pe legacy (fără claim-uri) → payload valid", (() => { const p = parseAuthCode(JSON.stringify(base)); return p !== null && p.user_id === undefined; })());

// ── integrare readAuthCodeIdentity (10.2): pe blob-uri deja garantate curate de boundary ──
check("19. ⭐⭐ cod user complet → readAuthCodeIdentity = user", readAuthCodeIdentity(withUser).kind === "user");
check("20. ⭐⭐ cod fără claim-uri → legacy_client", readAuthCodeIdentity(base).kind === "legacy_client");
check("21. ⭐⭐⭐ readAuthCodeIdentity pe parțial (defensiv) → corrupt (isAuthCodePayload false)", readAuthCodeIdentity({ ...base, user_id: "u1" }).kind === "corrupt");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
