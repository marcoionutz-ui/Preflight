/**
 * lib/db/grantInsert.test.ts — PH-2 step 10.3b-v frunză 1 (persistare grant: piese pure).
 *
 * (a) `buildGrantInsertRow` mapează 1:1 + scopes copiat; (b) `grantRowMatchesGrant` = identitate exactă, status EXCLUS,
 * coloane extra ignorate; (c) `decideGrantInsertOutcome` = succes→inserted / row mangled→conflict / eroare+read-back
 * (match→already_present, diferă→conflict, not_found→unavailable, unavailable→unavailable).
 */
import { buildGrantInsertRow, grantRowMatchesGrant, decideGrantInsertOutcome } from "./grantInsert";
import { buildGrant, type OAuthGrant } from "../oauth/grant";
import type { GrantLookup } from "./grantLookup";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function mkGrant(over: Partial<OAuthGrant> = {}): OAuthGrant {
  const r = buildGrant({
    grant_id: "g1", registration_id: "reg1", client_id: "c1", user_id: "u1",
    resource: "https://preflight.app/api/mcp", scopes: ["read:all", "read:market"],
    entitlement_version: 3, nowIso: "2026-01-01T00:00:00.000Z",
  });
  if (!r.ok) throw new Error("fixture grant invalid: " + r.error);
  return { ...r.grant, ...over };
}
const G = mkGrant();
const rowOf = (g: OAuthGrant) => buildGrantInsertRow(g);

