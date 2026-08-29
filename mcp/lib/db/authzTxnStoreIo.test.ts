/**
 * lib/db/authzTxnStoreIo.test.ts — PH-2 step 10.3b-iv frunză 3 (wrapperele I/O, unit cu client FAKE).
 *
 * Fără Redis real: injectăm un client fake ca să verificăm CABLAREA — discriminarea READ (found/absent/corrupt/
 * unavailable), maparea clasificatorilor pe CREATE/BIND/CONSUME, `unavailable` la client null / throw, și că `raw`-ul +
 * argumentele Lua sunt exact ce trebuie. Semantica ATOMICĂ reală (NX/CAS/compare-and-delete) e dovedită separat pe
 * Redis real în `authzTxnStoreIo.integration.ts`.
 */
import {
  createAuthzTxn, readAuthzTxn, bindAuthzTxnUser, consumeAuthzTxn,
} from "./authzTxnStoreIo";
import { authzTxnKey, AUTHZ_TXN_CONSUME_LUA, AUTHZ_TXN_BIND_CAS_LUA } from "./authzTxnStore";
import { buildAuthzTransaction, type AuthzTransaction } from "../oauth/authzTransaction";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const CH = "E9Melgz-yJgAB3Y9jn0aY0kEwlWdW3l1o0V0lqTfMug"; // 43-char base64url (format PKCE valid)
function mkTxn(over: Partial<AuthzTransaction> = {}): AuthzTransaction {
  const r = buildAuthzTransaction({
    txn_id: "tx1", csrf_token: "csrf1", grant_id: "grant1", registration_id: "reg1", client_id: "c1",
    redirect_uri: "https://claude.ai/cb", state: "st", resource: "https://x/api/mcp",
    requested_scopes: ["read:all"], code_challenge: CH, code_challenge_method: "S256",
    now: 1000, ttlMs: 600000,
  });
  if (!r.ok) throw new Error("fixture txn invalid: " + r.error);
  return { ...r.txn, ...over };
}

// Client fake care înregistrează apelurile; fiecare metodă e configurabilă per-test.
type Call = { m: string; args: unknown[] };
function fakeRedis(opts: { get?: string | null; set?: "OK" | null; evalRet?: unknown; throwOn?: string }) {
  const calls: Call[] = [];
  const guard = (m: string) => { if (opts.throwOn === m) throw new Error("boom"); };
  const client = {
    async get(...args: unknown[]) { calls.push({ m: "get", args }); guard("get"); return opts.get ?? null; },
    async set(...args: unknown[]) { calls.push({ m: "set", args }); guard("set"); return opts.set ?? null; },
    async eval(...args: unknown[]) { calls.push({ m: "eval", args }); guard("eval"); return opts.evalRet; },
  };
  return { client: client as unknown as ReturnType<typeof import("./redis").getRedis>, calls };
}

