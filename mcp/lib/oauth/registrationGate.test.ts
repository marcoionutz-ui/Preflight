/**
 * lib/oauth/registrationGate.test.ts — PH-2 pas 6 (poarta pură de registration, sursă unică POST + consent view).
 */
import { checkRegistrationBinding, type RegistrationGateFields, type RegistrationTxnBinding } from "./registrationGate";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const NOW = 1_500_000;
const txn: RegistrationTxnBinding = { registration_id: "reg_1", client_id: "client_1" };

function regOf(over: Partial<RegistrationGateFields> = {}): RegistrationGateFields {
  return {
    registration_id: "reg_1",
    client_id:       "client_1",
    status:          "active",
    grant_types:     ["authorization_code"],
    expires_at:      null,
    ...over,
  };
}

function main(): void {
console.log("PH-2 pas 6 — registrationGate (checkRegistrationBinding, pur)");

check("1. ⭐⭐⭐ registration validă (activă, legată, authz_code, ne-expirată) → ok",
  checkRegistrationBinding(regOf(), txn, NOW).ok === true);

check("2. ⭐⭐⭐ null → reject (OBLIGATORIE)", (() => {
  const r = checkRegistrationBinding(null, txn, NOW);
  return r.ok === false && /nu are registration/.test(r.reason);
})());

check("3. ⭐⭐⭐ registration_id ≠ txn → reject (registration_id mismatch)", (() => {
  const r = checkRegistrationBinding(regOf({ registration_id: "reg_X" }), txn, NOW);
  return r.ok === false && /registration_id mismatch/.test(r.reason);
})());

check("4. ⭐⭐⭐ client_id ≠ txn → reject (client_id mismatch)", (() => {
  const r = checkRegistrationBinding(regOf({ client_id: "client_X" }), txn, NOW);
  return r.ok === false && /client_id mismatch/.test(r.reason);
})());

check("5. ⭐⭐⭐ status suspended → reject", checkRegistrationBinding(regOf({ status: "suspended" }), txn, NOW).ok === false);
check("6. ⭐⭐⭐ status revoked → reject", checkRegistrationBinding(regOf({ status: "revoked" }), txn, NOW).ok === false);

check("7. ⭐⭐⭐ fără authorization_code → reject",
  checkRegistrationBinding(regOf({ grant_types: ["refresh_token", "client_credentials"] }), txn, NOW).ok === false);
check("7b. ⭐⭐ grant_types gol → reject", checkRegistrationBinding(regOf({ grant_types: [] }), txn, NOW).ok === false);

check("8. ⭐⭐⭐ expirată (expires_at < nowMs) → reject", checkRegistrationBinding(regOf({ expires_at: NOW - 1 }), txn, NOW).ok === false);
check("9. ⭐⭐⭐ expires_at EXACT === nowMs → reject (strict în viitor, nu ≥)", (() => {
  const r = checkRegistrationBinding(regOf({ expires_at: NOW }), txn, NOW);
  return r.ok === false && /expirată/.test(r.reason);
})());
check("10. ⭐⭐⭐ expires_at în viitor (> nowMs) → ok", checkRegistrationBinding(regOf({ expires_at: NOW + 1 }), txn, NOW).ok === true);
check("11. ⭐⭐ expires_at null (nu expiră) → ok", checkRegistrationBinding(regOf({ expires_at: null }), txn, NOW).ok === true);

check("12. ⭐ ok NU poartă reason (doar {ok:true})", (() => {
  const r = checkRegistrationBinding(regOf(), txn, NOW);
  return r.ok === true && !("reason" in r);
})());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
