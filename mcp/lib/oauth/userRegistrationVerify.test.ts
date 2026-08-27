/**
 * lib/oauth/userRegistrationVerify.test.ts — PH-2 step 10.5 (verificarea REGISTRATION-ului DCR pentru tokenuri USER, pur).
 */
import { verifyUserRegistration } from "./userRegistrationVerify";
import type { RegistrationLookup } from "../db/registrationLookup";
import type { RegistrationRef } from "./authorizeConsent";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const NOW = 1_000_000;
const reg: RegistrationRef = {
  registration_id: "r1", client_id: "c1", status: "active",
  grant_types: ["authorization_code", "refresh_token"], expires_at: null,
};
const found = (over: Partial<RegistrationRef> = {}): RegistrationLookup => ({ status: "found", registration: { ...reg, ...over } });
const V = (lookup: RegistrationLookup, over: Partial<{ clientId: string; nowMs: number; requiredGrantType: string }> = {}) =>
  verifyUserRegistration(lookup, { clientId: "c1", nowMs: NOW, requiredGrantType: "authorization_code", ...over });

function main(): void {
console.log("PH-2 step 10.5 — verifyUserRegistration (pur)");

// ── happy ────────────────────────────────────────────────────────────────────────
const ok = V(found());
check("1. ⭐⭐⭐ registration activă, ne-expirată, client_id egal, grant permis → ok", ok.ok === true && ok.ok && ok.registration.registration_id === "r1");
check("2. ⭐⭐ expires_at null = nu expiră → ok", V(found({ expires_at: null })).ok === true);
check("3. ⭐⭐ expires_at STRICT în viitor → ok", V(found({ expires_at: NOW + 1 })).ok === true);
check("4. ⭐⭐ grant refresh_token cerut, registration îl permite → ok", V(found(), { requiredGrantType: "refresh_token" }).ok === true);

// ── lookup discriminat ─────────────────────────────────────────────────────────────
const un = V({ status: "unavailable", reason: "supabase down" });
check("5. ⭐⭐⭐ lookup unavailable → unavailable (503, NU reject/401)", un.ok === false && !un.ok && un.kind === "unavailable");
const nf = V({ status: "not_found" });
check("6. ⭐⭐⭐ lookup not_found → reject (client neînregistrat/șters → 401)", nf.ok === false && !nf.ok && nf.kind === "reject");

// ── checks fail-closed → reject ─────────────────────────────────────────────────────
const mm = V(found({ client_id: "c2" }));
check("7. ⭐⭐⭐ client_id ≠ token (rând greșit de la adaptor) → reject (identitate confirmată EXPLICIT)", mm.ok === false && !mm.ok && mm.kind === "reject");
check("8. ⭐⭐⭐ status suspended → reject", V(found({ status: "suspended" })).ok === false);
check("9. ⭐⭐⭐ status revoked → reject", V(found({ status: "revoked" })).ok === false);
check("10. ⭐⭐⭐ expirată (expires_at ≤ now) → reject", V(found({ expires_at: NOW })).ok === false);
check("10b. ⭐⭐ expirată (expires_at < now) → reject", V(found({ expires_at: NOW - 1 })).ok === false);
check("11. ⭐⭐⭐ grant type cerut NEpermis (cere refresh_token dar registration are doar authorization_code) → reject",
  V(found({ grant_types: ["authorization_code"] }), { requiredGrantType: "refresh_token" }).ok === false);
check("12. ⭐⭐ registration cu grant_types goale → reject (nu permite nimic)",
  V(found({ grant_types: [] })).ok === false);

// ── NU ia plan/scopes/quota din registration (doar poartă de client valid) ──────────
check("13. ⭐⭐ rezultatul ok expune DOAR registration (fără plan/scopes/limite) — cont-ul e sursa acelora",
  (() => { const r = V(found()); return r.ok === true && r.ok && !("plan" in r) && !("scopes" in r); })());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