async function main(): Promise<void> {
console.log("PH-2 step 10.3b-iv frunză 3 — authzTxnStoreIo (unit, client fake)");

// ── CREATE ────────────────────────────────────────────────────────────────────
check("1. ⭐⭐ CREATE client null → unavailable", await createAuthzTxn(mkTxn(), null) === "unavailable");
{
  const { client, calls } = fakeRedis({ set: "OK" });
  const res = await createAuthzTxn(mkTxn(), client);
  check("2. ⭐⭐⭐ CREATE set 'OK' → created", res === "created");
  const setArgs = calls.find(c => c.m === "set")!.args;
  check("3. ⭐⭐ CREATE scrie la authzTxnKey(txn_id) cu JSON.stringify + EX + NX",
    setArgs[0] === authzTxnKey("tx1") && setArgs[1] === JSON.stringify(mkTxn()) && setArgs[2] === "EX" && setArgs[4] === "NX");
}
check("4. ⭐⭐⭐ CREATE set null (NX picat) → collision", await createAuthzTxn(mkTxn(), fakeRedis({ set: null }).client) === "collision");
check("5. ⭐⭐ CREATE throw → unavailable", await createAuthzTxn(mkTxn(), fakeRedis({ throwOn: "set" }).client) === "unavailable");

// ── READ (discriminat) ──────────────────────────────────────────────────────────
check("6. ⭐⭐ READ client null → unavailable", (await readAuthzTxn("tx1", null)).status === "unavailable");
check("7. ⭐⭐⭐ READ get null → absent", (await readAuthzTxn("tx1", fakeRedis({ get: null }).client)).status === "absent");
check("8. ⭐⭐⭐ READ JSON stricat → corrupt", (await readAuthzTxn("tx1", fakeRedis({ get: "{not json" }).client)).status === "corrupt");
check("9. ⭐⭐⭐ READ JSON valid dar formă invalidă → corrupt",
  (await readAuthzTxn("tx1", fakeRedis({ get: JSON.stringify({ txn_id: "tx1" }) }).client)).status === "corrupt");
{
  const raw = JSON.stringify(mkTxn());
  const res = await readAuthzTxn("tx1", fakeRedis({ get: raw }).client);
  check("10. ⭐⭐⭐ READ blob valid → found", res.status === "found");
  check("11. ⭐⭐⭐ READ found.raw byte-exact = blob-ul stocat", res.status === "found" && res.raw === raw);
  check("12. ⭐⭐ READ found.txn = parsed", res.status === "found" && res.txn.txn_id === "tx1" && res.txn.session_user_id === null);
}
check("13. ⭐⭐ READ throw → unavailable", (await readAuthzTxn("tx1", fakeRedis({ get: "x", throwOn: "get" }).client)).status === "unavailable");

// ── BIND (CAS) ──────────────────────────────────────────────────────────────────
check("14. ⭐⭐ BIND client null → unavailable",
  (await bindAuthzTxnUser({ txn: mkTxn(), raw: JSON.stringify(mkTxn()) }, "u1", null)).status === "unavailable");
{
  // bindUser respinge rebind la alt user (txn deja legată de "other").
  const boundOther = mkTxn({ session_user_id: "other" });
  const res = await bindAuthzTxnUser({ txn: boundOther, raw: JSON.stringify(boundOther) }, "u1", fakeRedis({ evalRet: 1 }).client);
  check("15. ⭐⭐⭐ BIND rebind la alt user → reject (fără a atinge Redis)", res.status === "reject");
}
{
  const txn = mkTxn();                      // nelegată (session_user_id null)
  const raw = JSON.stringify(txn);
  const { client, calls } = fakeRedis({ evalRet: 1 });
  const res = await bindAuthzTxnUser({ txn, raw }, "u1", client);
  check("16. ⭐⭐⭐ BIND CAS 1 → updated", res.status === "updated");
  check("17. ⭐⭐⭐ BIND updated.txn legat de user + newRaw îl conține",
    res.status === "updated" && res.txn.session_user_id === "u1" && res.raw === JSON.stringify({ ...txn, session_user_id: "u1" }));
  const evalArgs = calls.find(c => c.m === "eval")!.args;
  check("18. ⭐⭐ BIND CAS cheamă AUTHZ_TXN_BIND_CAS_LUA cu (oldRaw, newRaw)",
    evalArgs[0] === AUTHZ_TXN_BIND_CAS_LUA && evalArgs[3] === raw && evalArgs[4] === (res.status === "updated" ? res.raw : ""));
}
{
  const txn = mkTxn();
  const raw = JSON.stringify(txn);
  check("19. ⭐⭐ BIND CAS 0 → conflict", (await bindAuthzTxnUser({ txn, raw }, "u1", fakeRedis({ evalRet: 0 }).client)).status === "conflict");
  check("20. ⭐⭐ BIND CAS -1 → absent", (await bindAuthzTxnUser({ txn, raw }, "u1", fakeRedis({ evalRet: -1 }).client)).status === "absent");
  check("21. ⭐⭐ BIND CAS -2 → expired", (await bindAuthzTxnUser({ txn, raw }, "u1", fakeRedis({ evalRet: -2 }).client)).status === "expired");
  check("22. ⭐⭐ BIND throw → unavailable", (await bindAuthzTxnUser({ txn, raw }, "u1", fakeRedis({ evalRet: 1, throwOn: "eval" }).client)).status === "unavailable");
}
{
  // Idempotent: txn deja legată de "u1" → bindUser întoarce ACELAȘI txn → newRaw === oldRaw.
  const same = mkTxn({ session_user_id: "u1" });
  const raw = JSON.stringify(same);
  const { client, calls } = fakeRedis({ evalRet: 1 });
  const res = await bindAuthzTxnUser({ txn: same, raw }, "u1", client);
  const evalArgs = calls.find(c => c.m === "eval")!.args;
  check("23. ⭐⭐ BIND idempotent (același user) → updated, newRaw === oldRaw", res.status === "updated" && evalArgs[3] === raw && evalArgs[4] === raw);
}

// ── CONSUME ─────────────────────────────────────────────────────────────────────
check("24. ⭐⭐ CONSUME client null → unavailable", await consumeAuthzTxn("tx1", "raw", null) === "unavailable");
{
  const { client, calls } = fakeRedis({ evalRet: 1 });
  const res = await consumeAuthzTxn("tx1", "theRaw", client);
  check("25. ⭐⭐⭐ CONSUME eval 1 → consumed", res === "consumed");
  const evalArgs = calls.find(c => c.m === "eval")!.args;
  check("26. ⭐⭐ CONSUME cheamă AUTHZ_TXN_CONSUME_LUA cu (key, raw exact)",
    evalArgs[0] === AUTHZ_TXN_CONSUME_LUA && evalArgs[2] === authzTxnKey("tx1") && evalArgs[3] === "theRaw");
}
check("27. ⭐⭐⭐ CONSUME eval -1 (absent) → gone", await consumeAuthzTxn("tx1", "r", fakeRedis({ evalRet: -1 }).client) === "gone");
check("28. ⭐⭐⭐ CONSUME eval 0 (blob schimbat) → gone", await consumeAuthzTxn("tx1", "r", fakeRedis({ evalRet: 0 }).client) === "gone");
check("29. ⭐⭐ CONSUME throw → unavailable", await consumeAuthzTxn("tx1", "r", fakeRedis({ evalRet: 1, throwOn: "eval" }).client) === "unavailable");

// ── CREATE invalid (fail-closed la scriere, fără a atinge Redis) ─────────────────
{
  const { client, calls } = fakeRedis({ set: "OK" });
  const res = await createAuthzTxn(mkTxn({ txn_id: "" }), client); // txn_id gol → formă invalidă
  check("30. ⭐⭐⭐ CREATE txn invalid → 'invalid'", res === "invalid");
  check("31. ⭐⭐⭐ CREATE invalid NU atinge Redis (0 apeluri set)", calls.filter(c => c.m === "set").length === 0);
}

// ── READ legătura cheie↔identitate: blob cu alt txn_id decât cheia → corrupt ─────
{
  const blobForTx1 = JSON.stringify(mkTxn({ txn_id: "tx1" }));
  const res = await readAuthzTxn("OTHER-KEY", fakeRedis({ get: blobForTx1 }).client); // cheie ≠ txn_id din blob
  check("32. ⭐⭐⭐ READ blob cu txn_id ≠ cheia citită → corrupt (legătura cheie↔identitate)", res.status === "corrupt");
}
check("33. ⭐⭐ READ blob cu txn_id === cheia → found (control pozitiv)",
  (await readAuthzTxn("tx1", fakeRedis({ get: JSON.stringify(mkTxn({ txn_id: "tx1" })) }).client)).status === "found");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
