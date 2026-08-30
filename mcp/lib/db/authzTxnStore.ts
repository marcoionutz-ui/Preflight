/**
 * lib/db/authzTxnStore.ts — PH-2 step 10.3b-i (store ATOMIC al AuthzTransaction: Lua + clasificatori puri).
 *
 * Frunză (ZERO importuri grele) → clasificatorii-s testabili în tsx, iar Lua-ul e evaluabil pe un Redis real (ca
 * `oauthAtomic.ts`). Tranzacția de consent e ONE-TIME + legată de sesiune (vezi `authzTransaction.ts` pt. logica pură).
 * Store-ul oferă cele 4 operații atomice necesare fluxului `/authorize` (10.3b-iv + frunză 5):
 *   - CREATE        = `SET NX EX` (atomic prin el însuși; coliziune pe txn_id existent → NU suprascrie).
 *   - CONSUME       = compare-and-delete pe blob-ul EXACT (one-time: dublă-trimitere concurentă → a doua eșuează).
 *   - BIND          = compare-and-set (CAS) pe blob: aplică noul blob DOAR dacă cel curent e neschimbat (sticky-bind-ul
 *     de user, calculat PUR în app via `bindUser`, e scris atomic aici; păstrează TTL-ul rămas — consent bounded).
 *   - CONSUME+ISSUE = compare-and-delete pe txn + `SET NX` cod într-o SINGURĂ op (poarta de concurență a Approve-ului).
 *
 * ⚠️ Redis Lua rulează ATOMIC (scriptul întreg, neîntrerupt de alte comenzi). CREATE/CONSUME/BIND fac o singură mutație
 * condiționată de un GET; CONSUME+ISSUE face `SET NX` (cod) + `DEL` (txn) ca o SINGURĂ unitate atomică (tot sau nimic) →
 * sigure, fără rollback necesar.
 */

export const AUTHZ_TXN_TTL_SEC = 10 * 60; // fereastra de consent (10 min)

export function authzTxnKey(txnId: string): string { return `mcp:authz_txn:${txnId}`; }

// ── CREATE (SET NX EX) — clasificator peste rezultatul ioredis ("OK" | null) ──
export type TxnCreateResult = "created" | "collision";
export function classifyTxnCreate(res: unknown): TxnCreateResult {
  return res === "OK" ? "created" : "collision"; // null (NX a picat) → txn_id deja există
}

// ── CONSUME (compare-and-delete pe blob exact) ────────────────────────────────
//   1 = consumed (am șters blob-ul care era EXACT al nostru); -1 = absent; 0 = schimbat (altă generație).
export const AUTHZ_TXN_CONSUME_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return -1 end
if cur == ARGV[1] then redis.call('DEL', KEYS[1]) return 1 end
return 0
`;
export type TxnConsumeResult = "consumed" | "gone";
export function classifyTxnConsume(res: unknown): TxnConsumeResult {
  return Number(res) === 1 ? "consumed" : "gone"; // -1 (absent) / 0 (schimbat) → gone (deja folosită / concurență)
}

// ── BIND (compare-and-set pe blob; păstrează TTL-ul rămas, în MILISECUNDE) ─────
//   Setează ARGV[2] (blob nou) DOAR dacă cel curent === ARGV[1] (blob citit), rescriind cu TTL-ul RĂMAS ca să NU
//   extindă fereastra de consent. Folosim `PTTL` (ms), NU `TTL` (secunde): `TTL` întoarce 0 când mai e sub 1s →
//   ramura de fallback ar reînvia cheia cu o fereastră întreagă. Dacă `PTTL` nu-i strict pozitiv (aproape moartă /
//   fără expiry / anomalie) → RESPINGEM fail-closed (`-2`), NU reînviem. 1 = updated; -1 = absent; -2 = expired; 0 = conflict.
export const AUTHZ_TXN_BIND_CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return -1 end
if cur ~= ARGV[1] then return 0 end
local pttl = redis.call('PTTL', KEYS[1])
if not pttl or pttl <= 0 then return -2 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', pttl)
return 1
`;
export type TxnCasResult = "updated" | "absent" | "expired" | "conflict";
export function classifyTxnCas(res: unknown): TxnCasResult {
  const n = Number(res);
  if (n === 1)  return "updated";
  if (n === -1) return "absent";
  if (n === -2) return "expired"; // fără TTL valid (sub-secundă / anomalie) → NU s-a reînviat, tratat ca gone
  return "conflict"; // 0 → blob schimbat între citire și scriere (retry)
}

// ── CONSUME + ISSUE (atomic: consumă txn ȘI emite authorization code într-o SINGURĂ op) ──
//   Poarta de concurență a fluxului Approve (PH-2 pas 6 frunză 5): compară blob-ul txn (ARGV[1]), scrie codul cu `SET NX`
//   (KEYS[2]) și ȘTERGE txn — TOT sau NIMIC. Închide (a) double-submit-ul (a doua trimitere vede txn deja consumată →
//   `gone`, fără al doilea cod) ȘI (b) cazul „txn consumată dar codul nescris" (nu mai există fereastră între consume și
//   issue). `SET NX` exprimă invariantul „cheia code trebuie LIBERĂ" (ca `oauthAtomic.ts`): dacă a picat (cheia există)
//   returnăm ÎNAINTE de `DEL` → txn NEATINSĂ, caller-ul reîncearcă cu alt cod. KEYS[1]=txn, KEYS[2]=code; ARGV[1]=blob
//   txn AȘTEPTAT, ARGV[2]=payload code (JSON), ARGV[3]=TTL code (sec).
//   1 = issued; -2 = collision (SET NX a picat — retry cu alt cod, txn NEATINSĂ); -1 = absent / 0 = schimbată → gone.
export const AUTHZ_TXN_CONSUME_ISSUE_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return -1 end
if cur ~= ARGV[1] then return 0 end
local ok = redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3], 'NX')
if not ok then return -2 end
redis.call('DEL', KEYS[1])
return 1
`;
export type TxnConsumeIssueResult = "issued" | "collision" | "gone" | "invalid";
export function classifyTxnConsumeIssue(res: unknown): TxnConsumeIssueResult {
  // Match EXACT pe formele canonice pe care le produce Lua-ul nostru prin ioredis (întreg SAU string-ul lui canonic).
  // FĂRĂ `Number()`: ar accepta fals `""`/`" "`→0, `"1e0"`/`"01"`→1 (forme pe care Lua-ul NU le emite). Orice altceva
  // (null/undefined/obiect/NaN/`2`/`-3`/forme necanonice) → `invalid` (fail-closed; wrapper-ul îl mapează la 503).
  if (res === 1  || res === "1")                            return "issued";
  if (res === -2 || res === "-2")                           return "collision"; // SET NX picat → retry alt cod, txn NEATINSĂ
  if (res === -1 || res === "-1" || res === 0 || res === "0") return "gone";     // absentă / schimbată → deja folosită
  return "invalid";
}
