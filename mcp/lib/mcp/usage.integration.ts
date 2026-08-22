/**
 * lib/mcp/usage.integration.ts — PH-2 9b (DOVADĂ pe Redis REAL că `reserveQuota` cheamă quota lunară pe SUBIECT).
 *
 * Rulează DOAR pe loopback + opt-in (ca `quotaAtomic.integration.ts`):
 *   REDIS_URL=redis://127.0.0.1:6379 QUOTA_INTEGRATION_ALLOW=1 tsx lib/mcp/usage.integration.ts
 * Altfel SKIP curat (exit 0). NU face flushdb — chei unice + curățare punctuală.
 *
 * `usage.ts` importă `supabase-admin` (createClient are nevoie de URL/key truthy la load), dar `reserveQuota` NU
 * atinge Supabase — setăm env DUMMY înainte de import ca modulul să se încarce; nimic nu se conectează la Supabase.
 *
 * Dovedește (9b): (1) subiect CLIENT → incrementează cheia LEGACY `mcp:quota:${clientId}:${ym}` (byte-identic cu
 * azi → fără reset de contor); (2) subiect ACCOUNT → cheia `mcp:quota:acct:${userId}:${ym}`; (3) account vs client
 * cu ACELAȘI id string → chei DIFERITE; (4) doi clienți ai aceluiași user (2 apeluri account, același userId) împart
 * contorul; (5) depășit → contor NEschimbat + status exceeded; (6) refund pe cheia PINNED decrementează cheia
 * corectă; (7) unlimited (-1) → nicio cheie atinsă. Oracle-ul cheii e construit INDEPENDENT (string brut, nu prin
 * `monthlyQuotaKey`) ca să prindă o cablare greșită.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL   ||= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY  ||= "dummy-service-role-key-integration";

import Redis from "ioredis";

const URL = process.env.REDIS_URL ?? "";
const LOOPBACK = /^redis:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(URL);
if (!LOOPBACK || process.env.QUOTA_INTEGRATION_ALLOW !== "1") {
  console.log("[usage.integration] SKIP — cere REDIS_URL loopback + QUOTA_INTEGRATION_ALLOW=1");
  process.exit(0);
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

// Oracle INDEPENDENT al lunii curente (nu prin quotaKey.ts) — format brut, ca să prindem o cablare greșită.
function ymNow(): string {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const { reserveQuota, refundQuota } = await import("./usage");
  const r = new Redis(URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  const ym = ymNow();
  const get = async (k: string) => Number(await r.get(k) ?? 0);

  try {
    console.log("PH-2 — usage.reserveQuota pe Redis REAL (cheie pe subiect)");

    // ── (1) subiect CLIENT → cheia LEGACY, byte-identică cu azi ────────────────
    {
      const clientId = "c_leg";
      const legacyKey = `mcp:quota:${clientId}:${ym}`; // exact ce producea quotaKey(clientId) înainte de PH-2
      await r.del(legacyKey);
      const o = await reserveQuota({ kind: "client", clientId }, 1, 100);
      check("1. ⭐⭐⭐ client → reserved, cheia returnată = cheia LEGACY", o.status === "reserved" && (o as { key: string }).key === legacyKey);
      check("1b. ⭐⭐ contorul de la cheia legacy = 1 (client_credentials neschimbat)", (await get(legacyKey)) === 1);
      await r.del(legacyKey);
    }

    // ── (2) subiect ACCOUNT → cheia acct: ─────────────────────────────────────
    {
      const userId = "u_acc";
      const acctKey = `mcp:quota:acct:${userId}:${ym}`;
      await r.del(acctKey);
      const o = await reserveQuota({ kind: "account", userId }, 1, 100);
      check("2. ⭐⭐⭐ account → reserved, cheia = mcp:quota:acct:<userId>:<ym>", o.status === "reserved" && (o as { key: string }).key === acctKey);
      check("2b. ⭐⭐ contorul de la cheia de cont = 1", (await get(acctKey)) === 1);
      await r.del(acctKey);
    }

    // ── (3) account vs client cu ACELAȘI id → chei DIFERITE, contoare separate ─
    {
      const id = "same_id";
      const clientKey = `mcp:quota:${id}:${ym}`, acctKey = `mcp:quota:acct:${id}:${ym}`;
      await r.del(clientKey, acctKey);
      await reserveQuota({ kind: "client",  clientId: id }, 1, 100);
      await reserveQuota({ kind: "account", userId:   id }, 1, 100);
      check("3. ⭐⭐⭐ chei separate: client=1 ȘI account=1 (fără coliziune pe același string)", (await get(clientKey)) === 1 && (await get(acctKey)) === 1);
      await r.del(clientKey, acctKey);
    }

    // ── (4) doi clienți ai aceluiași user împart contorul de cont ─────────────
    {
      const userId = "u_shared";
      const acctKey = `mcp:quota:acct:${userId}:${ym}`;
      await r.del(acctKey);
      await reserveQuota({ kind: "account", userId }, 1, 100); // „client A" al userului
      await reserveQuota({ kind: "account", userId }, 1, 100); // „client B" al aceluiași user
      check("4. ⭐⭐⭐ 2 rezervări pe același userId → contor de cont = 2 (quota partajată)", (await get(acctKey)) === 2);
      await r.del(acctKey);
    }

    // ── (5) depășit → contor NEschimbat + status exceeded ─────────────────────
    {
      const clientId = "c_exc";
      const key = `mcp:quota:${clientId}:${ym}`;
      await r.del(key);
      await r.set(key, "100"); // deja la quota
      const o = await reserveQuota({ kind: "client", clientId }, 1, 100);
      check("5. ⭐⭐⭐ la quota → exceeded", o.status === "exceeded");
      check("5b. ⭐⭐ contorul NEschimbat (100), fără consum parțial", (await get(key)) === 100);
      await r.del(key);
    }

    // ── (6) refund pe cheia PINNED decrementează cheia corectă ────────────────
    {
      const userId = "u_ref";
      const acctKey = `mcp:quota:acct:${userId}:${ym}`;
      await r.del(acctKey);
      const o = await reserveQuota({ kind: "account", userId }, 3, 100);
      const pinned = (o as { key: string }).key;
      check("6. ⭐ reserved a incrementat cu 3", (await get(acctKey)) === 3);
      await refundQuota(pinned, 3);
      check("6b. ⭐⭐⭐ refund pe cheia pinned → cheia de cont revine la 0 (DEL)", (await get(acctKey)) === 0);
      await r.del(acctKey);
    }

    // ── (7) unlimited (-1) → nicio cheie atinsă ───────────────────────────────
    {
      const clientId = "c_unl";
      const key = `mcp:quota:${clientId}:${ym}`;
      await r.del(key);
      const o = await reserveQuota({ kind: "client", clientId }, 1, -1);
      check("7. ⭐⭐ monthlyQuota=-1 → unlimited, ZERO chei create", o.status === "unlimited" && (await r.exists(key)) === 0);
    }

    // ── (8) subiect INVALID → unavailable, ÎNAINTE de unlimited/degraded, ZERO chei ──
    {
      // userId gol → monthlyQuotaKey aruncă → reserveQuota fail-closed `unavailable` (nu unlimited, nu client, nu degraded)
      const bad = { kind: "account", userId: "" } as unknown as Parameters<typeof reserveQuota>[0];
      const o1 = await reserveQuota(bad, 1, 100);
      check("8. ⭐⭐⭐ subiect account cu userId gol → unavailable (fail-closed, nu fallback client/degraded)", o1.status === "unavailable");
      // chiar și cu monthlyQuota=-1, un subiect invalid rămâne unavailable (validarea e ÎNAINTE de unlimited)
      const o2 = await reserveQuota(bad, 1, -1);
      check("8b. ⭐⭐⭐ subiect invalid + quota -1 → tot unavailable (NU unlimited)", o2.status === "unavailable");
      // kind necunoscut → tot unavailable, fără chei
      const bogus = { kind: "mystery", clientId: "x" } as unknown as Parameters<typeof reserveQuota>[0];
      const o3 = await reserveQuota(bogus, 1, 100);
      check("8c. ⭐⭐ kind necunoscut → unavailable", o3.status === "unavailable" && (await r.exists(`mcp:quota:x:${ym}`)) === 0);
    }

    console.log("\n" + passed + " passed, " + failed + " failed");
  } finally {
    r.disconnect();
  }
  // `reserveQuota` deschide un singleton ioredis intern (getRedis) care ține event loop-ul viu → exit explicit.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("[usage.integration] eroare:", e); process.exit(1); });
