/**
 * scripts/provisionCimdClient.ts — lotul OAuth staging (design rev3 §2, §9 S0): provizionarea clientului CIMD FIXAT.
 *
 * Operatorul (Marco) descarcă documentul CIMD al hosted apps Claude cu `curl`, îl salvează în evidență și rulează:
 *   npx tsx scripts/provisionCimdClient.ts --doc=<fișierul salvat> --client-id=<URL-ul văzut în logul S0> [--apply [--replace]]
 *
 * Ce face:
 *   - citește DOAR fișierul local (NICIODATĂ un fetch de rețea — documentul se verifică o dată, de om, nu la runtime);
 *   - tipărește sha256-ul octeților fișierului (pentru evidență / verificarea periodică din backlog);
 *   - rulează validatorul PUR `validateCimdDocument` (lib/oauth/cimdDocValidate.ts) și tipărește rândul rezultat
 *     (metadata publică de client; nu există secrete în joc — un client CIMD e `public` / `none`);
 *   - fără `--apply` = DRY RUN offline: nu cere env, nu atinge baza;
 *   - cu `--apply`: cere `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` EXPLICIT din shell (`.env.local` NU
 *     se mai încarcă — review cgpt: în WSL indică producția) și `EXPECT_SUPABASE_REF` = ref-ul de staging declarat;
 *     `vetAdminScriptTarget` (mode `staging_only`) refuză orice altă țintă și producția ÎNAINTE de importul clientului
 *     administrativ; tipărește DOAR host-ul proiectului Supabase țintă (nu cheia), apoi scrie UN rând în
 *     `oauth_client_registrations` prin `supabaseAdmin` (service-role), idempotent pe `client_id`:
 *       · rând absent → insert (`status = active`, `expires_at = null`);
 *       · rând identic → nimic de scris (exit 0);
 *       · rând diferit → tipărește diferențele și REFUZĂ, cu excepția lui `--replace` (update pe același rând, deci
 *         `registration_id` și grant-urile legate de el se păstrează).
 *
 * Coduri de ieșire: 0 = ok (dry run valid / inserat / deja identic / înlocuit); 1 = utilizare greșită sau env lipsă
 * pentru `--apply` (nimic atins); 2 = refuzat (fișier ilizibil / JSON invalid / document respins de validator / rând
 * existent diferit fără `--replace`); 3 = eroare de bază de date.
 *
 * Rulare tipică (staging): întâi fără `--apply`, se verifică rândul și sha256-ul, apoi cu `--apply`.
 */
import ws from "ws";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  validateCimdDocument, toCimdProvisionRow, diffCimdProvisionRow, type CimdProvisionRow,
} from "../lib/oauth/cimdDocValidate";
import { vetAdminScriptTarget } from "../lib/config/adminScriptTarget";
import { PROD_SUPABASE_REFS } from "../lib/mcp/releaseGate";

const TAG = "[provision:cimd]";
const TABLE = "oauth_client_registrations";
const ROW_COLS = "client_id, client_type, token_endpoint_auth_method, grant_types, redirect_uris, client_name, status, expires_at";
/** Un document CIMD are câteva sute de octeți; un fișier mult mai mare nu e documentul așteptat. */
const MAX_DOC_BYTES = 64 * 1024;
const PG_UNIQUE_VIOLATION = "23505";

const EXIT_OK = 0, EXIT_USAGE = 1, EXIT_REFUSED = 2, EXIT_DB = 3;

const USAGE = "utilizare: provisionCimdClient --doc=<fișier JSON salvat> --client-id=<URL https claude.ai|claude.com> [--apply [--replace]]";

interface Args { doc: string; clientId: string; apply: boolean; replace: boolean }

/** Argumente stricte: doar cele cunoscute, fiecare o singură dată; `--replace` are sens doar cu `--apply`. */
function parseArgs(argv: readonly string[]): Args | null {
  let doc: string | undefined, clientId: string | undefined, apply = false, replace = false;
  const seen = new Set<string>();
  for (const a of argv) {
    const key = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (seen.has(key)) return null;
    seen.add(key);
    if (a.startsWith("--doc="))            doc = a.slice("--doc=".length);
    else if (a.startsWith("--client-id=")) clientId = a.slice("--client-id=".length);
    else if (a === "--apply")              apply = true;
    else if (a === "--replace")            replace = true;
    else return null;
  }
  if (!doc || !clientId) return null;
  if (replace && !apply) return null;
  return { doc, clientId, apply, replace };
}

