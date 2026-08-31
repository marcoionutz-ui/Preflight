/**
 * lib/db/consumeAuthzTxnAndIssueCode.integration.ts — PH-2 pas 6 frunză 5 (DOVADĂ pe Redis REAL a porții atomice Approve).
 *
 * Rulează DOAR pe loopback + opt-in (ca `authzTxnStore.integration.ts`):
 *   REDIS_URL=redis://127.0.0.1:6379 QUOTA_INTEGRATION_ALLOW=1 tsx lib/db/consumeAuthzTxnAndIssueCode.integration.ts
 * Altfel SKIP curat. Chei unice + curățare punctuală (fără flushdb).
 *
 * Dovedește: (A) issued = cod scris (cu TTL) + txn ȘTEARSĂ; (B) second-submit → gone (txn deja consumată, fără al doilea
 * cod); (C) blob mismatch → gone + txn NEatinsă; (D) double-submit CONCURENT → EXACT un `issued`, celălalt `gone`;
 * (E) coliziune de cod (Lua direct) → -2 + txn NEștearsă (retry sigur); (F) retry PRIN wrapper: collision întâi →
 * issued la a doua (bucla de retry chiar rulează); (G) coliziune PERSISTENTĂ (5×) → unavailable după EXACT
 * MAX_ATTEMPTS evals, txn NEatinsă (fail-closed pe buclă epuizată, 503 retryable).
 */
import Redis from "ioredis";
import { consumeAuthzTxnAndIssueCode, type AuthCodePayload } from "./oauth-codes";
import { authzTxnKey, AUTHZ_TXN_CONSUME_ISSUE_LUA, AUTHZ_TXN_TTL_SEC, classifyTxnConsumeIssue } from "./authzTxnStore";

