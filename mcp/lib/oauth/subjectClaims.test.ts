/**
 * lib/oauth/subjectClaims.test.ts — PH-2a GUARD (uniunea de subiect user/client, fail-closed).
 */
import { buildUserSubject, buildClientSubject, isUserSubject, isClientSubject, parseTokenSubject } from "./subjectClaims";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2a — subjectClaims (uniune discriminată user/client)");

const u = buildUserSubject({ user_id: "u1", grant_id: "g1", entitlement_version: 1, client_id: "tp_x" });
const c = buildClientSubject({ client_id: "tp_x", credential_version: "2026-01-01T00:00:00Z" });

check("1. buildUserSubject → subject_kind user + câmpuri", u.subject_kind === "user" && isUserSubject(u));
check("2. buildClientSubject → subject_kind client", c.subject_kind === "client" && isClientSubject(c));
check("3. ⭐ user NU e client și invers", !isClientSubject(u) && !isUserSubject(c));

// ── isUserSubject fail-closed ─────────────────────────────────────────────────
check("4. ⭐ user fără user_id → false", !isUserSubject({ subject_kind: "user", grant_id: "g", entitlement_version: 1, client_id: "c" }));
check("5. ⭐ user fără grant_id → false", !isUserSubject({ subject_kind: "user", user_id: "u", entitlement_version: 1, client_id: "c" }));
check("6. ⭐ entitlement_version 0 → false (începe de la 1)", !isUserSubject({ subject_kind: "user", user_id: "u", grant_id: "g", entitlement_version: 0, client_id: "c" }));
check("7. ⭐ entitlement_version float → false", !isUserSubject({ subject_kind: "user", user_id: "u", grant_id: "g", entitlement_version: 1.5, client_id: "c" }));
check("8. ⭐ user fără client_id → false", !isUserSubject({ subject_kind: "user", user_id: "u", grant_id: "g", entitlement_version: 1 }));

// ── isClientSubject fail-closed ───────────────────────────────────────────────
check("9. ⭐ client fără credential_version → false", !isClientSubject({ subject_kind: "client", client_id: "c" }));
check("10. ⭐ client fără client_id → false", !isClientSubject({ subject_kind: "client", credential_version: "v" }));

// ── parseTokenSubject fail-closed (NU ghicește tipul) ─────────────────────────
check("11. ⭐⭐ parse user valid → user", (() => { const s = parseTokenSubject(u); return s?.subject_kind === "user"; })());
check("12. ⭐⭐ parse client valid → client", (() => { const s = parseTokenSubject(c); return s?.subject_kind === "client"; })());
check("13. ⭐⭐⭐ subject_kind necunoscut → null (nu cade pe alt path)", parseTokenSubject({ subject_kind: "admin", user_id: "u" }) === null);
check("14. ⭐⭐ subject_kind absent → null", parseTokenSubject({ user_id: "u", grant_id: "g", entitlement_version: 1, client_id: "c" }) === null);
check("15. ⭐⭐ user cu subject_kind='user' dar câmp lipsă → null (NU devine client)", parseTokenSubject({ subject_kind: "user", client_id: "c", credential_version: "v" }) === null);
check("16. null / non-obiect → null", parseTokenSubject(null) === null && parseTokenSubject("x") === null && parseTokenSubject(42) === null);

// ── uniune STRICTĂ: claims exclusive celeilalte ramuri sunt RESPINSE (cgpt P2) ─
check("17. ⭐⭐⭐ client cu user_id → NU e client (claim exclusiv user, respins)",
  !isClientSubject({ subject_kind: "client", client_id: "c", credential_version: "v", user_id: "leak" }) &&
  parseTokenSubject({ subject_kind: "client", client_id: "c", credential_version: "v", user_id: "leak" }) === null);
check("18. ⭐⭐ client cu grant_id → NU e client",
  !isClientSubject({ subject_kind: "client", client_id: "c", credential_version: "v", grant_id: "g" }));
check("19. ⭐⭐ client cu entitlement_version → NU e client",
  !isClientSubject({ subject_kind: "client", client_id: "c", credential_version: "v", entitlement_version: 1 }));
check("20. ⭐⭐⭐ user cu credential_version → NU e user (claim exclusiv client, respins)",
  !isUserSubject({ subject_kind: "user", user_id: "u", grant_id: "g", entitlement_version: 1, client_id: "c", credential_version: "v" }) &&
  parseTokenSubject({ subject_kind: "user", user_id: "u", grant_id: "g", entitlement_version: 1, client_id: "c", credential_version: "v" }) === null);
check("21. ⭐ client curat (doar client_id + credential_version) → tot client (client_id e claim COMUN)",
  isClientSubject({ subject_kind: "client", client_id: "c", credential_version: "v" }));
check("22. ⭐ user curat → tot user", isUserSubject(u));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
