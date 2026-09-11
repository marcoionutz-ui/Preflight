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

import { randomBytes }             from "crypto";
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
import { authzTxnKey, AUTHZ_TXN_CONSUME_ISSUE_LUA, classifyTxnConsumeIssue } from "./authzTxnStore";
import { mintToken, TOKEN_TTL_SEC, REFRESH_TTL_SEC, type TokenPayload } from "./oauth-tokens";
import { newFamilyId, mintRefreshToken, familyKey } from "./oauth-refresh";
import { finalizeUserTokenPayload, type UserTokenDraft } from "../oauth/tokenPayloadModel";
import { finalizeUserRefreshPayload, type UserRefreshDraft } from "../oauth/refreshPayloadModel";
import { deriveS256Challenge } from "../oauth/pkce";

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

// ── PH-2 pas 6 frunză 5: consume txn + issue code ATOMIC (poarta de concurență a Approve-ului) ──
const CONSUME_ISSUE_MAX_ATTEMPTS = 5; // retry pe coliziune de cod (astronomic improbabil pe 32B random) → apoi fail-closed

export type ConsumeIssueOutcome =
  | { status: "issued"; code: string }
  | { status: "gone" }        // txn absentă/schimbată/consumată (double-submit sau expirată la mijloc) → NU emite
  | { status: "unavailable" }; // eșec SAU stare NECUNOSCUTĂ (throw = poate consumată; invalid; collision persistent) → 503

/**
 * Consumă tranzacția de consent (compare-and-delete pe `txnRaw`) ȘI emite un authorization code, ÎNTR-O SINGURĂ op Lua
 * (`AUTHZ_TXN_CONSUME_ISSUE_LUA`) — poarta de concurență a Approve-ului: serializează double-submit-ul și elimină
 * fereastra „txn consumată dar cod nescris". Generează cod random; pe `collision` (SET NX picat) reîncearcă cu ALT cod
 * (txn NEATINSĂ), până la MAX_ATTEMPTS. Pe `gone` NU emite.
 *
 * ⚠️ `unavailable` (503) = eșec SAU stare NECUNOSCUTĂ, NU o garanție că txn e intactă: un `throw` poate însemna că Lua
 * A RULAT pe server (txn consumată + cod scris) dar reply-ul s-a pierdut pe conexiune. (`collision` persistent = txn
 * sigur NEatinsă; `invalid` = rezultat anormal, necunoscut.) Caller-ul NU trebuie să presupună pe `unavailable` că 503
 * a păstrat txn — retry-ul corect e RE-RULAREA întregului flux (readAuthzTxn → `gone` ⇒ eroare / `found` ⇒ re-emite),
 * NU o re-emitere oarbă. Emiterea codului e AT-MOST-ONCE, nu exactly-once. NU șterge txn pe niciun eșec explicit.
 */
export async function consumeAuthzTxnAndIssueCode(
  txnId:   string,
  txnRaw:  string,
  payload: AuthCodePayload,
  client = getRedis(),
): Promise<ConsumeIssueOutcome> {
  if (!client) return { status: "unavailable" };
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt < CONSUME_ISSUE_MAX_ATTEMPTS; attempt++) {
    const code = randomBytes(32).toString("hex");
    let verdict: ReturnType<typeof classifyTxnConsumeIssue>;
    try {
      const res = await client.eval(
        AUTHZ_TXN_CONSUME_ISSUE_LUA, 2,
        authzTxnKey(txnId), codeKey(code),
        txnRaw, body, String(CODE_TTL_SEC),
      );
      verdict = classifyTxnConsumeIssue(res);
    } catch {
      // throw = stare NECUNOSCUTĂ: Lua poate fi rulat pe server (txn consumată, cod scris) dar reply-ul s-a pierdut. NU
      // presupunem txn intactă — vezi contractul de mai sus (`unavailable` ≠ garanție că txn există).
      return { status: "unavailable" };
    }
    if (verdict === "issued")  return { status: "issued", code };
    if (verdict === "gone")    return { status: "gone" };
    if (verdict === "invalid") return { status: "unavailable" }; // rezultat Lua necunoscut → fail-closed (stare incertă)
    // verdict === "collision" → cheia code ocupată; alt cod, reîncearcă (txn NEATINSĂ pe SET NX picat)
  }
  return { status: "unavailable" }; // coliziuni persistente (SET NX picat de fiecare dată → txn sigur NEatinsă), tot 503
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

/**
 * PH-2 step 10.4c: emitere inițială la authorization_code pentru un cod cu identitate de USER. Analog exact cu
 * `consumeCodeAndIssueWithRefresh` (ACELAȘI Lua `AUTH_CODE_ISSUE_WITH_REFRESH_LUA`, ACELEAȘI TTL-uri), dar payload-urile
 * serializate sunt USER-shaped (access + refresh cu identitate `user_id`/`grant_id`/`entitlement_version`, FĂRĂ
 * `credential_version`). `family_id` NOU se generează aici și e comun access + refresh (revocare la nivel de grant, ca
 * la forma client). Draft-urile (fără familie) vin din planner-ul pur (10.4b); `finalize*` le sigilează cu familia +
 * ARUNCĂ dacă payload-ul rezultat nu-i valid (fail-closed: mai bine 500 decât un token/refresh nerevocabil stocat).
 *   `issued` → cod consumat + access + refresh + familie scrise atomic. `already_used`/`unavailable` ca la varianta client.
 */
export async function consumeCodeAndIssueUserWithRefresh(
  code:         string,
  raw:          string,
  accessDraft:  UserTokenDraft,
  refreshDraft: UserRefreshDraft,
): Promise<IssueWithRefreshResult> {
  const r = getRedis();
  if (!r) return { status: "unavailable" };

  const familyId = newFamilyId();
  const access   = mintToken(finalizeUserTokenPayload(accessDraft, familyId));
  const refresh  = mintRefreshToken(finalizeUserRefreshPayload(refreshDraft, familyId));

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

  // 12.5b-0 (blocker cgpt): derivarea S256 trăiește ACUM într-o singură funcție (`deriveS256Challenge` din
  // lib/oauth/pkce.ts), folosită ȘI de generatorul de canary → imposibil de divergat formula. Comportament identic.
  const computed = deriveS256Challenge(verifier);
  // E7: comparație constant-time a digesturilor PKCE, fără throw
  // dacă challenge-ul primit are altă lungime.
  return timingSafeStrEqual(computed, challenge);
}
