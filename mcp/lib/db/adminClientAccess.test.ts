/**
 * lib/db/adminClientAccess.test.ts — lot OAuth staging §4.1 (O1): piesele pure ale `scripts/adminClientAccess.ts`.
 *
 * (a) `parseAdminClientArgs`: uniune închisă, fail-closed pe argumente necunoscute/ambigue; (b) `planAccessChange`:
 * authorize doar pe client activ, noop pe deja-autorizat (audit păstrat), unauthorize pe orice status; (c) listarea nu
 * conține și nu cere `secret_hash`; (d) guard de sursă pe script (coloane explicite, confirmarea update-ului, env).
 * cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";
import {
  ADMIN_CLIENT_COLUMNS, EXIT_BACKEND, EXIT_OK, EXIT_REFUSED, EXIT_USAGE,
  formatClientRow, parseAdminClientArgs, planAccessChange, type AdminClientRow,
} from "./adminClientAccess";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const NOW = "2026-11-03T12:00:00.000Z";
function row(over: Partial<AdminClientRow> = {}): AdminClientRow {
  return {
    client_id: "tp_abc", user_id: "11111111-1111-1111-1111-111111111111", name: "a@b.c", plan: "free_trial",
    scopes: ["read:basic"], status: "active", created_at: "2026-01-01T00:00:00.000Z",
    admin_authorized_at: null, admin_authorized_by: null, ...over,
  };
}

function main(): void {
console.log("Lot OAuth staging §4.1 — adminClientAccess (piese pure)");

// ── (a) parse ──
check("1. ⭐⭐ --list → list", parseAdminClientArgs(["--list"]).kind === "list");
check("2. ⭐⭐⭐ --authorize --client-id --by → authorize (by trim)", (() => {
  const c = parseAdminClientArgs(["--authorize", "--client-id=tp_marco_personal", "--by=  marco M2M  "]);
  return c.kind === "authorize" && c.clientId === "tp_marco_personal" && c.by === "marco M2M";
})());
check("3. ⭐⭐ --unauthorize --client-id → unauthorize", (() => {
  const c = parseAdminClientArgs(["--unauthorize", "--client-id=tp_abc"]);
  return c.kind === "unauthorize" && c.clientId === "tp_abc";
})());
check("4. ⭐⭐⭐ fără mod / două moduri → usage_error",
  parseAdminClientArgs([]).kind === "usage_error"
  && parseAdminClientArgs(["--list", "--authorize", "--client-id=x", "--by=y"]).kind === "usage_error"
  && parseAdminClientArgs(["--authorize", "--unauthorize", "--client-id=x"]).kind === "usage_error");
check("5. ⭐⭐⭐ --authorize fără --by sau cu --by gol/doar spații → usage_error",
  parseAdminClientArgs(["--authorize", "--client-id=x"]).kind === "usage_error"
  && parseAdminClientArgs(["--authorize", "--client-id=x", "--by="]).kind === "usage_error"
  && parseAdminClientArgs(["--authorize", "--client-id=x", "--by=   "]).kind === "usage_error");
check("6. ⭐⭐ --by cu newline / > 200 → usage_error",
  parseAdminClientArgs(["--authorize", "--client-id=x", "--by=a\nb"]).kind === "usage_error"
  && parseAdminClientArgs(["--authorize", "--client-id=x", "--by=" + "n".repeat(201)]).kind === "usage_error");
check("7. ⭐⭐⭐ --client-id lipsă / gol / cu spațiu → usage_error",
  parseAdminClientArgs(["--authorize", "--by=n"]).kind === "usage_error"
  && parseAdminClientArgs(["--unauthorize", "--client-id="]).kind === "usage_error"
  && parseAdminClientArgs(["--unauthorize", "--client-id=a b"]).kind === "usage_error");
check("8. ⭐⭐ argument necunoscut (typo) → usage_error (nu ghicim la un script care scrie)",
  parseAdminClientArgs(["--authorise", "--client-id=x", "--by=n"]).kind === "usage_error"
  && parseAdminClientArgs(["--list", "--all"]).kind === "usage_error");
check("9. ⭐⭐ --by lângă --unauthorize, argumente lângă --list, --client-id dublu → usage_error",
  parseAdminClientArgs(["--unauthorize", "--client-id=x", "--by=n"]).kind === "usage_error"
  && parseAdminClientArgs(["--list", "--client-id=x"]).kind === "usage_error"
  && parseAdminClientArgs(["--unauthorize", "--client-id=x", "--client-id=y"]).kind === "usage_error");

// ── (b) planAccessChange ──
check("10. ⭐⭐⭐ authorize pe client activ neautorizat → apply {now, by}, requireActive", (() => {
  const p = planAccessChange(row(), { kind: "authorize", by: "marco" }, NOW);
  return p.kind === "apply" && p.patch.admin_authorized_at === NOW && p.patch.admin_authorized_by === "marco" && p.requireActive;
})());
check("11. ⭐⭐⭐ authorize pe client inexistent → refuse not_found", (() => {
  const p = planAccessChange(null, { kind: "authorize", by: "m" }, NOW);
  return p.kind === "refuse" && p.code === "not_found";
})());
check("12. ⭐⭐⭐ authorize pe revoked/suspended → refuse not_active (nu reactivăm pe ușa din spate)",
  ["revoked", "suspended", null].every(st => {
    const p = planAccessChange(row({ status: st }), { kind: "authorize", by: "m" }, NOW);
    return p.kind === "refuse" && p.code === "not_active";
  }));
check("13. ⭐⭐ authorize pe deja-autorizat → noop (data + nota originale păstrate)",
  planAccessChange(row({ admin_authorized_at: "2026-10-01T00:00:00Z", admin_authorized_by: "orig" }), { kind: "authorize", by: "nou" }, NOW).kind === "noop");
check("14. ⭐⭐ authorize pe admin_authorized_at malformat → apply (repară prin autorizare explicită)",
  planAccessChange(row({ admin_authorized_at: "garbage" }), { kind: "authorize", by: "m" }, NOW).kind === "apply");
check("15. ⭐⭐⭐ unauthorize pe autorizat → apply {null, null}, fără requireActive", (() => {
  const p = planAccessChange(row({ admin_authorized_at: NOW, admin_authorized_by: "m" }), { kind: "unauthorize" }, NOW);
  return p.kind === "apply" && p.patch.admin_authorized_at === null && p.patch.admin_authorized_by === null && !p.requireActive;
})());
check("16. ⭐⭐ unauthorize pe client revocat dar autorizat → apply (retragerea e mereu sigură)",
  planAccessChange(row({ status: "revoked", admin_authorized_at: NOW, admin_authorized_by: "m" }), { kind: "unauthorize" }, NOW).kind === "apply");
check("17. ⭐⭐ unauthorize pe deja-neautorizat → noop; pe inexistent → refuse not_found",
  planAccessChange(row(), { kind: "unauthorize" }, NOW).kind === "noop"
  && (() => { const p = planAccessChange(null, { kind: "unauthorize" }, NOW); return p.kind === "refuse" && p.code === "not_found"; })());

// ── (c) listare fără secret ──
check("18. ⭐⭐⭐ ADMIN_CLIENT_COLUMNS NU conține secret_hash și nici '*'",
  !/secret/.test(ADMIN_CLIENT_COLUMNS) && !/\*/.test(ADMIN_CLIENT_COLUMNS));
