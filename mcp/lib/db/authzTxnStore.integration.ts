/**
 * lib/db/authzTxnStore.integration.ts — PH-2 step 10.3b-i (DOVADĂ pe Redis REAL a store-ului de tranzacție).
 *
 * Rulează DOAR pe loopback + opt-in (ca `quotaAtomic.integration.ts`):
 *   REDIS_URL=redis://127.0.0.1:6379 QUOTA_INTEGRATION_ALLOW=1 tsx lib/db/authzTxnStore.integration.ts
 * Altfel SKIP curat. Chei unice + curățare punctuală (fără flushdb).
 *
 * Dovedește: (1) CREATE NX one-time (a doua creare pe același id → collision, blob-ul NU se suprascrie); (2) CONSUME
 * compare-and-delete (consumă exact blob-ul citit; a doua consumare → gone; consumare cu blob GREȘIT → gone + cheia
 * NEștearsă); (3) BIND CAS (aplică noul blob doar dacă cel curent e neschimbat; CAS pe blob vechi după o modificare →
 * conflict; TTL-ul rămas e PĂSTRAT, nu resetat).
 */
import Redis from "ioredis";
import {
  authzTxnKey, AUTHZ_TXN_TTL_SEC, classifyTxnCreate,
  AUTHZ_TXN_CONSUME_LUA, classifyTxnConsume, AUTHZ_TXN_BIND_CAS_LUA, classifyTxnCas,
} from "./authzTxnStore";

const URL = process.env.REDIS_URL ?? "";
const LOOPBACK = /^redis:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(URL);
if (!LOOPBACK || process.env.QUOTA_INTEGRATION_ALLOW !== "1") {
  console.log("[authzTxnStore.integration] SKIP — cere REDIS_URL loopback + QUOTA_INTEGRATION_ALLOW=1");
  process.exit(0);
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

// sufix random per rulare → chei disjuncte între rulări paralele.
const SFX = Math.random().toString(36).slice(2, 10);
const K = (name: string) => authzTxnKey(`it_${name}_${SFX}`);

async function main(): Promise<void> {
  const r = new Redis(URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  const create = (k: string, v: string) => r.set(k, v, "EX", AUTHZ_TXN_TTL_SEC, "NX");
  const consume = (k: string, old: string) => r.eval(AUTHZ_TXN_CONSUME_LUA, 1, k, old);
  const casBind = (k: string, oldV: string, newV: string) => r.eval(AUTHZ_TXN_BIND_CAS_LUA, 1, k, oldV, newV);

  try {
    console.log("PH-2 step 10.3b-i — authzTxnStore pe Redis REAL");

    // ── (1) CREATE NX one-time ────────────────────────────────────────────────
    {
      const k = K("create");
      await r.del(k);
      const first = classifyTxnCreate(await create(k, "blobA"));
      const second = classifyTxnCreate(await create(k, "blobB"));
      check("1. ⭐⭐ prima creare → created", first === "created");
      check("2. ⭐⭐⭐ a doua creare pe același id → collision (NX)", second === "collision");
      check("3. ⭐⭐⭐ blob-ul NU s-a suprascris (rămâne blobA)", (await r.get(k)) === "blobA");
      await r.del(k);
    }

    // ── (2) CONSUME compare-and-delete ────────────────────────────────────────
    {
      const k = K("consume");
      await r.del(k);
      await create(k, "blobX");
      check("4. ⭐⭐⭐ consumare cu blob GREȘIT → gone + cheia NEștearsă", classifyTxnConsume(await consume(k, "WRONG")) === "gone" && (await r.exists(k)) === 1);
      check("5. ⭐⭐⭐ consumare cu blob corect → consumed + cheia ștearsă", classifyTxnConsume(await consume(k, "blobX")) === "consumed" && (await r.exists(k)) === 0);
      check("6. ⭐⭐⭐ a doua consumare (deja folosită) → gone", classifyTxnConsume(await consume(k, "blobX")) === "gone");
    }

    // ── (3) BIND CAS + TTL preserved (ms) ─────────────────────────────────────
    {
      const k = K("bind");
      await r.del(k);
      await create(k, "v1");
      await r.pexpire(k, 300_000); // TTL rămas ~300s
      const ok1 = classifyTxnCas(await casBind(k, "v1", "v2"));
      check("7. ⭐⭐⭐ CAS pe blob curent (v1→v2) → updated + GET=v2", ok1 === "updated" && (await r.get(k)) === "v2");
      const pttl = await r.pttl(k);
      check("8. ⭐⭐⭐ TTL PĂSTRAT după bind (~300s, nu resetat la 600s)", pttl > 0 && pttl <= 300_000);
      const conflict = classifyTxnCas(await casBind(k, "v1", "v3")); // v1 nu mai e curent (e v2)
      check("9. ⭐⭐⭐ CAS pe blob VECHI (v1 după modificare) → conflict + neschimbat (v2)", conflict === "conflict" && (await r.get(k)) === "v2");
      await r.del(k);
      check("10. ⭐⭐ CAS pe cheie absentă → absent", classifyTxnCas(await casBind(k, "v1", "v2")) === "absent");
    }

    // ── (4) MARGINE sub-secundă: PTTL < 1s → bind NU reînvie cheia cu o fereastră nouă ──
    {
      const k = K("margin");
      await r.del(k);
      await create(k, "m1");
      await r.pexpire(k, 700); // 0.7s rămas — `TTL` (secunde) ar da 0 și ar declanșa bug-ul de reînviere
      const res = classifyTxnCas(await casBind(k, "m1", "m2"));
      const pttl = await r.pttl(k);
      // Bind-ul fie a rescris cu PX ~700ms (updated, TTL rămâne SUB 1s), fie a fost respins (expired) — în NICIUN caz
      // cheia NU trebuie să aibă ~600s. Cheia poate lipsi deja dacă a expirat între timp (-2 pttl) — și ăla-i ok.
      // Strict: pe `updated` TTL-ul rămas trebuie POZITIV și sub 1s (nu -1/fără-expirare); pe expired/absent cheia e gone.
      const strictTtl = res === "updated" ? (pttl > 0 && pttl <= 1000) : (pttl <= 0);
      check("11. ⭐⭐⭐ sub-secundă → NU reînviere: TTL rămas 0<pttl≤1s pe updated (nu -1/nu ~600s), gone pe expired/absent",
        (res === "updated" || res === "expired" || res === "absent") && strictTtl);
      await r.del(k);
    }

    console.log("\n" + passed + " passed, " + failed + " failed");
  } finally {
    r.disconnect();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("[authzTxnStore.integration] eroare:", e); process.exit(1); });
