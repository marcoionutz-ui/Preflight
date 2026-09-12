/**
 * lib/mcp/canaryRedisCleanup.ts — PH-12 12.5b-5a (cleanup Redis ȚINTIT pentru Gate 1 auth-canary).
 *
 * Orchestrator cu I/O INJECTAT (port `CanaryRedisPort` = {get, del}) — NU complet pur, dar TOATĂ logica (derivare chei,
 * rezolvare family_id, secvențiere, raport) e tsx-testabilă cu un fake al portului. Cheile se construiesc EXCLUSIV prin
 * helper-ele oficiale din `oauthStorageKeys.ts` (sursă unică; fără prefixe hardcodate; API pe formă corectă → fără
 * footgun hash/token).
 *
 * ANTI-DISTRUGERE (lock Marco/cgpt): DOAR `del(key)` pe cheie SPECIFICĂ — niciun `SCAN`, niciun `FLUSHDB`, niciun delete
 * „broad". Portul nici nu expune așa ceva. Rate-limit/quota (`mcp:rl:*` / `mcp:quota:*`) NU se ating: contoare per-cont,
 * TTL scurt, fără credențiale → expiră singure.
 *
 * IDEMPOTENȚĂ (lock cgpt #2): `GET → not_found` și `DEL → not_found` (0) sunt REZULTAT NORMAL — codul OAuth e consumat
 * într-un Gate 1 reușit, iar un token poate lipsi/expira. NU sunt erori. DOAR `unavailable` (throw / Redis jos) SAU un
 * payload PREZENT dar CORUPT (nu putem extrage family_id → riscăm o familie orfană) înseamnă cleanup INCOMPLET → roșu.
 *
 * FAMILY (lock cgpt #1): citim TOATE credențialele disponibile — AT1/AT2 (`parseStoredToken` + `tokenFamilyId`) ȘI
 * RT1/RT2 (`parseStoredRefresh` + `family_id`) — și colectăm toate family-urile. Invariantă: un run produce O SINGURĂ
 * familie. Dacă apar family-uri DIFERITE → curățăm best-effort TOATE familiile derivate, DAR marcăm roșu (invariantă
 * ruptă).
 *
 * ANTI-LEAK (lock Marco): raportul poartă DOAR coduri închise (`target` + `code`) — zero token/hash/payload/family_id.
 */

import { accessTokenKey, refreshTokenKey, refreshFamilyKey, authCodeKey } from "../db/oauthStorageKeys";
import { parseStoredToken } from "./tokenGuard";
import { tokenFamilyId } from "../oauth/tokenPayloadModel";
import { parseStoredRefresh } from "../oauth/refreshPayloadModel";

// ────────────────────────────── portul injectat (I/O real în 4b) ──────────────────────────────

export type RedisGetOutcome =
  | { status: "found"; value: string }
  | { status: "not_found" }           // cheie absentă/expirată — benign (idempotent)
  | { status: "unavailable" };        // Redis jos/respins — cleanup incomplet

export type RedisDelOutcome =
  | { status: "deleted" }             // DEL a șters ≥1 cheie
  | { status: "not_found" }           // DEL 0 — deja dispărut, benign (idempotent)
  | { status: "unavailable" };        // Redis jos/respins — cleanup incomplet

/**
 * Portul de cleanup Redis. Adaptorul real (4b) îl mapează pe clientul Redis local (loopback, anti-prod vetat) traducând
 * `null`→not_found, count≥1→deleted, count 0→not_found, throw→unavailable. Expune EXCLUSIV `get`/`del` pe cheie
 * specifică — niciun scan/flush/broad delete.
 */
export interface CanaryRedisPort {
  get(key: string): Promise<RedisGetOutcome>;
  del(key: string): Promise<RedisDelOutcome>;
}

// ────────────────────────────── materialul de chei (populat în run) ──────────────────────────────

/** Secretele plain produse de un run Gate 1 (AT1/AT2, RT1/RT2, cod). Populate de runner prin wrappere pe pași. */
export interface CanaryKeyMaterial {
  accessTokens:  readonly string[];
  refreshTokens: readonly string[];
  authCodes:     readonly string[];
  // Familii DEJA descoperite în rulări anterioare pe ACELAȘI ledger. Retry-safe (lock cgpt P1): dacă un prim run șterge
  // tokenurile dar NU familia (DEL unavailable), un al doilea run nu ar mai putea rezolva familia din payload-uri
  // (tokenurile-s duse) → familie orfană pe veci. Seed-uind cleanup-ul din familiile deja descoperite, retry-ul o prinde.
  resolvedFamilyIds?: readonly string[];
}

