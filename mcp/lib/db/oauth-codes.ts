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
  type RefreshPayload,
  AUTH_CODE_CONSUME_LUA,
  AUTH_CODE_CONSUME_AND_ISSUE_LUA,
  AUTH_CODE_ISSUE_WITH_REFRESH_LUA,
  classifyConsumeResult,
  classifyIssueResult,
  parseAuthCode,
} from "./oauthAtomic";
import { mintToken, TOKEN_TTL_SEC, REFRESH_TTL_SEC, type TokenPayload } from "./oauth-tokens";
import { newFamilyId, mintRefreshToken, familyKey } from "./oauth-refresh";

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

/**
 * U7 (atomic issuance): consumă codul (compare-and-delete pe `raw`) ȘI scrie tokenul într-un SINGUR EVAL atomic.
 * Înlocuiește secvența `finalizeAuthCode` → `issueToken` din ruta /token: dacă Redis pica ÎNTRE ele, codul rămânea
 * ars fără token emis, iar clientul trebuia să reia tot flow-ul de /authorize. Acum e all-or-nothing — la eșec
 * nimic nu se persistă, clientul reia cu ACELAȘI cod.
 *   `issued`       → cod consumat + token scris atomic.
 *   `already_used` → codul a dispărut între peek și finalize (replay / dublă-trimitere) → invalid_grant.
 *   `unavailable`  → Redis jos/respins → 503 (NU emite un token pe un cod nesigilat).
 */
export type IssueResult =
  | { status: "issued"; token: string }
  | { status: "already_used" }
  | { status: "unavailable" };

export async function consumeCodeAndIssueToken(
  code:         string,
  raw:          string,
  tokenPayload: TokenPayload,
): Promise<IssueResult> {
  const r = getRedis();
  if (!r) return { status: "unavailable" };

  const { token, key, value } = mintToken(tokenPayload);
  try {
    const res = await r.eval(
      AUTH_CODE_CONSUME_AND_ISSUE_LUA,
      2,
      codeKey(code), key,
      raw, value, String(TOKEN_TTL_SEC),
    );
    const verdict = classifyIssueResult(res);
    if (verdict === "issued")       return { status: "issued", token };
    // SET NX a eșuat → tokenul NU s-a scris ȘI codul NU s-a șters (all-or-nothing) → 503 retry (nu ardem codul).
    if (verdict === "write_failed") return { status: "unavailable" };
    return { status: "already_used" };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * PH-4: emitere inițială la authorization_code CU refresh token. Consumă codul (compare-and-delete pe `raw`) ȘI scrie
 * access + refresh + cheia de familie, all-or-nothing (`AUTH_CODE_ISSUE_WITH_REFRESH_LUA`). Refresh-ul moștenește
 * client_id/scopes/audience/credential_version din access payload + un `family_id` NOU (rădăcina lanțului de rotație).
 *   `issued`       → cod consumat + access + refresh + familie scrise atomic.
 *   `already_used` → codul a dispărut între peek și finalize (replay) → invalid_grant.
 *   `unavailable`  → Redis jos/respins → 503 (NU emite pe un cod nesigilat).
 */
export type IssueWithRefreshResult =
  | { status: "issued"; token: string; refreshToken: string }
  | { status: "already_used" }
  | { status: "unavailable" };

export async function consumeCodeAndIssueWithRefresh(
  code:         string,
  raw:          string,
  tokenPayload: TokenPayload,
): Promise<IssueWithRefreshResult> {
  const r = getRedis();
  if (!r) return { status: "unavailable" };

  const familyId = newFamilyId();
  // cgpt #1: access token-ul emis la authorization_code poartă ACELAȘI family_id ca refresh-ul → dacă familia e
  // revocată (reuse-detection pe lanț), și access token-ul emis inițial moare în resolveAuth, nu doar refresh-ul.
  const access   = mintToken({ ...tokenPayload, family_id: familyId });
  const refreshPayload: RefreshPayload = {
    client_id:          tokenPayload.client_id,
    scopes:             tokenPayload.scopes,
    audience:           tokenPayload.audience ?? "", // la auth_code audience e mereu setat (PH-3)
    credential_version: tokenPayload.credential_version,
    family_id:          familyId,
    issued_at:          tokenPayload.issued_at,
  };
  const refresh = mintRefreshToken(refreshPayload);

  try {
    const res = await r.eval(
      AUTH_CODE_ISSUE_WITH_REFRESH_LUA,
      4,
      codeKey(code), access.key, refresh.key, familyKey(familyId),
      raw, access.value, refresh.value,
      String(TOKEN_TTL_SEC), String(REFRESH_TTL_SEC), refresh.hash,
    );
    const verdict = classifyIssueResult(res);
    if (verdict === "issued")       return { status: "issued", token: access.token, refreshToken: refresh.token };
    if (verdict === "write_failed") return { status: "unavailable" }; // cod PĂSTRAT → retry
    return { status: "already_used" };
  } catch {
    return { status: "unavailable" };
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
