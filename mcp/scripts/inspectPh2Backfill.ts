/**
 * scripts/inspectPh2Backfill.ts — PH-2a TELEMETRIE READ-ONLY (ca inspect:u9).
 *
 * Citește `oauth_clients` + `auth.users` și raportează CE AR PRODUCE backfill-ul (account_entitlements +
 * oauth_client_registrations): conflicte, invalidRows, warnings, ORFANI și DRIFT în tabelele țintă — FĂRĂ SĂ
 * SCRIE NIMIC.
 *
 * FAZĂ EXPLICITĂ obligatorie (cgpt) — `--phase=<...>`:
 *   pre-schema    → înainte de migrație; tabelele țintă pot lipsi.
 *   post-schema   → după migrație, ÎNAINTE de backfill; AMBELE tabele TREBUIE să existe, dar rândurile recomputate
 *                   pot lipsi încă (se verifică DOAR coliziunile pe rândurile prezente).
 *   post-backfill → după backfill; FIECARE entitlement + FIECARE registration recomputată TREBUIE să existe ȘI să fie
 *                   identică — lipsa devine DRIFT (dovada că backfill-ul a fost incomplet). NU cerem egalitate de
 *                   count-uri totale (ținta poate avea în plus public DCR registrations legitime).
 *
 * Fără `--phase` → exit 2. Verdict ne-curat → exit 1.
 *
 * Corectitudine: paginare stabilă + `count(*)` exact la SURSĂ ȘI ȚINTĂ (leaf `paginateExact`, testat separat);
 * orphan check pe `auth.users`; drift COMPLET (inclusiv `entitlement_version` + `expires_at`) via `driftCompare`;
 * „tabel absent” = DOAR `42P01`/„does not exist” (orice altă eroare aruncă). Verdict PUR (`evaluateBackfillVerdict`).
 *
 * Rulare:  npm run inspect:ph2 -w @preflight/mcp -- --phase=pre-schema   (bootstrap-ul încarcă .env.local + WebSocket).
 */
import "./inspectBootstrap"; // PRIMUL: .env.local + polyfill WebSocket (Node < 22) înainte de supabase-admin
import { supabaseAdmin } from "../lib/db/supabase-admin";
import { computeEntitlementBackfill } from "../lib/db/entitlementBackfill";
import { computeRegistrationBackfill } from "../lib/db/registrationBackfill";
import { evaluateBackfillVerdict, type SchemaPhase, type FetchIntegrity } from "../lib/db/backfillVerdict";
import { paginateExact, type PageFetcher } from "../lib/db/paginateExact";
import { collectEntitlementDrift, collectRegistrationDrift, type BackfillPhase,
         type TargetEntitlementRow, type TargetRegistrationRow } from "../lib/db/driftCompare";

interface RawClientRow {
  client_id:             string;
  user_id:               string | null;
  plan:                  string;
  scopes:                string[];
  rate_limit_per_minute: number;
  rate_limit_per_day:    number;
  status:                string;
  name:                  string | null;
  redirect_uris:         string[];
}

const PAGE = 1000;
const SRC_COLS = "client_id, user_id, plan, scopes, rate_limit_per_minute, rate_limit_per_day, status, name, redirect_uris";
const ENT_COLS = "user_id, plan, scopes, rate_limit_per_minute, rate_limit_per_day, status, entitlement_version";
const REG_COLS = "client_id, client_type, token_endpoint_auth_method, grant_types, redirect_uris, client_name, status, expires_at";

/** Faza obligatorie din argv. Fără ea → exit 2 (nu ghicim). */
function parsePhase(): SchemaPhase {
  const flag = process.argv.find((a) => a.startsWith("--phase="));
  const val = flag ? flag.split("=")[1] : undefined;
  if (val === "pre-schema" || val === "post-schema" || val === "post-backfill") return val;
  console.error("[inspect:ph2] lipsește/greșită faza. Rulează cu --phase=pre-schema | post-schema | post-backfill");
  process.exit(2);
}

/** PageFetcher peste supabaseAdmin pt. un tabel dat (HEAD count + range ordonat). */
function fetcherFor(table: string, cols: string, orderCol: string): PageFetcher {
  return {
    async headCount() {
      const { count, error } = await supabaseAdmin.from(table).select(cols, { count: "exact", head: true });
      return { count, error };
    },
    async fetchRange(from: number, to: number) {
      const { data, error } = await supabaseAdmin.from(table).select(cols).order(orderCol, { ascending: true }).range(from, to);
      return { data, error };
    },
  };
}

/** Setul tuturor id-urilor din auth.users (paginat via admin API). */
async function fetchAuthUserIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let page = 1; ; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PAGE });
    if (error) throw new Error("listUsers auth eșuat: " + error.message);
    const users = data?.users ?? [];
    for (const u of users) if (typeof u.id === "string") ids.add(u.id);
    if (users.length < PAGE) break;
  }
  return ids;
}

