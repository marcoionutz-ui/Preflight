/**
 * lib/db/grantRevoke.test.ts — lot OAuth staging §6 (revocarea din dashboard, DOAR conexiunile Claude).
 *
 * (a) tranziția `active → revoked`, `revoked → revoked`; (b) `selectClaudeRegistrationIds` = `isClaudeCimdClientId` pe
 * registration-uri, fail-closed pe rânduri malformate / listă trunchiată; (c) planul UPDATE-ului: user + active + DOAR
 * id-uri Claude, userId non-uuid refuzat, listă goală → nothing; (d) clasificarea răspunsului: idempotent, fail-closed pe
 * rânduri incoerente; (e) SET MIXT pe un DB fals: doar grant-urile active ale userului pe registration-uri Claude sunt
 * revocate — alt public, legacy/confidențial, alt user, deja revocat rămân neatinse; al doilea apel → 0; (f) guard de
 * sursă: I/O-ul real, server action-ul (sesiune verificată), UI-ul. Modulul NU încarcă supabase-admin la import.
 * cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";
import {
  nextGrantStatus, selectClaudeRegistrationIds, planUserGrantRevoke, classifyGrantRevokeResult,
  revokeClaudeGrantsForUser, REGISTRATION_READ_LIMIT, type GrantRevokeIo, type GrantRevokePlan,
} from "./grantRevoke";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const U  = "11111111-2222-4333-8444-555555555555";
const U2 = "99999999-2222-4333-8444-555555555555";
const CL_AI  = "https://claude.ai/oauth/claude-mcp-client-metadata";
const CL_COM = "https://claude.com/oauth/claude-mcp-client-metadata";
const OTHER  = "https://other.example/oauth/meta";
type Plan = Extract<GrantRevokePlan, { kind: "plan" }>;
const PLAN: Plan = { kind: "plan", filter: { user_id: U, status: "active", registration_ids: ["r-ai"] }, patch: { status: "revoked" } };
const rev = (grant_id: string, over: Record<string, unknown> = {}) =>
  ({ grant_id, user_id: U, registration_id: "r-ai", client_id: CL_AI, status: "revoked", ...over });

interface FakeGrant { grant_id: string; user_id: string; registration_id: string; client_id: string; status: string }
interface FakeReg { registration_id: string; client_id: string; client_type: string }

/** DB fals care respectă EXACT filtrele I/O-ului real (client_type=public; user_id + status + registration_id IN). */
function fakeDb(regs: FakeReg[], grants: FakeGrant[]): { io: GrantRevokeIo; grants: () => FakeGrant[]; updates: () => number } {
  let state = grants.map(g => ({ ...g }));
  let updates = 0;
  return {
    io: {
      async readPublicRegistrations() {
        return { data: regs.filter(r => r.client_type === "public").map(r => ({ registration_id: r.registration_id, client_id: r.client_id })), error: null };
      },
      async revokeGrants(p) {
        updates++;
        const hit = state.filter(g => g.user_id === p.filter.user_id && g.status === p.filter.status
          && p.filter.registration_ids.includes(g.registration_id));
        state = state.map(g => hit.includes(g) ? { ...g, status: p.patch.status } : g);
        return { data: hit.map(g => ({ ...g, status: p.patch.status })), error: null };
      },
    },
    grants:  () => state,
    updates: () => updates,
  };
}