function main(): void {
console.log("PH-2 step 10.3b-v frunză 1 — grantInsert (piese pure)");

// ── (a) buildGrantInsertRow ──────────────────────────────────────────────────────
{
  const row = buildGrantInsertRow(G);
  check("1. ⭐⭐⭐ mapează toate câmpurile 1:1", row.grant_id === "g1" && row.registration_id === "reg1" && row.client_id === "c1"
    && row.user_id === "u1" && row.resource === "https://preflight.app/api/mcp" && row.entitlement_version === 3
    && row.status === "active" && row.created_at === "2026-01-01T00:00:00.000Z");
  check("2. ⭐⭐ scopes păstrate + COPIE (referință diferită)", JSON.stringify(row.scopes) === JSON.stringify(["read:all", "read:market"]) && row.scopes !== G.scopes);
}

// ── (b) grantRowMatchesGrant ─────────────────────────────────────────────────────
check("3. ⭐⭐⭐ identitate exactă → true", grantRowMatchesGrant(rowOf(G), G) === true);
check("4. ⭐⭐⭐ grant_id diferit → false", grantRowMatchesGrant({ ...rowOf(G), grant_id: "gX" }, G) === false);
check("5. ⭐⭐ user_id diferit → false", grantRowMatchesGrant({ ...rowOf(G), user_id: "uX" }, G) === false);
check("6. ⭐⭐ resource diferit → false", grantRowMatchesGrant({ ...rowOf(G), resource: "https://evil/api/mcp" }, G) === false);
check("7. ⭐⭐ scopes ordine diferită → false", grantRowMatchesGrant({ ...rowOf(G), scopes: ["read:market", "read:all"] }, G) === false);
check("8. ⭐⭐ scopes lungime diferită → false", grantRowMatchesGrant({ ...rowOf(G), scopes: ["read:all"] }, G) === false);
check("9. ⭐ entitlement_version diferit → false", grantRowMatchesGrant({ ...rowOf(G), entitlement_version: 4 }, G) === false);
check("10. ⭐ created_at alt instant → false", grantRowMatchesGrant({ ...rowOf(G), created_at: "2027-01-01T00:00:00.000Z" }, G) === false);
check("10b. ⭐⭐⭐ created_at ACELAȘI instant, altă formă (+00:00 vs .000Z) → true (semantic, nu string)", grantRowMatchesGrant({ ...rowOf(G), created_at: "2026-01-01T00:00:00+00:00" }, G) === true);
check("10c. ⭐⭐ created_at neparsabil → false", grantRowMatchesGrant({ ...rowOf(G), created_at: "not-a-date" }, G) === false);
check("11. ⭐⭐⭐ status DIFERIT dar identitate egală → true (status exclus, mutabil)", grantRowMatchesGrant({ ...rowOf(G), status: "revoked" }, G) === true);
check("12. ⭐⭐ coloane extra (id auto / updated_at) + identitate egală → true", grantRowMatchesGrant({ ...rowOf(G), id: 42, updated_at: "x" }, G) === true);
check("13. non-obiect → false", grantRowMatchesGrant(null, G) === false && grantRowMatchesGrant(42, G) === false);
check("14. scopes ne-array → false", grantRowMatchesGrant({ ...rowOf(G), scopes: "read:all" }, G) === false);

// ── (c) decideGrantInsertOutcome ─────────────────────────────────────────────────
const found = (g: OAuthGrant): GrantLookup => ({ status: "found", grant: g });
const notFound: GrantLookup = { status: "not_found" };
const unavail: GrantLookup = { status: "unavailable", reason: "down" };

check("15. ⭐⭐⭐ succes + rând confirmat → inserted",
  decideGrantInsertOutcome({ insertError: null, insertData: rowOf(G), readback: null, expected: G }).status === "inserted");
check("16. ⭐⭐⭐ succes + rând mangled (diferă) → conflict",
  decideGrantInsertOutcome({ insertError: null, insertData: { ...rowOf(G), user_id: "uX" }, readback: null, expected: G }).status === "conflict");
check("17. ⭐⭐ succes fără rând → unavailable (ambiguu)",
  decideGrantInsertOutcome({ insertError: null, insertData: null, readback: null, expected: G }).status === "unavailable");
check("18. ⭐⭐⭐ eroare + read-back găsit+MATCH → already_present (idempotent)",
  decideGrantInsertOutcome({ insertError: { message: "dup" }, insertData: null, readback: found(G), expected: G }).status === "already_present");
check("19. ⭐⭐⭐ eroare + read-back găsit+DIFERĂ → conflict (colizie id)",
  decideGrantInsertOutcome({ insertError: { message: "dup" }, insertData: null, readback: found(mkGrant({ user_id: "uX" })), expected: G }).status === "conflict");
check("20. ⭐⭐⭐ eroare + read-back not_found → unavailable (n-a aterizat, retry)",
  decideGrantInsertOutcome({ insertError: { message: "net" }, insertData: null, readback: notFound, expected: G }).status === "unavailable");
check("21. ⭐⭐ eroare + read-back unavailable → unavailable",
  decideGrantInsertOutcome({ insertError: { message: "net" }, insertData: null, readback: unavail, expected: G }).status === "unavailable");
check("22. ⭐⭐ eroare + read-back null → unavailable (fail-closed)",
  decideGrantInsertOutcome({ insertError: { message: "net" }, insertData: null, readback: null, expected: G }).status === "unavailable");
check("23. ⭐⭐⭐ read-back găsit+identitate egală dar REVOCAT → revoked (persistat ≠ utilizabil, NU already_present)",
  decideGrantInsertOutcome({ insertError: { message: "dup" }, insertData: null, readback: found(mkGrant({ status: "revoked" })), expected: G }).status === "revoked");
check("24. ⭐⭐⭐ succes + rând confirmat dar status revoked → revoked (blochează emiterea codului)",
  decideGrantInsertOutcome({ insertError: null, insertData: { ...rowOf(G), status: "revoked" }, readback: null, expected: G }).status === "revoked");
check("25. ⭐⭐ eroare + read-back găsit+match+ACTIVE explicit → already_present",
  decideGrantInsertOutcome({ insertError: { message: "dup" }, insertData: null, readback: found(mkGrant({ status: "active" })), expected: G }).status === "already_present");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
