/**
 * lib/db/authzTxnStoreIo.integration.ts — PH-2 step 10.3b-iv frunză 3 (DOVADĂ pe Redis REAL a wrapperelor I/O).
 *
 * Spre deosebire de `authzTxnStore.integration.ts` (care evaluează Lua-ul DIRECT), aici trecem prin FUNCȚIILE-wrapper
 * reale (`createAuthzTxn`/`readAuthzTxn`/`bindAuthzTxnUser`/`consumeAuthzTxn`) cu un client ioredis injectat → dovedim
 * lanțul complet al fluxului `/authorize`, pe atomicitate reală (NX / CAS pe blob / compare-and-delete).
 *
 * Rulează DOAR pe loopback + opt-in:
 *   REDIS_URL=redis://127.0.0.1:6379 QUOTA_INTEGRATION_ALLOW=1 tsx lib/db/authzTxnStoreIo.integration.ts
 * Altfel SKIP curat. Chei unice per rulare + curățare punctuală (fără flushdb).
 *
 * Dovedește: (A) lifecycle create→read(found)→bind→read(bound)→consume→read(absent); (B) CREATE NX one-time (a doua
 * creare → collision, blob-ul NU se suprascrie); (C) CONSUME compare-and-delete (re-consum → gone; blob GREȘIT → gone +
 * cheia NEștearsă); (D) BIND CAS pe blob stale → conflict; (E) BIND sticky reject rebind la alt user; (F) READ corrupt
 * pe blob stricat scris direct.
 */
import Redis from "ioredis";
import { createAuthzTxn, readAuthzTxn, bindAuthzTxnUser, consumeAuthzTxn } from "./authzTxnStoreIo";
import { authzTxnKey } from "./authzTxnStore";
import { buildAuthzTransaction, type AuthzTransaction } from "../oauth/authzTransaction";

