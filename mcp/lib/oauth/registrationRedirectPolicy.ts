/**
 * lib/oauth/registrationRedirectPolicy.ts — PH-2a (allowlist POZITIV de redirect pt. ÎNREGISTRARE). PUR → tsx.
 *
 * `isSafeRedirectUri` (U7) e un DENYLIST: blochează 4 scheme periculoase + fragment/userinfo/http-non-loopback, dar
 * lasă să treacă `ftp:`, `mailto:`, `ws:`, `wss:` etc. Pentru ce ÎNREGISTRĂM (backfill confidențial + DCR public)
 * vrem un ALLOWLIST pozitiv: acceptăm EXPLICIT doar
 *   - `https:` (orice host),
 *   - `http:` DOAR loopback (127.0.0.1 / [::1] / localhost) — native/dev,
 *   - schemă custom native „private-use” în formă reverse-domain (conține punct, ex. `com.example.app:/cb`).
 * Orice altă schemă (ftp/mailto/ws/wss/file/data/javascript/vbscript sau o schemă fără punct) e RESPINSĂ.
 * Se compune peste U7 (fragment/userinfo/blocked rămân interzise).
 */

import { isSafeRedirectUri } from "./redirectUri";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Scheme web/periculoase care NU sunt „custom native”, chiar dacă ar conține un punct. */
const NON_NATIVE_SCHEMES = new Set([
  "http", "https", "ftp", "ftps", "ws", "wss", "mailto", "file", "data", "javascript", "vbscript", "blob", "about",
]);
const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/;

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** True DOAR dacă `uri` e în allowlist-ul pozitiv de înregistrare (și trece și politica U7). */
export function isAllowedRegistrationRedirect(uri: string): boolean {
  if (typeof uri !== "string" || uri.trim() === "") return false;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }

  // gardul U7 (fragment/userinfo/blocked/http-non-loopback) rămâne obligatoriu
  if (!isSafeRedirectUri(uri)) return false;

  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "https") return true;
  if (scheme === "http")  return isLoopbackHost(u.hostname);

  // custom native private-use: schemă validă, reverse-domain (conține punct), ne-web/ne-periculoasă
  if (SCHEME_RE.test(scheme) && scheme.includes(".") && !NON_NATIVE_SCHEMES.has(scheme)) return true;

  return false;
}
