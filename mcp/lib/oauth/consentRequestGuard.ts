/**
 * lib/oauth/consentRequestGuard.ts — PH-2 pas 6 frunză 5b-i (gărzile PURE ale POST-ului /consent).
 *
 * Zero I/O. Două verificări structurale înainte de orice decizie, ambele fail-closed:
 *   1. isFormUrlEncoded  — Content-Type trebuie să fie application/x-www-form-urlencoded (JSON/multipart/lipsă → reject).
 *   2. parseConsentForm  — body MĂRGINIT (MAX_CONSENT_BODY_BYTES, verificat înainte de parsare); extrage EXACT o dată
 *      fiecare câmp (txn_id/csrf_token/action); duplicat SAU lipsă → reject (RFC 6749 §3.1). Validează FORMATUL txn_id
 *      (contract cookie/resume), csrf (base64url) și action (structural, 1–32 [A-Za-z_-]). `action` NEcunoscut trece
 *      parse-ul (approve/deny/altceva) — semantica e decisă de decideConsentGrant, nu aici.
 *   3. isSameOriginRequest — apărare CSRF: Origin (autoritar când e prezent) SAU Referer trebuie să fie EXACT originea
 *      canonică. Niciunul pe un POST care schimbă starea → reject (browserele moderne trimit Origin pe POST).
 *
 * NOTĂ: `parseConsentForm` verifică lungimea DUPĂ ce body-ul e deja în memorie (defense-in-depth). Protecția COMPLETĂ e
 * în rută (5b-ii): citire mărginită a stream-ului la MAX_CONSENT_BODY_BYTES înainte de a materializa string-ul.
 */
import { isValidResumeTxnId } from "./sessionResume";

/** Plafon pe body-ul formularului de consent — 3 câmpuri minuscule; orice peste = abuz. Byte length (UTF-8). */
export const MAX_CONSENT_BODY_BYTES = 8 * 1024;

// ── 1. Content-Type ───────────────────────────────────────────────────────────────────────────────────
/** True DOAR pentru application/x-www-form-urlencoded (parametri ca `; charset=utf-8` permiși). Lipsă/JSON/multipart → false. */
export function isFormUrlEncoded(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0].trim().toLowerCase(); // ignoră parametrii (charset etc.), case-insensitive
  return mediaType === "application/x-www-form-urlencoded";
}

// ── 2. parse form ─────────────────────────────────────────────────────────────────────────────────────
export type ConsentFormParse =
  | { ok: true; txn_id: string; csrf_token: string; action: string }
  | { ok: false; reason: string };

const CSRF_RE   = /^[A-Za-z0-9_-]{16,256}$/; // base64url opac, mărginit (newAuthzCsrfToken → ~43 chars)
const ACTION_RE = /^[A-Za-z_-]{1,32}$/;      // structural: ne-gol, ≤32, doar litere/_/- (approve/deny/necunoscut)

export function parseConsentForm(body: string): ConsentFormParse {
  // Bounded input ÎNAINTE de parsare (defense-in-depth; ruta mărginește deja stream-ul). Byte length UTF-8, nu char.
  if (Buffer.byteLength(body, "utf8") > MAX_CONSENT_BODY_BYTES) return { ok: false, reason: "body prea mare" };
  const p = new URLSearchParams(body);
  // EXACT o dată pe fiecare câmp — duplicat (injecție de parametru) SAU lipsă → reject.
  for (const field of ["txn_id", "csrf_token", "action"] as const) {
    const n = p.getAll(field).length;
    if (n === 0) return { ok: false, reason: `câmp lipsă: ${field}` };
    if (n > 1)  return { ok: false, reason: `câmp duplicat: ${field}` };
  }
  const txn_id     = p.get("txn_id")     ?? "";
  const csrf_token = p.get("csrf_token") ?? "";
  const action     = p.get("action")     ?? "";
  if (!isValidResumeTxnId(txn_id)) return { ok: false, reason: "txn_id invalid (format)" };
  if (!CSRF_RE.test(csrf_token))   return { ok: false, reason: "csrf_token invalid (format)" };
  if (!ACTION_RE.test(action))     return { ok: false, reason: "action invalid (format/lungime)" }; // gol sau >32 → reject
  return { ok: true, txn_id, csrf_token, action };
}

// ── 2. CSRF: Origin/Referer ───────────────────────────────────────────────────────────────────────────
/** Originea (scheme://host:port) a unui URL, sau null dacă nu se parsează. Strip-uiește orice path. */
function originOf(u: string): string | null {
  try { return new URL(u).origin; } catch { return null; }
}

/**
 * True DOAR dacă un antet prezent se potrivește cu originea canonică. Origin e autoritar când e prezent; altfel cade
 * pe Referer. Nici Origin nici Referer → false (fail-closed pe un POST care schimbă starea). Origin opac ("null") sau
 * origine canonică coruptă → false. `canonicalOrigin` poate purta un path prefix (resolveBaseUrl) — reținem doar originea.
 */
export function isSameOriginRequest(origin: string | null, referer: string | null, canonicalOrigin: string): boolean {
  const canon = originOf(canonicalOrigin);
  if (!canon) return false; // origine canonică coruptă → fail-closed
  if (origin !== null && origin !== "") return originOf(origin) === canon;   // Origin autoritar (normalizat)
  if (referer !== null && referer !== "") return originOf(referer) === canon; // fallback Referer
  return false; // niciun antet de origine pe POST → fail-closed
}
