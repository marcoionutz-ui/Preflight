/**
 * lib/oauth/cimdDocValidate.ts — lotul OAuth staging (design rev3 §2, §3, §9 S0): validarea documentului CIMD al
 * clientului Claude, la PROVIZIONARE (o singură dată, de operator), nu la runtime.
 *
 * Frunză PURĂ (zero I/O; documentul e deja parsat, citit de operator dintr-un fișier salvat cu `curl`) → tsx-testabilă.
 * „Fixat”: serverul NU descarcă niciodată documentul la `/authorize` (fără SSRF, fără dependență de claude.ai la fiecare
 * autorizare). `scripts/provisionCimdClient.ts` rulează acest validator pe fișierul salvat și scrie UN rând în
 * `oauth_client_registrations` — exact forma întoarsă aici.
 *
 * Verificări (toate obligatorii, fail-closed):
 *   - `clientIdUrl`: URL `https:` parsabil, host EXACT `claude.ai` sau `claude.com`, fără userinfo, fără fragment, fără
 *     port explicit, cu o cale (nu doar „/”), în formă canonică (`new URL(x).href === x` — refuză host uppercase,
 *     segmente `.`/`..`, port implicit scris explicit etc.; un client_id e comparat ulterior pe șir exact).
 *   - documentul: obiect simplu (nu array / null / instanță de clasă); fără `client_secret*` (un client CIMD e public).
 *   - `client_id` din document === `clientIdUrl` (șir exact).
 *   - `token_endpoint_auth_method === "none"` (absent = implicit `client_secret_basic` RFC 7591 → refuz).
 *   - `grant_types` (array de stringuri) include `authorization_code` ȘI `refresh_token`; absent = implicit
 *     `["authorization_code"]` (RFC 7591 §2) → refuz, lipsește `refresh_token`.
 *   - `redirect_uris` array de stringuri; intersecția cu `CLAUDE_CALLBACKS` (șir exact) ≠ ∅. Rândul primește DOAR
 *     intersecția, în ordinea `CLAUDE_CALLBACKS` (decizia O4).
 *   - `client_name` opțional: string ne-gol ≤ 200 caractere, fără caractere de control; altfel `null` (doar afișare).
 *
 * Motivele de refuz sunt CODURI ÎNCHISE, statice — nu ecouăm niciodată conținut din document (poate fi arbitrar).
 * NU aruncă.
 */

import { CLAUDE_CALLBACKS } from "./claudeCallbacks";

/** Host-urile pe care le acceptăm pentru URL-ul documentului CIMD al hosted apps Claude. */
const CLAUDE_CIMD_HOSTS: ReadonlySet<string> = new Set(["claude.ai", "claude.com"]);
const CLIENT_NAME_MAX = 200;
const LOG_PATH_MAX = 200;

/** Rândul `oauth_client_registrations` pe care provizionarea îl scrie (fără `registration_id`/timestamps). */
export interface CimdRegistration {
  client_id:                  string;
  client_type:                "public";
  token_endpoint_auth_method: "none";
  grant_types:                ["authorization_code", "refresh_token"];
  redirect_uris:              string[];   // ∩ CLAUDE_CALLBACKS, în ordinea CLAUDE_CALLBACKS
  client_name:                string | null;
}

/** Coduri de refuz închise (fără conținut din document). */
export type CimdRefusalReason =
  | "client_id_url_invalid"          // nu e URL parsabil
  | "client_id_url_not_https"
  | "client_id_url_host_not_claude"
  | "client_id_url_has_userinfo"
  | "client_id_url_has_fragment"
  | "client_id_url_has_port"
  | "client_id_url_no_path"
  | "client_id_url_not_canonical"
  | "document_not_object"
  | "document_contains_secret"
  | "client_id_mismatch"
  | "token_endpoint_auth_method_not_none"
  | "grant_types_invalid"
  | "grant_types_missing_authorization_code"
  | "grant_types_missing_refresh_token"
  | "redirect_uris_invalid"
  | "redirect_uris_no_claude_callback";

