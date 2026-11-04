/**
 * scripts/adminClientAccess.ts — lot OAuth staging §4.1 (O1): autorizarea EXPLICITĂ de admin a clienților legacy.
 *
 * După migrația `0002`, `lookupClientById` întoarce `found` DOAR pentru `oauth_clients` cu `status = active` ȘI
 * `admin_authorized_at` nenul (regula în `lib/db/clientLookup.ts` → `isUsableLegacyClient`). Clienții auto-creați de
 * dashboard rămân în tabel, neschimbați, dar închiși (secretul → 401 `invalid_client`, tokenul vechi → 401 la apel).
 * Acest script e SINGURA cale de a-i deschide, client cu client:
 *
 *   --list                                         client_id, user_id, name, plan, scopes, status, created_at,
 *                                                  admin_authorized_at, admin_authorized_by, usable. FĂRĂ secret_hash
 *                                                  (coloanele sunt cerute explicit; selecția wildcard nu se folosește).
 *   --authorize --client-id=<id> --by=<notă>       setează admin_authorized_at = acum, admin_authorized_by = <notă>,
 *                                                  DOAR pentru clientul exact și DOAR dacă e `active`. Tipărește
 *                                                  before/after. Deja autorizat → noop (audit original păstrat).
 *   --unauthorize --client-id=<id>                 pune ambele coloane pe null (staging E0b: starea „după 0002").
 *
 * Decizii:
 *   - Ținta se declară EXPLICIT: `EXPECT_SUPABASE_REF` trebuie să fie ref-ul din URL (`vetAdminScriptTarget`, mode
 *     `explicit_any`: producția e permisă DOAR declarată explicit — autorizarea M2M în producție e o poartă separată).
 *   - Env-ul service-role se cere EXPLICIT din shell (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). NU
 *     încărcăm `.env.local` (spre deosebire de `inspect:ph2`, care e read-only): un script care SCRIE nu trebuie să
 *     aleagă tăcut un proiect dintr-un fișier local. Tipărim host-ul țintă (fără cheie) înainte de orice acțiune.
 *   - `supabase-admin` se importă DINAMIC, abia după verificarea env-ului (altfel `createClient` aruncă la load cu un
 *     mesaj opac). Polyfill WebSocket pentru Node < 22 (ca `inspectBootstrap`), fără dotenv.
 *   - Nu schimbăm `status`, nu ștergem rânduri, nu deducem „admin" din `user_id`/plan. Nu atingem `secret_hash`.
 *   - UPDATE-ul e confirmat prin `.select(...).maybeSingle()`: Supabase nu dă eroare pe 0 rânduri, deci fără confirmare
 *     am raporta un succes inexistent (ex. clientul a fost revocat între citire și scriere) → exit 3.
 *
 * Coduri de ieșire: 0 ok/noop · 1 backend/neașteptat · 2 utilizare sau env lipsă · 3 refuz pe starea țintei.
 *
 * Rulare (din `mcp/`):  NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/adminClientAccess.ts --list
 */
import ws from "ws";
import {
  ADMIN_CLIENT_COLUMNS, ADMIN_CLIENT_USAGE, EXIT_BACKEND, EXIT_OK, EXIT_REFUSED, EXIT_USAGE,
  formatClientRow, parseAdminClientArgs, planAccessChange, type AdminClientRow,
} from "../lib/db/adminClientAccess";
import { paginateExact, type PageFetcher } from "../lib/db/paginateExact";
import { isUsableLegacyClient } from "../lib/db/clientLookup";
import { vetAdminScriptTarget } from "../lib/config/adminScriptTarget";
import { PROD_SUPABASE_REFS } from "../lib/mcp/releaseGate";

const TAG  = "[adminClientAccess]";
const PAGE = 1000;

type SupabaseAdmin = typeof import("../lib/db/supabase-admin").supabaseAdmin;

/** Host-ul țintei (fără cale/cheie) — pentru ca operatorul să vadă pe ce proiect scrie. URL invalid → null. */
function targetHost(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}

