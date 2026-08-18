/**
 * PH-11 integration — lifecycle protecție demo pe Redis REAL, prin PRIMITIVELE DE PRODUCȚIE (Lua + admitBuildRequest
 * / enforceRequestRate / withBuildLease / cacheDemoReport / finishBuild). NU în `npm test`.
 * Rulează: `npm run test:ph11-integration` cu Redis LOCAL dedicat.
 *
 * Acoperă (cgpt R4): renew ATOMIC de ownership (lease+slot într-un Lua), request-rate FAIL-CLOSED (Redis-down →
 * unavailable), orchestratorul REAL withBuildLease (ownership check imediat, heartbeat serializat care ține build-ul
 * viu peste TTL-ul inițial, pierderea ownership-ului în timpul build-ului → fără overwrite, Redis indisponibil →
 * build-ul nu pornește), plus fencing, single-flight, cap concurență, cleanup imediat.
 *
 * SIGURANȚĂ: chei sintetice + curățarea cheilor fixe atinse; NU flushdb; loopback + opt-in.
 */
import Redis from "ioredis";
import {
  DEMO_IP_RATE_LUA, DEMO_BUDGET_LUA, DEMO_SEMAPHORE_ACQUIRE_LUA, DEMO_BUILD_RENEW_LUA,
  DEMO_LEASE_RELEASE_LUA,
  admitBuildRequest, enforceRequestRate, withBuildLease, cacheDemoReport, finishBuild,
} from "./demoCache";
import { DEMO_MAX_CONCURRENT_BUILDS, DEMO_REQ_LIMIT_PER_WINDOW, DEMO_BUILD_LIMIT_PER_WINDOW } from "../demo/demoGuard";

const URL = process.env.REDIS_URL ?? "";
const LOOPBACK = /^redis:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(URL);
if (!LOOPBACK || process.env.PH4_INTEGRATION_ALLOW !== "1") {
  console.error("REFUZ: seteaza REDIS_URL spre un Redis LOCAL dedicat (loopback) + PH4_INTEGRATION_ALLOW=1.");
  process.exit(3);
}
process.env.REDIS_URL = URL;

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
const r = new Redis(URL);
const SUFFIX = Math.random().toString(36).slice(2, 8);
const K = (tag: string) => `demo:it_${SUFFIX}:${tag}`;
const tracked = new Set<string>(["demo:build_budget", "demo:active_builds"]);
const tk = (k: string) => { tracked.add(k); return k; };
const cacheKey = (slug: string) => `demo:cache:${slug}`;
const leaseKey = (slug: string) => `demo:lease:${slug}`;
const ACTIVE = "demo:active_builds";

async function resetFor(ip: string, slug: string) {
  ["demo:build_budget", ACTIVE, `demo:req:${ip}`, `demo:build:${ip}`, cacheKey(slug), leaseKey(slug)]
    .forEach(k => tracked.add(k));
  await r.del("demo:build_budget", ACTIVE, `demo:req:${ip}`, `demo:build:${ip}`, cacheKey(slug), leaseKey(slug));
}

