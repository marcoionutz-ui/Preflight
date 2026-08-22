/**
 * lib/db/quotaAtomic.integration.ts — PH-2 (DOVADĂ pe Redis REAL a quota-ei atomice multi-dimensionale).
 *
 * Rulează DOAR pe loopback + opt-in explicit (ca `refresh.integration.ts`):
 *   REDIS_URL=redis://127.0.0.1:6379 QUOTA_INTEGRATION_ALLOW=1 tsx lib/db/quotaAtomic.integration.ts
 * Altfel SKIP curat (exit 0). NU face flushdb — folosește chei unice + le curăță punctual.
 *
 * Dovedește (cgpt): (1) allow ⇒ toate cheile incrementate; (2) client plin ⇒ account NEatins; (3) account plin ⇒
 * client NEatins; (4) 2 clienți ai aceluiași user împart contorul de account; (5) client_credentials atinge DOAR
 * cheile clientului; (6) concurență la limită ⇒ trec EXACT câte permite plafonul; (7) denied ⇒ ZERO din cele 4 chei
 * se modifică; + retry_after = max TTL al ferestrelor care blochează. (Redis-down = plasa degraded a wiring-ului,
 * nu a Lua-ului — se dovedește la cablare.)
 */
import Redis from "ioredis";
import { QUOTA_CHECK_INCR_LUA, quotaFromEval, evalArgs,
         authCodeQuotaPlan, clientCredsQuotaPlan, accountRlKeys, clientRlKeys } from "./quotaAtomic";