async function loadSupabase(): Promise<SupabaseAdmin | null> {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const host = url ? targetHost(url) : null;
  if (!url || !key || !host) {
    console.error(`${TAG} lipsesc NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (service-role al mediului țintă), ` +
      "sau URL-ul e invalid. Setează-le explicit în shell; .env.local NU se încarcă.");
    return null;
  }
  const target = vetAdminScriptTarget({
    supabaseUrl: url, serviceKey: key, expectRef: process.env.EXPECT_SUPABASE_REF,
    mode: "explicit_any", prodRefs: PROD_SUPABASE_REFS,
  });
  if (!target.ok) {
    console.error(`${TAG} țintă refuzată (${target.reason}): setează EXPECT_SUPABASE_REF = ref-ul proiectului din URL.`);
    return null;
  }
  if (target.production) console.log(`${TAG} ATENȚIE: țintă de PRODUCȚIE declarată explicit (${target.ref}).`);
  const g = globalThis as unknown as { WebSocket?: unknown };
  if (typeof g.WebSocket === "undefined") g.WebSocket = ws;
  console.log(`${TAG} țintă Supabase: ${host}`);
  const mod = await import("../lib/db/supabase-admin");
  return mod.supabaseAdmin;
}

async function readOne(sb: SupabaseAdmin, clientId: string): Promise<{ row: AdminClientRow | null } | { error: string }> {
  const { data, error } = await sb.from("oauth_clients").select(ADMIN_CLIENT_COLUMNS).eq("client_id", clientId).maybeSingle();
  if (error) return { error: error.message };
  return { row: (data ?? null) as AdminClientRow | null };
}

async function runList(sb: SupabaseAdmin): Promise<number> {
  const fetcher: PageFetcher = {
    async headCount() {
      const { count, error } = await sb.from("oauth_clients").select("client_id", { count: "exact", head: true });
      return { count, error };
    },
    async fetchRange(from, to) {
      const { data, error } = await sb.from("oauth_clients").select(ADMIN_CLIENT_COLUMNS)
        .order("client_id", { ascending: true }).range(from, to);
      return { data, error };
    },
  };
  const res = await paginateExact<AdminClientRow>(fetcher, PAGE, "oauth_clients");
  if (!res.present) {
    console.error(`${TAG} tabelul oauth_clients lipsește`);
    return EXIT_BACKEND;
  }
  for (const r of res.rows) console.log(formatClientRow(r));
  const usable = res.rows.filter(r => isUsableLegacyClient(r)).length;
  console.log(`${TAG} total=${res.rows.length} (count=${res.expected}) usable=${usable}`);
  if (res.rows.length !== res.expected) {
    console.error(`${TAG} listare incompletă: aduse ${res.rows.length} din ${res.expected}`);
    return EXIT_BACKEND;
  }
  return EXIT_OK;
}

async function runChange(
  sb: SupabaseAdmin,
  cmd: { kind: "authorize"; clientId: string; by: string } | { kind: "unauthorize"; clientId: string },
): Promise<number> {
  const before = await readOne(sb, cmd.clientId);
  if ("error" in before) { console.error(`${TAG} citire eșuată: ${before.error}`); return EXIT_BACKEND; }

  const plan = planAccessChange(before.row, cmd, new Date().toISOString());
  if (before.row) console.log(`${TAG} before: ${formatClientRow(before.row)}`);
  if (plan.kind === "refuse") {
    console.error(`${TAG} REFUZ (${plan.code}): ${plan.reason} — client_id=${cmd.clientId}`);
    return EXIT_REFUSED;
  }
  if (plan.kind === "noop") {
    console.log(`${TAG} nimic de schimbat: ${plan.reason}`);
    return EXIT_OK;
  }

  let q = sb.from("oauth_clients").update(plan.patch).eq("client_id", cmd.clientId);
  if (plan.requireActive) q = q.eq("status", "active");
  const { data, error } = await q.select(ADMIN_CLIENT_COLUMNS).maybeSingle();
  if (error) { console.error(`${TAG} update eșuat: ${error.message}`); return EXIT_BACKEND; }
  if (!data) {
    console.error(`${TAG} REFUZ: update-ul nu a confirmat niciun rând (client revocat/șters între citire și scriere?)`);
    return EXIT_REFUSED;
  }
  console.log(`${TAG} after:  ${formatClientRow(data as AdminClientRow)}`);
  return EXIT_OK;
}

async function main(): Promise<number> {
  const cmd = parseAdminClientArgs(process.argv.slice(2));
  if (cmd.kind === "usage_error") {
    console.error(`${TAG} ${cmd.reason}\n${ADMIN_CLIENT_USAGE}`);
    return EXIT_USAGE;
  }
  const sb = await loadSupabase();
  if (!sb) return EXIT_USAGE;
  if (cmd.kind === "list") return runList(sb);
  return runChange(sb, cmd);
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => { console.error(`${TAG} eroare:`, e instanceof Error ? e.message : String(e)); process.exit(EXIT_BACKEND); },
);
