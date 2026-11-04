/**
 * lib/config/adminScriptTarget.test.ts — ținta explicită a scripturilor admin (lot OAuth staging, review cgpt P1).
 * Plus gardă de sursă: cele trei scripturi admin nu mai încarcă `.env.local` și decid ținta ÎNAINTE de importul
 * clientului administrativ.
 */
import { readFileSync } from "node:fs";
import { vetAdminScriptTarget, type AdminTargetVerdict } from "./adminScriptTarget";

let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name}`); failed++; }
}

console.log("Lot OAuth staging — ținta explicită a scripturilor admin");

const STG  = "abcdefghijklmnopqrst";
const PROD = "ipeyogzfgqypfkujraxm";
const OTHER = "zzzzzzzzzzzzzzzzzzzz";
const jwt = (payload: Record<string, unknown>): string =>
  ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");
const v = (o: Partial<Parameters<typeof vetAdminScriptTarget>[0]>): AdminTargetVerdict => vetAdminScriptTarget({
  supabaseUrl: `https://${STG}.supabase.co`, serviceKey: jwt({ ref: STG, role: "service_role" }), expectRef: STG,
  mode: "staging_only", prodRefs: [PROD], ...o,
});
const reason = (r: AdminTargetVerdict): string => (r.ok ? "ok" : r.reason);

const good = v({});
check("1. staging explicit + JWT cu ref/rol corecte → ok, key verificată", good.ok && good.ref === STG && good.key_ref === "verified" && !good.production);
check("2. slash final acceptat", v({ supabaseUrl: `https://${STG}.supabase.co/` }).ok);
check("3. cheie sb_secret_ (fără ref) → ok, unverifiable", (() => { const r = v({ serviceKey: "sb_secret_xxxxxxxxxxxx" }); return r.ok && r.key_ref === "unverifiable"; })());
check("4. fără URL → url_missing", reason(v({ supabaseUrl: undefined })) === "url_missing");
check("5. fără cheie → key_missing", reason(v({ serviceKey: "  " })) === "key_missing");
check("6. fără EXPECT_SUPABASE_REF → expect_ref_missing", reason(v({ expectRef: undefined })) === "expect_ref_missing");
check("7. ref declarat malformat → expect_ref_malformed", reason(v({ expectRef: "ABC" })) === "expect_ref_malformed");
check("8. URL ≠ ref declarat → url_ref_mismatch", reason(v({ expectRef: OTHER })) === "url_ref_mismatch");
check("9. http → url_not_clean_origin", reason(v({ supabaseUrl: `http://${STG}.supabase.co` })) === "url_not_clean_origin");
check("10. cale / query / port / userinfo → url_not_clean_origin",
  [`https://${STG}.supabase.co/rest/v1`, `https://${STG}.supabase.co/?x=1`, `https://${STG}.supabase.co:8443`, `https://u:p@${STG}.supabase.co`]
    .every((u) => reason(v({ supabaseUrl: u })) === "url_not_clean_origin"));
check("11. host non-Supabase → url_not_supabase_cloud", reason(v({ supabaseUrl: "https://db.example.com" })) === "url_not_supabase_cloud");
check("12. JWT cu alt ref → key_ref_mismatch", reason(v({ serviceKey: jwt({ ref: OTHER, role: "service_role" }) })) === "key_ref_mismatch");
check("13. JWT anon → key_role_not_service", reason(v({ serviceKey: jwt({ ref: STG, role: "anon" }) })) === "key_role_not_service");
check("14. ⭐⭐⭐ producția, staging_only → production_refused (chiar declarată explicit)",
  reason(v({ supabaseUrl: `https://${PROD}.supabase.co`, expectRef: PROD, serviceKey: jwt({ ref: PROD, role: "service_role" }) })) === "production_refused");
check("15. producția, explicit_any, declarată explicit → ok cu production=true", (() => {
  const r = v({ mode: "explicit_any", supabaseUrl: `https://${PROD}.supabase.co`, expectRef: PROD, serviceKey: jwt({ ref: PROD, role: "service_role" }) });
  return r.ok && r.production;
})());
check("16. producția, explicit_any, dar ref declarat = staging → url_ref_mismatch",
  reason(v({ mode: "explicit_any", supabaseUrl: `https://${PROD}.supabase.co`, expectRef: STG })) === "url_ref_mismatch");

// ── Gardă de sursă pe cele trei scripturi ─────────────────────────────────────────────────────────────
const scripts: Array<[string, "staging_only" | "explicit_any"]> = [
  ["scripts/provisionCimdClient.ts", "staging_only"],
  ["scripts/createBetaInvite.ts", "staging_only"],
  ["scripts/adminClientAccess.ts", "explicit_any"],
];
for (const [path, mode] of scripts) {
  const src = readFileSync(path, "utf8");
  check(`17. ${path}: NU încarcă .env.local (fără inspectBootstrap / dotenv)`, !/import\s+["']\.\/inspectBootstrap["']|from\s+["']\.\/inspectBootstrap["']|from "dotenv"|require\("dotenv"\)/.test(src));
  check(`18. ${path}: vetAdminScriptTarget cu mode ${mode} și EXPECT_SUPABASE_REF`,
    new RegExp(`vetAdminScriptTarget\\([\\s\\S]{0,300}EXPECT_SUPABASE_REF[\\s\\S]{0,200}mode:\\s*"${mode}"`).test(src));
  const iVet = src.indexOf("vetAdminScriptTarget(");
  const iImp = src.indexOf('await import("../lib/db/');
  check(`19. ${path}: verificarea țintei vine ÎNAINTE de importul clientului administrativ`, iVet > -1 && iImp > iVet);
}

if (failed > 0) { console.log(`\n${failed} verificări picate`); process.exit(1); }
console.log("\ntoate verificările au trecut");
