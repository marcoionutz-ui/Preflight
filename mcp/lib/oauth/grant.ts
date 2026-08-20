/**
 * lib/oauth/grant.ts — PH-2a (grant-ul de autorizare: build + validare, PUR).
 *
 * Zero I/O → testabil izolat în tsx. Un GRANT (Marco #1/#2) leagă o identitate de client (registration) de un
 * resource-owner (user) pentru o resursă + un set de scopes. FK-ul e UNIC către `oauth_client_registrations`
 * (`registration_id`), nu un `client_id` polimorfic. `client_id` e păstrat DENORMALIZAT (snapshot pt. token/audit).
 * Tokenurile de user poartă `grant_id` + `user_id` + `entitlement_version` (vezi `subjectClaims.ts`).
 *
 * CONTRACT FK (cgpt #6): fiindcă `registration_id` e FK UNIC către `oauth_client_registrations`, acel tabel TREBUIE
 * să fie identitatea de protocol COMUNĂ pentru AMBELE tipuri de client — public DCR ȘI confidențial. Clienții
 * confidențiali legacy din `oauth_clients` se backfill-uiesc 1:1 în `oauth_client_registrations` (aditiv, non-
 * distructiv), altfel `/authorize` pentru un confidențial existent n-ar putea crea grant. Tabelul NU poate rămâne
 * „public-DCR-only" dacă toate autorizările interactive devin user-bound. (Vezi PREFLIGHT_PH2_DESIGN.md.)
 */

export type GrantStatus = "active" | "revoked";

export interface OAuthGrant {
  grant_id:            string;
  registration_id:     string;  // FK UNIC → oauth_client_registrations
  client_id:           string;  // denormalizat (snapshot)
  user_id:             string;
  resource:            string;  // canonic, validat la /authorize
  scopes:              string[];
  entitlement_version: number;
  status:              GrantStatus;
  created_at:          string;  // ISO
}

function isNonEmptyString(v: unknown): v is string { return typeof v === "string" && v.length > 0; }

/** Trim + eliminare goluri/whitespace + dedup + ordine stabilă. Un `" "` NU devine scope utilizabil (cgpt P2). */
function normalizeScopes(scopes: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of scopes) {
    if (typeof s !== "string") continue;
    const t = s.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Un array de scopes „curat" = ne-gol ȘI fiecare element string ne-gol după trim (fără `""`/`" "`). */
function scopesUsable(scopes: unknown): scopes is string[] {
  return Array.isArray(scopes) && scopes.length > 0 && scopes.every(s => typeof s === "string" && s.trim() !== "");
}

/**
 * Construiește un grant validat. Întoarce `{ ok:true, grant }` sau `{ ok:false, error }` — NU aruncă. Câmpurile
 * obligatorii trebuie ne-goale; `scopes` trebuie ne-gol după dedup (un grant fără scopes n-ar autoriza nimic);
 * `entitlement_version` întreg ≥1; `now` injectat (ISO) ca funcția să rămână pură.
 */
export function buildGrant(p: {
  grant_id: string; registration_id: string; client_id: string; user_id: string;
  resource: string; scopes: readonly string[]; entitlement_version: number; nowIso: string;
}): { ok: true; grant: OAuthGrant } | { ok: false; error: string } {
  if (!isNonEmptyString(p.grant_id))        return { ok: false, error: "grant_id lipsă" };
  if (!isNonEmptyString(p.registration_id)) return { ok: false, error: "registration_id lipsă" };
  if (!isNonEmptyString(p.client_id))       return { ok: false, error: "client_id lipsă" };
  if (!isNonEmptyString(p.user_id))         return { ok: false, error: "user_id lipsă" };
  if (!isNonEmptyString(p.resource))        return { ok: false, error: "resource lipsă" };
  if (!(typeof p.entitlement_version === "number" && Number.isInteger(p.entitlement_version) && p.entitlement_version >= 1))
    return { ok: false, error: "entitlement_version invalid" };
  const scopes = normalizeScopes(p.scopes);
  if (scopes.length === 0)                  return { ok: false, error: "scopes goale/whitespace (grantul n-ar autoriza nimic)" };
  if (!isNonEmptyString(p.nowIso))          return { ok: false, error: "nowIso lipsă" };

  return {
    ok: true,
    grant: {
      grant_id:            p.grant_id,
      registration_id:     p.registration_id,
      client_id:           p.client_id,
      user_id:             p.user_id,
      resource:            p.resource,
      scopes,
      entitlement_version: p.entitlement_version,
      status:              "active",
      created_at:          p.nowIso,
    },
  };
}

/** Guard de formă pt. citirea unui grant din DB (fail-closed). */
export function isValidGrant(raw: unknown): raw is OAuthGrant {
  if (typeof raw !== "object" || raw === null) return false;
  const o = raw as Record<string, unknown>;
  return isNonEmptyString(o.grant_id)
    && isNonEmptyString(o.registration_id)
    && isNonEmptyString(o.client_id)
    && isNonEmptyString(o.user_id)
    && isNonEmptyString(o.resource)
    && scopesUsable(o.scopes)   // ne-gol + fiecare scope ne-gol după trim (respinge [""], [" "])
    && typeof o.entitlement_version === "number" && Number.isInteger(o.entitlement_version) && o.entitlement_version >= 1
    && (o.status === "active" || o.status === "revoked")
    && isNonEmptyString(o.created_at);
}

/** Grant utilizabil pt. emiterea/reînnoirea unui token: status `active` + scopes curate (ne-gol după trim). */
export function isGrantUsable(g: Pick<OAuthGrant, "status" | "scopes">): boolean {
  return g.status === "active" && scopesUsable(g.scopes);
}