export type CimdValidation =
  | { ok: true;  registration: CimdRegistration }
  | { ok: false; reason: CimdRefusalReason };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function isStringArray(v: unknown): v is string[] { return Array.isArray(v) && v.every((s) => typeof s === "string"); }
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Verifică URL-ul `client_id` (forma cerută de CIMD + host Claude). `null` = valid. */
function checkClientIdUrl(clientIdUrl: string): CimdRefusalReason | null {
  if (typeof clientIdUrl !== "string" || clientIdUrl.length === 0) return "client_id_url_invalid";
  let u: URL;
  try { u = new URL(clientIdUrl); } catch { return "client_id_url_invalid"; }
  if (u.protocol !== "https:")                   return "client_id_url_not_https";
  if (!CLAUDE_CIMD_HOSTS.has(u.hostname))        return "client_id_url_host_not_claude";
  if (u.username !== "" || u.password !== "")    return "client_id_url_has_userinfo";
  if (u.hash !== "" || clientIdUrl.includes("#")) return "client_id_url_has_fragment";
  if (u.port !== "")                             return "client_id_url_has_port";
  if (u.pathname === "" || u.pathname === "/")   return "client_id_url_no_path";
  if (u.href !== clientIdUrl)                    return "client_id_url_not_canonical";
  return null;
}

/** Validează documentul CIMD salvat de operator față de `client_id`-ul observat la S0. Vezi contractul din header. */
export function validateCimdDocument(doc: unknown, clientIdUrl: string): CimdValidation {
  const urlRefusal = checkClientIdUrl(clientIdUrl);
  if (urlRefusal) return { ok: false, reason: urlRefusal };

  if (!isPlainObject(doc)) return { ok: false, reason: "document_not_object" };
  if ("client_secret" in doc || "client_secret_expires_at" in doc) return { ok: false, reason: "document_contains_secret" };

  if (doc.client_id !== clientIdUrl) return { ok: false, reason: "client_id_mismatch" };
  if (doc.token_endpoint_auth_method !== "none") return { ok: false, reason: "token_endpoint_auth_method_not_none" };

  // RFC 7591 §2: `grant_types` absent ⇒ implicit ["authorization_code"] (deci fără refresh_token → refuz mai jos).
  const grantTypes: unknown = "grant_types" in doc && doc.grant_types !== undefined ? doc.grant_types : ["authorization_code"];
  if (!isStringArray(grantTypes))                   return { ok: false, reason: "grant_types_invalid" };
  if (!grantTypes.includes("authorization_code"))   return { ok: false, reason: "grant_types_missing_authorization_code" };
  if (!grantTypes.includes("refresh_token"))        return { ok: false, reason: "grant_types_missing_refresh_token" };

  if (!isStringArray(doc.redirect_uris)) return { ok: false, reason: "redirect_uris_invalid" };
  const presented = new Set(doc.redirect_uris);
  const redirect_uris = CLAUDE_CALLBACKS.filter((cb) => presented.has(cb)); // șir exact, ordinea CLAUDE_CALLBACKS
  if (redirect_uris.length === 0) return { ok: false, reason: "redirect_uris_no_claude_callback" };

  const rawName = doc.client_name;
  const client_name = typeof rawName === "string" && rawName.length > 0 && rawName.length <= CLIENT_NAME_MAX
    && !CONTROL_CHARS.test(rawName) ? rawName : null;

  return {
    ok: true,
    registration: {
      client_id:                  clientIdUrl,
      client_type:                "public",
      token_endpoint_auth_method: "none",
      grant_types:                ["authorization_code", "refresh_token"],
      redirect_uris,
      client_name,
    },
  };
}

/** Rândul complet scris de provizionare: registration-ul validat + `status = active`, `expires_at = null` (nu expiră). */
export interface CimdProvisionRow extends CimdRegistration {
  status:     "active";
  expires_at: null;
}

