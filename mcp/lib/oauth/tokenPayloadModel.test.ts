/**
 * lib/oauth/tokenPayloadModel.test.ts — PH-2 step 10 GUARD (forme discriminate token payload, pur).
 */
import {
  isUserTokenDraft, isUserTokenPayload, isClientTokenPayload, isLegacyClientTokenPayload,
  parseStoredTokenPayload, tokenRequiresCredentialVersion,
  buildUserTokenDraft, finalizeUserTokenPayload, buildClientTokenPayload,
} from "./tokenPayloadModel";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const AUD = "https://preflight.app/api/mcp";
const userStored = { subject_kind: "user", user_id: "u1", grant_id: "g1", entitlement_version: 1, client_id: "c1", scopes: ["read:all"], issued_at: 123, audience: AUD, family_id: "f1" };
const userDraft  = { subject_kind: "user", user_id: "u1", grant_id: "g1", entitlement_version: 1, client_id: "c1", scopes: ["read:all"], issued_at: 123, audience: AUD }; // fără family_id
const clientNew  = { subject_kind: "client", client_id: "c1", scopes: ["read:all"], issued_at: 123, credential_version: "v1", audience: AUD };
const clientLegacyAudFam = { client_id: "c1", scopes: ["read:all"], issued_at: 123, credential_version: "v1", audience: AUD, family_id: "f1" }; // auth-code de azi
const clientLegacyBare   = { client_id: "c1", scopes: ["read:all"], issued_at: 123, credential_version: "v1" }; // pre-PH-3

