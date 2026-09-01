/**
 * lib/db/authzTxnStore.test.ts — PH-2 step 10.3b-i GUARD (clasificatori store tranzacție, pur). Lua-ul real e în integration.
 */
import {
  classifyTxnCreate, classifyTxnConsume, classifyTxnCas, authzTxnKey,
  classifyTxnConsumeIssue, AUTHZ_TXN_CONSUME_ISSUE_LUA,
  classifyActionClaim, authzActionClaimKey, AUTHZ_TXN_ACTION_CLAIM_LUA, isAuthzTxnAction,
} from "./authzTxnStore";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 step 10.3b-i — authzTxnStore (clasificatori, pur)");

// ── create ──────────────────────────────────────────────────────────────────────
check("1. ⭐⭐ create 'OK' → created", classifyTxnCreate("OK") === "created");
check("2. ⭐⭐⭐ create null (NX a picat) → collision", classifyTxnCreate(null) === "collision");
check("3. create undefined → collision", classifyTxnCreate(undefined) === "collision");

// ── consume ─────────────────────────────────────────────────────────────────────
check("4. ⭐⭐ consume 1 → consumed", classifyTxnConsume(1) === "consumed");
check("5. ⭐⭐⭐ consume -1 (absent) → gone", classifyTxnConsume(-1) === "gone");
check("6. ⭐⭐⭐ consume 0 (schimbat/concurență) → gone", classifyTxnConsume(0) === "gone");
check("7. consume '1' (string din Lua) → consumed", classifyTxnConsume("1") === "consumed");

// ── cas (bind) ────────────────────────────────────────────────────────────────────
check("8. ⭐⭐ cas 1 → updated", classifyTxnCas(1) === "updated");
check("9. ⭐⭐ cas -1 → absent", classifyTxnCas(-1) === "absent");
check("10. ⭐⭐⭐ cas 0 → conflict (blob schimbat între citire și scriere)", classifyTxnCas(0) === "conflict");
check("10a. ⭐⭐⭐ cas -2 → expired (PTTL ne-pozitiv, NU s-a reînviat)", classifyTxnCas(-2) === "expired");

// ── key ─────────────────────────────────────────────────────────────────────────
check("11. ⭐ cheia = mcp:authz_txn:<id>", authzTxnKey("t1") === "mcp:authz_txn:t1");

// ── consume + issue (atomic; frunză 5) ────────────────────────────────────────────
check("12. ⭐⭐⭐ consumeIssue 1 → issued", classifyTxnConsumeIssue(1) === "issued");
check("13. ⭐⭐⭐ consumeIssue -2 → collision (cheia code ocupată; retry cu alt cod, txn NEATINSĂ)", classifyTxnConsumeIssue(-2) === "collision");
check("14. ⭐⭐⭐ consumeIssue -1 (txn absentă) → gone", classifyTxnConsumeIssue(-1) === "gone");
check("15. ⭐⭐⭐ consumeIssue 0 (txn schimbată/consumată de concurent) → gone", classifyTxnConsumeIssue(0) === "gone");
check("16. ⭐⭐ consumeIssue '1' (string din Lua) → issued", classifyTxnConsumeIssue("1") === "issued");
check("16b. ⭐⭐⭐ consumeIssue 'x' → invalid (rezultat necunoscut → NU gone; wrapper → 503)", classifyTxnConsumeIssue("x") === "invalid");
check("16c. ⭐⭐⭐ consumeIssue null → invalid", classifyTxnConsumeIssue(null) === "invalid");
check("16d. ⭐⭐⭐ consumeIssue undefined → invalid", classifyTxnConsumeIssue(undefined) === "invalid");
check("16e. ⭐⭐⭐ consumeIssue 2 (cod pozitiv necunoscut) → invalid (NU issued)", classifyTxnConsumeIssue(2) === "invalid");
check("16f. ⭐⭐⭐ consumeIssue -3 (cod negativ necunoscut) → invalid (NU gone)", classifyTxnConsumeIssue(-3) === "invalid");
check("16g. ⭐⭐⭐ consumeIssue '' (gol) → invalid (NU gone — Number('')===0 evitat)", classifyTxnConsumeIssue("") === "invalid");
check("16h. ⭐⭐⭐ consumeIssue ' ' (spațiu) → invalid (NU gone)", classifyTxnConsumeIssue(" ") === "invalid");
check("16i. ⭐⭐⭐ consumeIssue '1e0' → invalid (formă necanonică; NU issued)", classifyTxnConsumeIssue("1e0") === "invalid");
check("16j. ⭐⭐⭐ consumeIssue '01' → invalid (formă necanonică; NU issued)", classifyTxnConsumeIssue("01") === "invalid");
check("16k. ⭐⭐ consumeIssue '-1'/'0' (string canonic din Lua) → gone", classifyTxnConsumeIssue("-1") === "gone" && classifyTxnConsumeIssue("0") === "gone");
check("16l. ⭐⭐ consumeIssue '-2' (string canonic) → collision", classifyTxnConsumeIssue("-2") === "collision");

