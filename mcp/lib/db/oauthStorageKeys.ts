/**
 * lib/db/oauthStorageKeys.ts — PH-12 12.5b-5a (SURSĂ UNICĂ pentru cheile Redis ale credențialelor OAuth).
 *
 * Modul PUR (doar `crypto`) care deține FORMATUL cheilor de stocare a credențialelor OAuth. Toate call-site-urile —
 * `oauth-tokens`, `oauth-refresh`, `oauth-codes` ȘI cleanup-ul de canary (12.5b-5a) — construiesc cheile DOAR prin
 * aceste helper-e, deci prefixul (`mcp:token:` / `mcp:refresh:` / `mcp:refresh_family:` / `mcp:code:`) nu mai e
 * hardcodat în mai multe locuri care pot deriva de contract.
 *
 * API pe FORMA CORECTĂ direct (token brut vs id de familie vs cod) → fără footgun „helperul așteaptă hash sau token
 * brut?": access + refresh se hash-uiesc AICI, o singură dată. Familia + codul folosesc id-ul/codul ca atare (codul e
 * deja un secret opac de 32B cu TTL 5 min; familia e un id opac) — oglindesc EXACT stocarea din modulele DB.
 */

import { createHash } from "crypto";

/** sha256 hex al unui secret opac (access/refresh token). Sursa unică a hash-ului de credențial. */
export function hashCredential(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

/** Cheia Redis a unui ACCESS token, din tokenul BRUT (`mcp:token:<sha256>`). */
export function accessTokenKey(plainToken: string): string {
  return `mcp:token:${hashCredential(plainToken)}`;
}

/** Cheia Redis a unui REFRESH token, din tokenul BRUT (`mcp:refresh:<sha256>`). */
export function refreshTokenKey(plainToken: string): string {
  return `mcp:refresh:${hashCredential(plainToken)}`;
}

/** Cheia Redis a POINTER-ului de familie de refresh, din `family_id` (`mcp:refresh_family:<family_id>`). */
export function refreshFamilyKey(familyId: string): string {
  return `mcp:refresh_family:${familyId}`;
}

/** Cheia Redis a unui AUTHORIZATION CODE, din cod (`mcp:code:<code>`). Codul NU se hash-uiește (oglindește stocarea). */
export function authCodeKey(code: string): string {
  return `mcp:code:${code}`;
}
