/**
 * lib/db/grantReadWiring.test.ts — PH-2 step 10.5a frunza 2 (GUARD de sursă pe cablarea `getGrantById`, fără Supabase).
 *
 * „Verde pe clasificatorul pur ≠ I/O corect cablat": verificăm că `getGrantById` din `ph2Reads.ts` (a) citește din
 * tabelul `oauth_grants`, (b) filtrează pe `grant_id`, (c) folosește `.maybeSingle()` (0 rânduri → data:null distinct
 * de eroare), (d) selectează EXPLICIT coloanele (incl. `created_at`, altfel `found` = OAuthGrant type-unsound),
 * (e) e învelit în try/catch → `unavailable` (fail-closed, NU 401), (f) dispecerizează prin `classifyGrantLookup`
 * (frunza 1, pură). cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 step 10.5a — cablare getGrantById (guard de sursă)");

const src = readFileSync("lib/db/ph2Reads.ts", "utf8");

// izolează corpul funcției getGrantById (de la semnătură până la următorul `export ` sau EOF)
const m = src.match(/export async function getGrantById[\s\S]*?(?=\nexport |\n?$)/);
const fn = m ? m[0] : "";

// ── existență + semnătură ────────────────────────────────────────────────────────
check("1. ⭐⭐⭐ ph2Reads exportă getGrantById(grantId): Promise<GrantLookup>",
  /export async function getGrantById\(\s*grantId:\s*string\s*\):\s*Promise<GrantLookup>/.test(src));
check("2. ⭐⭐ importă classifyGrantLookup + tipul GrantLookup din ./grantLookup",
  /import\s*\{[^}]*classifyGrantLookup[^}]*\btype\s+GrantLookup[^}]*\}\s*from\s*"\.\/grantLookup"/.test(src));

// ── corpul funcției: tabel + filtru + maybeSingle ─────────────────────────────────
check("3. ⭐⭐⭐ citește din tabelul oauth_grants", /\.from\("oauth_grants"\)/.test(fn));
check("4. ⭐⭐⭐ filtrează pe grant_id (.eq(\"grant_id\", grantId))", /\.eq\("grant_id",\s*grantId\)/.test(fn));
check("5. ⭐⭐⭐ folosește .maybeSingle() (0 rânduri → not_found, distinct de eroare)", /\.maybeSingle\(\)/.test(fn));

// ── select EXPLICIT pe toate coloanele OAuthGrant (incl. created_at) ───────────────
check("6. ⭐⭐ select explicit (NU select('*'))", /\.select\("/.test(fn) && !/\.select\("\*"\)/.test(fn) && !/\.select\('\*'\)/.test(fn));
for (const col of ["grant_id", "registration_id", "client_id", "user_id", "resource", "scopes", "entitlement_version", "status", "created_at"]) {
  const selMatch = fn.match(/\.select\("([^"]*)"\)/);
  const cols = selMatch ? selMatch[1] : "";
  const stars = col === "created_at" ? "⭐⭐⭐" : "⭐";
  check(`7.${col} ${stars} coloana ${col} cerută explicit în select`, new RegExp("\\b" + col + "\\b").test(cols));
}

// ── fail-closed + dispecerizare pură ──────────────────────────────────────────────
check("8. ⭐⭐⭐ throw (rețea) prins → unavailable (fail-closed, NU 401)",
  /catch\s*\(err\)[\s\S]{0,140}status:\s*"unavailable"/.test(fn));
check("9. ⭐⭐⭐ dispecerizează prin classifyGrantLookup(data, error) (nu re-implementează discriminarea)",
  /return\s+classifyGrantLookup\(data,\s*error\)/.test(fn));
check("10. ⭐ nu ratează niciun return pe calea normală (return în try + return în catch)",
  (fn.match(/return\s+classifyGrantLookup/g) || []).length === 1 && /catch/.test(fn));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
