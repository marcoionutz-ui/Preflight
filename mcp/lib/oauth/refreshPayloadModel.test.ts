/**
 * lib/oauth/refreshPayloadModel.test.ts — PH-2 step 10.4a (refresh USER: formă discriminată, pur).
 *
 * KEY: refresh-ul user poartă IDENTITATE (user_id/grant_id/entitlement_version) și INTERZICE `credential_version`
 * (validitatea la rotație = grant/entitlement, nu secretul clientului). Split draft/stocat pe family_id (ca la token).
 * Discriminatorul rutează pe subject_kind și NU confundă forma client cu forma user (cross-collision).
 */
import {
  isUserRefreshDraft, isUserRefreshPayload,
  classifyStoredRefresh, parseStoredRefresh, isUserRefresh,
  buildUserRefreshDraft, finalizeUserRefreshPayload,
  type UserRefreshDraft,
} from "./refreshPayloadModel";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
function throws(fn: () => unknown): boolean { try { fn(); return false; } catch { return true; } }

// forme de referință
const draft = { subject_kind: "user", client_id: "c1", user_id: "u1", grant_id: "g1", entitlement_version: 2, scopes: ["read:all"], audience: "https://x/api/mcp", issued_at: 1 };
const stored = { ...draft, family_id: "f1" };
// forma CLIENT existentă (RefreshPayload din oauthAtomic): FĂRĂ subject_kind, CU credential_version.
const clientRefresh = { client_id: "c1", scopes: ["read:all"], audience: "https://x/api/mcp", credential_version: "cv1", family_id: "f1", issued_at: 1 };

