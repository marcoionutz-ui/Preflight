/**
 * lib/oauth/redirectMatch.ts — PH-2a (compararea redirect_uri la /authorize, /token și DCR).
 *
 * PUR (compune doar cu `isSafeRedirectUri`) → testabil izolat în tsx.
 *
 * REGULA (OAuth 2.1 + RFC 8252): compararea redirect_uri preînregistrat vs. cel prezentat este MATCH EXACT de string
 * (RFC 6749 §3.1.2 / OAuth 2.1 §4.1.3) — fără wildcard, prefix sau host-only. SINGURA excepție e cea din
 * RFC 8252 §7.3 + §8.4 pentru redirecturile loopback ale aplicațiilor native: AS-ul TREBUIE să permită orice PORT,
 * dar DOAR pe IP-literal loopback — `127.0.0.1` și `[::1]`. `localhost` NU beneficiază de excepție (poate fi
 * redirecționat prin DNS/hosts către alt proces) → exact-match, inclusiv portul. Scheme/host/path/query rămân
 * identice; portul e singura diferență tolerată, și numai pe IP-literal.
 *
 * Fail-closed: ambele URI-uri trec întâi politica de siguranță U7 (`isSafeRedirectUri`) — fragment/userinfo/scheme
 * periculoase/http-non-loopback sunt respinse înainte de orice comparație.
 */
import { isSafeRedirectUri } from "./redirectUri";

// RFC 8252: excepția de port variabil se aplică EXCLUSIV IP-literalelor loopback, nu hostname-ului `localhost`.
const LOOPBACK_IP_LITERALS = new Set(["127.0.0.1", "[::1]"]);

/** http + host ∈ {127.0.0.1, [::1]} → candidat pentru excepția de port RFC 8252. */
function isHttpLoopbackIpLiteral(u: URL): boolean {
  return u.protocol.toLowerCase() === "http:" && LOOPBACK_IP_LITERALS.has(u.hostname.toLowerCase());
}

/**
 * True dacă `presented` se potrivește cu `registered` conform politicii de mai sus. Exact-match implicit; excepție de
 * port DOAR când AMBELE sunt http loopback IP-literal, cu scheme/host/path/query identice.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (!isSafeRedirectUri(registered) || !isSafeRedirectUri(presented)) return false;
  if (registered === presented) return true; // exact-match (acoperă și portul identic)

  let r: URL, p: URL;
  try { r = new URL(registered); p = new URL(presented); } catch { return false; }

  // Excepția RFC 8252 se aplică doar dacă AMBELE sunt http loopback IP-literal.
  if (!isHttpLoopbackIpLiteral(r) || !isHttpLoopbackIpLiteral(p)) return false;

  // host trebuie identic (127.0.0.1 ≠ [::1]); path + query identice; PORTUL e singura diferență permisă.
  return r.hostname.toLowerCase() === p.hostname.toLowerCase()
      && r.pathname === p.pathname
      && r.search   === p.search;
}

/**
 * True dacă `presented` se potrivește cu VREUNUL dintre redirect-urile preînregistrate (allowlist). Înlocuiește
 * `allowlist.includes(uri)` (exact-string) cu regula loopback-aware — clienții publici MCP folosesc porturi variabile.
 */
export function redirectUriMatchesAny(registered: readonly string[], presented: string): boolean {
  for (const r of registered) if (redirectUriMatches(r, presented)) return true;
  return false;
}
