/**
 * lib/db/oauth-codes.ts
 * Authorization codes — Redis, TTL 5 minute
 * Folosit în Authorization Code flow cu PKCE
 *
 * E4: codul NU se mai consumă (GETDEL) ÎNAINTE de validare. `peekAuthCode` doar CITEȘTE (fără ștergere) →
 * caller-ul validează client_id/redirect_uri/PKCE/client-activ pe payload → DOAR pe succes total `finalizeAuthCode`
 * face compare-and-delete ATOMIC. Astfel o cerere invalidă (verifier/client greșit) NU mai arde codul clientului
 * legitim (DoS de consum), iar single-use + anti-replay/concurență sunt garantate de CAD-ul din Lua.
 */

import { createHash, randomBytes } from "crypto";
import { getRedis }                from "./redis";
import { timingSafeStrEqual }      from "./constantTime";
import {
  type AuthCodePayload,
  type ConsumeResult,
  AUTH_CODE_CONSUME_LUA,
  classifyConsumeResult,
  parseAuthCode,
} from "./oauthAtomic";

export type { AuthCodePayload } from "./oauthAtomic";

const CODE_TTL_SEC = 5 * 60; // 5 minute

function codeKey(code: string): string {
  return `mcp:code:${code}`;
}

export async function issueAuthCode(payload: AuthCodePayload): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;

  const code = randomBytes(32).toString("hex");
  await r.set(codeKey(code), JSON.stringify(payload), "EX", CODE_TTL_SEC);
  return code;
}

/**
 * E4: rezultat DISCRIMINAT al citirii unui authorization code (nimic șters).
 *   `found`       → codul există; `payload` validat de formă + `raw` (blob-ul exact, pt. compare-and-delete la finalize).
 *   `absent`      → cheie inexistentă/expirată SAU blob corupt (necredibil) → clientul primește invalid_grant.
 *   `unavailable` → Redis jos/respins → NU putem verifica codul → caller-ul întoarce 503, nu invalid_grant (ar minți).
 */
export type AuthCodeLookup =
  | { status: "found"; payload: AuthCodePayload; raw: string }
  | { status: "absent" }
  | { status: "unavailable" };

/** E4: citește codul FĂRĂ să-l șteargă. Ștergerea vine abia la `finalizeAuthCode`, după ce validarea a trecut. */
export async function peekAuthCode(code: string): Promise<AuthCodeLookup> {
  const r = getRedis();
  if (!r) return { status: "unavailable" };

  try {
    const raw = await r.get(codeKey(code));
    if (!raw) return { status: "absent" };
    const payload = parseAuthCode(raw);
    if (!payload) return { status: "absent" }; // blob corupt = necanjabil → tratat ca absent
    return { status: "found", payload, raw };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * E4: consumă codul ATOMIC, o singură dată, DOAR după ce toată validarea a trecut. Compare-and-delete pe `raw`
 * (blob-ul exact citit la peek): șterge doar dacă valoarea curentă e neschimbată.
 *   `consumed`    → am câștigat cursa → emite token.
 *   `already_used`→ codul a fost deja consumat între peek și finalize (replay / dublă-trimitere concurentă) → invalid_grant.
 *   `unavailable` → Redis jos/respins → 503 (nu am putut sigila consumul; NU emite token pe un cod nesigilat).
 */
export async function finalizeAuthCode(
  code: string,
  raw:  string,
): Promise<ConsumeResult | "unavailable"> {
  const r = getRedis();
  if (!r) return "unavailable";

  try {
    const res = await r.eval(AUTH_CODE_CONSUME_LUA, 1, codeKey(code), raw);
    return classifyConsumeResult(res);
  } catch {
    return "unavailable";
  }
}

export function verifyCodeVerifier(verifier: string, challenge: string, method: string): boolean {
  // S256-only — "plain" PKCE is legacy fallback for clients that can't do
  // SHA256, which no client we support needs. Rejecting it outright avoids
  // downgrade risk without breaking anything currently in use.
  if (method !== "S256") return false;

  const computed = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  // E7: comparație constant-time a digesturilor PKCE, fără throw
  // dacă challenge-ul primit are altă lungime.
  return timingSafeStrEqual(computed, challenge);
}