export function toCimdProvisionRow(registration: CimdRegistration): CimdProvisionRow {
  return { ...registration, status: "active", expires_at: null };
}

/** Un câmp care diferă între rândul existent și cel dorit (valorile NU sunt secrete: metadata publică de client). */
export interface CimdRowDifference { field: keyof CimdProvisionRow; existing: unknown; desired: unknown }

const SET_FIELDS:    readonly (keyof CimdProvisionRow)[] = ["grant_types", "redirect_uris"];
const SCALAR_FIELDS: readonly (keyof CimdProvisionRow)[] = ["client_id", "client_type", "token_endpoint_auth_method", "client_name", "status", "expires_at"];

function sameStringSet(a: unknown, b: readonly string[]): boolean {
  if (!isStringArray(a)) return false;
  const sa = new Set(a), sb = new Set(b);
  return sa.size === sb.size && [...sb].every((x) => sa.has(x));
}

/**
 * Diferențele dintre un rând existent în `oauth_client_registrations` (citit brut) și rândul dorit. `[]` = identic
 * (provizionare idempotentă, nimic de scris). `grant_types`/`redirect_uris` se compară ca MULȚIMI (ordinea din DB nu
 * contează); restul pe valoare exactă (`expires_at` existent trebuie să fie `null`). Un rând non-obiect → toate câmpurile
 * diferă (fail-closed: nu-l considerăm „deja provizionat”). Pur.
 */
export function diffCimdProvisionRow(existing: unknown, desired: CimdProvisionRow): CimdRowDifference[] {
  const o: Record<string, unknown> = typeof existing === "object" && existing !== null && !Array.isArray(existing)
    ? existing as Record<string, unknown> : {};
  const out: CimdRowDifference[] = [];
  for (const f of SCALAR_FIELDS) {
    if (o[f] !== desired[f]) out.push({ field: f, existing: o[f], desired: desired[f] });
  }
  for (const f of SET_FIELDS) {
    const want = desired[f] as readonly string[];
    if (!sameStringSet(o[f], want)) out.push({ field: f, existing: o[f], desired: want });
  }
  return out;
}

/**
 * S0 (design rev3 §9): câmpurile LOGABILE ale unui `client_id` necunoscut, DOAR dacă e un URL `https:` pe host exact
 * `claude.ai`/`claude.com` — originea + calea (fără query, fragment, userinfo; calea plafonată la 200 de caractere;
 * `URL` o percent-encodează, deci fără newline). Orice altceva → `null` (nu logăm `client_id`-uri arbitrare). Pur.
 */
export function claudeCimdClientIdLogFields(clientId: unknown): { origin: string; path: string } | null {
  if (typeof clientId !== "string" || clientId.length === 0) return null;
  let u: URL;
  try { u = new URL(clientId); } catch { return null; }
  if (u.protocol !== "https:" || !CLAUDE_CIMD_HOSTS.has(u.hostname)) return null;
  return { origin: u.origin, path: u.pathname.slice(0, LOG_PATH_MAX) };
}

/**
 * Lot OAuth staging §6 (revocarea din dashboard): `true` dacă `clientId` e un `client_id` CIMD de Claude — EXACT regula
 * URL-ului din `validateCimdDocument` (`checkClientIdUrl`): `https:`, host exact `claude.ai`/`claude.com`, fără
 * userinfo, fără port, fără fragment, cu cale, în formă canonică. Orice rând `oauth_client_registrations` provizionat
 * de `provisionCimdClient` trece; un client legacy (`tp_…`) sau un alt public → `false`. O singură sursă: NU există
 * un al doilea parser de „e Claude?". Pur, nu aruncă.
 */
export function isClaudeCimdClientId(clientId: unknown): boolean {
  return typeof clientId === "string" && checkClientIdUrl(clientId) === null;
}