const URL = process.env.REDIS_URL ?? "";
const LOOPBACK = /^redis:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(URL);
if (!LOOPBACK || process.env.QUOTA_INTEGRATION_ALLOW !== "1") {
  console.log("[authzTxnStoreIo.integration] SKIP — cere REDIS_URL loopback + QUOTA_INTEGRATION_ALLOW=1");
  process.exit(0);
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const SFX = Math.random().toString(36).slice(2, 10);
const CH  = "E9Melgz-yJgAB3Y9jn0aY0kEwlWdW3l1o0V0lqTfMug"; // 43-char base64url valid
function mkTxn(id: string, over: Partial<AuthzTransaction> = {}): AuthzTransaction {
  const r = buildAuthzTransaction({
    txn_id: id, csrf_token: "csrf_" + id, registration_id: "reg1", client_id: "c1",
    redirect_uri: "https://claude.ai/cb", state: "st", resource: "https://x/api/mcp",
    requested_scopes: ["read:all"], code_challenge: CH, code_challenge_method: "S256",
    now: Date.now(), ttlMs: 600000,
  });
  if (!r.ok) throw new Error("fixture txn invalid: " + r.error);
  return { ...r.txn, ...over };
}

async function main(): Promise<void> {
  const r  = new Redis(URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  const r2 = new Redis(URL, { maxRetriesPerRequest: 2, lazyConnect: false }); // a doua conexiune → cursă reală
  const made: string[] = [];
  const id = (name: string) => `it_${name}_${SFX}`;
  const track = (txnId: string) => { made.push(authzTxnKey(txnId)); return txnId; };

  try {
    // ── (A) lifecycle complet ────────────────────────────────────────────────────
    const aId = track(id("A"));
    const aTxn = mkTxn(aId);
    check("A1. CREATE nelegată → created", await createAuthzTxn(aTxn, r) === "created");

    const read1 = await readAuthzTxn(aId, r);
    check("A2. READ → found, nelegată (session_user_id null)", read1.status === "found" && read1.txn.session_user_id === null);
    check("A3. READ found.raw byte-exact = JSON.stringify(txn)", read1.status === "found" && read1.raw === JSON.stringify(aTxn));

    const bind = read1.status === "found" ? await bindAuthzTxnUser({ txn: read1.txn, raw: read1.raw }, "user-A", r) : { status: "unavailable" as const };
    check("A4. BIND user-A → updated", bind.status === "updated");
    check("A5. BIND updated.txn legat de user-A", bind.status === "updated" && bind.txn.session_user_id === "user-A");

    const pttl = await r.pttl(authzTxnKey(aId));
    check("A6. BIND păstrează TTL (0 < pttl ≤ fereastra 600s)", pttl > 0 && pttl <= 600000);

    const read2 = await readAuthzTxn(aId, r);
    check("A7. READ după bind → found, legată de user-A", read2.status === "found" && read2.txn.session_user_id === "user-A");
    check("A8. READ raw post-bind = raw-ul întors de BIND", read2.status === "found" && bind.status === "updated" && read2.raw === bind.raw);

    const boundRaw = read2.status === "found" ? read2.raw : "";
    check("A9. CONSUME cu raw-ul legat → consumed", await consumeAuthzTxn(aId, boundRaw, r) === "consumed");
    check("A10. READ după consume → absent", (await readAuthzTxn(aId, r)).status === "absent");

    // ── (B) CREATE NX one-time ───────────────────────────────────────────────────
    const bId = track(id("B"));
    const bTxn = mkTxn(bId);
    check("B1. CREATE → created", await createAuthzTxn(bTxn, r) === "created");
    const bTxn2 = mkTxn(bId, { csrf_token: "DIFERIT" }); // același id, blob diferit
    check("B2. CREATE al doilea pe același id → collision", await createAuthzTxn(bTxn2, r) === "collision");
    const readB = await readAuthzTxn(bId, r);
    check("B3. blob-ul NU s-a suprascris (csrf original păstrat)", readB.status === "found" && readB.txn.csrf_token === "csrf_" + bId);

    // ── (C) CONSUME compare-and-delete ───────────────────────────────────────────
    const cId = track(id("C"));
    const cTxn = mkTxn(cId);
    await createAuthzTxn(cTxn, r);
    const cRaw = JSON.stringify(cTxn);
    check("C1. CONSUME cu blob GREȘIT → gone + cheia NEștearsă", await consumeAuthzTxn(cId, cRaw + "x", r) === "gone");
    check("C2. cheia încă există după consume cu blob greșit", (await readAuthzTxn(cId, r)).status === "found");
    check("C3. CONSUME cu blob corect → consumed", await consumeAuthzTxn(cId, cRaw, r) === "consumed");
    check("C4. re-CONSUME (deja consumat) → gone", await consumeAuthzTxn(cId, cRaw, r) === "gone");

    // ── (D) BIND CAS pe blob stale → conflict ────────────────────────────────────
    const dId = track(id("D"));
    const dTxn = mkTxn(dId);
    await createAuthzTxn(dTxn, r);
    const readD = await readAuthzTxn(dId, r);            // raw1 (nelegată)
    await bindAuthzTxnUser({ txn: dTxn, raw: JSON.stringify(dTxn) }, "user-D", r); // mută la raw2 (legată)
    const staleBind = readD.status === "found" ? await bindAuthzTxnUser({ txn: readD.txn, raw: readD.raw }, "user-D", r) : { status: "unavailable" as const };
    check("D1. BIND cu raw STALE (blob deja schimbat) → conflict", staleBind.status === "conflict");

    // ── (E) BIND sticky: rebind la alt user → reject ─────────────────────────────
    const eId = track(id("E"));
    const eTxn = mkTxn(eId);
    await createAuthzTxn(eTxn, r);
    const readE = await readAuthzTxn(eId, r);
    const b1 = readE.status === "found" ? await bindAuthzTxnUser({ txn: readE.txn, raw: readE.raw }, "user-E", r) : { status: "unavailable" as const };
    const rebind = b1.status === "updated" ? await bindAuthzTxnUser({ txn: b1.txn, raw: b1.raw }, "user-OTHER", r) : { status: "unavailable" as const };
    check("E1. BIND legată de user-E, rebind la user-OTHER → reject", rebind.status === "reject");

    // ── (F) READ corrupt pe blob stricat ─────────────────────────────────────────
    const fId = track(id("F"));
    await r.set(authzTxnKey(fId), "{nu-i json", "EX", 600);
    check("F1. READ pe JSON stricat → corrupt", (await readAuthzTxn(fId, r)).status === "corrupt");
    await r.set(authzTxnKey(fId), JSON.stringify({ txn_id: fId }), "EX", 600); // formă invalidă
    check("F2. READ pe formă invalidă → corrupt", (await readAuthzTxn(fId, r)).status === "corrupt");

    // ── (G) CURSĂ REALĂ (2 conexiuni): două BIND concurente, useri diferiți → exact unul updated ──
    const gId = track(id("G"));
    await createAuthzTxn(mkTxn(gId), r);
    const readG = await readAuthzTxn(gId, r);
    if (readG.status !== "found") {
      check("G. precondiție: read found", false);
    } else {
      const binds = await Promise.all([
        bindAuthzTxnUser({ txn: readG.txn, raw: readG.raw }, "user-P", r),
        bindAuthzTxnUser({ txn: readG.txn, raw: readG.raw }, "user-Q", r2),
      ]);
      check("G1. două BIND concurente (useri diferiți) → exact unul updated", binds.filter(b => b.status === "updated").length === 1);
      check("G2. celălalt BIND → conflict (CAS a pierdut)", binds.filter(b => b.status === "conflict").length === 1);
      // nit cgpt: starea STOCATĂ trebuie să fie exact câștigătorul returnat (nu doar numărătoarea).
      const winner = binds.find(b => b.status === "updated");
      const afterG = await readAuthzTxn(gId, r);
      const okG3 = winner && winner.status === "updated" && afterG.status === "found" && afterG.txn.session_user_id === winner.txn.session_user_id;
      check("G3. userul STOCAT === câștigătorul returnat de BIND", !!okG3);
    }

    // ── (H) CURSĂ REALĂ (2 conexiuni): două CONSUME concurente pe același raw → exact unul consumed ──
    const hId = track(id("H"));
    const hTxn = mkTxn(hId);
    await createAuthzTxn(hTxn, r);
    const hRaw = JSON.stringify(hTxn);
    const consumes = await Promise.all([
      consumeAuthzTxn(hId, hRaw, r),
      consumeAuthzTxn(hId, hRaw, r2),
    ]);
    check("H1. două CONSUME concurente → exact unul consumed", consumes.filter(x => x === "consumed").length === 1);
    check("H2. celălalt CONSUME → gone", consumes.filter(x => x === "gone").length === 1);
  } finally {
    // curățare punctuală ÎN finally (cgpt): dacă un apel direct Redis aruncă înainte de cleanup, nu lăsăm reziduuri.
    if (made.length) await r.del(...made);
    const leftover = made.length ? await r.exists(...made) : 0;
    check("Z. curățare: 0 chei rămase", leftover === 0);
    r.disconnect();
    r2.disconnect();
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
}

main().then(() => process.exit(failed > 0 ? 1 : 0)).catch(e => { console.error(e); process.exit(1); });