function main(): void {
console.log("PH-2 step 10.4a — refreshPayloadModel (refresh user discriminat, pur)");

// ── happy path: draft vs stocat ─────────────────────────────────────────────────
check("1. ⭐⭐⭐ draft user valid (fără family_id) → isUserRefreshDraft", isUserRefreshDraft(draft));
check("2. ⭐⭐⭐ stocat user valid (cu family_id) → isUserRefreshPayload", isUserRefreshPayload(stored));
check("3. ⭐⭐⭐ draft CU family_id → NU e draft (family se adaugă la emitere)", !isUserRefreshDraft(stored));
check("4. ⭐⭐⭐ stocat FĂRĂ family_id → NU e stocat (nerevocabil)", !isUserRefreshPayload(draft));

// ── INTERDICȚIA credential_version (invariantă centrală) ─────────────────────────
check("5. ⭐⭐⭐ draft + credential_version → false (interzis pe user)", !isUserRefreshDraft({ ...draft, credential_version: "cv1" }));
check("6. ⭐⭐⭐ stocat + credential_version → false (interzis pe user)", !isUserRefreshPayload({ ...stored, credential_version: "cv1" }));

// ── subject_kind ────────────────────────────────────────────────────────────────
check("7. ⭐⭐⭐ subject_kind absent → NU e user", !isUserRefreshPayload({ ...stored, subject_kind: undefined }));
check("8. ⭐⭐ subject_kind='client' → NU e user", !isUserRefreshPayload({ ...stored, subject_kind: "client" }));

// ── semantic invalid pe câmpuri ──────────────────────────────────────────────────
check("9.  ⭐⭐⭐ user_id gol → false", !isUserRefreshPayload({ ...stored, user_id: "" }));
check("10. ⭐⭐⭐ grant_id gol → false", !isUserRefreshPayload({ ...stored, grant_id: "" }));
check("11. ⭐⭐⭐ client_id gol → false", !isUserRefreshPayload({ ...stored, client_id: "" }));
check("12. ⭐⭐⭐ entitlement_version 0 → false", !isUserRefreshPayload({ ...stored, entitlement_version: 0 }));
check("13. ⭐⭐⭐ entitlement_version negativ → false", !isUserRefreshPayload({ ...stored, entitlement_version: -1 }));
check("14. ⭐⭐⭐ entitlement_version fracționar → false", !isUserRefreshPayload({ ...stored, entitlement_version: 1.5 }));
check("15. ⭐⭐⭐ entitlement_version NaN → false", !isUserRefreshPayload({ ...stored, entitlement_version: NaN }));
check("16. ⭐⭐ entitlement_version ne-număr → false", !isUserRefreshPayload({ ...stored, entitlement_version: "2" }));
check("17. ⭐⭐⭐ audience gol → false (PH-3)", !isUserRefreshPayload({ ...stored, audience: "" }));
check("18. ⭐⭐ family_id gol → false", !isUserRefreshPayload({ ...stored, family_id: "" }));
check("19. ⭐⭐ scopes ne-array → false", !isUserRefreshPayload({ ...stored, scopes: "read:all" }));
check("20. ⭐⭐ scopes cu element ne-string → false", !isUserRefreshPayload({ ...stored, scopes: ["read:all", 3] }));
check("21. ⭐⭐ issued_at ne-finit → false", !isUserRefreshPayload({ ...stored, issued_at: Infinity }));
check("22. ⭐ non-obiect → false", !isUserRefreshPayload(null) && !isUserRefreshPayload("x") && !isUserRefreshDraft(42));

// ── classifyStoredRefresh: rutare pe subject_kind ─────────────────────────────────
check("23. ⭐⭐⭐ classify(user stocat) → forma user", (() => { const p = classifyStoredRefresh(stored); return p !== null && isUserRefresh(p); })());
check("24. ⭐⭐⭐ classify(client refresh) → forma client (nu user)", (() => { const p = classifyStoredRefresh(clientRefresh); return p !== null && !isUserRefresh(p); })());
check("25. ⭐⭐⭐ classify(subject_kind='client') → null (fail-closed)", classifyStoredRefresh({ ...clientRefresh, subject_kind: "client" }) === null);
check("26. ⭐⭐⭐ classify(user parțial: fără grant_id) → null", classifyStoredRefresh({ ...stored, grant_id: undefined }) === null);

// ── CROSS-COLLISION: formele NU se confundă ───────────────────────────────────────
check("27. ⭐⭐⭐ blob USER nu trece drept client (subject_kind rutează + lipsă credential_version)", (() => { const p = classifyStoredRefresh(stored); return p !== null && isUserRefresh(p); })());
check("28. ⭐⭐⭐ blob CLIENT nu trece drept user (subject_kind absent → forma client)", (() => { const p = classifyStoredRefresh(clientRefresh); return p !== null && !isUserRefresh(p); })());
check("29. ⭐⭐ user cu credential_version INJECTAT → null (nu-l acceptăm ca user, nici ca client)", classifyStoredRefresh({ ...stored, credential_version: "cv1" }) === null);

// ── HIBRID user/client (cgpt): client + claim-uri user, FĂRĂ subject_kind → NU trece drept client ────────────────
// Forma client (subject_kind absent) delega la isRefreshPayload; dacă acel guard nu interzice câmpurile user, un blob
// hibrid trecea drept refresh client (coliziune → o formă coruptă devine legacy/client). Acum e respins la rădăcină.
const hybridAll    = { ...clientRefresh, user_id: "u1", grant_id: "g1", entitlement_version: 2 };
const hybridUserId = { ...clientRefresh, user_id: "u1" };
const hybridGrant  = { ...clientRefresh, grant_id: "g1" };
const hybridVer    = { ...clientRefresh, entitlement_version: 2 };
check("29a. ⭐⭐⭐ client + TOATE claim-urile user (fără subject_kind) → null (nu client)", classifyStoredRefresh(hybridAll) === null);
check("29b. ⭐⭐⭐ client + DOAR user_id → null", classifyStoredRefresh(hybridUserId) === null);
check("29c. ⭐⭐⭐ client + DOAR grant_id → null", classifyStoredRefresh(hybridGrant) === null);
check("29d. ⭐⭐⭐ client + DOAR entitlement_version → null", classifyStoredRefresh(hybridVer) === null);
check("29e. ⭐⭐⭐ client + subject_kind='user' injectat (dar restul client) → null (rutat la guard user, cade)", classifyStoredRefresh({ ...clientRefresh, subject_kind: "user" }) === null);
check("29f. ⭐⭐⭐ parseStoredRefresh(hibrid complet) → null", parseStoredRefresh(JSON.stringify(hybridAll)) === null);
check("29g. ⭐⭐⭐ parseStoredRefresh(hibrid un singur claim) → null", parseStoredRefresh(JSON.stringify(hybridUserId)) === null);
check("29h. ⭐⭐ client curat (fără niciun câmp user) → ÎNCĂ trece drept client (nu am spart forma validă)", (() => { const p = classifyStoredRefresh(clientRefresh); return p !== null && !isUserRefresh(p); })());

// ── parseStoredRefresh: round-trip + corupt ───────────────────────────────────────
check("30. ⭐⭐⭐ parse(round-trip user) → forma user cu câmpuri păstrate", (() => {
  const p = parseStoredRefresh(JSON.stringify(stored));
  return p !== null && isUserRefresh(p) && p.user_id === "u1" && p.grant_id === "g1" && p.entitlement_version === 2 && p.family_id === "f1";
})());
check("31. ⭐⭐ parse(round-trip client) → forma client", (() => { const p = parseStoredRefresh(JSON.stringify(clientRefresh)); return p !== null && !isUserRefresh(p); })());
check("32. ⭐⭐⭐ parse(JSON corupt) → null", parseStoredRefresh("{nope") === null);
check("33. ⭐⭐⭐ parse(user fără family_id) → null (nerevocabil, nu-l stocăm)", parseStoredRefresh(JSON.stringify(draft)) === null);

// ── buildere: validează + aruncă ──────────────────────────────────────────────────
check("34. ⭐⭐⭐ buildUserRefreshDraft(valid) → draft valid, fără family_id", (() => {
  const d = buildUserRefreshDraft({ client_id: "c1", user_id: "u1", grant_id: "g1", entitlement_version: 2, scopes: ["read:all"], audience: "https://x/api/mcp", issued_at: 1 });
  return isUserRefreshDraft(d) && (d as UserRefreshDraft & { family_id?: unknown }).family_id === undefined;
})());
check("35. ⭐⭐⭐ buildUserRefreshDraft(entitlement_version 0) → aruncă", throws(() => buildUserRefreshDraft({ client_id: "c1", user_id: "u1", grant_id: "g1", entitlement_version: 0, scopes: ["read:all"], audience: "https://x/api/mcp", issued_at: 1 })));
check("36. ⭐⭐⭐ buildUserRefreshDraft(audience gol) → aruncă (PH-3)", throws(() => buildUserRefreshDraft({ client_id: "c1", user_id: "u1", grant_id: "g1", entitlement_version: 2, scopes: ["read:all"], audience: "", issued_at: 1 })));
check("37. ⭐⭐⭐ finalizeUserRefreshPayload(draft, 'f1') → stocat valid", (() => {
  const d = buildUserRefreshDraft({ client_id: "c1", user_id: "u1", grant_id: "g1", entitlement_version: 2, scopes: ["read:all"], audience: "https://x/api/mcp", issued_at: 1 });
  const s = finalizeUserRefreshPayload(d, "f1");
  return isUserRefreshPayload(s) && s.family_id === "f1";
})());
check("38. ⭐⭐⭐ finalizeUserRefreshPayload(draft, '') → aruncă (family gol)", (() => {
  const d = buildUserRefreshDraft({ client_id: "c1", user_id: "u1", grant_id: "g1", entitlement_version: 2, scopes: ["read:all"], audience: "https://x/api/mcp", issued_at: 1 });
  return throws(() => finalizeUserRefreshPayload(d, ""));
})());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
