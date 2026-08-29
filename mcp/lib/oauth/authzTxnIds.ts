/**
 * lib/oauth/authzTxnIds.ts — PH-2 pas 6 frunză 3b-i (generatoare de identificatori pt. tranzacția de consent).
 *
 * `/api/oauth/authorize/start` generează, pentru o cerere OAuth interactivă nouă, trei identificatori opaci care intră în
 * `buildAuthzTransaction`:
 *   - `newAuthzTxnId()`   — cheia tranzacției (și valoarea din cookie-ul de resume + din `/authorize?txn_id=`). GARANȚIE:
 *     trece `isValidResumeTxnId` (base64url, 16–128) — altfel `setResumeCookie` ar arunca ori resume-ul ar respinge un
 *     txn_id pe care chiar noi l-am emis. 24 octeți → 32 caractere base64url (192 biți entropie).
 *   - `newAuthzCsrfToken()` — token anti-CSRF pt. ecranul de consent (verificat la POST-ul de consent, frunza 5). 32 octeți.
 *   - `newAuthzGrantId()`  — `grant_id` STICKY (generat ACUM, propagat prin txn → grant → cod). Coloana `oauth_grants.grant_id`
 *     e `uuid`, deci FORMA trebuie să fie un UUID (nu hex/base64url) ca insertul să nu fie respins de Postgres.
 *
 * Wrapper subțiri peste `node:crypto` — deterministe ca FORMĂ, deci testabile (lungime/charset/round-trip/unicitate).
 */

import { randomBytes, randomUUID } from "node:crypto";

/** Id-ul tranzacției de consent — base64url, 32 caractere. Trece `isValidResumeTxnId` (contract cookie/resume). */
export function newAuthzTxnId(): string {
  return randomBytes(24).toString("base64url"); // 24B → 32 base64url chars ∈ [16,128]
}

/** Token anti-CSRF pt. ecranul de consent — base64url, opac. Verificat la POST-ul de consent (frunza 5). */
export function newAuthzCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/** `grant_id` sticky — UUID (coloana `oauth_grants.grant_id` e `uuid`; forma non-UUID ar fi respinsă la insert). */
export function newAuthzGrantId(): string {
  return randomUUID();
}
