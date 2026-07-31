/**
 * lib/db/oauthClientInsert.test.ts — E3 (secret_rotated_at explicit la insert + guard fail-closed).
 *
 * Dovadă că rândul de insert poartă MEREU `secret_rotated_at` (nu depindem de un DEFAULT DB care poate lipsi)
 * și că guard-ul respinge un client fără credential_version valabil (altfel tokenurile lui ar pica toate la auth).
 * Leaf pur → rulează standalone în tsx.
 */
import { createHash } from "crypto";
import {
  type OAuthClientInsertBase,
  buildOAuthClientInsertRow,
  hasValidCredentialVersion,
} from "./oauthClientInsert";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const BASE: OAuthClientInsertBase = {
  client_id:             "tp_deadbeef",
  secret_hash:           createHash("sha256").update("s3cr3t").digest("hex"),
  name:                  "Test client",
  plan:                  "starter",
  scopes:                ["read:all"],
  rate_limit_per_minute: 60,
  rate_limit_per_day:    10_000,
  notes:                 null,
  user_id:               null,
};

const NOW_ISO = "2026-07-31T18:00:00.000Z";

function main(): void {
console.log("E3 — oauthClientInsert (secret_rotated_at explicit + guard fail-closed)");

// ── buildOAuthClientInsertRow ─────────────────────────────────────────────────
const row = buildOAuthClientInsertRow(BASE, NOW_ISO);
check("1. ⭐ rândul de insert include secret_rotated_at (nu lipsește ca înainte)",
  Object.prototype.hasOwnProperty.call(row, "secret_rotated_at"));
check("2. ⭐ secret_rotated_at === nowIso (timestamp-ul creării, injectat)", row.secret_rotated_at === NOW_ISO);
check("3. secret_rotated_at e string ne-gol", typeof row.secret_rotated_at === "string" && row.secret_rotated_at.length > 0);
check("4. câmpurile de bază sunt păstrate (client_id)", row.client_id === BASE.client_id);
check("5. câmpurile de bază sunt păstrate (scopes)", row.scopes === BASE.scopes);
check("6. nu adaugă câmpuri neașteptate (doar base + secret_rotated_at + redirect_uris)",
  Object.keys(row).sort().join(",") === [...Object.keys(BASE), "secret_rotated_at", "redirect_uris"].sort().join(","));
check("7. ⭐ NU lasă secret_rotated_at pe seama DB-ului (nu e undefined)", row.secret_rotated_at !== undefined);

// redirect_uris (varu: aceeași clasă de invariant — folosit direct cu .length/.includes/.filter) ──────────────
check("7a. ⭐ rândul include redirect_uris (nu lipsește ca înainte)",
  Object.prototype.hasOwnProperty.call(row, "redirect_uris"));
check("7b. ⭐ redirect_uris === [] (array gol, fail-closed — nu poate autoriza până nu configurează allowlist)",
  Array.isArray(row.redirect_uris) && row.redirect_uris.length === 0);
check("7c. redirect_uris nu e undefined (nu-l lasă pe seama DB-ului)", row.redirect_uris !== undefined);
check("7d. .length/.includes/.filter merg pe redirect_uris (nu ar arunca pe NULL)",
  row.redirect_uris.length === 0 && row.redirect_uris.includes("x") === false && row.redirect_uris.filter(Boolean).length === 0);

// ── hasValidCredentialVersion (guard fail-closed) ─────────────────────────────
check("8. rând cu secret_rotated_at valid → true", hasValidCredentialVersion(row));
check("9. ⭐ secret_rotated_at null (DB fără DEFAULT) → false", !hasValidCredentialVersion({ secret_rotated_at: null }));
check("10. ⭐ secret_rotated_at undefined (coloană lipsă) → false", !hasValidCredentialVersion({ secret_rotated_at: undefined }));
check("11. ⭐ secret_rotated_at \"\" (gol) → false", !hasValidCredentialVersion({ secret_rotated_at: "" }));
check("12. secret_rotated_at non-string (număr) → false", !hasValidCredentialVersion({ secret_rotated_at: 123 as any }));
check("13. row null → false (nu aruncă)", !hasValidCredentialVersion(null));
check("14. row undefined → false (nu aruncă)", !hasValidCredentialVersion(undefined));
check("15. secret_rotated_at ISO real → true", hasValidCredentialVersion({ secret_rotated_at: NOW_ISO }));

// ── round-trip: rândul construit trece guard-ul (regresie: dropul câmpului îl pică) ──
check("16. ⭐ round-trip: buildOAuthClientInsertRow → hasValidCredentialVersion true",
  hasValidCredentialVersion(buildOAuthClientInsertRow(BASE, NOW_ISO)));
// dovada că guard-ul chiar prinde regresia: un rând FĂRĂ câmp (ce era înainte fixul) pică.
check("17. ⭐ rândul VECHI (fără secret_rotated_at, ca înainte de E3) → guard false",
  !hasValidCredentialVersion(BASE as any));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
