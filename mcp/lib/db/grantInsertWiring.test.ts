/**
 * lib/db/grantInsertWiring.test.ts — PH-2 step 10.3b-v frunză 2b (orchestrarea `resolveGrantInsert`, wiring cu fake-uri).
 *
 * Testăm orchestrarea PURĂ `resolveGrantInsert` (din grantInsert.ts) cu `exec`/`getGrant` fake — NU importăm din
 * `ph2Reads` (care ar încărca `supabase-admin` → `createClient` la load → „supabaseUrl required" fără env). Verificăm:
 * insert → pe eroare read-back pe `grant.grant_id` → `decideGrantInsertOutcome`; pe succes NU se face read-back; `exec`
 * primește `buildGrantInsertRow(grant)`. + source-guard TEXTUAL pe `ph2Reads.ts` (readFileSync, fără import): wrapper-ul
 * `insertGrant` leagă `resolveGrantInsert` cu insert real în `oauth_grants` + `getGrantById`.
 */
import { readFileSync } from "node:fs";
import { resolveGrantInsert } from "./grantInsert";
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
    resource: "https://preflight.app/api/mcp", scopes: ["read:all"], entitlement_version: 3,
    nowIso: "2026-01-01T00:00:00.000Z",
  });
  if (!r.ok) throw new Error("fixture: " + r.error);
  return { ...r.grant, ...over };
}
const G = mkGrant();
const rowOf = (g: OAuthGrant) => ({
  grant_id: g.grant_id, registration_id: g.registration_id, client_id: g.client_id, user_id: g.user_id,
  resource: g.resource, scopes: [...g.scopes], entitlement_version: g.entitlement_version, status: g.status, created_at: g.created_at,
});

function fakeExec(res: { data: unknown; error: { message?: string } | null }) {
  const calls: Record<string, unknown>[] = [];
  const exec = async (row: Record<string, unknown>) => { calls.push(row); return res; };
  return { exec, calls };
}
function fakeGetGrant(res: GrantLookup) {
  const ids: string[] = [];
  const getGrant = async (id: string) => { ids.push(id); return res; };
  return { getGrant, ids };
}
const found = (g: OAuthGrant): GrantLookup => ({ status: "found", grant: g });
const run = (grant: OAuthGrant, ex: { exec: (r: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }> }, gg: { getGrant: (id: string) => Promise<GrantLookup> }) =>
  resolveGrantInsert({ grant, exec: ex.exec, getGrant: gg.getGrant });

async function main(): Promise<void> {
console.log("PH-2 step 10.3b-v frunză 2b — resolveGrantInsert (wiring, fake exec + getGrant)");

// ── SUCCES: rând confirmat → inserted, FĂRĂ read-back ────────────────────────────
{
  const ex = fakeExec({ data: rowOf(G), error: null });
  const gg = fakeGetGrant(found(G));
  const res = await run(G, ex, gg);
  check("1. ⭐⭐⭐ succes + rând confirmat → inserted", res.status === "inserted");
  check("2. ⭐⭐⭐ pe succes NU se face read-back (getGrant necheamat)", gg.ids.length === 0);
  check("3. ⭐⭐ exec a primit buildGrantInsertRow(grant)", ex.calls.length === 1 && ex.calls[0].grant_id === "g1" && JSON.stringify(ex.calls[0].scopes) === JSON.stringify(["read:all"]));
}

// ── SUCCES ambiguu: fără rând → unavailable ──────────────────────────────────────
check("4. ⭐⭐ succes fără rând întors → unavailable (ambiguu)",
  (await run(G, fakeExec({ data: null, error: null }), fakeGetGrant(found(G)))).status === "unavailable");

// ── EROARE → read-back pe grant_id → decide ──────────────────────────────────────
{
  const gg = fakeGetGrant(found(G));
  const res = await run(G, fakeExec({ data: null, error: { message: "duplicate key" } }), gg);
  check("5. ⭐⭐⭐ eroare + read-back match → already_present (idempotent)", res.status === "already_present");
  check("6. ⭐⭐⭐ read-back cheamă getGrant cu EXACT grant.grant_id", gg.ids.length === 1 && gg.ids[0] === "g1");
}
check("7. ⭐⭐⭐ eroare + read-back DIFERĂ → conflict",
  (await run(G, fakeExec({ data: null, error: { message: "dup" } }), fakeGetGrant(found(mkGrant({ user_id: "uX" }))))).status === "conflict");
check("8. ⭐⭐⭐ eroare + read-back match dar REVOCAT → revoked (persistat ≠ utilizabil)",
  (await run(G, fakeExec({ data: null, error: { message: "dup" } }), fakeGetGrant(found(mkGrant({ status: "revoked" }))))).status === "revoked");
check("9. ⭐⭐⭐ eroare + read-back not_found → unavailable (n-a aterizat)",
  (await run(G, fakeExec({ data: null, error: { message: "net" } }), fakeGetGrant({ status: "not_found" }))).status === "unavailable");
check("10. ⭐⭐ eroare + read-back unavailable → unavailable",
  (await run(G, fakeExec({ data: null, error: { message: "net" } }), fakeGetGrant({ status: "unavailable", reason: "down" }))).status === "unavailable");

// ── source-guard TEXTUAL pe ph2Reads (fără import → fără supabase-admin) ──────────
{
  let src: string | null = null;
  try { src = readFileSync("lib/db/ph2Reads.ts", "utf8"); } catch { src = null; }
  if (src === null) {
    check("11. (skip — ph2Reads.ts absent în sandbox; source-guard în WSL)", true);
  } else {
    const flat = src.replace(/\s+/g, " ");
    const execTargetsGrants = /\.from\(\s*"oauth_grants"\s*\)\s*\.insert\(/.test(flat);          // insert real în oauth_grants
    const wrapperUsesResolve = /insertGrant\([^)]*\)\s*:\s*Promise<InsertGrantResult>\s*\{\s*return resolveGrantInsert\(/.test(flat); // wrapper subțire
    const wiresExecAndReadback = /exec:\s*defaultGrantInsertExec/.test(flat) && /getGrant:\s*getGrantById/.test(flat);
    check("11. ⭐⭐⭐ ph2Reads: insertGrant = resolveGrantInsert(exec=insert oauth_grants, getGrant=getGrantById)",
      execTargetsGrants && wrapperUsesResolve && wiresExecAndReadback);
    if (!execTargetsGrants)     console.log("     insert oauth_grants negăsit");
    if (!wrapperUsesResolve)    console.log("     insertGrant nu deleagă la resolveGrantInsert");
    if (!wiresExecAndReadback)  console.log("     exec/getGrant nelegate la defaultGrantInsertExec/getGrantById");
  }
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main().then(() => { if (failed > 0) process.exit(1); });