async function main(): Promise<void> {
console.log("Lot OAuth staging §6 — grantRevoke (doar conexiunile Claude)");

// ── (a) tranziții ──
check("1. ⭐⭐⭐ active → revoked (schimbat)", (() => { const t = nextGrantStatus("active"); return t.changed && t.to === "revoked"; })());
check("2. ⭐⭐ revoked → revoked (neschimbat, idempotent; fără drum înapoi la active)",
  (() => { const t = nextGrantStatus("revoked"); return !t.changed && t.to === "revoked"; })());

// ── (b) registration-urile Claude ──
check("3. ⭐⭐⭐ selectClaudeRegistrationIds: doar claude.ai / claude.com (alt public, legacy tp_, http, port → ignorate)", (() => {
  const r = selectClaudeRegistrationIds([
    { registration_id: "r-ai", client_id: CL_AI }, { registration_id: "r-com", client_id: CL_COM },
    { registration_id: "r-other", client_id: OTHER }, { registration_id: "r-legacy", client_id: "tp_0123" },
    { registration_id: "r-http", client_id: "http://claude.ai/x" }, { registration_id: "r-port", client_id: "https://claude.ai:8443/x" },
    { registration_id: "r-user", client_id: "https://u@claude.ai/x" }, { registration_id: "r-suffix", client_id: "https://claude.ai.evil.com/x" },
  ], null);
  return r.status === "ok" && r.ids.join(",") === "r-ai,r-com";
})());
check("4. ⭐⭐ selectClaudeRegistrationIds: listă goală → ok []", (() => {
  const r = selectClaudeRegistrationIds([], null); return r.status === "ok" && r.ids.length === 0;
})());
check("5. ⭐⭐⭐ selectClaudeRegistrationIds: eroare / non-listă / rând malformat → unavailable (fail-closed)",
  selectClaudeRegistrationIds(null, { message: "down" }).status === "unavailable"
  && [null, undefined, {}, "x"].every(d => selectClaudeRegistrationIds(d, null).status === "unavailable")
  && selectClaudeRegistrationIds([null], null).status === "unavailable"
  && selectClaudeRegistrationIds([{ registration_id: "", client_id: CL_AI }], null).status === "unavailable"
  && selectClaudeRegistrationIds([{ registration_id: "r", client_id: 7 }], null).status === "unavailable");
check("6. ⭐⭐ selectClaudeRegistrationIds: listă la plafon (posibil trunchiată) → unavailable",
  selectClaudeRegistrationIds(Array.from({ length: REGISTRATION_READ_LIMIT }, (_, i) => ({ registration_id: "r" + i, client_id: OTHER })), null).status === "unavailable");

// ── (c) plan ──
check("7. ⭐⭐⭐ plan: filtru user_id + status=active + registration_ids (dedup), patch doar status=revoked", (() => {
  const p = planUserGrantRevoke(U, ["r-ai", "r-com", "r-ai"]);
  return p.kind === "plan" && p.filter.user_id === U && p.filter.status === "active"
    && p.filter.registration_ids.join(",") === "r-ai,r-com" && p.patch.status === "revoked" && Object.keys(p.patch).length === 1;
})());
check("8. ⭐⭐⭐ plan: niciun registration Claude → nothing (fără UPDATE cu IN gol)", planUserGrantRevoke(U, []).kind === "nothing");
check("9. ⭐⭐⭐ plan: userId gol / non-uuid / non-string → refuse",
  ["", " ", "abc", `${U} `, "*"].every(v => planUserGrantRevoke(v, ["r-ai"]).kind === "refuse")
  && planUserGrantRevoke(undefined, ["r-ai"]).kind === "refuse" && planUserGrantRevoke(42, ["r-ai"]).kind === "refuse");

// ── (d) clasificarea răspunsului UPDATE ──
check("10. ⭐⭐⭐ rânduri revocate ale userului pe registration Claude din plan → revoked count + grantIds", (() => {
  const r = classifyGrantRevokeResult([rev("g1"), rev("g2")], null, PLAN);
  return r.status === "revoked" && r.count === 2 && r.grantIds.join(",") === "g1,g2";
})());
check("11. ⭐⭐⭐ IDEMPOTENT: 0 rânduri → revoked count=0", (() => {
  const r = classifyGrantRevokeResult([], null, PLAN); return r.status === "revoked" && r.count === 0;
})());
check("12. ⭐⭐⭐ eroare / non-listă → unavailable",
  classifyGrantRevokeResult(null, { message: "down" }, PLAN).status === "unavailable"
  && [null, undefined, {}].every(d => classifyGrantRevokeResult(d, null, PLAN).status === "unavailable"));
check("13. ⭐⭐⭐ rând al altui user / nerevocat / registration în afara planului / client_id ne-Claude / fără grant_id → unavailable",
  classifyGrantRevokeResult([rev("g1", { user_id: U2 })], null, PLAN).status === "unavailable"
  && classifyGrantRevokeResult([rev("g1", { status: "active" })], null, PLAN).status === "unavailable"
  && classifyGrantRevokeResult([rev("g1", { registration_id: "r-other" })], null, PLAN).status === "unavailable"
  && classifyGrantRevokeResult([rev("g1", { client_id: OTHER })], null, PLAN).status === "unavailable"
  && classifyGrantRevokeResult([rev("", {})], null, PLAN).status === "unavailable"
  && classifyGrantRevokeResult([null], null, PLAN).status === "unavailable");

// ── (e) SET MIXT pe DB fals ──
{
  const regs: FakeReg[] = [
    { registration_id: "r-ai",     client_id: CL_AI,     client_type: "public" },
    { registration_id: "r-com",    client_id: CL_COM,    client_type: "public" },
    { registration_id: "r-other",  client_id: OTHER,     client_type: "public" },
    { registration_id: "r-legacy", client_id: "tp_0123", client_type: "confidential" },
  ];
  const grants: FakeGrant[] = [
    { grant_id: "g-ai",      user_id: U,  registration_id: "r-ai",     client_id: CL_AI,     status: "active" },
    { grant_id: "g-com",     user_id: U,  registration_id: "r-com",    client_id: CL_COM,    status: "active" },
    { grant_id: "g-other",   user_id: U,  registration_id: "r-other",  client_id: OTHER,     status: "active" },
    { grant_id: "g-legacy",  user_id: U,  registration_id: "r-legacy", client_id: "tp_0123", status: "active" },
    { grant_id: "g-u2",      user_id: U2, registration_id: "r-ai",     client_id: CL_AI,     status: "active" },
    { grant_id: "g-old",     user_id: U,  registration_id: "r-ai",     client_id: CL_AI,     status: "revoked" },
  ];
  const db = fakeDb(regs, grants);
  const first = await revokeClaudeGrantsForUser(U, db.io);
  const st = (id: string) => db.grants().find(g => g.grant_id === id)?.status;
  check("14. ⭐⭐⭐ set mixt: revocă EXACT g-ai + g-com (count=2)",
    first.status === "revoked" && first.count === 2 && [...first.grantIds].sort().join(",") === "g-ai,g-com"
    && st("g-ai") === "revoked" && st("g-com") === "revoked");
  check("15. ⭐⭐⭐ set mixt: alt public (g-other) și legacy/confidențial (g-legacy) rămân ACTIVE",
    st("g-other") === "active" && st("g-legacy") === "active");
  check("16. ⭐⭐⭐ set mixt: grant-ul Claude al ALTUI user (g-u2) rămâne activ; g-old rămâne revoked",
    st("g-u2") === "active" && st("g-old") === "revoked");
  const second = await revokeClaudeGrantsForUser(U, db.io);
  check("17. ⭐⭐⭐ idempotent: al doilea apel → count=0, nimic altceva schimbat",
    second.status === "revoked" && second.count === 0 && st("g-other") === "active" && st("g-legacy") === "active" && st("g-u2") === "active");

  const noClaude = fakeDb([{ registration_id: "r-other", client_id: OTHER, client_type: "public" }],
    [{ grant_id: "g-other", user_id: U, registration_id: "r-other", client_id: OTHER, status: "active" }]);
  const nc = await revokeClaudeGrantsForUser(U, noClaude.io);
  check("18. ⭐⭐⭐ fără registration Claude → count=0, ZERO UPDATE-uri, grant-ul altui client neatins",
    nc.status === "revoked" && nc.count === 0 && noClaude.updates() === 0 && noClaude.grants()[0].status === "active");
}

// ── (e2) orchestrare: refuz / indisponibil ──
{
  let reads = 0;
  const io: GrantRevokeIo = {
    async readPublicRegistrations() { reads++; return { data: [], error: null }; },
    async revokeGrants() { return { data: [], error: null }; },
  };
  const bad = await revokeClaudeGrantsForUser("not-a-uuid", io);
  check("19. ⭐⭐⭐ userId invalid → refused, ZERO I/O", bad.status === "refused" && reads === 0);
  let updated = 0;
  const regDown = await revokeClaudeGrantsForUser(U, {
    async readPublicRegistrations() { return { data: null, error: { message: "timeout" } }; },
    async revokeGrants() { updated++; return { data: [], error: null }; },
  });
  check("20. ⭐⭐⭐ citirea registration-urilor eșuează → unavailable, UPDATE NEapelat", regDown.status === "unavailable" && updated === 0);
  const updDown = await revokeClaudeGrantsForUser(U, {
    async readPublicRegistrations() { return { data: [{ registration_id: "r-ai", client_id: CL_AI }], error: null }; },
    async revokeGrants() { return { data: null, error: { message: "timeout" } }; },
  });
  check("21. ⭐⭐ UPDATE eșuează → unavailable", updDown.status === "unavailable");
}

// ── (f) guard de sursă ──
{
  const src = readFileSync("lib/db/grantRevoke.ts", "utf8");
  check("22. ⭐⭐⭐ predicatul Claude e importat din cimdDocValidate (o singură regulă, fără parser local)",
    /import \{ isClaudeCimdClientId \} from "\.\.\/oauth\/cimdDocValidate"/.test(src) && !/new URL\(/.test(src) && !/\.hostname/.test(src));
  check("23. ⭐⭐⭐ I/O real: registration-uri publice (registration_id, client_id) cu plafon",
    /\.from\(REGISTRATIONS_TABLE\)\s*\.select\("registration_id, client_id"\)\s*\.eq\("client_type", "public"\)\s*\.limit\(REGISTRATION_READ_LIMIT\)/.test(src));
  check("24. ⭐⭐⭐ I/O real: UPDATE oauth_grants filtrat pe user_id + status + registration_id IN, cu RETURNING",
    /\.from\(GRANT_REVOKE_TABLE\)\s*\.update\(plan\.patch\)\s*\.eq\("user_id", plan\.filter\.user_id\)\s*\.eq\("status", plan\.filter\.status\)\s*\.in\("registration_id", plan\.filter\.registration_ids\)\s*\.select\(GRANT_REVOKE_RETURNING\)/.test(src));
  check("25. ⭐⭐ supabase-admin încărcat DINAMIC (testul importă modulul fără env)",
    /await import\("\.\/supabase-admin"\)/.test(src) && !/^import[^\n]*supabase-admin/m.test(src));

  const actions = readFileSync("app/dashboard/actions.ts", "utf8");
  const m = actions.match(/export async function revokeClaudeAccessAction[\s\S]*?\n\}/);
  const a = m ? m[0] : "";
  check("26. ⭐⭐⭐ server action: sesiune verificată ÎNAINTE de revocare, userId din sesiune, doar Claude",
    a.length > 0 && a.indexOf("auth.getUser()") > -1 && a.indexOf("auth.getUser()") < a.indexOf("revokeClaudeGrantsForUser(")
    && /revokeClaudeGrantsForUser\(user\.id\)/.test(a) && /if \(!user\) return \{ ok: false/.test(a));
  check("27. ⭐⭐ server action: fără parametri din browser", /revokeClaudeAccessAction\(\)/.test(actions));

  const ui = readFileSync("app/dashboard/dashboard-client.tsx", "utf8");
  check("28. ⭐⭐ UI: data-testid stabile (revoke-claude-access + revoke-result) + eticheta „Revoke Claude's access”",
    /data-testid="revoke-claude-access"/.test(ui) && /data-testid="revoke-result"/.test(ui) && /"Revoke Claude's access"/.test(ui));
  check("29. ⭐⭐ UI: rezultatul spune câte conexiuni Claude au fost revocate",
    /Revoked \$\{revoke\.revoked\} Claude connection/.test(ui) && /0 revoked/.test(ui));
  check("30. ⭐⭐ UI: fără window.confirm pe revocare (Playwright închide dialogurile implicit)", (() => {
    const h = ui.match(/async function handleRevokeClaude[\s\S]*?\n {2}\}/);
    return !!h && !/confirm\(/.test(h[0]);
  })());

  const page = readFileSync("app/dashboard/page.tsx", "utf8");
  check("31. ⭐⭐⭐ dashboard: fără auto-provizionare (createOAuthClient nu mai e chemat)", !/createOAuthClient\(/.test(page));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
