/**
 * lib/db/authzTxnStoreIo.ts — PH-2 step 10.3b-iv frunză 3 (wrapperele I/O peste `authzTxnStore` leaf).
 *
 * Analog `oauth-codes.ts` peste `oauthAtomic.ts`: leaf-ul (`authzTxnStore.ts`) rămâne PUR (chei + Lua + clasificatori,
 * ZERO importuri grele, tsx-testabil), iar acest fișier leagă la `getRedis()` cele 4 operații I/O ale fluxului
 * `/authorize` (10.3b-iv): CREATE (SET NX EX), READ (discriminat), BIND (CAS pe blob, sticky-user via `bindUser` pur) și
 * CONSUME (compare-and-delete). Toate întorc `unavailable` la Redis jos/respins (client null / throw) → ruta face 503,
 * NU tratează necunoscutul ca „absent" (ar minți fluxul de consent).
 *
 * READ e DISCRIMINAT (cerință cgpt): `found {txn, raw} | absent | corrupt | unavailable`. `raw` = blob-ul EXACT stocat,
 * necesar pentru BIND (CAS pe blob-ul citit) și CONSUME (compare-and-delete). Un blob care nu-i JSON valid SAU nu trece
 * `isValidAuthzTransaction` → `corrupt` (fail-closed: nu-l tratăm ca tranzacție utilizabilă), NU `absent`.
 *
 * Clientul e injectabil (`client = getRedis()`) DOAR ca seam de test (unit cu client fake) — producția folosește
 * singleton-ul real. Serializarea e mereu `JSON.stringify(txn)` (compact, ordine de chei stabilă) → `raw`-ul returnat de
 * READ e byte-identic cu ce compară CAS/compare-and-delete.
 */

import { getRedis } from "./redis";
import {
  authzTxnKey, AUTHZ_TXN_TTL_SEC,
  classifyTxnCreate, type TxnCreateResult,
  AUTHZ_TXN_CONSUME_LUA, classifyTxnConsume, type TxnConsumeResult,
  AUTHZ_TXN_BIND_CAS_LUA, classifyTxnCas,
  authzActionClaimKey, AUTHZ_TXN_ACTION_CLAIM_LUA, classifyActionClaim, type AuthzTxnAction,
} from "./authzTxnStore";
import { bindUser, isValidAuthzTransaction, type AuthzTransaction } from "../oauth/authzTransaction";

type RedisClient = ReturnType<typeof getRedis>;

// ── CREATE (SET NX EX) ─────────────────────────────────────────────────────────
export type CreateAuthzTxnResult = TxnCreateResult | "invalid" | "unavailable"; // "created" | "collision" | "invalid" | "unavailable"

/**
 * Creează tranzacția one-time (SET NX EX). Coliziune pe txn_id existent → `collision` (NU suprascrie). O tranzacție
 * malformată e RESPINSĂ (`invalid`) FĂRĂ să atingă Redis — nu stocăm un blob pe care `readAuthzTxn` l-ar respinge oricum
 * ca `corrupt` (fail-closed la scriere, nu doar la citire).
 */
export async function createAuthzTxn(
  txn:    AuthzTransaction,
  client: RedisClient = getRedis(),
): Promise<CreateAuthzTxnResult> {
  if (!isValidAuthzTransaction(txn)) return "invalid";
  if (!client) return "unavailable";
  try {
    const res = await client.set(authzTxnKey(txn.txn_id), JSON.stringify(txn), "EX", AUTHZ_TXN_TTL_SEC, "NX");
    return classifyTxnCreate(res);
  } catch {
    return "unavailable";
  }
}

// ── READ (discriminat) ─────────────────────────────────────────────────────────
export type AuthzTxnReadResult =
  | { status: "found"; txn: AuthzTransaction; raw: string } // `raw` = blob EXACT (pt. CAS + compare-and-delete)
  | { status: "absent" }
  | { status: "corrupt" }       // JSON stricat SAU formă invalidă → fail-closed (nu utilizabil)
  | { status: "unavailable" };  // Redis jos/respins → 503, NU „absent"

/** Citește tranzacția FĂRĂ s-o consume; discriminat + `raw` pe `found` (necesar CAS/compare-and-delete). */
export async function readAuthzTxn(
  txnId:  string,
  client: RedisClient = getRedis(),
): Promise<AuthzTxnReadResult> {
  if (!client) return { status: "unavailable" };
  try {
    const raw = await client.get(authzTxnKey(txnId));
    if (raw === null || raw === undefined) return { status: "absent" };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { status: "corrupt" }; }
    // Legătura ATOMICĂ cheie↔identitate (cgpt): blob-ul trebuie să declare EXACT txn_id-ul cheii citite. Altfel
    // `read` pe cheia X ar întoarce o tranzacție cu `txn_id: Y`, iar `bindAuthzTxnUser`/`consumeAuthzTxn` (care
    // construiesc cheia din `txn.txn_id`) ar opera pe cheia Y → identitate ruptă. Nepotrivire → `corrupt`, fail-closed.
    if (!isValidAuthzTransaction(parsed) || parsed.txn_id !== txnId) return { status: "corrupt" };
    return { status: "found", txn: parsed, raw };
  } catch {
    return { status: "unavailable" };
  }
}

