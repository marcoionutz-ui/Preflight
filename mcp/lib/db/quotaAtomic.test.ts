/**
 * lib/db/quotaAtomic.test.ts — PH-2 GUARD (parser + planuri quota atomică, pur). Redis-ul real e în integration.
 */
import { quotaFromEval, evalArgs, accountRlKeys, clientRlKeys,
         authCodeQuotaPlan, clientCredsQuotaPlan, RL_MIN_TTL, RL_DAY_TTL } from "./quotaAtomic";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 — quotaAtomic (parser + planuri, pur)");

// ── quotaFromEval ─────────────────────────────────────────────────────────────
{
  const o = quotaFromEval([1, 0, 3, 6, 1, 2], 4);
  check("1. allowed → status ok + counts", o?.status === "ok" && JSON.stringify((o as { counts: number[] }).counts) === JSON.stringify([3, 6, 1, 2]));
}
{
  const o = quotaFromEval([0, 3600, 100, 100, 5, 5], 4);
  check("2. ⭐ limited → retryAfterSec + counts curente", o?.status === "limited" && (o as { retryAfterSec: number }).retryAfterSec === 3600);
}
check("3. ⭐⭐ lungime greșită → null (fail-closed)", quotaFromEval([1, 0, 3], 4) === null);
check("4. ⭐⭐ allowed ≠ 0|1 → null", quotaFromEval([2, 0, 1, 1, 1, 1], 4) === null);
check("5. ⭐ retry negativ → null", quotaFromEval([0, -1, 1, 1, 1, 1], 4) === null);
check("6. ⭐ count non-finit → null", quotaFromEval([1, 0, "x", 1, 1, 1], 4) === null);
check("7. non-array → null", quotaFromEval("nope", 4) === null);
check("8. o singură fereastră (client_credentials) → ok", quotaFromEval([1, 0, 5, 9], 2)?.status === "ok");
check("8a. ⭐⭐ nWindows=0 → null (fail-closed, nu accepta rezultat fără ferestre)", quotaFromEval([1, 0], 0) === null);
check("8b. ⭐ nWindows fracționar → null", quotaFromEval([1, 0, 1], 1.5) === null);
check("8c. ⭐⭐ count negativ → null", quotaFromEval([1, 0, -1, 2], 2) === null);
check("8d. ⭐⭐ count fracționar → null", quotaFromEval([1, 0, 1.5, 2], 2) === null);
check("8e. ⭐ retry fracționar → null", quotaFromEval([0, 30.5, 1, 1], 2) === null);
check("8f. ⭐ retry negativ → null", quotaFromEval([0, -5, 1, 1], 2) === null);
check("8g. ⭐⭐ allowed=1 dar retry≠0 → null (contract Lua corupt: permis ⇒ retry 0)", quotaFromEval([1, 5, 3, 6], 2) === null);
check("8h. allowed=1 cu retry=0 → ok (contract respectat)", quotaFromEval([1, 0, 3, 6], 2)?.status === "ok");

// ── chei ──────────────────────────────────────────────────────────────────────
check("9. ⭐ account keys pe namespace NOU (mcp:rl:acct:*)", accountRlKeys("u1").minKey === "mcp:rl:acct:min:u1" && accountRlKeys("u1").dayKey === "mcp:rl:acct:day:u1");
check("10. ⭐ client keys = ACELEAȘI ca azi (mcp:rl:min/day) → client_credentials neschimbat", clientRlKeys("c1").minKey === "mcp:rl:min:c1" && clientRlKeys("c1").dayKey === "mcp:rl:day:c1");

// ── planuri ─────────────────────────────────────────────────────────────────────
{
  const plan = authCodeQuotaPlan("u1", { perMinute: 10, perDay: 100 }, { clientId: "c1", limits: { perMinute: 5, perDay: 50 } });
  check("11. ⭐ auth-code plan: 4 ferestre, ordine account(day,min) apoi client(day,min)", plan.length === 4 &&
    plan[0].key === "mcp:rl:acct:day:u1" && plan[1].key === "mcp:rl:acct:min:u1" &&
    plan[2].key === "mcp:rl:day:c1"     && plan[3].key === "mcp:rl:min:c1");
  check("12. ⭐ limite + TTL corecte pe ferestre", plan[0].limit === 100 && plan[0].ttlSec === RL_DAY_TTL && plan[1].limit === 10 && plan[1].ttlSec === RL_MIN_TTL);
}
{
  const plan = authCodeQuotaPlan("u1", { perMinute: 10, perDay: 100 }, { accountOnly: true });
  check("13. ⭐⭐ account-only EXPLICIT → doar 2 ferestre (fără client secundar)", plan.length === 2 && plan.every(w => w.key.includes("acct")));
}
{
  const plan = clientCredsQuotaPlan("c1", { perMinute: 20, perDay: 1000 });
  check("14. ⭐ client_credentials plan: 2 ferestre, chei client de azi", plan.length === 2 && plan[0].key === "mcp:rl:day:c1" && plan[1].key === "mcp:rl:min:c1");
}

// ── evalArgs ─────────────────────────────────────────────────────────────────
{
  const plan = authCodeQuotaPlan("u1", { perMinute: 10, perDay: 100 }, { clientId: "c1", limits: { perMinute: 5, perDay: 50 } });
  const { keys, argv } = evalArgs(plan);
  check("15. ⭐ evalArgs: keys = cheile în ordine", JSON.stringify(keys) === JSON.stringify(["mcp:rl:acct:day:u1", "mcp:rl:acct:min:u1", "mcp:rl:day:c1", "mcp:rl:min:c1"]));
  check("16. ⭐⭐ evalArgs: argv[0]=n, apoi (limită,ttl) per fereastră", argv[0] === "4" && argv[1] === "100" && argv[2] === String(RL_DAY_TTL) && argv[3] === "10" && argv[4] === String(RL_MIN_TTL));
  check("17. argv are 1 + 2n elemente", argv.length === 1 + 2 * 4);
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