async function main(): Promise<void> {
  console.log("PH-11 integration — lifecycle + orchestrator real");

  // ── Primitive: rate / budget / semaphore ────────────────────────────────────
  const ipk = tk(K("rl"));
  check("1. IP rate INCR + EXPIRE", Number(await r.eval(DEMO_IP_RATE_LUA, 1, ipk, "60")) === 1 && (await r.ttl(ipk)) > 0);
  const bk = tk(K("bud"));
  const bv = [] as number[];
  for (let i = 0; i < 4; i++) bv.push(Number(await r.eval(DEMO_BUDGET_LUA, 1, bk, "3", "0", "60")));
  check("2. buget 2→1→0→-1", bv[0] === 2 && bv[1] === 1 && bv[2] === 0 && bv[3] === -1);
  const sk = tk(K("sem"));
  const sA = Number(await r.eval(DEMO_SEMAPHORE_ACQUIRE_LUA, 1, sk, "2", "15", "A"));
  const sB = Number(await r.eval(DEMO_SEMAPHORE_ACQUIRE_LUA, 1, sk, "2", "15", "B"));
  const sC = Number(await r.eval(DEMO_SEMAPHORE_ACQUIRE_LUA, 1, sk, "2", "15", "C"));
  check("3. ⭐ semafor 0,1 apoi PLIN(-1)", sA === 0 && sB === 1 && sC === -1);

  // ── LEASE SET NX + release compare-and-token ────────────────────────────────
  const lk = tk(K("lease"));
  check("4. lease SET NX: primul OK, al doilea null",
    (await r.set(lk, "A", "EX", 10, "NX")) === "OK" && (await r.set(lk, "B", "EX", 10, "NX")) === null);
  check("5. ⭐⭐ release owner GREȘIT → 0 (nu șterge)", Number(await r.eval(DEMO_LEASE_RELEASE_LUA, 1, lk, "B")) === 0 && (await r.get(lk)) === "A");
  await r.eval(DEMO_LEASE_RELEASE_LUA, 1, lk, "A");

  // ── RENEW ATOMIC de ownership (lease + slot într-un singur Lua) ──────────────
  const slugRW = `it_${SUFFIX}_rw`; tracked.add(leaseKey(slugRW));
  await r.set(leaseKey(slugRW), "own", "EX", 5);
  await r.eval(DEMO_SEMAPHORE_ACQUIRE_LUA, 1, ACTIVE, "8", "5", "own");
  const rn1 = Number(await r.eval(DEMO_BUILD_RENEW_LUA, 2, leaseKey(slugRW), ACTIVE, "own", "10", "12"));
  check("6. ⭐⭐ renew atomic (lease==token ∧ token∈ZSET) → 1 + TTL-uri extinse",
    rn1 === 1 && (await r.ttl(leaseKey(slugRW))) > 5 && Number(await r.zscore(ACTIVE, "own")) > 0);
  check("7. ⭐⭐ renew cu token GREȘIT pe lease → 0 (lost, nu reînnoiește altcuiva)",
    Number(await r.eval(DEMO_BUILD_RENEW_LUA, 2, leaseKey(slugRW), ACTIVE, "intrus", "10", "12")) === 0);
  await r.zrem(ACTIVE, "own"); // slot pierdut (prune-uit) dar lease încă al nostru
  check("8. ⭐⭐⭐ renew când SLOTUL lipsește (lease ok, slot pierdut) → 0 (ownership atomic: ambele sau niciunul)",
    Number(await r.eval(DEMO_BUILD_RENEW_LUA, 2, leaseKey(slugRW), ACTIVE, "own", "10", "12")) === 0);
  await r.del(leaseKey(slugRW), ACTIVE);

  // ── PUBLICARE FENCED ─────────────────────────────────────────────────────────
  const slugF = `it_${SUFFIX}_fence`; tracked.add(cacheKey(slugF)); tracked.add(leaseKey(slugF));
  await r.set(leaseKey(slugF), "OWNER", "EX", 10);
  check("9. ⭐ publish cu lease propriu → published",
    (await cacheDemoReport(slugF, { who: "OWNER" }, "OWNER")) === "published" &&
    JSON.parse((await r.get(cacheKey(slugF)))!).payload.who === "OWNER");
  check("10. ⭐⭐⭐ publish cu lease STRĂIN → lost_lease + cache NESCHIMBAT",
    (await cacheDemoReport(slugF, { who: "OLD" }, "OLD")) === "lost_lease" &&
    JSON.parse((await r.get(cacheKey(slugF)))!).payload.who === "OWNER");

  // ── Single-flight + cap concurență ──────────────────────────────────────────
  const slugSF = `it_${SUFFIX}_sf`, ipSF = `it_${SUFFIX}_ipsf`; await resetFor(ipSF, slugSF);
  const race = await Promise.all(Array.from({ length: 10 }, () => admitBuildRequest(slugSF, ipSF)));
  check("11. ⭐⭐⭐ 10 concurente cold → 1 builder (single-flight)",
    race.filter(x => x.action === "build").length === 1 && race.filter(x => x.action === "busy").length === 9);
  const w = race.find(x => x.action === "build"); if (w?.leaseToken) await finishBuild(slugSF, w.leaseToken);
  await r.del(ACTIVE, "demo:build_budget");
  const N = DEMO_MAX_CONCURRENT_BUILDS + 2;
  const dist = await Promise.all(Array.from({ length: N }, (_, i) => {
    const slug = `it_${SUFFIX}_c${i}`, ip = `it_${SUFFIX}_ipc${i}`;
    [cacheKey(slug), leaseKey(slug), `demo:req:${ip}`, `demo:build:${ip}`].forEach(k => tracked.add(k));
    return admitBuildRequest(slug, ip);
  }));
  check(`12. ⭐⭐⭐ ${N} slug-uri distincte → EXACT ${DEMO_MAX_CONCURRENT_BUILDS} build-uri (cap concurență)`,
    dist.filter(x => x.action === "build").length === DEMO_MAX_CONCURRENT_BUILDS);
  await r.del(ACTIVE);

  // ── request-rate FAIL-CLOSED (item 1) ───────────────────────────────────────
  const ipR = `it_${SUFFIX}_ipr`; tracked.add(`demo:req:${ipR}`); tracked.add(`demo:build:${ipR}`);
  await r.del(`demo:req:${ipR}`, `demo:build:${ipR}`);
  check("13. enforceRequestRate sub limită → allow", (await enforceRequestRate(ipR)) === "allow");
  await r.set(`demo:req:${ipR}`, String(DEMO_REQ_LIMIT_PER_WINDOW), "EX", 60);
  check("14. ⭐ enforceRequestRate peste limită → limited", (await enforceRequestRate(ipR)) === "limited");
  check("15. request-rate NU atinge build-rate (cheie separată intactă)", (await r.get(`demo:build:${ipR}`)) === null);
  // Redis-down → unavailable (NU allow): fail-closed inclusiv pentru URL invalid
  const savedUrl = process.env.REDIS_URL; delete process.env.REDIS_URL;
  const downRate = await enforceRequestRate(ipR);
  process.env.REDIS_URL = savedUrl;
  check("16. ⭐⭐⭐ enforceRequestRate cu Redis INDISPONIBIL → 'unavailable' (FAIL-CLOSED, nu allow)", downRate === "unavailable");

  // ── stale admission expune cache age ────────────────────────────────────────
  const slugST = `it_${SUFFIX}_st`, ipST = `it_${SUFFIX}_ipst`; await resetFor(ipST, slugST);
  await r.set(cacheKey(slugST), JSON.stringify({ cachedAt: Date.now() - 90_000, payload: { m: 1 } }), "EX", 300);
  await r.set(`demo:build:${ipST}`, String(DEMO_BUILD_LIMIT_PER_WINDOW), "EX", 60);
  const stAdm = await admitBuildRequest(slugST, ipST);
  check("17. ⭐⭐ stale admission: serve_stale + cacheAgeSec ~90",
    stAdm.action === "serve_stale" && (stAdm.cacheAgeSec ?? 0) >= 85 && (stAdm.cacheAgeSec ?? 0) <= 95);

  // ── ORCHESTRATOR REAL withBuildLease (cgpt R4) ──────────────────────────────
  // (a) ține build-ul viu PESTE TTL-ul inițial prin heartbeat serializat → niciun al doilea builder.
  const slugKA = `it_${SUFFIX}_ka`, ipKA2 = `it_${SUFFIX}_ipka2`; await resetFor(ipKA2, slugKA);
  await r.set(leaseKey(slugKA), "kaTok", "PX", 700);                 // TTL inițial scurt (build „lent")
  await r.eval(DEMO_SEMAPHORE_ACQUIRE_LUA, 1, ACTIVE, "8", "1", "kaTok");
  let kaBuilt = false;
  const kaProm = withBuildLease(slugKA, "kaTok", async () => { kaBuilt = true; await sleep(1400); return { m: SUFFIX }; },
    { leaseTtlSec: 5, slotTtlSec: 5, heartbeatMs: 150 });
  await sleep(1000);                                                 // > TTL-ul inițial (700ms) — heartbeat trebuie să-l fi reînnoit
  const secondDuring = await admitBuildRequest(slugKA, ipKA2);
  check("18. ⭐⭐⭐ withBuildLease REAL ține lease-ul viu peste TTL-ul inițial → al doilea request e busy (nu builder)",
    kaBuilt && (await r.get(leaseKey(slugKA))) === "kaTok" && secondDuring.action === "busy");
  const kaRes = await kaProm;
  check("19. ⭐⭐ withBuildLease: build rulat + published + release (lease+slot eliberate)",
    kaRes.built && kaRes.published === "published" &&
    (await r.get(leaseKey(slugKA))) === null && Number(await r.zcard(ACTIVE)) === 0);

  // (b) pierderea ownership-ului ÎN TIMPUL build-ului → NU publică (fenced) + cache intact.
  const slugLL = `it_${SUFFIX}_ll`; tracked.add(cacheKey(slugLL)); tracked.add(leaseKey(slugLL));
  await r.del(cacheKey(slugLL)); await r.set(leaseKey(slugLL), "llTok", "EX", 5);
  await r.eval(DEMO_SEMAPHORE_ACQUIRE_LUA, 1, ACTIVE, "8", "5", "llTok");
  const llProm = withBuildLease(slugLL, "llTok", async () => { await sleep(500); return { who: "builder" }; },
    { leaseTtlSec: 5, slotTtlSec: 5, heartbeatMs: 100 });
  await sleep(180);
  // un THIEF fură lease-ul + slotul și publică
  await r.del(leaseKey(slugLL)); await r.set(leaseKey(slugLL), "thief", "EX", 5);
  await r.zrem(ACTIVE, "llTok");
  await r.set(cacheKey(slugLL), JSON.stringify({ cachedAt: Date.now(), payload: { who: "thief" } }), "EX", 300);
  const llRes = await llProm;
  check("20. ⭐⭐⭐ ownership pierdut ÎN TIMPUL build-ului → published lost_lease + NU suprascrie (cache = thief)",
    llRes.built && llRes.published === "lost_lease" &&
    JSON.parse((await r.get(cacheKey(slugLL)))!).payload.who === "thief");
  await r.del(leaseKey(slugLL));

  // (c) Redis INDISPONIBIL înainte de build → callback-ul de build NU e apelat.
  let downBuilt = false;
  const savedUrl2 = process.env.REDIS_URL; delete process.env.REDIS_URL;
  const downRes = await withBuildLease("x", "tok", async () => { downBuilt = true; return 1; });
  process.env.REDIS_URL = savedUrl2;
  check("21. ⭐⭐⭐ Redis indisponibil între admission și build → build NU pornește (built:false, callback neapelat)",
    downBuilt === false && downRes.built === false && downRes.report === null && downRes.published === "unavailable");

  // (d) Redis devine INDISPONIBIL ÎN TIMPUL build-ului (nu înainte): check-ul inițial trece, callback-ul începe,
  // următorul heartbeat primește eroare (unavailable) → NU publică, published:"unavailable", built:true, cleanup best-effort.
  const slugUD = `it_${SUFFIX}_ud`; tracked.add(cacheKey(slugUD)); tracked.add(leaseKey(slugUD));
  await r.del(cacheKey(slugUD), leaseKey(slugUD));
  await r.set(leaseKey(slugUD), "udTok", "EX", 5);
  await r.eval(DEMO_SEMAPHORE_ACQUIRE_LUA, 1, ACTIVE, "8", "5", "udTok");
  let udBuilt = false;
  const udProm = withBuildLease(slugUD, "udTok", async () => { udBuilt = true; await sleep(500); return { who: "builder" }; },
    { leaseTtlSec: 5, slotTtlSec: 5, heartbeatMs: 100 });
  await sleep(180); // check inițial a trecut + build pornit; acum stricăm renew-ul: leaseKey devine ZSET → GET WRONGTYPE → eroare
  await r.del(leaseKey(slugUD)); await r.zadd(leaseKey(slugUD), 1, "corrupt");
  const udRes = await udProm;
  check("22. ⭐⭐⭐ Redis eroare ÎN TIMPUL build-ului → built:true, published:'unavailable' (fail-closed), cache NEscris",
    udBuilt && udRes.built && udRes.published === "unavailable" && (await r.get(cacheKey(slugUD))) === null);
  await r.del(leaseKey(slugUD));

  // (e) Verdictul renew-ului aflat în curs când build-ul se termină: publicarea AȘTEAPTĂ verdictul. Furăm lease-ul
  // chiar înainte de finalul build-ului → ultimul heartbeat marchează lost → published lost_lease (nu publish orb).
  const slugIF = `it_${SUFFIX}_if`; tracked.add(cacheKey(slugIF)); tracked.add(leaseKey(slugIF));
  await r.del(cacheKey(slugIF)); await r.set(leaseKey(slugIF), "ifTok", "EX", 5);
  await r.eval(DEMO_SEMAPHORE_ACQUIRE_LUA, 1, ACTIVE, "8", "5", "ifTok");
  const ifProm = withBuildLease(slugIF, "ifTok", async () => { await sleep(240); return { who: "builder" }; },
    { leaseTtlSec: 5, slotTtlSec: 5, heartbeatMs: 40 });
  await sleep(200); // furăm lease-ul chiar înainte de finalul build-ului (240ms) → un heartbeat surprinde pierderea
  await r.del(leaseKey(slugIF)); await r.set(leaseKey(slugIF), "thief2", "EX", 5); await r.zrem(ACTIVE, "ifTok");
  const ifRes = await ifProm;
  check("23. ⭐⭐⭐ publicarea reflectă verdictul ultimului heartbeat (așteaptă renew-ul) → lost_lease, fără overwrite orb",
    ifRes.built && ifRes.published === "lost_lease" && (await r.get(cacheKey(slugIF))) === null);
  await r.del(leaseKey(slugIF));

  // (f) IZOLARE (cgpt nit test-23): dovedește că STAREA de ownership (nu fencing-ul) decide publicarea. Renew erează
  // tranzitoriu → 'unavailable' → heartbeat oprit; apoi RESTAURĂM lease-ul la tokenul nostru, deci un fenced publish
  // AR reuși. Totuși published trebuie să rămână 'unavailable' + cache NEscris → izolează starea de fencing.
  const slugISO = `it_${SUFFIX}_iso`; tracked.add(cacheKey(slugISO)); tracked.add(leaseKey(slugISO));
  await r.del(cacheKey(slugISO)); await r.set(leaseKey(slugISO), "isoTok", "EX", 5);
  await r.eval(DEMO_SEMAPHORE_ACQUIRE_LUA, 1, ACTIVE, "8", "5", "isoTok");
  const isoProm = withBuildLease(slugISO, "isoTok", async () => { await sleep(420); return { who: "builder" }; },
    { leaseTtlSec: 5, slotTtlSec: 5, heartbeatMs: 70 });
  await sleep(150); await r.del(leaseKey(slugISO)); await r.rpush(leaseKey(slugISO), "x"); // leaseKey → LIST ⇒ GET WRONGTYPE ⇒ renew 'unavailable'
  await sleep(140);                                                                          // un heartbeat prinde eroarea + oprește timerul
  await r.del(leaseKey(slugISO)); await r.set(leaseKey(slugISO), "isoTok", "EX", 5);        // RESTAUREAZĂ: acum fenced publish AR reuși
  const isoRes = await isoProm;
  check("23b. ⭐⭐⭐ IZOLARE: 'unavailable' din heartbeat blochează publish deși fencing-ul AR reuși (starea decide, nu fencing)",
    isoRes.built && isoRes.published === "unavailable" && (await r.get(cacheKey(slugISO))) === null);
  await r.del(leaseKey(slugISO));

  // (g) DETERMINIST (cgpt): dovedește că withBuildLease AȘTEAPTĂ un renew ÎNCĂ ÎN ZBOR înainte de a decide publicarea
  // (linia `if (inflight) await inflight`). Injectăm `renewOwnership`: apelul #1 (check imediat) = renewed; heartbeat-ul
  // = un renew DEFERAT (nerezolvat). Build-ul se termină → withBuildLease NU trebuie să se întoarcă (blocat pe await).
  // Rezolvăm deferat cu 'unavailable' (lease-ul rămâne VALID, deci un fenced publish AR reuși) → abia atunci published
  // devine 'unavailable' + cache gol. Nu depinde de timing/fencing — controlăm noi momentul rezolvării.
  const slugDET = `it_${SUFFIX}_det`; tracked.add(cacheKey(slugDET)); tracked.add(leaseKey(slugDET));
  await r.del(cacheKey(slugDET)); await r.set(leaseKey(slugDET), "detTok", "EX", 30); // lease VALID → fencing ar publica
  let resolveRenew: (v: "renewed" | "lost" | "unavailable") => void = () => {};
  const deferredRenew = new Promise<"renewed" | "lost" | "unavailable">(res => { resolveRenew = res; });
  let renewCalls = 0, detFinished = false;
  const detProm = withBuildLease(slugDET, "detTok", async () => { await sleep(80); return { who: "builder" }; }, {
    leaseTtlSec: 5, slotTtlSec: 5, heartbeatMs: 20,
    renewOwnership: () => { renewCalls++; return renewCalls === 1 ? Promise.resolve("renewed") : deferredRenew; },
  });
  void detProm.then(() => { detFinished = true; });
  await sleep(200); // build (80ms) s-a terminat demult; heartbeat a pornit renew-ul DEFERAT (nerezolvat)
  check("23c. ⭐⭐⭐ DETERMINIST: build terminat DAR withBuildLease încă NU s-a întors (blocat pe `await inflight`)",
    detFinished === false && renewCalls >= 2);
  resolveRenew("unavailable"); // rezolvăm renew-ul în zbor → verdict unavailable (lease-ul e încă valid)
  const detRes = await detProm;
  check("23d. ⭐⭐⭐ DETERMINIST: după rezolvarea renew-ului în zbor ca 'unavailable' → published unavailable + cache gol (deși fencing-ul AR fi publicat)",
    detRes.built && detRes.published === "unavailable" && (await r.get(cacheKey(slugDET))) === null);
  await r.del(leaseKey(slugDET));

  // ── cleanup imediat pe eroare parțială din admitBuildRequest ────────────────
  const slugER = `it_${SUFFIX}_err`, ipER = `it_${SUFFIX}_iper`; await resetFor(ipER, slugER);
  await r.set("demo:build_budget", "notahash"); // HMGET pe string → WRONGTYPE → eval aruncă în admit
  const errAdm = await admitBuildRequest(slugER, ipER);
  check("24. ⭐⭐ eroare Redis după lease+slot → busy + lease ELIBERAT imediat + slot ZCARD 0",
    errAdm.action === "busy" && (await r.get(leaseKey(slugER))) === null && Number(await r.zcard(ACTIVE)) === 0);
  await r.del("demo:build_budget");

  console.log("\n" + passed + " passed, " + failed + " failed");
}

main()
  .catch((e) => { console.error("THREW:", e); failed++; })
  .finally(async () => {
    try { if (tracked.size) await r.del(...tracked); } catch { /* best-effort */ }
    await r.quit().catch(() => {});
    process.exit(failed > 0 ? 1 : 0);
  });
