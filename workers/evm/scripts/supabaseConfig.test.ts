/**
 * scripts/supabaseConfig.test.ts — E26 (leaf pur resolveSupabaseCreds).
 *
 * Decide dacă avem credențiale Supabase valide. Ambele necesare, ne-goale după trim.
 * Orice lipsă / whitespace / non-string → null (client dezactivat → worker degradat, nu crash).
 */
import { resolveSupabaseCreds } from "../src/infra/supabaseConfig";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

function main(): void {
  console.log("E26 leaf — resolveSupabaseCreds(env)");

  // ambele prezente → creds trim-uite
  {
    const c = resolveSupabaseCreds({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc_key_123" });
    check("1. ambele prezente → creds", c !== null && c.url === "https://x.supabase.co" && c.key === "svc_key_123");
  }
  // lipsă
  check("2. url lipsă (undefined) → null", resolveSupabaseCreds({ SUPABASE_SERVICE_ROLE_KEY: "k" }) === null);
  check("3. key lipsă (undefined) → null", resolveSupabaseCreds({ NEXT_PUBLIC_SUPABASE_URL: "u" }) === null);
  check("4. ambele lipsă → null", resolveSupabaseCreds({}) === null);
  // gol / whitespace
  check("5. url gol → null", resolveSupabaseCreds({ NEXT_PUBLIC_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "k" }) === null);
  check("6. key gol → null", resolveSupabaseCreds({ NEXT_PUBLIC_SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "" }) === null);
  check("7. url whitespace-only → null", resolveSupabaseCreds({ NEXT_PUBLIC_SUPABASE_URL: "   ", SUPABASE_SERVICE_ROLE_KEY: "k" }) === null);
  check("8. key whitespace-only → null", resolveSupabaseCreds({ NEXT_PUBLIC_SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "\t\n " }) === null);
  // trim
  {
    const c = resolveSupabaseCreds({ NEXT_PUBLIC_SUPABASE_URL: "  https://y.co  ", SUPABASE_SERVICE_ROLE_KEY: " key " });
    check("9. trim pe url + key", c !== null && c.url === "https://y.co" && c.key === "key");
  }
  // non-string (defensiv, deși tipizat)
  check("10. url non-string → null", resolveSupabaseCreds({ NEXT_PUBLIC_SUPABASE_URL: 123 as unknown as string, SUPABASE_SERVICE_ROLE_KEY: "k" }) === null);
  check("11. key non-string → null", resolveSupabaseCreds({ NEXT_PUBLIC_SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: null as unknown as string }) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