async function main(): Promise<void> {
  const phase = parsePhase();
  console.log(`[inspect:ph2] READ-ONLY — nu se scrie nimic în DB. Fază: ${phase}\n`);

  // ── sursă (oauth_clients) — trebuie să existe mereu ──
  const src = await paginateExact<RawClientRow>(fetcherFor("oauth_clients", SRC_COLS, "client_id"), PAGE, "oauth_clients");
  if (!src.present) throw new Error("oauth_clients lipsește — sursă indispensabilă");
  console.log(`[inspect:ph2] oauth_clients: count(*)=${src.expected}, aduse=${src.rows.length}\n`);
  const rows = src.rows;

  // ── account_entitlements (per user) ──
  const ent = computeEntitlementBackfill(rows);
  console.log("== account_entitlements ==");
  console.log(`  entitlements (useri fără conflict): ${ent.entitlements.length}`);
  console.log(`  skip user_id null:                  ${ent.skippedNullUser}`);
  console.log(`  invalidRows:                        ${ent.invalidRows.length}`);
  console.log(`  CONFLICTE (blochează userul):       ${ent.conflicts.length}`);
  for (const c of ent.conflicts) {
    console.log(`    ⚠ user ${c.user_id}: ${c.reason}`);
    for (const v of c.variants) console.log(`        variantă [${v.client_ids.join(", ")}]`);
  }
  for (const iv of ent.invalidRows) console.log(`    ✗ client ${iv.client_id}: ${iv.reasons.join("; ")}`);

  // ── oauth_client_registrations (confidențiali 1:1) ──
  const reg = computeRegistrationBackfill(rows);
  console.log("\n== oauth_client_registrations (confidențial 1:1) ==");
  console.log(`  registrations:  ${reg.registrations.length}`);
  console.log(`  invalidRows:    ${reg.invalidRows.length}`);
  console.log(`  warnings:       ${reg.warnings.length}`);
  for (const iv of reg.invalidRows) console.log(`    ✗ client ${iv.client_id}: ${iv.reasons.join("; ")}`);
  for (const w of reg.warnings)      console.log(`    ⚠ client ${w.client_id}: ${w.warning}`);

  // ── orphan check: user_id non-null trebuie să existe în auth.users ──
  const authIds = await fetchAuthUserIds();
  const sourceUserIds = [...new Set(rows.map((r) => r.user_id).filter((u): u is string => typeof u === "string" && u.length > 0))];
  const orphanUserIds = sourceUserIds.filter((id) => !authIds.has(id));
  console.log("\n== integritate auth.users ==");
  console.log(`  user_id distincti (non-null): ${sourceUserIds.length}`);
  console.log(`  ORFANI (fără auth.users):     ${orphanUserIds.length}`);
  for (const o of orphanUserIds.slice(0, 20)) console.log(`    ✗ ${o}`);

  // ── tabele țintă (paginat + count exact) + drift conștient de fază ──
  const entTarget = await paginateExact<TargetEntitlementRow & { user_id: string }>(fetcherFor("account_entitlements", ENT_COLS, "user_id"), PAGE, "account_entitlements");
  const regTarget = await paginateExact<TargetRegistrationRow & { client_id: string }>(fetcherFor("oauth_client_registrations", REG_COLS, "client_id"), PAGE, "oauth_client_registrations");

  const targetDrift: { table: string; detail: string }[] = [];
  if (entTarget.present) {
    const existing = new Map(entTarget.rows.map((r) => [r.user_id, r]));
    targetDrift.push(...collectEntitlementDrift(phase as BackfillPhase, ent.entitlements, existing));
  }
  if (regTarget.present) {
    const existing = new Map(regTarget.rows.map((r) => [r.client_id, r]));
    targetDrift.push(...collectRegistrationDrift(phase as BackfillPhase, reg.registrations, existing));
  }
  if (targetDrift.length > 0) {
    console.log("\n== drift țintă ==");
    for (const d of targetDrift) console.log(`    ✗ ${d.table}: ${d.detail}`);
  }

  // ── verdict PUR + exit code ──
  const targetFetch: { entitlements: FetchIntegrity | null; registrations: FetchIntegrity | null } = {
    entitlements:  entTarget.present ? { expected: entTarget.expected, fetched: entTarget.rows.length } : null,
    registrations: regTarget.present ? { expected: regTarget.expected, fetched: regTarget.rows.length } : null,
  };
  const verdict = evaluateBackfillVerdict({
    schema:       { phase, entPresent: entTarget.present, regPresent: regTarget.present },
    fetch:        { expected: src.expected, fetched: rows.length },
    targetFetch,
    orphanUserIds,
    entitlement:  { conflicts: ent.conflicts.length, invalidRows: ent.invalidRows.length },
    registration: { invalidRows: reg.invalidRows.length },
    targetDrift,
  });

  console.log(`\n[inspect:ph2] verdict (${phase}): ${verdict.clean ? "CURAT ✅ — se poate continua" : "ARE PROBLEME ✗"}`);
  for (const p of verdict.problems) console.log(`    → ${p}`);
  console.log("[inspect:ph2] READ-ONLY — nimic scris.");

  if (!verdict.clean) process.exit(1);
}

main().catch((e) => { console.error("[inspect:ph2] eroare:", e); process.exit(1); });
