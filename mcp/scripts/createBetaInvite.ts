/**
 * scripts/createBetaInvite.ts — lotul OAuth staging, §4 (creează o invitație beta; rulat de Marco).
 *
 * Rulare (din mcp/):
 *   npx tsx scripts/createBetaInvite.ts --email=<adresă> [--ttl-days=7] [--base-url=<https origin>]
 *
 * Ce face: normalizează emailul (trim + lowercase), generează un token aleator (32 octeți, base64url), scrie în
 * `beta_invites` DOAR sha256(token) și tipărește O SINGURĂ dată, pe stdout, linkul `<base-url>/signup/invite?token=…`,
 * plus `invite_id` și expirarea. Tokenul nu se poate recupera ulterior (în DB e doar hash-ul) — o invitație pierdută
 * se înlocuiește cu una nouă.
 *
 * Mediu: `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `EXPECT_SUPABASE_REF` ale staging-ului, EXPLICIT din
 * shell (`.env.local` NU se mai încarcă — review cgpt: în WSL indică producția). `vetAdminScriptTarget` (mode
 * `staging_only`) refuză altă țintă și producția înainte de importul clientului administrativ; `assertCanaryIsolation`
 * refuză în plus domeniul MCP de producție pentru link. `--base-url` implicit = `PUBLIC_BASE_URL`.
 *
 * Coduri de ieșire: 0 = creată; 1 = eroare neașteptată; 2 = validare (argumente, mediu lipsă, țintă de producție);
 * 3 = DB (insert eșuat / Supabase indisponibil). Pe stderr nu apar niciodată tokenul, cheia sau emailul.
 */
import ws from "ws";
import {
  DEFAULT_INVITE_TTL_DAYS,
  MAX_INVITE_TTL_DAYS,
  buildInviteLink,
  isValidInviteTtlDays,
  normalizeInviteBaseUrl,
  normalizeInviteEmail,
} from "../lib/oauth/inviteRedeem";
import { assertCanaryIsolation, PROD_SUPABASE_REFS } from "../lib/mcp/releaseGate";
import { vetAdminScriptTarget } from "../lib/config/adminScriptTarget";

const TAG = "[createBetaInvite]";

function fail(code: 1 | 2 | 3, msg: string): never {
  console.error(`${TAG} ${msg}`);
  process.exit(code);
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hits = process.argv.slice(2).filter((a) => a.startsWith(prefix));
  if (hits.length > 1) fail(2, `--${name} dat de mai multe ori`);
  return hits.length === 1 ? hits[0].slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const known = ["--email=", "--ttl-days=", "--base-url="];
  const unknown = process.argv.slice(2).filter((a) => !known.some((k) => a.startsWith(k)));
  if (unknown.length > 0) fail(2, "argumente necunoscute (folosește --email=, --ttl-days=, --base-url=)");

  const email = normalizeInviteEmail(argValue("email"));
  if (email === null) fail(2, "--email lipsă sau invalid");

  const ttlRaw = argValue("ttl-days");
  const ttlDays = ttlRaw === undefined ? DEFAULT_INVITE_TTL_DAYS : (/^\d+$/.test(ttlRaw) ? Number(ttlRaw) : Number.NaN);
  if (!isValidInviteTtlDays(ttlDays)) fail(2, `--ttl-days trebuie să fie un întreg în [1, ${MAX_INVITE_TTL_DAYS}]`);

  const baseUrl = normalizeInviteBaseUrl(argValue("base-url") ?? process.env.PUBLIC_BASE_URL);
  if (baseUrl === null) fail(2, "--base-url (sau PUBLIC_BASE_URL) lipsă sau invalid: cer o origine https, fără path/query");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const target = vetAdminScriptTarget({
    supabaseUrl,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    expectRef:  process.env.EXPECT_SUPABASE_REF,
    mode: "staging_only",
    prodRefs: PROD_SUPABASE_REFS,
  });
  if (!target.ok) fail(2, `țintă refuzată (${target.reason}): cer în shell NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY și EXPECT_SUPABASE_REF ale staging-ului`);

  const iso = assertCanaryIsolation({ mcpBaseUrl: baseUrl, supabaseUrl });
  if (!iso.ok) fail(2, `țintă refuzată (doar staging în acest lot): ${iso.reason}`);
  console.error(`${TAG} țintă Supabase: ${target.host} (ref declarat, cheie ${target.key_ref})`);
  const g = globalThis as unknown as { WebSocket?: unknown };
  if (typeof g.WebSocket === "undefined") g.WebSocket = ws;    // Node < 22: polyfill pentru supabase-js, fără dotenv

  // Import DINAMIC după verificarea mediului: `supabase-admin` construiește clientul la încărcare.
  const { createBetaInvite } = await import("../lib/db/betaInvites");
  const res = await createBetaInvite(email, ttlDays);
  if (!res.ok) fail(res.reason === "invalid_input" ? 2 : 3, `invitația nu a fost creată (${res.reason})`);

  // Singura ieșire cu tokenul: stdout, o dată.
  console.log(`invite_link: ${buildInviteLink(baseUrl, res.token)}`);
  console.log(`invite_id:   ${res.inviteId}`);
  console.log(`expires_at:  ${res.expiresAt}`);
}

main().then(
  () => process.exit(0),
  () => fail(1, "eroare neașteptată"),
);
