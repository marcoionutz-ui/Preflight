/**
 * lib/mcp/canaryPkce.ts — PH-12 12.5b-0 (driver Gate 1 auth-canary: PKCE + state, PUR).
 *
 * Partea CLIENT a PKCE (RFC 7636) pentru driver-ul de canary — server-ul are DOAR validatorii (`lib/oauth/pkce.ts`)
 * fiindcă el nu generează niciodată un verifier. Aici generăm perechea pe care un client public (Claude.ai connector)
 * o produce: `code_verifier` random + `code_challenge = BASE64URL-fără-padding(SHA-256(verifier))`, metoda `S256`.
 *
 * Contract cu serverul (dovedit în test): challenge-ul produs aici TREBUIE să fie exact ce recomputează
 * `verifyCodeVerifier` din `lib/db/oauth-codes.ts` — `createHash("sha256").update(verifier).digest("base64url")` —
 * altfel token exchange-ul ar da `invalid_grant` pe „code_verifier mismatch". De aceea folosim IDENTIC `digest("base64url")`
 * (base64url fără padding în Node), iar verifier-ul e `randomBytes(32).toString("base64url")` (43 caractere, toate în
 * unreserved-set base64url → trece `isValidCodeVerifier`). Auto-verificăm ambele cu validatorii serverului (fail-loud).
 *
 * PUR: zero I/O, doar `crypto`. Testabil în tsx. Fără leak: nu logăm nimic aici.
 */

import { randomBytes } from "crypto";
import { isValidCodeVerifier, isValidS256Challenge, PKCE_METHOD_S256, deriveS256Challenge } from "../oauth/pkce";

export interface PkcePair {
  verifier:  string;
  challenge: string;
  method:    "S256";
}

/**
 * Generează o pereche PKCE S256 validă (RFC 7636). `verifier` = 32 bytes random în base64url (43 caractere,
 * ~256 biți entropie); `challenge` = base64url-fără-padding(SHA-256(verifier)) — IDENTIC cu ce recomputează serverul.
 * Fail-loud dacă output-ul propriu nu trece validatorii serverului (nu emitem niciodată o pereche care ar fi respinsă).
 */
export function generatePkcePair(): PkcePair {
  const verifier  = randomBytes(32).toString("base64url");
  // SURSĂ UNICĂ: aceeași funcție pe care o folosește `verifyCodeVerifier` la server → challenge-ul produs aici e EXACT
  // ce va accepta serverul (fără oglindă duplicată care poate divergea; blocker cgpt 12.5b-0).
  const challenge = deriveS256Challenge(verifier);

  // Auto-verificare cu validatorii REALI ai serverului — dacă vreodată encoding-ul divergează, crapă AICI, nu la /token.
  if (!isValidCodeVerifier(verifier)) {
    throw new Error("canaryPkce: generated verifier failed RFC 7636 format check");
  }
  if (!isValidS256Challenge(challenge)) {
    throw new Error("canaryPkce: generated challenge failed S256 canonical format check");
  }

  return { verifier, challenge, method: PKCE_METHOD_S256 };
}

/**
 * `state` opac pentru round-trip anti-CSRF/mixup (RFC 6749 §10.12). Random, base64url, ne-gol. Driver-ul îl trimite
 * la /authorize și verifică EXACT valoarea întoarsă pe callback (`verifyCallback`).
 */
export function generateState(): string {
  return randomBytes(16).toString("base64url");
}