/** Ledger mutabil: runner-ul înregistrează secretele pe măsură ce apar (unic, ne-gol). Sursa lui `CanaryKeyMaterial`. */
export interface CanaryKeyLedger extends CanaryKeyMaterial {
  resolvedFamilyIds: string[];
  recordAccessToken(token: string): void;
  recordRefreshToken(token: string): void;
  recordAuthCode(code: string): void;
  /** Persistă un family_id descoperit de cleanup → un retry pe ACELAȘI ledger poate șterge familia chiar dacă tokenurile-s duse. */
  recordFamilyId(id: string): void;
}

export function makeKeyLedger(): CanaryKeyLedger {
  const accessTokens:     string[] = [];
  const refreshTokens:    string[] = [];
  const authCodes:        string[] = [];
  const resolvedFamilyIds: string[] = [];
  const addUniq = (arr: string[], v: string): void => {
    if (typeof v === "string" && v.length > 0 && !arr.includes(v)) arr.push(v);
  };
  return {
    accessTokens, refreshTokens, authCodes, resolvedFamilyIds,
    recordAccessToken:  (t) => addUniq(accessTokens, t),
    recordRefreshToken: (t) => addUniq(refreshTokens, t),
    recordAuthCode:     (c) => addUniq(authCodes, c),
    recordFamilyId:     (id) => addUniq(resolvedFamilyIds, id),
  };
}

// ────────────────────────────── raport ──────────────────────────────

export type CleanupTarget    = "access" | "refresh" | "family" | "code";
// `unexpected_payload`: payload VALID dar fără family_id (lock cgpt P2). Ledger-ul provine EXCLUSIV din fluxul user
// `authorization_code` → un token prezent fără familie (ex. formă client-shaped) e ANORMAL, nu cleanup verde.
export type CleanupErrorCode = "unavailable" | "corrupt_payload" | "unexpected_payload";

export interface RedisCleanupReport {
  ok:               boolean;                                          // false: erori / invariantă ruptă / reziduu / dovadă eșuată
  deleted:          number;                                           // câte DEL au întors "deleted" (not_found nu se numără)
  familyIdsSeen:    number;                                           // family-uri DISTINCTE rezolvate
  invariantBroken:  boolean;                                          // >1 family distinct într-un singur run
  errors:           { target: CleanupTarget; code: CleanupErrorCode }[]; // coduri închise — fără valori
  // DOVADĂ post-delete (mutată AICI din runner, lock cgpt): pe categorii, fără chei/id-uri.
  stillPresent:     CleanupTarget[];                                  // GET post-delete a găsit cheia → REZIDUU
  proofUnavailable: CleanupTarget[];                                  // GET-ul de dovadă a eșuat (unavailable/throw) → NU pot dovedi absența
}

// ────────────────────────────── orchestrare ──────────────────────────────

/** Prinde un `port.get` care aruncă → tratat ca `unavailable` (fail-closed, portul n-ar trebui să arunce). */
async function safeGet(port: CanaryRedisPort, key: string): Promise<RedisGetOutcome> {
  try { return await port.get(key); } catch { return { status: "unavailable" }; }
}
/** Prinde un `port.del` care aruncă → tratat ca `unavailable` (fail-closed). */
async function safeDel(port: CanaryRedisPort, key: string): Promise<RedisDelOutcome> {
  try { return await port.del(key); } catch { return { status: "unavailable" }; }
}

/**
 * Șterge ȚINTIT resursele Redis produse de un run Gate 1: familia (rezolvată din payload-uri) → access → refresh → cod,
 * apoi DOVEDEȘTE absența cu un GET post-delete pe ACELEAȘI chei (aceleași familii descoperite de această execuție —
 * lock cgpt P1#2). Best-effort (încearcă tot, nu aruncă). Roșu dacă: eroare de citire/payload, invariantă ruptă,
 * reziduu (GET post-delete găsește cheia) SAU dovadă eșuată (GET unavailable ≠ absent — lock cgpt P1#1).
 */
