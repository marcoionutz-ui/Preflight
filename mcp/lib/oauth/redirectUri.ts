/**
 * lib/oauth/redirectUri.ts — U7 (redirect_uri hardening).
 *
 * PUR (fără importuri) → testabil izolat în tsx. Politica unică de siguranță pentru redirect URIs.
 *
 * `new URL()` acceptă `javascript:/data:/file:/vbscript:` ca „URL absolut valid" (execuție de cod la redirect),
 * iar un URL altfel valid poate ascunde vectori: fragment (`#…` — interzis de RFC 6749 §3.1.2 pentru redirect_uri),
 * userinfo (`user:pass@host` — poate păcăli owner-ul / masca hostul real), sau `http://` către un host non-loopback
 * (redirect în clar → cod interceptabil). Politica (U7): HTTPS + scheme custom native OK; HTTP doar loopback;
 * NICIODATĂ fragment sau userinfo; NICIODATĂ cele 4 scheme periculoase.
 */

const BLOCKED_PROTOCOLS = new Set(["javascript:", "data:", "file:", "vbscript:"]);
const LOOPBACK_HOSTS    = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True dacă `redirectUri` respectă politica de siguranță U7. Folosit la SCRIERE (addRedirectUri) și la MATCH (isAllowedRedirectUri). */
export function isSafeRedirectUri(redirectUri: string): boolean {
  let u: URL;
  try { u = new URL(redirectUri); } catch { return false; } // nu e un URL absolut valid

  const proto = u.protocol.toLowerCase();
  if (BLOCKED_PROTOCOLS.has(proto)) return false;             // execuție de cod la redirect
  if (u.hash !== "") return false;                            // fragment interzis (RFC 6749 §3.1.2)
  if (u.username !== "" || u.password !== "") return false;   // userinfo (spoofing / mascarea hostului)

  // HTTP permis DOAR pentru loopback (native/dev); orice alt host în clar → respins.
  if (proto === "http:" && !LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) return false;

  return true; // https:, scheme custom native (myapp://…), http loopback
}
