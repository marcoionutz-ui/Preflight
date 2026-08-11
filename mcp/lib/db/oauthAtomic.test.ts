/**
 * lib/db/oauthAtomic.test.ts — E4 + E6 (OAuth atomicitate).
 *
 * E4: `isAuthCodePayload`/`parseAuthCode`/`classifyConsumeResult` + PROBĂ Redis reală pt. compare-and-delete
 *   (peek NU șterge; finalize consumă o SINGURĂ dată; blob greșit NU șterge; sub concurență exact 1 câștigă).
 * E6: `rateLimitFromEval` + PROBĂ Redis reală pt. „check-then-increment" (o cerere respinsă NU incrementează nimic
 *   → nu mai arde quota de zi pe un 429 de minut; sub concurență exact `limita` trec).
 */
import {
  isAuthCodePayload, parseAuthCode, classifyConsumeResult,
  rateLimitFromEval, AUTH_CODE_CONSUME_LUA, RL_CHECK_INCR_LUA,
} from "./oauthAtomic";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const validCode = {
  client_id: "cli-1", scopes: ["read:all"], redirect_uri: "https://x/cb",
  code_challenge: "abc", code_challenge_method: "S256", issued_at: 1,
};

async function main(): Promise<void> {
console.log("E4 — isAuthCodePayload (guard de formă)");
check("1. valid → true", isAuthCodePayload(validCode) === true);
check("2. null → false", isAuthCodePayload(null) === false);
check("3. non-obiect ('x') → false", isAuthCodePayload("x") === false);
check("4. client_id lipsă → false", isAuthCodePayload({ ...validCode, client_id: undefined }) === false);
check("5. client_id gol → false", isAuthCodePayload({ ...validCode, client_id: "" }) === false);
check("6. redirect_uri gol → false", isAuthCodePayload({ ...validCode, redirect_uri: "" }) === false);
check("7. scopes ne-array → false", isAuthCodePayload({ ...validCode, scopes: "read:all" }) === false);
check("8. scopes cu element ne-string → false", isAuthCodePayload({ ...validCode, scopes: ["ok", 5] }) === false);
check("9. code_challenge ne-string → false", isAuthCodePayload({ ...validCode, code_challenge: 7 }) === false);
check("9b. issued_at lipsă → false", isAuthCodePayload({ ...validCode, issued_at: undefined }) === false);
check("9c. issued_at ne-număr ('x') → false", isAuthCodePayload({ ...validCode, issued_at: "x" }) === false);
check("9d. issued_at NaN → false", isAuthCodePayload({ ...validCode, issued_at: Number.NaN }) === false);
check("10. scopes gol [] → true (validat de PKCE/route, nu aici)", isAuthCodePayload({ ...validCode, scopes: [] }) === true);

console.log("\nE4 — parseAuthCode (JSON safe + formă)");
check("11. JSON valid + formă validă → payload", parseAuthCode(JSON.stringify(validCode))?.client_id === "cli-1");
check("12. JSON stricat → null", parseAuthCode("{bad") === null);
check("13. JSON valid + formă invalidă → null", parseAuthCode(JSON.stringify({ client_id: "x" })) === null);
check("14. 'null' literal → null", parseAuthCode("null") === null);

console.log("\nE4 — classifyConsumeResult (1→consumed; 0/-1→already_used)");
check("15. 1 → consumed", classifyConsumeResult(1) === "consumed");
check("16. 0 → already_used", classifyConsumeResult(0) === "already_used");
check("17. ⭐ -1 (blob schimbat) → already_used (fail-closed)", classifyConsumeResult(-1) === "already_used");
check("18. '1' (string din Lua) → consumed", classifyConsumeResult("1") === "consumed");
check("19. null → already_used", classifyConsumeResult(null) === "already_used");

console.log("\nE6 — rateLimitFromEval (permis vs blocat; fereastra blocată are remaining 0)");
check("20. permis sub limită → ok + remaining corect", (() => {
  const o = rateLimitFromEval([1, 3, 3, 0], 5, 100);
  return o?.status === "ok" && o.remaining_min === 2 && o.remaining_day === 97;
})());
check("21. permis exact la limită (req5) → ok remaining_min 0", (() => {
  const o = rateLimitFromEval([1, 5, 5, 0], 5, 100);
  return o?.status === "ok" && o.remaining_min === 0;
})());
check("22. ⭐ blocat pe MINUT → limited, remaining_min 0, day păstrat", (() => {
  const o = rateLimitFromEval([0, 5, 10, 60], 5, 100);
  return o?.status === "limited" && o.retry_after === 60 && o.remaining_min === 0 && o.remaining_day === 90;
})());
check("23. ⭐ blocat pe ZI → limited, remaining_day 0, min păstrat", (() => {
  const o = rateLimitFromEval([0, 3, 100, 86400], 5, 100);
  return o?.status === "limited" && o.retry_after === 86400 && o.remaining_min === 2 && o.remaining_day === 0;
})());
check("24. nelimitat pe minut (-1) → remaining_min -1", (() => {
  const o = rateLimitFromEval([1, 7, 7, 0], -1, 100);
  return o?.status === "ok" && o.remaining_min === -1 && o.remaining_day === 93;
})());
check("25. nelimitat ambele → -1/-1", (() => {
  const o = rateLimitFromEval([1, 9, 9, 0], -1, -1);
  return o?.status === "ok" && o.remaining_min === -1 && o.remaining_day === -1;
})());
check("26. non-array → null (cade pe degraded)", rateLimitFromEval("x", 5, 100) === null);
check("27. array scurt → null", rateLimitFromEval([1, 2], 5, 100) === null);
check("28. allowed NaN → null", rateLimitFromEval(["x", 1, 1, 0], 5, 100) === null);
check("29. ⭐ allowed ≠ 0|1 (2) → null (Lua coruptă → degraded)", rateLimitFromEval([2, 1, 1, 0], 5, 100) === null);
check("30. ⭐ retry non-finit (NaN) → null", rateLimitFromEval([0, 5, 5, Number.NaN], 5, 100) === null);

// ── Partea B: PROBĂ Redis reală (Lua CAD + rate-limit) ─────────────────────────────────
console.log("\nE4/E6 — Lua pe Redis real (skip curat dacă indisponibil)");
let redis: import("ioredis").default | null = null;
try {
  const { default: Redis } = await import("ioredis");
  const url = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL || "redis://127.0.0.1:6379";
  redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 3_000,
    retryStrategy: () => null, // fără reconnect infinit → proces curat când Redis e jos
  });
  redis.on("error", () => { /* înghite event-ul `error` (altfel "[ioredis] Unhandled error event" + hang) */ });
  await redis.connect();
  await redis.ping();
} catch {
  console.log("  ⚠️  Redis indisponibil — SKIP partea B.");
  try { redis?.disconnect(); } catch { /* noop */ }
  redis = null;
}

