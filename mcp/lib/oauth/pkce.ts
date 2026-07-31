/**
 * lib/oauth/pkce.ts — E1 (PKCE strict, RFC 7636).
 *
 * Frunză PURĂ (zero importuri; doar regex/string) → testabilă în tsx.
 *
 * Restul hardening-ului PKCE (challenge obligatoriu la /authorize, S256-only, redirect_uri allowlist, plain
 * respins, .well-known S256) e deja în cod. Piesa care lipsea din scope-ul „PKCE hardening" e VALIDAREA DE FORMAT
 * RFC 7636: fără ea, /authorize accepta orice `code_challenge` ne-gol (chiar un blob care nu poate fi niciodată
 * satisfăcut de vreun verifier → cod emis degeaba), iar /token accepta orice `code_verifier` — inclusiv unul
 * mult sub minimul de entropie cerut de spec. Validăm ambele la formatul CANONIC, devreme, cu mesaje explicite.
 */

export const PKCE_METHOD_S256 = "S256";

// RFC 7636 §4.1: code_verifier = 43–128 caractere din unreserved set = ALPHA / DIGIT / "-" / "." / "_" / "~".
// Lungimea minimă (43) garantează ≥256 biți de entropie când verifier-ul e generat aleator, cum cere spec-ul.
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

// RFC 7636 §4.2: code_challenge (S256) = BASE64URL-fără-padding(SHA-256(verifier)). SHA-256 = 32 bytes = 256 biți.
// base64url fără padding pe 32 bytes = 43 caractere, dar ULTIMUL caracter e restricționat: 43×6=258 biți codează
// 256 de biți de date + 2 biți de padding care TREBUIE să fie zero → doar caracterele al căror index e ≡ 0 (mod 4)
// pot apărea pe poziția finală = [AEIMQUYcgkosw048] (indici 0,4,8,…,60). Un „43 base64url + orice ultim caracter"
// ar accepta valori care nu pot fi rezultatul canonic al SHA-256 → le respingem (trailing-bits necanonici).
const S256_CHALLENGE_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** `true` dacă `v` respectă formatul RFC 7636 de code_verifier (43–128 caractere unreserved). */
export function isValidCodeVerifier(v: string): boolean {
  return typeof v === "string" && CODE_VERIFIER_RE.test(v);
}

/** `true` dacă `c` e un code_challenge S256 canonic (43 caractere base64url, fără padding). */
export function isValidS256Challenge(c: string): boolean {
  return typeof c === "string" && S256_CHALLENGE_RE.test(c);
}

/**
 * Rezultat DISCRIMINAT al validării PKCE la /authorize. `ok:false` poartă un mesaj gata de afișat
 * (errorPage) — NU redirectăm eroarea către redirect_uri-ul (posibil netrusted) din request.
 */
export type PkceChallengeCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validează perechea (code_challenge, code_challenge_method) primită la /authorize. PKCE e OBLIGATORIU:
 * metoda trebuie să fie EXACT „S256" (nu gol, nu „plain", nu altă variantă — downgrade blocat), iar challenge-ul
 * trebuie să fie în formatul canonic base64url de 43 de caractere. Astfel nu emitem niciodată un authorization
 * code legat de un challenge malformat pe care niciun verifier nu-l poate satisface.
 */
export function validateAuthorizeChallenge(challenge: string, method: string): PkceChallengeCheck {
  if (method !== PKCE_METHOD_S256) {
    return {
      ok:     false,
      reason: `PKCE is required: code_challenge_method must be "S256" (got "${method || "none"}").`,
    };
  }
  if (!isValidS256Challenge(challenge)) {
    return {
      ok:     false,
      reason: "PKCE is required: code_challenge must be a 43-character base64url (S256) value.",
    };
  }
  return { ok: true };
}