const URL = process.env.REDIS_URL ?? "";
const LOOPBACK = /^redis:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(URL);
if (!LOOPBACK || process.env.QUOTA_INTEGRATION_ALLOW !== "1") {
  console.log("[consumeAuthzTxnAndIssueCode.integration] SKIP — cere REDIS_URL loopback + QUOTA_INTEGRATION_ALLOW=1");
  process.exit(0);
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const SFX = Math.random().toString(36).slice(2, 10);
const codeKey = (c: string) => `mcp:code:${c}`; // oglindește helper-ul privat din oauth-codes.ts
const CODE_TTL_SEC = 5 * 60;

function mkPayload(): AuthCodePayload {
  return {
    client_id: "it-client", redirect_uri: "https://ex.test/cb", scopes: ["read:pair"],
    code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: "https://ex.test/api/mcp",
    state: "s", issued_at: Date.now(),
  } as unknown as AuthCodePayload;
}

async function main(): Promise<void> {
  const r = new Redis(URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  const seedTxn = (id: string, raw: string) => r.set(authzTxnKey(id), raw, "EX", AUTHZ_TXN_TTL_SEC);
  try {
    console.log("PH-2 pas 6 frunză 5 — consumeAuthzTxnAndIssueCode pe Redis REAL");

    // ── (A) issued: cod scris cu TTL + txn ștearsă ────────────────────────────
    {
      const id = `a_${SFX}`, raw = JSON.stringify({ txn_id: id, v: 1 });
      await seedTxn(id, raw);
      const out = await consumeAuthzTxnAndIssueCode(id, raw, mkPayload(), r);
      check("A1. ⭐⭐⭐ issued (cod emis)", out.status === "issued" && !!(out as { code?: string }).code);
      if (out.status === "issued") {
        const stored = await r.get(codeKey(out.code));
        const pttl   = await r.pttl(codeKey(out.code));
        const txnGone = await r.get(authzTxnKey(id));
        check("A2. ⭐⭐⭐ cheia code există + payload stocat (JSON)", stored !== null && stored.includes("it-client"));
        check("A3. ⭐⭐⭐ code TTL ≈ CODE_TTL_SEC (0 < pttl ≤ 300000ms)", pttl > 0 && pttl <= CODE_TTL_SEC * 1000);
        check("A4. ⭐⭐⭐ txn ȘTEARSĂ (consumată atomic cu emiterea)", txnGone === null);
        await r.del(codeKey(out.code));
      }
    }

    // ── (B) second-submit → gone (fără al doilea cod) ─────────────────────────
    {
      const id = `b_${SFX}`, raw = JSON.stringify({ txn_id: id, v: 1 });
      await seedTxn(id, raw);
      const first  = await consumeAuthzTxnAndIssueCode(id, raw, mkPayload(), r);
      const second = await consumeAuthzTxnAndIssueCode(id, raw, mkPayload(), r);
      check("B1. ⭐⭐⭐ primul → issued", first.status === "issued");
      check("B2. ⭐⭐⭐ al doilea (re-submit) → gone (txn deja consumată, fără al doilea cod)", second.status === "gone");
      if (first.status === "issued") await r.del(codeKey(first.code));
    }

    // ── (C) blob mismatch → gone + txn NEatinsă ───────────────────────────────
    {
      const id = `c_${SFX}`, rawA = JSON.stringify({ txn_id: id, v: "A" }), rawB = JSON.stringify({ txn_id: id, v: "B" });
      await seedTxn(id, rawA);
      const out = await consumeAuthzTxnAndIssueCode(id, rawB, mkPayload(), r); // blob greșit
      const txnStill = await r.get(authzTxnKey(id));
      check("C1. ⭐⭐⭐ blob greșit → gone", out.status === "gone");
      check("C2. ⭐⭐⭐ txn NEatinsă (blob-ul original intact)", txnStill === rawA);
      await r.del(authzTxnKey(id));
    }

    // ── (D) double-submit CONCURENT → EXACT un issued ─────────────────────────
    {
      const id = `d_${SFX}`, raw = JSON.stringify({ txn_id: id, v: 1 });
      await seedTxn(id, raw);
      const [o1, o2] = await Promise.all([
        consumeAuthzTxnAndIssueCode(id, raw, mkPayload(), r),
        consumeAuthzTxnAndIssueCode(id, raw, mkPayload(), r),
      ]);
      const statuses = [o1.status, o2.status].sort();
      check("D1. ⭐⭐⭐ concurent → EXACT un issued + un gone (Lua serializează)",
        statuses[0] === "gone" && statuses[1] === "issued");
      const txnGone = await r.get(authzTxnKey(id));
      check("D2. ⭐⭐⭐ txn ȘTEARSĂ o singură dată", txnGone === null);
      for (const o of [o1, o2]) if (o.status === "issued") await r.del(codeKey(o.code));
    }

    // ── (E) coliziune de cod (Lua DIRECT) → -2 + txn NEștearsă ─────────────────
    {
      const id = `e_${SFX}`, raw = JSON.stringify({ txn_id: id, v: 1 });
      const takenCode = `taken_${SFX}`;
      await seedTxn(id, raw);
      await r.set(codeKey(takenCode), "OCCUPIED", "EX", CODE_TTL_SEC); // cheia code deja ocupată
      const res = await r.eval(AUTHZ_TXN_CONSUME_ISSUE_LUA, 2, authzTxnKey(id), codeKey(takenCode), raw, "{}", String(CODE_TTL_SEC));
      const txnStill = await r.get(authzTxnKey(id));
      const codeStill = await r.get(codeKey(takenCode));
      check("E1. ⭐⭐⭐ cheia code ocupată → -2 (collision)", classifyTxnConsumeIssue(res) === "collision");
      check("E2. ⭐⭐⭐ txn NEștearsă pe coliziune (retry sigur)", txnStill === raw);
      check("E3. ⭐⭐⭐ cheia code ocupată NEsuprascrisă (SET NX)", codeStill === "OCCUPIED");
      await r.del(authzTxnKey(id), codeKey(takenCode));
    }

    // ── (F) retry PRIN WRAPPER: collision pe prima încercare → retry → issued cu cod NOU ──
    // Proxy peste clientul REAL: prima `eval` întoarce -2 (collision forțată), a doua deleagă la Redis-ul real.
    // Dovedește că bucla de retry a wrapper-ului chiar rulează + generează cod nou (P2: retry-ul e acum executat).
    {
      const id = `f_${SFX}`, raw = JSON.stringify({ txn_id: id, v: 1 });
      await seedTxn(id, raw);
      let evalCalls = 0;
      const codeKeysSeen: string[] = [];
      const proxy = {
        eval: (script: string, numkeys: number, ...args: (string | number)[]) => {
          evalCalls++;
          codeKeysSeen.push(String(args[1])); // args = [txnKey, codeKey, txnRaw, body, ttl] → args[1]=codeKey
          if (evalCalls === 1) return Promise.resolve(-2); // collision forțată pe PRIMA încercare
          return (r.eval as (...a: unknown[]) => Promise<unknown>)(script, numkeys, ...args); // real la a doua
        },
      } as unknown as typeof r;
      const out = await consumeAuthzTxnAndIssueCode(id, raw, mkPayload(), proxy);
      check("F1. ⭐⭐⭐ retry PRIN wrapper: collision întâi → issued la a doua", out.status === "issued");
      check("F2. ⭐⭐⭐ eval apelat de ≥2 ori (bucla de retry chiar rulează)", evalCalls >= 2);
      check("F3. ⭐⭐⭐ cod NOU pe retry (codeKey diferit între încercări)", codeKeysSeen.length >= 2 && codeKeysSeen[0] !== codeKeysSeen[1]);
      check("F4. ⭐⭐⭐ txn consumată REAL la a doua încercare (nu doar contorul)", (await r.get(authzTxnKey(id))) === null);
      if (out.status === "issued") await r.del(codeKey(out.code));
    }

    // ── (G) coliziune PERSISTENTĂ (5×): eval → -2 la FIECARE încercare → unavailable, txn NEatinsă ──
    // Proxy peste clientul REAL: `eval` întoarce -2 la TOATE apelurile (nu atinge niciodată Redis).
    // Dovedește epuizarea buclei mărginite: EXACT MAX_ATTEMPTS(5) evals → {unavailable}, fără cod scris,
    // txn rămasă INTACTĂ (coliziunea SET NX nu șterge txn → 503 e retryable pe txn încă vie).
    {
      const id = `g_${SFX}`, raw = JSON.stringify({ txn_id: id, v: 1 });
      await seedTxn(id, raw);
      let evalCalls = 0;
      const codeKeysSeen: string[] = [];
      const proxy = {
        eval: (_script: string, _numkeys: number, ..._args: (string | number)[]) => {
          evalCalls++;
          codeKeysSeen.push(String(_args[1])); // args[1] = codeKey
          return Promise.resolve(-2); // collision forțată la FIECARE încercare (nu atinge Redis)
        },
      } as unknown as typeof r;
      const out = await consumeAuthzTxnAndIssueCode(id, raw, mkPayload(), proxy);
      check("G1. ⭐⭐⭐ coliziune persistentă → unavailable (fail-closed după epuizarea buclei)", out.status === "unavailable");
      check("G2. ⭐⭐⭐ EXACT MAX_ATTEMPTS(5) evals (buclă mărginită, fără retry infinit)", evalCalls === 5);
      check("G3. ⭐⭐⭐ cod NOU la fiecare încercare (5 codeKey distincte)",
        codeKeysSeen.length === 5 && new Set(codeKeysSeen).size === 5);
      check("G4. ⭐⭐⭐ txn NEatinsă (SET NX picat nu șterge txn → 503 retryable pe txn încă vie)",
        (await r.get(authzTxnKey(id))) === raw);
      await r.del(authzTxnKey(id));
    }

    console.log("\n" + passed + " passed, " + failed + " failed");
  } finally {
    await r.quit();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
