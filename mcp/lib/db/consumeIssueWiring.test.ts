/**
 * lib/db/consumeIssueWiring.test.ts — PH-2 pas 6 frunză 5 (GUARD de sursă pe wrapper-ul I/O `consumeAuthzTxnAndIssueCode`).
 *
 * `oauth-codes.ts` importă redis → NU tsx-testabil (dovada pe Redis real e în integration). Verificăm ca TEXT: folosește
 * Lua-ul ATOMIC, retry pe coliziune cu ALT cod (txn neatinsă), fail-closed pe invalid/throw/coliziuni persistente, și NU
 * face consume separat (fără fereastră între consume și issue). cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 pas 6 frunză 5 — consumeAuthzTxnAndIssueCode (guard de sursă)");

const src = readFileSync("lib/db/oauth-codes.ts", "utf8");
// izolăm corpul funcției (până la închiderea ei) pentru verificările de absență
const fn = (src.match(/export async function consumeAuthzTxnAndIssueCode[\s\S]*?\n\}/) || [""])[0];

check("1. ⭐⭐⭐ exportă consumeAuthzTxnAndIssueCode(txnId, txnRaw, payload, client)",
  /export async function consumeAuthzTxnAndIssueCode\(\s*txnId:\s*string,\s*txnRaw:\s*string,\s*payload:\s*AuthCodePayload/.test(src));
check("2. ⭐⭐⭐ tipul rezultat: issued{code} | gone | unavailable",
  /ConsumeIssueOutcome[\s\S]{0,200}status:\s*"issued";\s*code:\s*string[\s\S]{0,120}"gone"[\s\S]{0,120}"unavailable"/.test(src));
check("3. ⭐⭐⭐ client null → unavailable (fără eval)", /if\s*\(!client\)\s*return\s*\{\s*status:\s*"unavailable"\s*\}/.test(fn));
check("4. ⭐⭐⭐ folosește Lua-ul ATOMIC AUTHZ_TXN_CONSUME_ISSUE_LUA cu 2 chei (txn + code)",
  /eval\(\s*AUTHZ_TXN_CONSUME_ISSUE_LUA,\s*2,\s*authzTxnKey\(txnId\),\s*codeKey\(code\)/.test(fn));
check("5. ⭐⭐⭐ ARGV = (txnRaw, body=JSON payload, CODE_TTL_SEC)",
  /authzTxnKey\(txnId\),\s*codeKey\(code\),\s*txnRaw,\s*body,\s*String\(CODE_TTL_SEC\)/.test(fn) && /const body = JSON\.stringify\(payload\)/.test(fn));
check("6. ⭐⭐⭐ generează cod PROASPĂT la FIECARE încercare (randomBytes ÎN buclă, înainte de eval)", (() => {
  const iFor  = fn.indexOf("for (");
  const iCode = fn.indexOf("randomBytes(32)");
  const iEval = fn.indexOf("eval(");
  return iFor > -1 && iCode > iFor && iEval > iCode; // random în buclă, înainte de eval
})());
check("7. ⭐⭐⭐ dispecerizează prin classifyTxnConsumeIssue(res)", /verdict = classifyTxnConsumeIssue\(res\)/.test(fn));
check("8. ⭐⭐⭐ issued → {status:'issued', code}", /verdict === "issued"\)\s*return\s*\{\s*status:\s*"issued",\s*code\s*\}/.test(fn));
check("9. ⭐⭐⭐ gone → {status:'gone'} (NU emite al doilea cod)", /verdict === "gone"\)\s*return\s*\{\s*status:\s*"gone"\s*\}/.test(fn));
check("10. ⭐⭐⭐ invalid (rezultat Lua necunoscut) → unavailable (fail-closed, NU gone)",
  /verdict === "invalid"\)\s*return\s*\{\s*status:\s*"unavailable"\s*\}/.test(fn));
check("11. ⭐⭐⭐ collision → retry cu ALT cod (NU return; continuă bucla) — nu tratat explicit ca terminal",
  !/verdict === "collision"\)\s*return/.test(fn));
check("12. ⭐⭐⭐ throw pe eval → unavailable (stare NECUNOSCUTĂ — NU presupune txn intactă; reply se poate pierde după ce Lua a rulat)",
  /catch\s*\{[\s\S]{0,260}return\s*\{\s*status:\s*"unavailable"\s*\}/.test(fn));
check("12b. ⭐⭐⭐ contract onest: `unavailable` NU e garanție că txn e intactă (docs afirmă explicit)",
  /unavailable[\s\S]{0,400}NU o garanție că txn e intactă/.test(src) && /AT-MOST-ONCE/.test(src));
check("13. ⭐⭐⭐ buclă MĂRGINITĂ (MAX_ATTEMPTS) + fail-closed la unavailable după epuizare", (() => {
  const bounded = /for\s*\(let attempt = 0;\s*attempt < CONSUME_ISSUE_MAX_ATTEMPTS/.test(fn);
  const tail = fn.match(/\}\s*\n\s*return\s*\{\s*status:\s*"unavailable"\s*\};\s*\/\/[^\n]*\n\}$/); // ultimul return, după buclă
  return bounded && !!tail;
})());
check("14. ⭐⭐⭐ NU face consume SEPARAT (fără consumeAuthzTxn/DEL/GETDEL manual → fără fereastră consume↔issue)",
  !/consumeAuthzTxn\(/.test(fn) && !/AUTHZ_TXN_CONSUME_LUA/.test(fn));
check("15. ⭐⭐ MAX_ATTEMPTS = 5 (retry strict pe coliziune, nu pe probabilitate)", /CONSUME_ISSUE_MAX_ATTEMPTS = 5\b/.test(src));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