function main(): void {
console.log("PH-2 step 10 — tokenPayloadModel (3 forme + draft, pur)");

// ── USER draft vs stocat: family_id ────────────────────────────────────────────
check("1. ⭐⭐⭐ user STOCAT cere family_id → valid cu el", isUserTokenPayload(userStored));
check("2. ⭐⭐⭐ user STOCAT FĂRĂ family_id → INVALID (nerevocabil prin familie)", !isUserTokenPayload(userDraft));
check("3. ⭐⭐ user DRAFT (fără family_id) → valid ca draft", isUserTokenDraft(userDraft));
check("4. ⭐⭐ user DRAFT cu family_id → NU e draft (draftul e pre-familie)", !isUserTokenDraft(userStored));
check("5. ⭐⭐⭐ user (draft sau stocat) FĂRĂ audience → invalid (PH-3 cere audience)", !isUserTokenDraft({ ...userDraft, audience: undefined }) && !isUserTokenPayload({ ...userStored, audience: undefined }));
check("6. ⭐⭐⭐ user CU credential_version (claim interzis) → invalid", !isUserTokenPayload({ ...userStored, credential_version: "v1" }));
check("7. ⭐ entitlement_version 0 → invalid", !isUserTokenPayload({ ...userStored, entitlement_version: 0 }));
check("8. ⭐ user fără client_id → invalid", !isUserTokenPayload({ ...userStored, client_id: "" }));
check("9. ⭐ user fără grant_id → invalid", !isUserTokenPayload({ ...userStored, grant_id: undefined }));

// ── CLIENT nou ─────────────────────────────────────────────────────────────────
check("10. ⭐⭐ client nou valid → true", isClientTokenPayload(clientNew));
check("11. ⭐⭐⭐ client nou FĂRĂ audience → invalid (formele noi cer audience)", !isClientTokenPayload({ ...clientNew, audience: undefined }));
check("12. ⭐⭐⭐ client nou CU family_id → invalid (M2M nu are familie)", !isClientTokenPayload({ ...clientNew, family_id: "f1" }));
check("13. ⭐ client nou fără credential_version → invalid", !isClientTokenPayload({ ...clientNew, credential_version: undefined }));
check("14. ⭐⭐⭐ client nou CU user_id (claim interzis) → invalid", !isClientTokenPayload({ ...clientNew, user_id: "u1" }));

// ── CLIENT legacy (izolat) ──────────────────────────────────────────────────────
check("15. ⭐⭐⭐ legacy (fără subject_kind) cu audience+family → valid (auth-code de azi)", isLegacyClientTokenPayload(clientLegacyAudFam));
check("16. ⭐⭐⭐ legacy bare (fără audience/family, pre-PH-3) → valid (grandfather)", isLegacyClientTokenPayload(clientLegacyBare));
check("17. ⭐⭐ legacy fără credential_version → invalid", !isLegacyClientTokenPayload({ client_id: "c1", scopes: [], issued_at: 1 }));
check("18. ⭐⭐⭐ legacy cu subject_kind (orice) → NU e legacy", !isLegacyClientTokenPayload({ ...clientLegacyBare, subject_kind: "client" }));
check("19. ⭐⭐ legacy cu user_id (claim interzis) → invalid", !isLegacyClientTokenPayload({ ...clientLegacyBare, user_id: "u1" }));

// ── discriminare mutuală ───────────────────────────────────────────────────────
check("20. ⭐⭐⭐ user stocat NU e client nici legacy", !isClientTokenPayload(userStored) && !isLegacyClientTokenPayload(userStored));
check("21. ⭐⭐⭐ client nou NU e user nici legacy", !isUserTokenPayload(clientNew) && !isLegacyClientTokenPayload(clientNew));
check("22. ⭐⭐ legacy NU e user nici client nou", !isUserTokenPayload(clientLegacyAudFam) && !isClientTokenPayload(clientLegacyAudFam));

// ── parseStoredTokenPayload (fail-closed, discriminare pe subject_kind) ──────────
check("23. ⭐⭐ parse user stocat → user", parseStoredTokenPayload(userStored)?.subject_kind === "user");
check("24. ⭐⭐⭐ parse user DRAFT (fără family) → null (nu e formă STOCATĂ validă)", parseStoredTokenPayload(userDraft) === null);
check("25. ⭐⭐ parse client nou → client", parseStoredTokenPayload(clientNew)?.subject_kind === "client");
check("26. ⭐⭐⭐ parse legacy → legacy (subject_kind undefined, nu null)", (() => { const p = parseStoredTokenPayload(clientLegacyAudFam); return p !== null && p.subject_kind === undefined; })());
check("27. ⭐⭐⭐ subject_kind=user dar câmp lipsă → null (NU cade pe altă formă)", parseStoredTokenPayload({ subject_kind: "user", user_id: "u1" }) === null);
check("28. ⭐⭐ subject_kind necunoscut (robot) → null", parseStoredTokenPayload({ subject_kind: "robot", client_id: "c1", scopes: [], issued_at: 1, credential_version: "v", audience: AUD }) === null);
check("29. null / non-obiect → null", parseStoredTokenPayload(null) === null && parseStoredTokenPayload(42) === null);

// ── tokenRequiresCredentialVersion (semantica de consum) ───────────────────────
check("30. ⭐⭐⭐ user → NU cere credential_version", tokenRequiresCredentialVersion(userStored as never) === false);
check("31. ⭐⭐⭐ client nou → cere credential_version", tokenRequiresCredentialVersion(clientNew as never) === true);
check("32. ⭐⭐⭐ legacy → cere credential_version (nu relaxa vechiul contract)", tokenRequiresCredentialVersion(clientLegacyBare as never) === true);

// ── buildere + finalize ─────────────────────────────────────────────────────────
{
  const d = buildUserTokenDraft({ user_id: "u1", grant_id: "g1", entitlement_version: 2, client_id: "c1", scopes: ["read:all"], issued_at: 9, audience: AUD });
  check("33. ⭐⭐ buildUserTokenDraft → draft valid, FĂRĂ family_id/credential_version", isUserTokenDraft(d) && !("family_id" in d) && !("credential_version" in d));
  check("34. ⭐⭐⭐ draftul NU e încă payload stocat valid (fără family)", !isUserTokenPayload(d));
  const stored = finalizeUserTokenPayload(d, "fam-XYZ");
  check("35. ⭐⭐⭐ finalizeUserTokenPayload adaugă family → payload STOCAT valid", isUserTokenPayload(stored) && stored.family_id === "fam-XYZ");
  check("36. finalize round-trip prin parse → user", parseStoredTokenPayload(stored)?.subject_kind === "user");
}
{
  const c = buildClientTokenPayload({ client_id: "c1", scopes: ["read:all"], issued_at: 9, credential_version: "v1", audience: AUD });
  check("37. ⭐⭐ buildClientTokenPayload → client valid + subject_kind=client, FĂRĂ family", isClientTokenPayload(c) && !("family_id" in c));
  check("38. buildClient → cere credential_version", tokenRequiresCredentialVersion(c) === true);
}

// ── builder-ele VALIDEAZĂ runtime (cgpt): nu emit niciodată payload invalid ─────
function throws(fn: () => unknown): boolean { try { fn(); return false; } catch { return true; } }
{
  const d = buildUserTokenDraft({ user_id: "u1", grant_id: "g1", entitlement_version: 1, client_id: "c1", scopes: ["read:all"], issued_at: 9, audience: AUD });
  check("39. ⭐⭐⭐ finalizeUserTokenPayload(draft, \"\") → ARUNCĂ (family_id gol = nerevocabil)", throws(() => finalizeUserTokenPayload(d, "")));
  check("40. finalizeUserTokenPayload cu family valid → OK", isUserTokenPayload(finalizeUserTokenPayload(d, "fam1")));
}
check("41. ⭐⭐⭐ buildUserTokenDraft cu audience gol → ARUNCĂ (nu emite draft invalid)", throws(() => buildUserTokenDraft({ user_id: "u1", grant_id: "g1", entitlement_version: 1, client_id: "c1", scopes: [], issued_at: 9, audience: "" })));
check("42. ⭐⭐ buildUserTokenDraft cu entitlement_version 0 → ARUNCĂ", throws(() => buildUserTokenDraft({ user_id: "u1", grant_id: "g1", entitlement_version: 0, client_id: "c1", scopes: [], issued_at: 9, audience: AUD })));
check("43. ⭐⭐⭐ buildClientTokenPayload cu audience gol → ARUNCĂ (formele noi cer audience)", throws(() => buildClientTokenPayload({ client_id: "c1", scopes: [], issued_at: 9, credential_version: "v1", audience: "" })));
check("44. ⭐⭐ buildClientTokenPayload cu credential_version gol → ARUNCĂ", throws(() => buildClientTokenPayload({ client_id: "c1", scopes: [], issued_at: 9, credential_version: "", audience: AUD })));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