const URL = process.env.REDIS_URL ?? "";
const LOOPBACK = /^redis:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(URL);
if (!LOOPBACK || process.env.QUOTA_INTEGRATION_ALLOW !== "1") {
  console.log("[quotaAtomic.integration] SKIP — cere REDIS_URL loopback + QUOTA_INTEGRATION_ALLOW=1");
  process.exit(0);
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

async function main(): Promise<void> {
  const r = new Redis(URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  const nWin = (plan: readonly { key: string }[]) => plan.length;

  async function run(plan: Parameters<typeof evalArgs>[0]) {
    const { keys, argv } = evalArgs(plan);
    const res = await r.eval(QUOTA_CHECK_INCR_LUA, keys.length, ...keys, ...argv);
    return quotaFromEval(res, nWin(plan));
  }
  const get = async (k: string) => Number(await r.get(k) ?? 0);
  async function delPlan(...keys: string[]) { if (keys.length) await r.del(...keys); }

  try {
    console.log("PH-2 — quotaAtomic pe Redis REAL");

    // ── (1) allow ⇒ toate cheile incrementate ────────────────────────────────
    {
      const u = "u_alw", c = "c_alw"; const ak = accountRlKeys(u), ck = clientRlKeys(c);
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
      const plan = authCodeQuotaPlan(u, { perMinute: 10, perDay: 100 }, { clientId: c, limits: { perMinute: 5, perDay: 50 } });
      const o = await run(plan);
      check("1. ⭐ allow → status ok", o?.status === "ok");
      check("1b. ⭐⭐ toate cele 4 chei = 1 după allow", (await get(ak.dayKey)) === 1 && (await get(ak.minKey)) === 1 && (await get(ck.dayKey)) === 1 && (await get(ck.minKey)) === 1);
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
    }

    // ── (2) client-minute plin ⇒ account NEatins ─────────────────────────────
    {
      const u = "u_cf", c = "c_cf"; const ak = accountRlKeys(u), ck = clientRlKeys(c);
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
      await r.set(ck.minKey, "5"); // client-minute la limită (5)
      const plan = authCodeQuotaPlan(u, { perMinute: 10, perDay: 100 }, { clientId: c, limits: { perMinute: 5, perDay: 50 } });
      const o = await run(plan);
      check("2. ⭐⭐⭐ client-minute plin → limited", o?.status === "limited");
      check("2b. ⭐⭐⭐ account NU s-a incrementat (all-or-nothing)", (await get(ak.minKey)) === 0 && (await get(ak.dayKey)) === 0);
      check("2c. ⭐ client-minute rămâne 5 (nu s-a atins)", (await get(ck.minKey)) === 5);
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
    }

    // ── (3) account-day plin ⇒ client NEatins ────────────────────────────────
    {
      const u = "u_af", c = "c_af"; const ak = accountRlKeys(u), ck = clientRlKeys(c);
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
      await r.set(ak.dayKey, "100"); // account-day la limită
      const plan = authCodeQuotaPlan(u, { perMinute: 10, perDay: 100 }, { clientId: c, limits: { perMinute: 5, perDay: 50 } });
      const o = await run(plan);
      check("3. ⭐⭐⭐ account-day plin → limited", o?.status === "limited");
      check("3b. ⭐⭐⭐ client NU s-a incrementat", (await get(ck.minKey)) === 0 && (await get(ck.dayKey)) === 0);
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
    }

    // ── (4) 2 clienți ai aceluiași user împart contorul de account ────────────
    {
      const u = "u_sh", cA = "c_shA", cB = "c_shB";
      const ak = accountRlKeys(u), ckA = clientRlKeys(cA), ckB = clientRlKeys(cB);
      await delPlan(ak.minKey, ak.dayKey, ckA.minKey, ckA.dayKey, ckB.minKey, ckB.dayKey);
      await run(authCodeQuotaPlan(u, { perMinute: 10, perDay: 100 }, { clientId: cA, limits: { perMinute: 5, perDay: 50 } }));
      await run(authCodeQuotaPlan(u, { perMinute: 10, perDay: 100 }, { clientId: cB, limits: { perMinute: 5, perDay: 50 } }));
      check("4. ⭐⭐⭐ account-min = 2 (ambii clienți ai aceluiași user au contribuit)", (await get(ak.minKey)) === 2);
      check("4b. ⭐ fiecare client are propriul contor = 1", (await get(ckA.minKey)) === 1 && (await get(ckB.minKey)) === 1);
      await delPlan(ak.minKey, ak.dayKey, ckA.minKey, ckA.dayKey, ckB.minKey, ckB.dayKey);
    }

    // ── (5) client_credentials atinge DOAR cheile clientului ─────────────────
    {
      const c = "c_cc"; const ck = clientRlKeys(c); const akGhost = accountRlKeys(c);
      await delPlan(ck.minKey, ck.dayKey, akGhost.minKey, akGhost.dayKey);
      const o = await run(clientCredsQuotaPlan(c, { perMinute: 20, perDay: 1000 }));
      check("5. ⭐⭐ client_credentials → ok, doar 2 chei client incrementate", o?.status === "ok" && (await get(ck.minKey)) === 1 && (await get(ck.dayKey)) === 1);
      check("5b. ⭐ nicio cheie de account atinsă", (await get(akGhost.minKey)) === 0 && (await get(akGhost.dayKey)) === 0);
      await delPlan(ck.minKey, ck.dayKey);
    }

    // ── (6) concurență la limită ⇒ trec EXACT câte permite plafonul ──────────
    {
      const u = "u_cc6", c = "c_cc6"; const ak = accountRlKeys(u), ck = clientRlKeys(c);
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
      const CAP = 10;
      const plan = authCodeQuotaPlan(u, { perMinute: CAP, perDay: 1000 }, { clientId: c, limits: { perMinute: 1000, perDay: 100000 } });
      const results = await Promise.all(Array.from({ length: 50 }, () => run(plan)));
      const allowed = results.filter(o => o?.status === "ok").length;
      check("6. ⭐⭐⭐ 50 concurente, cap account-min=10 → EXACT 10 permise", allowed === CAP);
      check("6b. ⭐⭐ account-min oprit fix la cap (10)", (await get(ak.minKey)) === CAP);
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
    }

    // ── (7) denied ⇒ ZERO din cele 4 chei se modifică ────────────────────────
    {
      const u = "u_d7", c = "c_d7"; const ak = accountRlKeys(u), ck = clientRlKeys(c);
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
      // account-day plin + celelalte cu valori arbitrare
      await r.set(ak.dayKey, "100"); await r.set(ak.minKey, "3"); await r.set(ck.dayKey, "7"); await r.set(ck.minKey, "2");
      const plan = authCodeQuotaPlan(u, { perMinute: 10, perDay: 100 }, { clientId: c, limits: { perMinute: 5, perDay: 50 } });
      const before = [await get(ak.dayKey), await get(ak.minKey), await get(ck.dayKey), await get(ck.minKey)];
      const o = await run(plan);
      const after = [await get(ak.dayKey), await get(ak.minKey), await get(ck.dayKey), await get(ck.minKey)];
      check("7. ⭐⭐⭐ denied → cele 4 chei NESCHIMBATE", o?.status === "limited" && JSON.stringify(before) === JSON.stringify(after));
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
    }

    // ── retry_after = max TTL al ferestrelor care blochează ──────────────────
    {
      const u = "u_ra", c = "c_ra"; const ak = accountRlKeys(u), ck = clientRlKeys(c);
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
      // ambele scope-uri pline pe minut ȘI zi → Lua auto-EXPIRE (TTL -1 → ttlSec); max = RL_DAY_TTL (86400)
      await r.set(ak.dayKey, "100"); await r.set(ak.minKey, "10");
      const plan = authCodeQuotaPlan(u, { perMinute: 10, perDay: 100 }, { accountOnly: true });
      const o = await run(plan);
      check("8. ⭐⭐ retry_after = max TTL blocant (86400, nu 60)", o?.status === "limited" && (o as { retryAfterSec: number }).retryAfterSec === 86_400);
      await delPlan(ak.minKey, ak.dayKey);
    }

    // ── (cgpt blocker #1) contor CORUPT într-o fereastră din mijloc → eval EȘUEAZĂ + TOATE cheile IDENTICE ──
    {
      const u = "u_corr", c = "c_corr"; const ak = accountRlKeys(u), ck = clientRlKeys(c);
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
      // fereastra 3 din 4 (client-day) coruptă cu „1.5"; celelalte au valori valide arbitrare
      await r.set(ak.dayKey, "5"); await r.set(ak.minKey, "1"); await r.set(ck.dayKey, "1.5"); await r.set(ck.minKey, "2");
      const plan = authCodeQuotaPlan(u, { perMinute: 10, perDay: 100 }, { clientId: c, limits: { perMinute: 5, perDay: 50 } });
      const before = [await r.get(ak.dayKey), await r.get(ak.minKey), await r.get(ck.dayKey), await r.get(ck.minKey)];
      let threw = false;
      try { await run(plan); } catch { threw = true; }
      const after = [await r.get(ak.dayKey), await r.get(ak.minKey), await r.get(ck.dayKey), await r.get(ck.minKey)];
      check("9. ⭐⭐⭐ contor corupt (client-day='1.5') → eval ARUNCĂ (redis.error_reply)", threw);
      check("9b. ⭐⭐⭐ TOATE cele 4 chei byte-identice (prevalidare înainte de orice mutație)", JSON.stringify(before) === JSON.stringify(after));
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
    }

    // ── (cgpt) contor NECANONIC pe care INCR l-ar respinge: '1e3' în fereastra 3 → eval EȘUEAZĂ + chei IDENTICE ──
    //   `tonumber('1e3')`=1000 (ar fi trecut prevalidarea veche) DAR `INCR` pe un string '1e3' aruncă → increment parțial.
    {
      const u = "u_e3", c = "c_e3"; const ak = accountRlKeys(u), ck = clientRlKeys(c);
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
      await r.set(ak.dayKey, "5"); await r.set(ak.minKey, "1"); await r.set(ck.dayKey, "1e3"); await r.set(ck.minKey, "2");
      const plan = authCodeQuotaPlan(u, { perMinute: 10, perDay: 100 }, { clientId: c, limits: { perMinute: 5, perDay: 50 } });
      const before = [await r.get(ak.dayKey), await r.get(ak.minKey), await r.get(ck.dayKey), await r.get(ck.minKey)];
      let threw = false;
      try { await run(plan); } catch { threw = true; }
      const after = [await r.get(ak.dayKey), await r.get(ak.minKey), await r.get(ck.dayKey), await r.get(ck.minKey)];
      check("10. ⭐⭐⭐ contor necanonic ('1e3', pe care INCR îl respinge) → eval ARUNCĂ", threw);
      check("10b. ⭐⭐⭐ cele 4 chei byte-identice (niciun INCR pe ferestrele anterioare)", JSON.stringify(before) === JSON.stringify(after));
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
    }

    // ── (cgpt) contor la limita int64 în fereastra 3 → respins de plafon ÎNAINTE de orice INCR (fără overflow) ──
    {
      const u = "u_ovf", c = "c_ovf"; const ak = accountRlKeys(u), ck = clientRlKeys(c);
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
      await r.set(ak.dayKey, "5"); await r.set(ak.minKey, "1"); await r.set(ck.dayKey, "9223372036854775807"); await r.set(ck.minKey, "2");
      const plan = authCodeQuotaPlan(u, { perMinute: 10, perDay: 100 }, { clientId: c, limits: { perMinute: 5, perDay: 50 } });
      const before = [await r.get(ak.dayKey), await r.get(ak.minKey), await r.get(ck.dayKey), await r.get(ck.minKey)];
      let threw = false;
      try { await run(plan); } catch { threw = true; }
      const after = [await r.get(ak.dayKey), await r.get(ak.minKey), await r.get(ck.dayKey), await r.get(ck.minKey)];
      check("11. ⭐⭐⭐ contor int64-max → eval ARUNCĂ (plafon anti-overflow înainte de INCR)", threw);
      check("11b. ⭐⭐⭐ cele 4 chei byte-identice", JSON.stringify(before) === JSON.stringify(after));
      await delPlan(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
    }

    console.log("\n" + passed + " passed, " + failed + " failed");
  } finally {
    r.disconnect();
  }
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("[quotaAtomic.integration] eroare:", e); process.exit(1); });
