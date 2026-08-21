/**
 * lib/db/registrationBackfill.test.ts — PH-2a GUARD (backfill 1:1 confidențiali, pur).
 */
import { computeRegistrationBackfill, CONFIDENTIAL_GRANT_TYPES, type LegacyClientForRegistration } from "./registrationBackfill";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
const row = (o: Partial<LegacyClientForRegistration>): LegacyClientForRegistration => ({
  client_id: "tp_a", name: "App A", status: "active", redirect_uris: ["https://claude.ai/cb"], ...o,
});

function main(): void {
console.log("PH-2a — registrationBackfill (confidențiali 1:1, pur)");

// ── happy path ──────────────────────────────────────────────────────────────
{
  const r = computeRegistrationBackfill([row({})]);
  check("1. un client → o registration", r.registrations.length === 1 && r.invalidRows.length === 0);
  const reg = r.registrations[0];
  check("2. ⭐ client_type confidential + auth_method client_secret_post", reg.client_type === "confidential" && reg.token_endpoint_auth_method === "client_secret_post");
  check("3. ⭐ grant_types = interactive + M2M", JSON.stringify(reg.grant_types) === JSON.stringify(CONFIDENTIAL_GRANT_TYPES));
  check("4. redirect_uris + client_name păstrate", reg.redirect_uris.length === 1 && reg.client_name === "App A");
}

// ── redirect_uris gol → warning, dar tot backfill ─────────────────────────────
{
  const r = computeRegistrationBackfill([row({ redirect_uris: [] })]);
  check("5. ⭐⭐ fără redirect_uris → warning + tot backfill (identitatea există)", r.registrations.length === 1 && r.warnings.length === 1 && /nu poate autoriza interactiv/.test(r.warnings[0].warning));
}
{
  const r = computeRegistrationBackfill([row({ redirect_uris: ["", "  "] })]);
  check("6. ⭐ redirect_uris doar goluri → warning (redirects curate = [])", r.registrations.length === 1 && r.registrations[0].redirect_uris.length === 0 && r.warnings.length === 1);
}

// ── validare + normalizare redirect (cgpt slice-migrare #5) ───────────────────
{
  const r = computeRegistrationBackfill([row({ redirect_uris: ["  https://claude.ai/cb  "] })]);
  check("7. ⭐⭐ redirect trimuit → păstrat curat", r.registrations.length === 1 && r.registrations[0].redirect_uris[0] === "https://claude.ai/cb");
}
{
  const r = computeRegistrationBackfill([row({ redirect_uris: ["https://a.io/cb", "https://a.io/cb", "  https://a.io/cb  "] })]);
  check("8. ⭐⭐ redirect duplicat (după trim) → dedup la 1", r.registrations.length === 1 && r.registrations[0].redirect_uris.length === 1);
}
{
  const r = computeRegistrationBackfill([row({ redirect_uris: ["javascript:alert(1)"] })]);
  check("9. ⭐⭐⭐ redirect nesigur (javascript:) → invalidRow, NU registration (fail-closed)", r.registrations.length === 0 && r.invalidRows.length === 1 && /neadmis/.test(r.invalidRows[0].reasons.join()));
}
{
  const r = computeRegistrationBackfill([row({ redirect_uris: ["http://evil.example.com/cb"] })]);
  check("10. ⭐⭐ http non-loopback → invalidRow (unsafe)", r.registrations.length === 0 && r.invalidRows.length === 1);
}
{
  const r = computeRegistrationBackfill([row({ redirect_uris: ["ftp://host/cb"] })]);
  check("10b. ⭐⭐⭐ ftp → invalidRow (allowlist pozitiv, cgpt)", r.registrations.length === 0 && r.invalidRows.length === 1 && /neadmis/.test(r.invalidRows[0].reasons.join()));
}

// ── validare fail-closed structurală ──────────────────────────────────────────
{
  const r = computeRegistrationBackfill([row({ client_id: "" })]);
  check("11. ⭐ client_id gol → invalidRow (nu registration)", r.registrations.length === 0 && r.invalidRows.length === 1);
}
{
  const r = computeRegistrationBackfill([row({ client_id: "   " })]);
  check("11b. ⭐⭐⭐ client_id whitespace-only → invalidRow (aliniat cu SQL btrim)", r.registrations.length === 0 && r.invalidRows.length === 1 && /blank/.test(r.invalidRows[0].reasons.join()));
}
{
  const r = computeRegistrationBackfill([row({ status: "zombie" })]);
  check("12. ⭐ status necunoscut → invalidRow", r.invalidRows.length === 1 && /status necunoscut/.test(r.invalidRows[0].reasons.join()));
}
{
  const r = computeRegistrationBackfill([row({ redirect_uris: ["https://ok.io/cb", 5 as unknown as string] })]);
  check("13. ⭐⭐ redirect_uris cu non-string → invalidRow (nu aruncă)", r.invalidRows.length === 1 && r.registrations.length === 0);
}

// ── duplicat client_id blochează TOATE aparițiile (order-independent, cgpt slice-migrare #6-dup) ──
{
  const r = computeRegistrationBackfill([row({ client_id: "dup" }), row({ client_id: "dup" })]);
  check("14. ⭐⭐⭐ client_id duplicat → AMBELE invalidRow, 0 registration (nu first-wins)", r.registrations.length === 0 && r.invalidRows.length === 2 && r.invalidRows.every(iv => /duplicat/.test(iv.reasons.join())));
}
{
  // ordine inversă: chiar dacă „bun” apare primul, duplicatul tot blochează tot
  const r = computeRegistrationBackfill([row({ client_id: "ok1" }), row({ client_id: "dup" }), row({ client_id: "dup" }), row({ client_id: "ok2" })]);
  check("15. ⭐⭐ dup blochează doar id-ul lui, ceilalți trec", r.registrations.length === 2 && r.invalidRows.length === 2);
}

// ── izolare + gol ─────────────────────────────────────────────────────────────
{
  const r = computeRegistrationBackfill([row({ client_id: "ok1" }), row({ client_id: "bad", status: "x" }), row({ client_id: "ok2", name: null })]);
  check("16. ⭐ 2 valide + 1 invalid, fiecare pe canalul lui", r.registrations.length === 2 && r.invalidRows.length === 1 && r.registrations[1].client_name === null);
}
check("17. input gol → totul gol", (() => { const r = computeRegistrationBackfill([]); return r.registrations.length === 0 && r.invalidRows.length === 0 && r.warnings.length === 0; })());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