export async function runCanaryRedisCleanup(
  port:              CanaryRedisPort,
  material:          CanaryKeyMaterial,
  onFamilyDiscovered?: (familyId: string) => void,
): Promise<RedisCleanupReport> {
  const errors: RedisCleanupReport["errors"] = [];
  let deleted = 0;

  // ── 1. Rezolvă family_id din TOATE credențialele disponibile (lock cgpt #1) ──
  // Seed din familiile deja descoperite pe acest ledger (retry-safe, lock cgpt P1): dacă un run anterior a șters
  // tokenurile dar nu familia, tokenurile nu mai sunt citibile acum → familia se prinde din seed, nu din payload.
  const families = new Set<string>(material.resolvedFamilyIds ?? []);
  const discover = (fid: string): void => { if (!families.has(fid)) { families.add(fid); onFamilyDiscovered?.(fid); } };

  for (const at of material.accessTokens) {
    const g = await safeGet(port, accessTokenKey(at));
    if (g.status === "unavailable") { errors.push({ target: "access", code: "unavailable" }); continue; }
    if (g.status === "not_found")   continue; // benign (idempotent)
    const parsed = parseStoredToken(g.value);
    if (parsed.status !== "valid")  { errors.push({ target: "access", code: "corrupt_payload" }); continue; }
    const fid = tokenFamilyId(parsed.payload);
    // P2 (lock cgpt): ledger-ul e din fluxul user auth-code → un access token VALID trebuie să aibă familie. Absența ei
    // (ex. formă client-shaped) e anormală → roșu, DAR continuăm ștergerea best-effort (nu revendicăm familia lipsă).
    if (!fid) { errors.push({ target: "access", code: "unexpected_payload" }); continue; }
    discover(fid);
  }

  for (const rt of material.refreshTokens) {
    const g = await safeGet(port, refreshTokenKey(rt));
    if (g.status === "unavailable") { errors.push({ target: "refresh", code: "unavailable" }); continue; }
    if (g.status === "not_found")   continue; // benign (idempotent)
    const payload = parseStoredRefresh(g.value);
    if (!payload)                   { errors.push({ target: "refresh", code: "corrupt_payload" }); continue; }
    if (!payload.family_id)         { errors.push({ target: "refresh", code: "unexpected_payload" }); continue; }
    discover(payload.family_id);
  }

  const invariantBroken = families.size > 1;

  // ── 2. Șterge ȚINTIT: familie → access → refresh → cod (cheie specifică, DEL) ──
  const delOne = async (key: string, target: CleanupTarget): Promise<void> => {
    const out = await safeDel(port, key);
    if (out.status === "unavailable") { errors.push({ target, code: "unavailable" }); return; }
    if (out.status === "deleted")     deleted++;
    // "not_found" (DEL 0) = deja dispărut = benign (idempotent)
  };

  const familyIds = [...families]; // aceeași listă folosită la ștergere ȘI la dovadă (lock cgpt P1#2)
  for (const fid of familyIds)             await delOne(refreshFamilyKey(fid), "family");
  for (const at of material.accessTokens)  await delOne(accessTokenKey(at),    "access");
  for (const rt of material.refreshTokens) await delOne(refreshTokenKey(rt),   "refresh");
  for (const code of material.authCodes)   await delOne(authCodeKey(code),     "code");

  // ── 3. DOVADĂ post-delete pe ACELEAȘI chei (lock cgpt): not_found=absent, found=reziduu, unavailable=dovadă eșuată ──
  const stillPresent     = new Set<CleanupTarget>();
  const proofUnavailable = new Set<CleanupTarget>();
  const proveGone = async (key: string, target: CleanupTarget): Promise<void> => {
    const g = await safeGet(port, key);
    if (g.status === "unavailable") { proofUnavailable.add(target); return; } // P1#1: unavailable ≠ absent
    if (g.status === "found")       { stillPresent.add(target); return; }     // reziduu
    // "not_found" = absent = dovedit
  };

  for (const fid of familyIds)             await proveGone(refreshFamilyKey(fid), "family");
  for (const at of material.accessTokens)  await proveGone(accessTokenKey(at),    "access");
  for (const rt of material.refreshTokens) await proveGone(refreshTokenKey(rt),   "refresh");
  for (const code of material.authCodes)   await proveGone(authCodeKey(code),     "code");

  return {
    ok: errors.length === 0 && !invariantBroken && stillPresent.size === 0 && proofUnavailable.size === 0,
    deleted,
    familyIdsSeen: families.size,
    invariantBroken,
    errors,
    stillPresent:     [...stillPresent],
    proofUnavailable: [...proofUnavailable],
  };
}