// ── BIND (CAS pe blob; sticky-user via bindUser pur) ───────────────────────────
export type BindAuthzTxnResult =
  | { status: "updated"; txn: AuthzTransaction; raw: string } // noul txn legat + noul `raw` (pt. consume ulterior)
  | { status: "reject";  reason: string }  // bindUser a respins (rebind la alt user — logout/account-switch)
  | { status: "conflict" }                 // CAS pierdut (blob-ul s-a schimbat între read și bind) → re-read + retry
  | { status: "absent" }                   // tranzacție dispărută
  | { status: "expired" }                  // fără TTL valid (fereastră de consent moartă)
  | { status: "unavailable" };

/**
 * Leagă userul Supabase de o tranzacție CITITĂ (`current` = `{txn, raw}` din `readAuthzTxn`). `bindUser` (pur) e
 * STICKY: leagă o tranzacție nelegată SAU confirmă ACELAȘI user; RESPINGE rebind la alt user. CAS pe `current.raw`
 * păstrează TTL-ul rămas (nu extinde fereastra) → aplică noul blob DOAR dacă cel curent e neschimbat.
 */
export async function bindAuthzTxnUser(
  current: { txn: AuthzTransaction; raw: string },
  userId:  string,
  client:  RedisClient = getRedis(),
): Promise<BindAuthzTxnResult> {
  if (!client) return { status: "unavailable" };

  const bound = bindUser(current.txn, userId);
  if (!bound.ok) return { status: "reject", reason: bound.error };

  const newRaw = JSON.stringify(bound.txn);
  try {
    const res = await client.eval(AUTHZ_TXN_BIND_CAS_LUA, 1, authzTxnKey(current.txn.txn_id), current.raw, newRaw);
    const verdict = classifyTxnCas(res); // "updated" | "absent" | "expired" | "conflict"
    if (verdict === "updated") return { status: "updated", txn: bound.txn, raw: newRaw };
    return { status: verdict };
  } catch {
    return { status: "unavailable" };
  }
}

// ── CONSUME (compare-and-delete pe blob exact) ─────────────────────────────────
export type ConsumeAuthzTxnResult = TxnConsumeResult | "unavailable"; // "consumed" | "gone" | "unavailable"

/** Consumă one-time tranzacția (compare-and-delete pe `raw` exact). A doua consumare / blob greșit → `gone`. */
export async function consumeAuthzTxn(
  txnId:  string,
  raw:    string,
  client: RedisClient = getRedis(),
): Promise<ConsumeAuthzTxnResult> {
  if (!client) return "unavailable";
  try {
    const res = await client.eval(AUTHZ_TXN_CONSUME_LUA, 1, authzTxnKey(txnId), raw);
    return classifyTxnConsume(res);
  } catch {
    return "unavailable";
  }
}

// ── ACTION CLAIM (arbitrare atomică cross-action, ÎNAINTE de efecte secundare) ──
export type ClaimActionOutcome =
  | { status: "won" }                          // am revendicat primul → produc efecte
  | { status: "idempotent" }                   // deja revendicată de ACEEAȘI acțiune (retry) → pot re-rula sigur
  | { status: "lost"; winner: AuthzTxnAction } // cealaltă acțiune VALIDĂ a câștigat → NU ating nimic
  | { status: "unavailable" };                 // Redis jos/respins / rezultat necunoscut → 503 (fail-closed)

/**
 * Revendică ATOMIC txn-ul pentru `action` ("approve"|"deny") ÎNAINTE de orice efect secundar. Cheia de claim e distinctă
 * de cheia txn; `SET NX` face ca EXACT o acțiune să câștige o cursă approve↔deny. Retry-ul aceleiași acțiuni → idempotent.
 * TTL ≥ viața txn (același `AUTHZ_TXN_TTL_SEC`) ca un perdant lent să vadă tot claim-ul câștigător. `invalid`/throw → 503.
 */
export async function claimAuthzTxnAction(
  txnId:  string,
  action: AuthzTxnAction,
  client: RedisClient = getRedis(),
): Promise<ClaimActionOutcome> {
  if (!client) return { status: "unavailable" };
  try {
    const res = await client.eval(
      AUTHZ_TXN_ACTION_CLAIM_LUA, 1, authzActionClaimKey(txnId), action, String(AUTHZ_TXN_TTL_SEC),
    );
    const c = classifyActionClaim(res, action);
    if (c === "won")        return { status: "won" };
    if (c === "idempotent") return { status: "idempotent" };
    if (c === "invalid")    return { status: "unavailable" }; // rezultat necunoscut → fail-closed
    return { status: "lost", winner: c.lost_to };
  } catch {
    return { status: "unavailable" };
  }
}
