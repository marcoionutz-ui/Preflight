/**
 * lib/db/entitlementBackfill.ts — PH-2a (backfill `account_entitlements` din `oauth_clients`, PUR + raport acționabil).
 *
 * Zero I/O → testabil izolat în tsx. Alimentează scriptul de migrare (telemetrie READ-ONLY întâi, ca `inspect:u9`).
 *
 * Reguli (Marco #8 + cgpt P2):
 *   - `user_id` null/gol → NU produce entitlement (contorizat separat).
 *   - scopes = MULȚIME reală: trim + eliminare goluri + dedup + ordine canonică, atât la COMPARAȚIE cât și la OUTPUT
 *     (altfel `["read:all"]` vs `["read:all","read:all"]` par variante diferite = conflict fals).
 *   - VALIDARE per rând (nu avem încredere în datele runtime): status cunoscut, plan ne-gol, scopes ne-goale după
 *     normalizare, limite ÎNTREGI finite cu politica explicită `-1` (unlimited). Rândurile invalide → `invalidRows`
 *     separat, NU migrate și NU confundate cu variante valide.
 *   - conflict = divergență REALĂ pe (plan/scopes/limite/status) între rândurile VALIDE ale aceluiași user → blochează
 *     DOAR acel user; raportul include `client_id`-urile fiecărei variante (rezoluție manuală acționabilă).
 *   - `entitlement_version=1` la backfill.
 */

const KNOWN_STATUS = new Set(["active", "revoked", "suspended"]);

export interface LegacyClientRow {
  client_id:             string;        // identificatorul sursă (pt. raport acționabil)
  user_id:               string | null;
  plan:                  string;
  scopes:                string[];
  rate_limit_per_minute: number;
  rate_limit_per_day:    number;
  status:                string;
}

export interface BackfilledEntitlement {
  user_id:               string;
  plan:                  string;
  scopes:                string[];      // normalizate (dedup + sortate)
  rate_limit_per_minute: number;
  rate_limit_per_day:    number;
  status:                string;
  entitlement_version:   number;
}

export interface BackfillVariant { key: string; client_ids: string[]; }
export interface BackfillConflict { user_id: string; reason: string; variants: BackfillVariant[]; }
export interface InvalidRow { client_id: string; user_id: string | null; reasons: string[]; }

export interface BackfillResult {
  entitlements:    BackfilledEntitlement[];
  conflicts:       BackfillConflict[];
  invalidRows:     InvalidRow[];
  skippedNullUser: number;
}

/**
 * Mulțime canonică de scopes: trim, fără goluri, dedup, sortat. Aceeași funcție pt. comparație ȘI output.
 * DEFENSIV (cgpt P2): ignoră orice element non-string (nu aruncă) — deși `validateRow` semnalează deja rândul ca
 * invalid înainte de a ajunge aici, garanția „nu arunca niciodată" ține migrarea altor useri în viață.
 */
function normalizeScopes(scopes: readonly unknown[]): string[] {
  const set = new Set<string>();
  for (const s of scopes) { if (typeof s !== "string") continue; const t = s.trim(); if (t) set.add(t); }
  return [...set].sort();
}

/** Limită validă: număr întreg finit ≥0, SAU exact -1 (unlimited). NaN/Infinity/float/alt negativ = invalid. */
function isValidLimit(n: number): boolean {
  return Number.isInteger(n) && (n >= 0 || n === -1);
}

/** Validează un rând (deja ne-null pe user). Întoarce lista de motive (gol = valid) + scopes normalizate. Nu aruncă. */
function validateRow(r: LegacyClientRow): { reasons: string[]; scopes: string[] } {
  const reasons: string[] = [];
  if (typeof r.plan !== "string" || r.plan.trim() === "") reasons.push("plan gol/invalid");
  if (!KNOWN_STATUS.has(r.status)) reasons.push(`status necunoscut: ${JSON.stringify(r.status)}`);
  if (!isValidLimit(r.rate_limit_per_minute)) reasons.push(`rate_limit_per_minute invalid: ${r.rate_limit_per_minute}`);
  if (!isValidLimit(r.rate_limit_per_day)) reasons.push(`rate_limit_per_day invalid: ${r.rate_limit_per_day}`);

  // Scopes: array de string-uri. Un element non-string (null / number / object dintr-un array PostgreSQL sau payload
  // runtime) → rând INVALID (cgpt P2), NU aruncă și NU blochează migrarea altor useri.
  let scopes: string[] = [];
  if (!Array.isArray(r.scopes) || !r.scopes.every(x => typeof x === "string")) {
    reasons.push("scopes invalide (nu e array de string-uri)");
  } else {
    scopes = normalizeScopes(r.scopes);
    if (scopes.length === 0) reasons.push("scopes goale după normalizare");
  }
  return { reasons, scopes };
}

export function computeEntitlementBackfill(rows: readonly LegacyClientRow[]): BackfillResult {
  const byUser = new Map<string, { row: LegacyClientRow; scopes: string[] }[]>();
  const invalidRows: InvalidRow[] = [];
  // cgpt P1: ORICE rând invalid „otrăvește" TOT userul — nu emitem entitlement din rândurile valide rămase ale
  // aceluiași user (ar fi o alegere tacită cu acces când starea reală e incertă). Fail-closed la nivel de user.
  const blockedUsers = new Set<string>();
  let skippedNullUser = 0;

  for (const r of rows) {
    if (r.user_id == null || r.user_id === "") { skippedNullUser++; continue; }
    const { reasons, scopes } = validateRow(r);
    if (reasons.length > 0) {
      invalidRows.push({ client_id: r.client_id, user_id: r.user_id, reasons });
      blockedUsers.add(r.user_id);
      continue;
    }
    (byUser.get(r.user_id) ?? byUser.set(r.user_id, []).get(r.user_id)!).push({ row: r, scopes });
  }

  const entitlements: BackfilledEntitlement[] = [];
  const conflicts:    BackfillConflict[]      = [];

  for (const [user_id, group] of byUser) {
    if (blockedUsers.has(user_id)) continue; // are ≥1 rând invalid → NU emitem entitlement (nici conflict)
    // Cheie canonică pe scopes NORMALIZATE + plan + limite + status; mapăm cheie → client_ids.
    const variants = new Map<string, { scopes: string[]; row: LegacyClientRow; client_ids: string[] }>();
    for (const { row, scopes } of group) {
      const key = JSON.stringify([row.plan.trim(), scopes, row.rate_limit_per_minute, row.rate_limit_per_day, row.status]);
      const v = variants.get(key);
      if (v) v.client_ids.push(row.client_id);
      else variants.set(key, { scopes, row, client_ids: [row.client_id] });
    }

    if (variants.size === 1) {
      const { scopes, row } = [...variants.values()][0];
      entitlements.push({
        user_id,
        plan:                  row.plan.trim(),
        scopes,                                    // normalizate
        rate_limit_per_minute: row.rate_limit_per_minute,
        rate_limit_per_day:    row.rate_limit_per_day,
        status:                row.status,
        entitlement_version:   1,
      });
    } else {
      conflicts.push({
        user_id,
        reason:   `divergent entitlement across ${group.length} clients (${variants.size} distinct variants)`,
        variants: [...variants.entries()].map(([key, v]) => ({ key, client_ids: v.client_ids })),
      });
    }
  }

  return { entitlements, conflicts, invalidRows, skippedNullUser };
}