check("19. ⭐⭐ ADMIN_CLIENT_COLUMNS conține coloanele cerute de §4.1",
  ["client_id", "user_id", "name", "plan", "scopes", "status", "created_at", "admin_authorized_at", "admin_authorized_by"]
    .every(c => ADMIN_CLIENT_COLUMNS.split(",").map(s => s.trim()).includes(c)));
check("20. ⭐⭐⭐ formatClientRow nu scurge un secret_hash strecurat în rând", (() => {
  const leaky = { ...row(), secret_hash: "deadbeefSECRET" } as unknown as AdminClientRow;
  return !formatClientRow(leaky).includes("deadbeefSECRET");
})());
check("21. ⭐⭐ formatClientRow: usable=no neautorizat, usable=yes activ+autorizat, usable=no revocat+autorizat",
  formatClientRow(row()).endsWith("usable=no")
  && formatClientRow(row({ admin_authorized_at: NOW })).endsWith("usable=yes")
  && formatClientRow(row({ status: "revoked", admin_authorized_at: NOW })).endsWith("usable=no"));
check("22. ⭐ formatClientRow: o singură linie chiar cu newline în name/notă",
  !/\n/.test(formatClientRow(row({ name: "a\nb", admin_authorized_by: "x\ny" }))));
check("23. ⭐ coduri de ieșire distincte 0/1/2/3",
  new Set([EXIT_OK, EXIT_BACKEND, EXIT_USAGE, EXIT_REFUSED]).size === 4 && EXIT_OK === 0 && EXIT_BACKEND === 1 && EXIT_USAGE === 2 && EXIT_REFUSED === 3);

// ── (d) guard de sursă pe script ──
{
  const src = readFileSync("scripts/adminClientAccess.ts", "utf8");
  check("24. ⭐⭐⭐ scriptul citește doar ADMIN_CLIENT_COLUMNS (fără select(\"*\"), fără secret_hash)",
    /select\(ADMIN_CLIENT_COLUMNS\)/.test(src) && !/select\("\*"\)/.test(src) && !/secret_hash/.test(src.replace(/^\s*\*.*$/gm, "")));
  check("25. ⭐⭐⭐ update-ul e confirmat (.select(...).maybeSingle()) și 0 rânduri → EXIT_REFUSED",
    /update\(plan\.patch\)[\s\S]{0,200}\.select\(ADMIN_CLIENT_COLUMNS\)\.maybeSingle\(\)/.test(src)
    && /if \(!data\)[\s\S]{0,200}return EXIT_REFUSED/.test(src));
  check("26. ⭐⭐ authorize adaugă .eq(\"status\",\"active\") la UPDATE (requireActive)",
    /if \(plan\.requireActive\) q = q\.eq\("status", "active"\)/.test(src));
  check("27. ⭐⭐ supabase-admin importat DINAMIC după verificarea env-ului; .env.local NU se încarcă",
    /await import\("\.\.\/lib\/db\/supabase-admin"\)/.test(src) && !/^import[^\n]*supabase-admin/m.test(src)
    && !/^import[^\n]*(dotenv|inspectBootstrap)/m.test(src) && !/config\(\{\s*path/.test(src));
  check("28. ⭐⭐ scriptul nu scrie status și nu șterge rânduri",
    !/update\(\{[^}]*status/.test(src) && !/\.delete\(/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
