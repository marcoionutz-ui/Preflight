/**
 * lib/db/oauth-refresh.ts — PH-4 (refresh tokens: mint / peek / rotate, Redis-bound).
 *
 * Logica atomică + clasificatorii puri trăiesc în `oauthAtomic.ts` (Lua + `classifyRefreshRotate`, testabile izolat).
 * Aici doar legăm la Redis. Refresh-urile sunt stocate HASH-uite (`mcp:refresh:<sha256>`); cheia de familie
 * (`mcp:refresh_family:<family_id>`) ține hash-ul refresh-ului CURENT valid (sau sentinela REVOKED) și e sursa de
 * adevăr pentru rotație + reuse-detection.
 */

import { randomBytes }            from "crypto";
import { getRedis }                from "./redis";
import { hashCredential, refreshTokenKey, refreshFamilyKey } from "./oauthStorageKeys";
import { mintToken, TOKEN_TTL_SEC, REFRESH_TTL_SEC, type TokenPayload } from "./oauth-tokens";
import {
  REFRESH_ROTATE_LUA, classifyRefreshRotate,
  REFRESH_FAMILY_REVOKED,
} from "./oauthAtomic";
// PH-2 step 10.5b: citirea refresh-ului e DISCRIMINATĂ (client SAU user) — `parseStoredRefresh` rutează pe
// `subject_kind`, deci `RefreshLookup.payload` e uniunea `AnyRefreshPayload`. Rotația e generică pe formă:
// accesează DOAR `family_id` (prezent pe ambele), iar `mintToken`/`mintRefreshToken` serializează orice payload.
import { parseStoredRefresh, type AnyRefreshPayload } from "../oauth/refreshPayloadModel";
import type { UserTokenPayload } from "../oauth/tokenPayloadModel";

// familyKey: re-export DELEGAT spre sursa unică `refreshFamilyKey` (12.5b-5a). Păstrat ca `export function familyKey`
// fiindcă e importat de `oauth-codes` + `userAuth.integration` și verificat de guard-ul de sursă `refresh.test` (check
// 28). Formatul cheii trăiește acum EXCLUSIV în `oauthStorageKeys` (fără prefix hardcodat aici).
export function familyKey(familyId: string): string { return refreshFamilyKey(familyId); }

/** Id de familie nou (lanț de rotație) — random, opac. */
export function newFamilyId(): string { return randomBytes(16).toString("hex"); }

/** Mint refresh token FĂRĂ scriere → token plain (de returnat clientului) + hash + cheie Redis + valoare serializată.
 *  PH-2 10.4c: generic pe payload — acceptă și `UserRefreshPayload` (finalizat), nu doar `RefreshPayload` client. */
export function mintRefreshToken<T>(payload: T): { token: string; hash: string; key: string; value: string } {
  const token = randomBytes(32).toString("hex");
  const hash  = hashCredential(token);            // hash-ul e cerut de Lua (pointer de familie); cheia vine din sursa unică
  return { token, hash, key: refreshTokenKey(token), value: JSON.stringify(payload) };
}

export type RefreshLookup =
  | { status: "found"; payload: AnyRefreshPayload } // PH-2 10.5b: client SAU user (discriminat pe subject_kind)
  | { status: "absent" }
  | { status: "unavailable" };

/**
 * Citește payload-ul unui refresh (fără mutații). `absent` = hash inexistent/expirat SAU blob corupt (necredibil).
 * `unavailable` = Redis jos/respins → caller-ul întoarce 503, NU invalid_grant (n-am putut verifica).
 * NB: prezența înregistrării NU garantează validitatea — un refresh superseded (rotit) încă există (expiră prin TTL);
 * VALIDITATEA e decisă de rotația atomică vs. pointerul de familie (vezi `rotateRefreshToken`).
 */
