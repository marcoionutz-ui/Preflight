/**
 * lib/db/authzTxnActionClaim.integration.ts — PH-2 pas 6 frunză 5b-iii (DOVADĂ pe Redis REAL a arbitrării cross-action).
 *
 * Rulează DOAR pe loopback + opt-in (ca celelalte integration):
 *   REDIS_URL=redis://127.0.0.1:6379 QUOTA_INTEGRATION_ALLOW=1 tsx lib/db/authzTxnActionClaim.integration.ts
 * Altfel SKIP curat. Chei unice + curățare punctuală (fără flushdb).
 *
 * Dovada DECISIVĂ (cursa cgpt): Approve și Deny concurente pe ACEEAȘI txn → EXACT o acțiune câștigă (`won`), cealaltă
 * PIERDE (`lost` cu `winner` = câștigătorul). SCOP: acest test dovedește ATOMICITATEA arbitrării (won/lost) pe Redis
 * real — NU observă Supabase/grant/code. Proprietatea „perdantul nu lasă grant orfan / cod" rezultă din COMBINAȚIA cu
 * source-guard-ul rutei (`consentRouteWiring`): perdantul iese pe `terminal` ÎNAINTE de insertGrant/consume.
 * (A) concurent → exact un won; (B) idempotent pe aceeași acțiune; (C) secvențial: perdantul vede câștigătorul;
 * (D) txn diferite nu interferează.
 */
import Redis from "ioredis";
import { claimAuthzTxnAction } from "./authzTxnStoreIo";
import { authzActionClaimKey } from "./authzTxnStore";

const URL = process.env.REDIS_URL ?? "";
const LOOPBACK = /^redis:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(URL);
if (!LOOPBACK || process.env.QUOTA_INTEGRATION_ALLOW !== "1") {
  console.log("[authzTxnActionClaim.integration] SKIP — cere REDIS_URL loopback + QUOTA_INTEGRATION_ALLOW=1");
  process.exit(0);
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const SFX = Math.random().toString(36).slice(2, 10);

async function main(): Promise<void> {
  const r = new Redis(URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  try {
    console.log("PH-2 pas 6 frunză 5b-iii — arbitrare cross-action pe Redis REAL");

    // ── (A) APPROVE + DENY CONCURENT → EXACT un won, celălalt lost cu winner = câștigătorul ──
    {
      const id = `a_${SFX}`;
      const [approve, deny] = await Promise.all([
        claimAuthzTxnAction(id, "approve", r),
        claimAuthzTxnAction(id, "deny", r),
      ]);
      const statuses = [approve.status, deny.status].sort();
      check("A1. ⭐⭐⭐ concurent approve+deny → EXACT un won + un lost (nu ambele câștigă)",
        statuses[0] === "lost" && statuses[1] === "won");
      // Câștigătorul e cel cu 'won'; perdantul trebuie să-l vadă exact ca `winner`.
      const winner = approve.status === "won" ? "approve" : "deny";
      const loser  = approve.status === "won" ? deny : approve;
      check("A2. ⭐⭐⭐ perdantul vede EXACT acțiunea câștigătoare în `winner`",
        loser.status === "lost" && loser.winner === winner);
      // Cheia de claim reflectă câștigătorul (o singură valoare persistată).
      check("A3. ⭐⭐⭐ cheia de claim conține DOAR acțiunea câștigătoare",
        (await r.get(authzActionClaimKey(id))) === winner);
      await r.del(authzActionClaimKey(id));
    }

    // ── (B) IDEMPOTENT: aceeași acțiune de două ori → won apoi idempotent (retry sigur) ──
    {
      const id = `b_${SFX}`;
      const first  = await claimAuthzTxnAction(id, "approve", r);
      const second = await claimAuthzTxnAction(id, "approve", r);
      check("B1. ⭐⭐⭐ primul approve → won", first.status === "won");
      check("B2. ⭐⭐⭐ al doilea approve (retry) → idempotent (NU lost — poate re-rula sigur)", second.status === "idempotent");
      await r.del(authzActionClaimKey(id));
    }

    // ── (C) SECVENȚIAL: approve câștigă, apoi deny → lost{winner:'approve'} (perdant târziu vede câștigătorul) ──
    {
      const id = `c_${SFX}`;
      const approve = await claimAuthzTxnAction(id, "approve", r);
      const deny    = await claimAuthzTxnAction(id, "deny", r);
      check("C1. ⭐⭐⭐ approve → won; deny ulterior → lost cu winner='approve' (deny NU produce efecte)",
        approve.status === "won" && deny.status === "lost" && deny.status === "lost" && deny.winner === "approve");
      await r.del(authzActionClaimKey(id));
    }

    // ── (D) txn DIFERITE nu interferează (fiecare are propriul claim) ──
    {
      const idA = `d1_${SFX}`, idB = `d2_${SFX}`;
      const a = await claimAuthzTxnAction(idA, "approve", r);
      const b = await claimAuthzTxnAction(idB, "deny", r);
      check("D1. ⭐⭐ txn diferite → ambele câștigă acțiunea lor (claim per-txn independent)", a.status === "won" && b.status === "won");
      await r.del(authzActionClaimKey(idA), authzActionClaimKey(idB));
    }

    console.log("\n" + passed + " passed, " + failed + " failed");
  } finally {
    await r.quit();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
