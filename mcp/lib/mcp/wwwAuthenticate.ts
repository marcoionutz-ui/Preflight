/**
 * lib/mcp/wwwAuthenticate.ts — lotul OAuth staging (design rev3 §5): header-ul `WWW-Authenticate` al unui 401 la `/api/mcp`.
 *
 * Frunză PURĂ (importă doar `normalizeBaseUrl`, pur) → tsx-testabilă. Claude (hosted apps) descoperă PRM-ul din
 * `resource_metadata` (RFC 9728 §5.1) și cere scope-ul din `scope` (RFC 6750 §3) → consimțământul arată doar
 * `read:basic`. `resource_metadata` TREBUIE absolut; originea vine din `resolveBaseUrl` (apelantul o rezolvă).
 *
 * Fallback (decizie documentată): dacă originea nu poate fi determinată (`resolveBaseUrl` aruncă fail-closed în
 * producție fără `PUBLIC_BASE_URL`) sau nu e un base URL http(s) curat, NU aruncăm și NU schimbăm statusul — întoarcem
 * EXACT header-ul relativ de dinainte. Un 401 trebuie să rămână 401 (altfel clientul ar vedea un 500 la un token lipsă);
 * PUBLIC_BASE_URL lipsă e deja semnalat separat (authenticate → 503, rutele de metadata → 5xx). Fără `scope` pe
 * fallback: forma veche, neschimbată.
 *
 * Apărare: originea e re-normalizată (`normalizeBaseUrl`: http/https, host, fără query/fragment/userinfo) și refuzată
 * dacă ar conține `"`, `\` sau spații — în dev originea poate veni din header-ele cererii, iar o valoare cu ghilimele
 * ar putea injecta parametri în header.
 */

import { normalizeBaseUrl } from "../oauth/baseUrl";

/** Scope-ul anunțat în 401 (design rev3 §5): singurul oferit în beta; `tp_situation_report` îl acceptă. */
export const WWW_AUTHENTICATE_SCOPE = "read:basic";
/** Calea PRM (RFC 9728), servită de `app/.well-known/oauth-protected-resource/route.ts`. */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
/** Header-ul de dinainte de lot (relativ, fără scope) — folosit DOAR ca fallback când originea lipsește. */
export const LEGACY_WWW_AUTHENTICATE = `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_PATH}"`;

const UNSAFE_IN_QUOTED = /["\\\s]/;

/**
 * Construiește valoarea `WWW-Authenticate`. `origin` valid → `Bearer resource_metadata="<origin>/.well-known/
 * oauth-protected-resource", scope="read:basic"`; `null` / invalid → `LEGACY_WWW_AUTHENTICATE`. Nu aruncă.
 */
export function buildWwwAuthenticate(origin: string | null): string {
  const base = normalizeBaseUrl(origin);
  if (base === null || UNSAFE_IN_QUOTED.test(base)) return LEGACY_WWW_AUTHENTICATE;
  return `Bearer resource_metadata="${base}${PROTECTED_RESOURCE_METADATA_PATH}", scope="${WWW_AUTHENTICATE_SCOPE}"`;
}