export async function peekRefreshToken(token: string): Promise<RefreshLookup> {
  const r = getRedis();
  if (!r) return { status: "unavailable" };
  try {
    const raw = await r.get(refreshTokenKey(token));
    if (!raw) return { status: "absent" };
    // Citire DISCRIMINATĂ fail-closed: blob user→formă user, subject_kind absent→formă client, orice altceva→null.
    const payload = parseStoredRefresh(raw);
    if (!payload) return { status: "absent" };
    return { status: "found", payload };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * PH-4 (cgpt #1/#2r — grant-level revocation, FAIL-CLOSED): starea familiei unui token, citită de `resolveAuth` la
 * FIECARE cerere. Invariantă: cât timp un access token (TTL 24h) e viu, cheia de familie (TTL 30 zile, sliding la
 * fiecare rotație) TREBUIE să existe și să fie un hash valid. Deci absența/coruperea cheii NU e „grant încheiat
 * natural", ci o invariantă RUPTĂ → respins (OAuth 2.1 §4.3.1: grantul refresh-ului trebuie să fie încă activ).
 *   `active`      → hash valid de 64 hex (refresh-ul curent al lanțului).
 *   `revoked`     → sentinela REVOKED (reuse-detection pe lanț sau logout).
 *   `inactive`    → cheie ABSENTĂ (nil) SAU valoare malformată (nici hash, nici sentinela) → grant inactiv → 401.
 *   `unavailable` → Redis jos/respins → caller-ul face retry apoi 503 (NU 401 fals).
 * Vechea variantă trata orice ≠ REVOKED (inclusiv nil/gunoi) ca `active` = fail-OPEN; acum e fail-CLOSED.
 */
export type FamilyState = "active" | "revoked" | "inactive" | "unavailable";

const FAMILY_HASH_RE = /^[0-9a-f]{64}$/;

export async function getFamilyState(familyId: string): Promise<FamilyState> {
  const r = getRedis();
  if (!r) return "unavailable";
  try {
    const v = await r.get(familyKey(familyId));
    if (v === null)                    return "inactive"; // cheie absentă/expirată cât access-ul e viu = invariantă ruptă
    if (v === REFRESH_FAMILY_REVOKED)  return "revoked";
    if (FAMILY_HASH_RE.test(v))        return "active";
    return "inactive";                                    // valoare malformată = necredibil → inactiv (fail-closed)
  } catch {
    return "unavailable";
  }
}

export type RefreshRotateResult =
  | { status: "rotated"; accessToken: string; refreshToken: string }
  | { status: "invalid" }         // familie expirată/inexistentă → invalid_grant
  | { status: "revoked" }         // familia era deja revocată → invalid_grant
  | { status: "reuse_detected" }  // refresh superseded reutilizat → familia REVOCATĂ acum → invalid_grant
  | { status: "unavailable" };    // Redis jos → 503 retry

/**
 * ROTAȚIE atomică: emite access + refresh noi, mută `family.current` pe noul refresh, all-or-nothing. Reuse-detection
 * e în Lua (refresh prezentat ≠ current → revocă familia). Caller-ul a validat deja identitatea (client — credential_version
 * pt. client; grant+cont pt. user) + scope narrowing pe payload-ul din `peekRefreshToken`; `newRefreshPayload` păstrează
 * ACELAȘI `family_id`.
 *
 * PH-2 10.5b — GENERIC pe formă: `accessPayload` e client (`TokenPayload`) SAU user (`UserTokenPayload`), iar
 * `newRefreshPayload` e `AnyRefreshPayload`. Corpul accesează DOAR `newRefreshPayload.family_id` (obligatoriu pe ambele
 * forme stocate); `mintToken`/`mintRefreshToken` sunt generice (serializează orice payload deja validat de builder).
 */
export async function rotateRefreshToken(
  oldToken:          string,
  accessPayload:     TokenPayload | UserTokenPayload,
  newRefreshPayload: AnyRefreshPayload,
): Promise<RefreshRotateResult> {
  const r = getRedis();
  if (!r) return { status: "unavailable" };

  const oldHash = hashCredential(oldToken);
  const access  = mintToken(accessPayload);
  const refresh = mintRefreshToken(newRefreshPayload);
  const famKey  = familyKey(newRefreshPayload.family_id);

  try {
    const res = await r.eval(
      REFRESH_ROTATE_LUA,
      3,
      famKey, refresh.key, access.key,
      oldHash, refresh.value, access.value,
      String(REFRESH_TTL_SEC), String(TOKEN_TTL_SEC), refresh.hash,
    );
    const verdict = classifyRefreshRotate(res);
    if (verdict === "rotated")        return { status: "rotated", accessToken: access.token, refreshToken: refresh.token };
    if (verdict === "reuse_detected") return { status: "reuse_detected" };
    if (verdict === "revoked")        return { status: "revoked" };
    if (verdict === "write_failed")   return { status: "unavailable" }; // SET NX collision → retry, nu consumăm
    return { status: "invalid" };
  } catch {
    return { status: "unavailable" };
  }
}