// ── Lua ATOMIC: structură + ordine (SET NX; coliziunea NU mutează; consume+issue = tot sau nimic) ──
const L = AUTHZ_TXN_CONSUME_ISSUE_LUA;
check("17. ⭐⭐⭐ Lua compară blob-ul txn EXACT (GET KEYS[1]; not cur → -1; cur ~= ARGV[1] → 0)",
  /GET',\s*KEYS\[1\]/.test(L) && /cur ~= ARGV\[1\][\s\S]{0,20}return 0/.test(L) && /not cur[\s\S]{0,20}return -1/.test(L));
check("18. ⭐⭐⭐ Lua scrie codul cu SET NX (KEYS[2] ARGV[2] EX ARGV[3] NX); pe eșec (cheie ocupată) → -2 collision", (() => {
  const setNx = /SET',\s*KEYS\[2\],\s*ARGV\[2\],\s*'EX',\s*ARGV\[3\],\s*'NX'/.test(L);
  const collision = /if not ok then return -2/.test(L);
  return setNx && collision;
})());
check("19. ⭐⭐⭐ pe SET NX reușit → șterge txn (DEL KEYS[1]) + return 1 (issued); SET ÎNAINTE de DEL (atomic)", (() => {
  const iSet = L.indexOf("SET");
  const iDel = L.indexOf("DEL");
  return /DEL',\s*KEYS\[1\]/.test(L) && /return 1/.test(L) && iSet > -1 && iDel > -1 && iSet < iDel;
})());
check("20. ⭐⭐⭐ coliziunea (return -2) e ÎNAINTE de DEL → txn NU se șterge pe cod ocupat (retry sigur)", (() => {
  const iCollisionReturn = L.indexOf("return -2");
  const iDel = L.indexOf("DEL");
  return iCollisionReturn > -1 && iDel > -1 && iCollisionReturn < iDel;
})());

// ── ACTION CLAIM (arbitrare atomică approve/deny) ──────────────────────────────────────────────────
check("21. ⭐⭐⭐ claim 'won' → won", classifyActionClaim("won", "approve") === "won");
check("22. ⭐⭐⭐ claim 'idempotent' → idempotent (retry aceeași acțiune)", classifyActionClaim("idempotent", "approve") === "idempotent");
check("23. ⭐⭐⭐ claim cu acțiunea CELUILALT → lost_to (am pierdut)", (() => {
  const r = classifyActionClaim("deny", "approve");
  return typeof r === "object" && r.lost_to === "deny";
})());
check("23b. ⭐⭐ claim simetric: approve câștigător văzut de deny → lost_to approve", (() => {
  const r = classifyActionClaim("approve", "deny");
  return typeof r === "object" && r.lost_to === "approve";
})());
check("23c. ⭐⭐ defensiv: string == myAction → idempotent (nu lost_to fals)", classifyActionClaim("approve", "approve") === "idempotent");
check("24. ⭐⭐⭐ claim null → invalid (fail-closed → 503)", classifyActionClaim(null, "approve") === "invalid");
check("24b. ⭐⭐⭐ claim undefined → invalid", classifyActionClaim(undefined, "approve") === "invalid");
check("24c. ⭐⭐⭐ claim '' (gol) → invalid (NU lost_to)", classifyActionClaim("", "approve") === "invalid");
check("24d. ⭐⭐ claim număr → invalid", classifyActionClaim(1, "approve") === "invalid");
check("24e. ⭐⭐⭐ claim 'bogus' (acțiune NEcunoscută/corupție) → invalid → 503 (NU câștigător fantomă care blochează txn 10 min)",
  classifyActionClaim("bogus", "approve") === "invalid");
check("24f. ⭐⭐ isAuthzTxnAction: doar approve/deny → true; restul → false",
  isAuthzTxnAction("approve") && isAuthzTxnAction("deny") && !isAuthzTxnAction("bogus") && !isAuthzTxnAction("won") && !isAuthzTxnAction(null));
check("25. ⭐ cheia de claim = mcp:authz_claim:<id> (namespace DISTINCT de txn)",
  authzActionClaimKey("t1") === "mcp:authz_claim:t1" && authzActionClaimKey("t1") !== authzTxnKey("t1"));

// ── Lua CLAIM: SET NX pe cheia de claim; won/idempotent/other-action ──
const CL = AUTHZ_TXN_ACTION_CLAIM_LUA;
check("26. ⭐⭐⭐ Lua claim: SET NX (KEYS[1] ARGV[1] NX EX ARGV[2]) → 'won' pe reușită",
  /SET',\s*KEYS\[1\],\s*ARGV\[1\],\s*'NX',\s*'EX',\s*ARGV\[2\]/.test(CL) && /if ok then return 'won'/.test(CL));
check("27. ⭐⭐⭐ Lua claim: pe eșec (deja revendicată) → GET; cur == ARGV[1] → 'idempotent'; altfel întoarce acțiunea câștigătoare",
  /GET',\s*KEYS\[1\]/.test(CL) && /cur == ARGV\[1\] then return 'idempotent'/.test(CL) && /return cur\s*$/.test(CL.trim()));
check("28. ⭐⭐⭐ Lua claim NU atinge cheia txn (mcp:authz_txn) — doar cheia de claim (fără efecte pe txn)",
  !/authz_txn/.test(CL));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
