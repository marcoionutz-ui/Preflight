/**
 * lib/db/authzTxnStore.test.ts — PH-2 step 10.3b-i GUARD (clasificatori store tranzacție, pur). Lua-ul real e în integration.
 */
import { classifyTxnCreate, classifyTxnConsume, classifyTxnCas, authzTxnKey } from "./authzTxnStore";

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

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