if (redis) {
  // ── E4: AUTH_CODE_CONSUME_LUA (compare-and-delete) ──
  const CODE_KEY = "test:e4:code:xyz";
  const raw = JSON.stringify(validCode);
  await redis.del(CODE_KEY);
  await redis.set(CODE_KEY, raw);

  // peek = GET simplu → NU șterge.
  const peeked = await redis.get(CODE_KEY);
  const stillThere = await redis.exists(CODE_KEY);
  check("B1. peek (GET) NU șterge codul", peeked === raw && Number(stillThere) === 1);

  // finalize corect → 1 (consumed) + cheia dispare.
  const c1 = await redis.eval(AUTH_CODE_CONSUME_LUA, 1, CODE_KEY, raw);
  const goneAfter = await redis.exists(CODE_KEY);
  check("B2. finalize corect → 1 (consumed) + cheia ștearsă", Number(c1) === 1 && Number(goneAfter) === 0);

  // al doilea finalize (cheie dispărută) → 0 (already_used).
  const c2 = await redis.eval(AUTH_CODE_CONSUME_LUA, 1, CODE_KEY, raw);
  check("B3. ⭐ al doilea finalize → 0 (already_used, single-use)", Number(c2) === 0);

  // finalize cu blob GREȘIT → -1 + NU șterge.
  await redis.set(CODE_KEY, raw);
  const c3 = await redis.eval(AUTH_CODE_CONSUME_LUA, 1, CODE_KEY, "{\"other\":true}");
  const survives = await redis.exists(CODE_KEY);
  check("B4. ⭐ finalize cu blob greșit → -1 + NU șterge", Number(c3) === -1 && Number(survives) === 1);

  // concurență: 20 finalize simultane pe același cod → EXACT 1 câștigă (1), restul 0.
  await redis.set(CODE_KEY, raw);
  const races = await Promise.all(
    Array.from({ length: 20 }, () => redis!.eval(AUTH_CODE_CONSUME_LUA, 1, CODE_KEY, raw)),
  );
  const wins = races.filter((x: unknown) => Number(x) === 1).length;
  const goneRace = await redis.exists(CODE_KEY);
  check("B5. ⭐ 20 finalize concurente → EXACT 1 consumed", wins === 1 && Number(goneRace) === 0);
  await redis.del(CODE_KEY);

  // ── E6: RL_CHECK_INCR_LUA (check-then-increment) ──
  const MIN_KEY = "test:e6:rl:min:cli";
  const DAY_KEY = "test:e6:rl:day:cli";
  const ev = (limMin: number, limDay: number): Promise<number[]> =>
    redis!.eval(RL_CHECK_INCR_LUA, 2, MIN_KEY, DAY_KEY, String(limMin), String(limDay), "60", "86400") as Promise<number[]>;

  // limit min=3, day=100: primele 3 permise, a 4-a blocată.
  await redis.del(MIN_KEY, DAY_KEY);
  const r1 = await ev(3, 100), r2 = await ev(3, 100), r3 = await ev(3, 100), r4 = await ev(3, 100);
  check("B6. primele 3 → allowed (nMin 1,2,3)", Number(r1[0]) === 1 && Number(r2[0]) === 1 && Number(r3[0]) === 1 && Number(r3[1]) === 3);
  check("B7. a 4-a → blocată (allowed 0, retry>0)", Number(r4[0]) === 0 && Number(r4[3]) > 0);
  // ⭐ E6 CORE: cererea respinsă a 4-a NU a incrementat contorul de zi.
  const dayCount = await redis.get(DAY_KEY);
  const minCount = await redis.get(MIN_KEY);
  check("B8. ⭐ după 4 cereri (1 respinsă) → day == 3 (NU 4: respinsa nu arde quota de zi)", Number(dayCount) === 3);
  check("B9. min == 3 (respinsa nu a incrementat nici minutul)", Number(minCount) === 3);

  // block pe ZI nu atinge contorul de MINUT.
  await redis.del(MIN_KEY, DAY_KEY);
  await ev(100, 2); await ev(100, 2); const rd = await ev(100, 2); // a 3-a blocată de day (limit 2)
  const minAfterDayBlock = await redis.get(MIN_KEY);
  check("B10. ⭐ block pe ZI (a 3-a) → min == 2 (nu 3: nu arde minutul)", Number(rd[0]) === 0 && Number(minAfterDayBlock) === 2);

  // concurență: limit min=5, 30 cereri simultane → EXACT 5 permise, day == 5 (fără supra-contorizare).
  await redis.del(MIN_KEY, DAY_KEY);
  const burst = await Promise.all(Array.from({ length: 30 }, () => ev(5, 1000)));
  const allowedCount = burst.filter((x: number[]) => Number(x[0]) === 1).length;
  const dayAfterBurst = await redis.get(DAY_KEY);
  check("B11. ⭐ 30 concurente, limit 5 → EXACT 5 permise (atomic)", allowedCount === 5);
  check("B12. ⭐ day == 5 după burst (respinsele nu au contorizat)", Number(dayAfterBurst) === 5);

  // TTL setat la primul hit.
  const ttlMin = await redis.ttl(MIN_KEY);
  check("B13. TTL setat pe minKey la primul incr (0<ttl<=60)", ttlMin > 0 && ttlMin <= 60);

  // ⭐ B14 (varu blocker): AMBELE ferestre epuizate → Retry-After = MAX(minTtl, dayTtl), nu cel mic (minut).
  await redis.del(MIN_KEY, DAY_KEY);
  await ev(1, 1);                    // consumă ambele (min→1, day→1)
  const both = await ev(1, 1);       // ambele blochează acum (cMin=1>=1 ȘI cDay=1>=1)
  check("B14. ⭐ ambele blocate → blocat (allowed 0)", Number(both[0]) === 0);
  check("B14b. ⭐ Retry-After = TTL-ul ZILEI (max), NU al minutului (>1000s, nu ~60)", Number(both[3]) > 1000);

  // ⭐ B15 (varu): cheie MINUTE cu contor dar FĂRĂ expiry (TTL -1) → reparat + reportat.
  await redis.del(MIN_KEY, DAY_KEY);
  await redis.set(MIN_KEY, "10");    // contor 10, fără EXPIRE → TTL -1
  const ttlBeforeMin = await redis.ttl(MIN_KEY);
  const healMin = await ev(5, 1000); // minBlocked (10>=5) → repară TTL
  const ttlAfterMin = await redis.ttl(MIN_KEY);
  check("B15. ⭐ min fără TTL (-1) reparat pe ramura blocată (0<ttl<=60)", ttlBeforeMin === -1 && ttlAfterMin > 0 && ttlAfterMin <= 60);
  check("B15b. Retry-After = TTL reparat al minutului (~60)", Number(healMin[3]) > 0 && Number(healMin[3]) <= 60);

  // ⭐ B16 (varu): cheie DAY cu contor dar FĂRĂ expiry → reparat (min sub limită, doar day blochează).
  await redis.del(MIN_KEY, DAY_KEY);
  await redis.set(DAY_KEY, "10");    // contor zi 10, fără EXPIRE
  const ttlBeforeDay = await redis.ttl(DAY_KEY);
  const healDay = await ev(100, 5);  // dayBlocked (10>=5), min sub limită
  const ttlAfterDay = await redis.ttl(DAY_KEY);
  const minUntouched = await redis.get(MIN_KEY);
  check("B16. ⭐ day fără TTL (-1) reparat pe ramura blocată (ttl>1000)", ttlBeforeDay === -1 && ttlAfterDay > 1000);
  check("B16b. block pe zi NU a incrementat minutul (min absent/0)", minUntouched === null || Number(minUntouched) === 0);
  check("B16c. Retry-After = TTL-ul zilei reparat (>1000)", Number(healDay[3]) > 1000);

  // ⭐ B17 (varu): ramura PERMISĂ repară o cheie existentă fără expiry (TTL -1 după un INCR care nu dă 1).
  await redis.del(MIN_KEY, DAY_KEY);
  await redis.set(MIN_KEY, "3");     // contor 3, fără EXPIRE
  const healAllowed = await ev(10, 1000); // permis (4<=10) → INCR→4, TTL<0 → repară
  const ttlHealed = await redis.ttl(MIN_KEY);
  check("B17. ⭐ ramura permisă repară TTL lipsă (allowed 1, 0<ttl<=60)", Number(healAllowed[0]) === 1 && ttlHealed > 0 && ttlHealed <= 60);

  await redis.del(MIN_KEY, DAY_KEY, CODE_KEY);
  redis.disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
