/**
 * lib/oauth/inviteWiring.test.ts — lotul OAuth staging, §4 / §4.3 (GUARD de sursă: invitații + migrarea 0002).
 *
 * Citește ca TEXT (nu importă — rutele depind de next/headers și supabase-admin): `app/signup/invite/route.ts`,
 * `app/auth/callback/route.ts`, `lib/db/betaInvites.ts`, `lib/db/ph2Reads.ts`, `scripts/createBetaInvite.ts` și
 * `supabase/migrations/0002_beta_invites_access_expiry.sql`. Rulat din `mcp/` (ca celelalte *Wiring.test.ts).
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

function main(): void {
console.log("OAuth staging §4 — invitații: guard de sursă (rute, I/O, migrarea 0002)");

const inv  = readFileSync("app/signup/invite/route.ts", "utf8");
const cb   = readFileSync("app/auth/callback/route.ts", "utf8");
const io   = readFileSync("lib/db/betaInvites.ts", "utf8");
const rd   = readFileSync("lib/db/ph2Reads.ts", "utf8");
const scr  = readFileSync("scripts/createBetaInvite.ts", "utf8");
const sql  = readFileSync("supabase/migrations/0002_beta_invites_access_expiry.sql", "utf8");

// ── /signup/invite ────────────────────────────────────────────────────────────
check("1. ⭐⭐⭐ invite: cookie DOAR pentru token bine-format", /if \(isWellFormedInviteToken\(token\)\)\s*\{\s*res\.cookies\.set\(INVITE_COOKIE, token, inviteCookieSetAttrs\(/.test(inv));
check("2. ⭐⭐⭐ invite: Secure derivat din NODE_ENV=production", /inviteCookieSetAttrs\(process\.env\.NODE_ENV === "production"\)/.test(inv));
check("3. ⭐⭐⭐ invite: 303 → /signup fără query (tokenul iese din URL)", /NextResponse\.redirect\(`\$\{origin\}\/signup`,\s*303\)/.test(inv));
check("4. ⭐⭐ invite: no-store + no-referrer; origine canonică", /"Cache-Control", "no-store"/.test(inv) && /"Referrer-Policy", "no-referrer"/.test(inv)
  && /resolveBaseUrl\(request\.headers,\s*process\.env\)/.test(inv));
check("5. ⭐⭐⭐ invite: tokenul nu e logat", !/console\.[a-z]+\([^)]*token\b/.test(inv.replace(/token absent/g, "")));

// ── /auth/callback ────────────────────────────────────────────────────────────
check("6. ⭐⭐⭐ callback: răscumpărarea vine DUPĂ schimbul reușit și ÎNAINTE de redirectul final", (() => {
  const iEx  = cb.indexOf("exchangeCodeForSession(code)");
  const iErr = cb.indexOf("/login?error=auth_failed`", iEx);
  const iRed = cb.indexOf("await redeemInviteFromCookie(");
  const iPlan = cb.indexOf("planCallbackRedirect(isResourceOwnerAuthorizeEnabled");
  return iEx > -1 && iErr > iEx && iRed > iErr && iPlan > iRed;
})());
check("7. ⭐⭐⭐ callback: cookie șters ÎNAINTE de decizie (Max-Age 0, același path)", (() => {
  const iClr  = cb.indexOf("cookieStore.set(INVITE_COOKIE, \"\", inviteCookieClearAttrs(");
  const iPlan = cb.indexOf("planCallbackInviteRedemption(");
  return iClr > -1 && iPlan > iClr;
})());
check("8. ⭐⭐⭐ callback: helperul e în try/catch total (un eșec nu rupe login-ul)",
  /async function redeemInviteFromCookie[\s\S]*?\{\s*try \{[\s\S]*?\} catch \{[\s\S]*?\}\s*\}/.test(cb));
check("9. ⭐⭐⭐ callback: răscumpărare prin redeemBetaInvite(tokenHash, userId, emailNormalized) + planInviteRedeem",
  /planInviteRedeem\(await redeemBetaInvite\(plan\.tokenHash, plan\.userId, plan\.emailNormalized\)\)/.test(cb));
check("10. ⭐⭐ callback: exchange tot o singură dată", count(cb, /exchangeCodeForSession\(/g) === 1);
check("11. ⭐⭐ callback: logurile de invitație nu conțin token/hash/email", !/console\.[a-z]+\([^)]*(raw|tokenHash|emailNormalized|\.email\b)/.test(cb));
check("11b. ⭐⭐⭐ callback: DOAR PKCE — fără verifyOtp și fără token_hash (anti login-CSRF, review cgpt)",
  !/verifyOtp\(/.test(cb) && !/searchParams\.get\("token_hash"\)/.test(cb));
check("11c. ⭐⭐ callback: URL-ul cererii nu se loghează", !/console\.[a-z]+\([^)]*request\.url/.test(cb));

// ── I/O ───────────────────────────────────────────────────────────────────────
check("12. ⭐⭐⭐ betaInvites: RPC redeem_beta_invite cu argumentele numite ale funcției SQL",
  /\.rpc\("redeem_beta_invite",\s*\{\s*p_token_hash:[\s\S]*p_user_id:[\s\S]*p_email_normalized:[\s\S]*p_now:[\s\S]*p_access_days:\s*BETA_ACCESS_DAYS/.test(io));
check("13. ⭐⭐⭐ betaInvites: insert scrie DOAR hash-ul (nu tokenul)", /token_hash: hashInviteToken\(token\)/.test(io) && !/token:\s*token\s*[,}]\s*\)/.test(io));
check("14. ⭐⭐ betaInvites: fără loguri", !/console\./.test(io));
check("15. ⭐⭐⭐ ph2Reads: select-ul entitlement-ului cere access_expires_at + nowMs injectat în clasificator",
  /entitlement_version, access_expires_at"\)/.test(rd) && /classifyEntitlementLookup\(data, error, nowMs\)/.test(rd));

// ── script ────────────────────────────────────────────────────────────────────
check("16. ⭐⭐ script: fără .env.local (fără inspectBootstrap); ținta verificată înainte de importul dinamic betaInvites", (() => {
  const iVet = scr.indexOf("vetAdminScriptTarget(");
  const iDyn = scr.indexOf('await import("../lib/db/betaInvites")');
  return !/import\s+["']\.\/inspectBootstrap["']/.test(scr) && iVet > -1 && iDyn > iVet && !/^import .*betaInvites/m.test(scr);
})());
check("17. ⭐⭐ script: refuză producția (assertCanaryIsolation) și are codurile 2/3", /assertCanaryIsolation\(/.test(scr) && /fail\(2,/.test(scr) && /\? 2 : 3/.test(scr));

// ── migrarea 0002 ─────────────────────────────────────────────────────────────
check("18. ⭐⭐⭐ sql: begin/commit", /^begin;$/m.test(sql) && /^commit;$/m.test(sql));
check("19. ⭐⭐⭐ sql: beta_invites + token_hash unic + forma hex64", /create table public\.beta_invites/.test(sql)
  && /constraint beta_invites_token_hash_uk\s+unique \(token_hash\)/.test(sql) && /token_hash ~ '\^\[0-9a-f\]\{64\}\$'/.test(sql));
check("20. ⭐⭐ sql: redeemed_by FK auth.users on delete set null + expirare > creare",
  /redeemed_by\s+uuid\s+null references auth\.users\(id\) on delete set null/.test(sql) && /check \(expires_at > created_at\)/.test(sql));
check("21. ⭐⭐⭐ sql: coloanele noi cu numele exacte", /add column access_expires_at timestamptz null/.test(sql)
  && /add column admin_authorized_at timestamptz null/.test(sql) && /add column admin_authorized_by text\s+null/.test(sql));
check("22. ⭐⭐⭐ sql: funcția — semnătura, plpgsql, security invoker, search_path fixat",
  /create function public\.redeem_beta_invite\(\s*p_token_hash\s+text,\s*p_user_id\s+uuid,\s*p_email_normalized\s+text,\s*p_now\s+timestamptz,\s*p_access_days\s+integer\s*\)\s*returns text\s*language plpgsql\s*security invoker\s*set search_path = public, pg_temp/.test(sql));
check("23. ⭐⭐⭐ sql: invitația blocată FOR UPDATE; entitlement nesuprascris (on conflict do nothing)",
  /where token_hash = p_token_hash\s+for update;/.test(sql) && /on conflict \(user_id\) do nothing;/.test(sql) && !/on conflict \(user_id\) do update/.test(sql));
check("24. ⭐⭐⭐ sql: planul beta free_trial / read:basic / 10 / 500 / active / p_now + zile",
  /'free_trial', array\['read:basic'\]::text\[\], 10, 500, 'active',\s*p_now \+ make_interval\(days => p_access_days\)/.test(sql));
check("25. ⭐⭐⭐ sql: toate cele 6 statusuri închise sunt întoarse",
  ["redeemed", "not_found", "already_redeemed", "expired", "email_mismatch", "already_entitled"].every((s) => sql.includes(`return '${s}';`)));
check("26. ⭐⭐⭐ sql: RLS + revoke all pe beta_invites", /alter table public\.beta_invites enable row level security;/.test(sql)
  && /revoke all on public\.beta_invites from anon, authenticated;/.test(sql));
check("27. ⭐⭐⭐ sql: execute revocat de la public/anon/authenticated, acordat doar service_role",
  /revoke execute on function public\.redeem_beta_invite\(text, uuid, text, timestamptz, integer\) from public, anon, authenticated;/.test(sql)
  && /grant\s+execute on function public\.redeem_beta_invite\(text, uuid, text, timestamptz, integer\) to service_role;/.test(sql));
check("28. ⭐⭐⭐ sql: oauth_clients RLS + revoke scrieri; account_entitlements revoke scrieri",
  /alter table public\.oauth_clients enable row level security;/.test(sql)
  && /revoke insert, update, delete, truncate on public\.oauth_clients from anon, authenticated;/.test(sql)
  && /revoke insert, update, delete, truncate on public\.account_entitlements from anon, authenticated;/.test(sql));
check("29. ⭐⭐ sql: blocul de verificare pică migrația pe drepturi rămase", /do \$\$[\s\S]*has_function_privilege\(r, 'public\.redeem_beta_invite/.test(sql)
  && /raise exception '0002 verify:/.test(sql));
check("30. ⭐ sql: fără security definer", !/security definer/i.test(sql));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