function printRow(label: string, row: CimdProvisionRow): void {
  console.log(`${TAG} ${label}:`);
  console.log(JSON.stringify(row, null, 2));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) { console.log(USAGE); return EXIT_USAGE; }

  // ── fișierul (doar local, fără rețea) ──
  let bytes: Buffer;
  try { bytes = readFileSync(args.doc); } catch {
    console.error(`${TAG} REFUZ: fișierul --doc nu poate fi citit.`);
    return EXIT_REFUSED;
  }
  console.log(`${TAG} fișier: ${bytes.length} octeți, sha256=${createHash("sha256").update(bytes).digest("hex")}`);
  if (bytes.length > MAX_DOC_BYTES) {
    console.error(`${TAG} REFUZ: fișierul depășește ${MAX_DOC_BYTES} octeți (nu e un document CIMD).`);
    return EXIT_REFUSED;
  }
  let doc: unknown;
  try { doc = JSON.parse(bytes.toString("utf8")); } catch {
    console.error(`${TAG} REFUZ: fișierul nu e JSON valid.`);
    return EXIT_REFUSED;
  }

  // ── validarea PURĂ ──
  const v = validateCimdDocument(doc, args.clientId);
  if (!v.ok) {
    console.error(`${TAG} REFUZ: documentul nu trece validarea (${v.reason}).`);
    return EXIT_REFUSED;
  }
  const desired = toCimdProvisionRow(v.registration);
  printRow(args.apply ? "rândul de scris" : "DRY RUN — rândul care AR fi scris (nimic atins; rulează cu --apply)", desired);
  if (!args.apply) return EXIT_OK;

  // ── --apply: ținta explicită (doar staging), verificată ÎNAINTE de importul clientului service-role ──
  const target = vetAdminScriptTarget({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    serviceKey:  process.env.SUPABASE_SERVICE_ROLE_KEY,
    expectRef:   process.env.EXPECT_SUPABASE_REF,
    mode: "staging_only",
    prodRefs: PROD_SUPABASE_REFS,
  });
  if (!target.ok) {
    console.error(`${TAG} REFUZ țintă (${target.reason}): --apply cere în shell NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY și EXPECT_SUPABASE_REF ale staging-ului; producția e refuzată. Nimic atins.`);
    return EXIT_USAGE;
  }
  console.log(`${TAG} țintă Supabase: ${target.host} (ref declarat, cheie ${target.key_ref})`);
  const g = globalThis as unknown as { WebSocket?: unknown };
  if (typeof g.WebSocket === "undefined") g.WebSocket = ws;    // Node < 22: polyfill pentru supabase-js, fără dotenv
  const { supabaseAdmin } = await import("../lib/db/supabase-admin");

  const read = await supabaseAdmin.from(TABLE).select(ROW_COLS).eq("client_id", desired.client_id).maybeSingle();
  if (read.error) { console.error(`${TAG} EROARE DB la citire (cod ${read.error.code ?? "?"}).`); return EXIT_DB; }
  const existing: unknown = read.data;

  if (existing === null) {
    const ins = await supabaseAdmin.from(TABLE).insert(desired);
    if (ins.error) {
      const race = ins.error.code === PG_UNIQUE_VIOLATION;
      console.error(`${TAG} EROARE DB la insert (cod ${ins.error.code ?? "?"})${race ? " — rândul a apărut între timp; rulează din nou" : ""}.`);
      return EXIT_DB;
    }
    console.log(`${TAG} INSERAT: ${desired.client_id} (status active, expires_at null).`);
    return EXIT_OK;
  }

  const diff = diffCimdProvisionRow(existing, desired);
  if (diff.length === 0) {
    console.log(`${TAG} deja provizionat, identic — nimic de scris.`);
    return EXIT_OK;
  }
  console.log(`${TAG} rândul existent DIFERĂ:`);
  for (const d of diff) console.log(`    ${d.field}: existent=${JSON.stringify(d.existing)} → dorit=${JSON.stringify(d.desired)}`);
  if (!args.replace) {
    console.error(`${TAG} REFUZ: rând existent diferit. Rulează cu --apply --replace ca să-l înlocuiești (registration_id se păstrează).`);
    return EXIT_REFUSED;
  }

  const upd = await supabaseAdmin.from(TABLE).update(desired).eq("client_id", desired.client_id).select("client_id");
  if (upd.error) { console.error(`${TAG} EROARE DB la update (cod ${upd.error.code ?? "?"}).`); return EXIT_DB; }
  if (!Array.isArray(upd.data) || upd.data.length !== 1) {
    console.error(`${TAG} EROARE DB: update-ul a atins ${Array.isArray(upd.data) ? upd.data.length : "?"} rânduri (așteptat 1).`);
    return EXIT_DB;
  }
  console.log(`${TAG} ÎNLOCUIT: ${desired.client_id} (status active, expires_at null).`);
  return EXIT_OK;
}

main().then(
  (code) => process.exit(code),
  () => { console.error(`${TAG} eroare neașteptată (DB/rețea).`); process.exit(EXIT_DB); },
);
