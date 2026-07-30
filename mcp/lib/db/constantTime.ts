/**
 * lib/db/constantTime.ts — E7 (comparație în timp constant pentru secrete/hash-uri).
 *
 * Frunză PURĂ (doar `crypto` builtin, zero importuri grele) → testabilă în tsx.
 *
 * De ce: `a === b` pe string-uri poate returna mai repede când prefixul diferă devreme (multe motoare JS
 * scurtcircuitează, deși comportamentul exact NU e garantat de spec) → un canal de timing prin care un atacator
 * care măsoară latența ar putea recupera valoarea stocată. E7 înlocuiește cele două comparații sensibile —
 * `client_secret` (verifySecret) și PKCE `code_verifier` (verifyCodeVerifier) — cu o comparație în TIMP CONSTANT.
 *
 * `crypto.timingSafeEqual` cere buffere de ACEEAȘI lungime (aruncă altfel) și o diferență de lungime ar scurge
 * lungimea prin throw. De aceea HASH-uim ambele părți la 32 de bytes ficși ÎNAINTE de comparare: comparația
 * digesturilor e constant-time (nu depinde de conținut), nu aruncă niciodată, iar sha256 fiind rezistent la
 * coliziuni un atacator nu poate forța egalitate falsă. (NB: hash-uirea în sine e proporțională cu lungimea
 * intrării — deci „constant-time" se referă la comparația digesturilor, nu la costul total; secretele/hash-urile
 * comparate aici au oricum lungime fixă.)
 *
 * Encoding `utf16le` (NU utf8): păstrează EXACT unitățile de cod ale string-ului JavaScript. utf8 colapsează
 * surogații singuratici invalizi (ex. `\uD800`, `\uD801`) toți la același caracter de înlocuire `�` → două
 * string-uri diferite ar produce ACELAȘI hash = fals pozitiv. utf16le menține semantica lui `===`.
 */

import { createHash, timingSafeEqual } from "crypto";

/**
 * `true` dacă `a` și `b` sunt egale, cu o comparație finală în timp constant. Hash-uiește ambele la sha256 (32B,
 * din unitățile utf16le ale string-ului) și compară bufferele cu `timingSafeEqual` → fără scurgere de lungime,
 * fără throw, aceeași semantică de egalitate ca `===`.
 */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf16le").digest();
  const hb = createHash("sha256").update(b, "utf16le").digest();
  return timingSafeEqual(ha, hb);
}
