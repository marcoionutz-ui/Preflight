/**
 * lib/db/driftCompare.ts — PH-2a (comparație PURĂ de drift pe câmpuri). Zero I/O → tsx.
 *
 * Inspectorul citește rândul EXISTENT din țintă și rândul RECOMPUTAT de backfill; funcțiile astea întorc lista
 * câmpurilor care DIFERĂ. Comparația e „completă” — include câmpuri materiale ușor de uitat:
 *   - entitlements: plan, scopes(set), ambele rate-limit, status, ȘI `entitlement_version` (cgpt slice2 #2);
 *   - registrations: client_type, auth_method, grant_types(set), redirect_uris(set), client_name, status,
 *     ȘI `expires_at` — un confidențial backfilled TREBUIE să aibă `expires_at = NULL` (cgpt slice2 #2).
 */

export interface TargetEntitlementRow {
  plan: string; scopes: string[];
  rate_limit_per_minute: number; rate_limit_per_day: number;
  status: string; entitlement_version: number;
}
export interface ComputedEntitlementRow {
  plan: string; scopes: string[];
  rate_limit_per_minute: number; rate_limit_per_day: number;
  status: string; entitlement_version: number;
}
export interface TargetRegistrationRow {
  client_type: string; token_endpoint_auth_method: string;
  grant_types: string[]; redirect_uris: string[];
  client_name: string | null; status: string; expires_at: string | null;
}
export interface ComputedRegistrationRow {
  client_type: string; token_endpoint_auth_method: string;
  grant_types: string[]; redirect_uris: string[];
  client_name: string | null; status: string;
}

/** Egalitate ca MULȚIME normalizată (ordine irelevantă, coerciție la string). */
export function sameSet(a: readonly unknown[] | null | undefined, b: readonly unknown[] | null | undefined): boolean {
  const na = [...(a ?? [])].map(String).sort();
  const nb = [...(b ?? [])].map(String).sort();
  return JSON.stringify(na) === JSON.stringify(nb);
}

export function diffEntitlement(cur: TargetEntitlementRow, want: ComputedEntitlementRow): string[] {
  const d: string[] = [];
  if (cur.plan !== want.plan)                                     d.push("plan");
  if (!sameSet(cur.scopes, want.scopes))                          d.push("scopes");
  if (cur.rate_limit_per_minute !== want.rate_limit_per_minute)   d.push("rate_limit_per_minute");
  if (cur.rate_limit_per_day !== want.rate_limit_per_day)         d.push("rate_limit_per_day");
  if (cur.status !== want.status)                                 d.push("status");
  // `entitlement_version` = metadata MONOTONĂ administrată de țintă (trigger-ul o incrementează la orice update
  // legitim de entitlement DUPĂ dual-write). Backfill-ul pornește mereu de la 1, dar o versiune >1 NU e drift —
  // ar da drift fals după prima modificare de plan/scopes. Verificăm DOAR că e integer >= 1 (nu egalitate).
  // `want.entitlement_version` (mereu 1) e intenționat neutilizat aici.
  if (!Number.isInteger(cur.entitlement_version) || cur.entitlement_version < 1) d.push("entitlement_version");
  return d;
}

export function diffRegistration(cur: TargetRegistrationRow, want: ComputedRegistrationRow): string[] {
  const d: string[] = [];
  if (cur.client_type !== want.client_type)                                 d.push("client_type");
  if (cur.token_endpoint_auth_method !== want.token_endpoint_auth_method)    d.push("token_endpoint_auth_method");
  if (!sameSet(cur.grant_types, want.grant_types))                          d.push("grant_types");
  if (!sameSet(cur.redirect_uris, want.redirect_uris))                      d.push("redirect_uris");
  if ((cur.client_name ?? null) !== (want.client_name ?? null))            d.push("client_name");
  if (cur.status !== want.status)                                          d.push("status");
  // backfill confidențial NU setează expires_at → trebuie să fie NULL în țintă
  if (cur.expires_at !== null)                                             d.push("expires_at");
  return d;
}

/**
 * Faza determină cum tratăm o cheie recomputată ABSENTĂ din țintă:
 *  - `pre-schema` / `post-schema` (== pre-backfill): țintele pot să nu conțină încă rândul → se verifică DOAR
 *    coliziunile (rânduri prezente care DIFERĂ). Absența e OK (backfill-ul le va insera).
 *  - `post-backfill`: FIECARE cheie recomputată TREBUIE să existe ȘI să fie identică. Absența = drift
 *    (dovada că backfill-ul a fost incomplet). NU comparăm count-uri totale (ținta poate avea în plus
 *    public DCR registrations legitime) — verificăm existența fiecărei chei AȘTEPTATE.
 */
export type BackfillPhase = "pre-schema" | "post-schema" | "post-backfill";

export interface DriftEntry { table: string; detail: string; }

export function collectEntitlementDrift(
  phase: BackfillPhase,
  computed: readonly (ComputedEntitlementRow & { user_id: string })[],
  existing: ReadonlyMap<string, TargetEntitlementRow>,
): DriftEntry[] {
  const out: DriftEntry[] = [];
  for (const e of computed) {
    const cur = existing.get(e.user_id);
    if (!cur) {
      if (phase === "post-backfill") out.push({ table: "account_entitlements", detail: `user ${e.user_id} LIPSEȘTE din țintă (backfill incomplet)` });
      continue;
    }
    const d = diffEntitlement(cur, e);
    if (d.length) out.push({ table: "account_entitlements", detail: `user ${e.user_id} diferă la: ${d.join(", ")}` });
  }
  return out;
}

export function collectRegistrationDrift(
  phase: BackfillPhase,
  computed: readonly (ComputedRegistrationRow & { client_id: string })[],
  existing: ReadonlyMap<string, TargetRegistrationRow>,
): DriftEntry[] {
  const out: DriftEntry[] = [];
  for (const r of computed) {
    const cur = existing.get(r.client_id);
    if (!cur) {
      if (phase === "post-backfill") out.push({ table: "oauth_client_registrations", detail: `client ${r.client_id} LIPSEȘTE din țintă (backfill incomplet)` });
      continue;
    }
    const d = diffRegistration(cur, r);
    if (d.length) out.push({ table: "oauth_client_registrations", detail: `client ${r.client_id} diferă la: ${d.join(", ")}` });
  }
  return out;
}
