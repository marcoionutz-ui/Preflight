/**
 * PH-10 integration — coada de watch fair per-client pe Redis REAL, folosind PRIMITIVELE DE PRODUCȚIE
 * (`enqueueWatchQueue` / `drainWatchQueue` din @preflight/schema — exact ce rulează mcp și worker-ul), NU o replică.
 * NU în `npm test`. Rulează: `npm run test:ph10-integration` cu Redis LOCAL dedicat.
 *
 * SIGURANȚĂ (cgpt #4): chain-uri SINTETICE random (`it_<rand>`) — nu ating niciodată base/arbitrum/bsc/ethereum;
 * NU face flushdb; cleanup complet în `finally`. Refuză non-loopback fără opt-in.
 *
 * Acoperă: idempotency (same/cross client), cap per-client & global (reject-not-evict), drain round-robin,
 * FAIR ACROSS CYCLES cu > budget clienți + realimentarea grupului din față, atomicitate la ultimul item,
 * EXPIRARE per-request (zombie pruned sub trafic continuu), rezultat Lua neașteptat (fail-closed), + invariant
 * final (fără membri zombie în seen, nicio coadă nevidă în afara rotației).
 */
import Redis from "ioredis";
import { enqueueWatchRequest } from "./watchQueue";
import {
  REDIS_KEYS, WATCH_ENQUEUE_LUA, enqueueWatchQueue, drainWatchQueue, classifyWatchEnqueue,
  WATCH_PER_CLIENT_CAP, WATCH_GLOBAL_CAP, WATCH_QUEUE_TTL_SEC,
} from "@preflight/schema";

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

const r = new Redis(URL);
const r2 = new Redis(URL); // a DOUA conexiune independentă — pt. cursa reală (comenzi pe socket-uri diferite)
const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
// chain-uri SINTETICE — nu coincid cu niciun chain real (normalizeChainId doar lowercase/trim)
const rnd = () => Math.random().toString(36).slice(2, 8);
const SUFFIX = rnd();
const CH = (tag: string) => `it_${SUFFIX}_${tag}`;
const usedChains: string[] = [];
const usedClients: Record<string, Set<string>> = {};
function track(chain: string, clientId: string) {
  if (!usedChains.includes(chain)) { usedChains.push(chain); usedClients[chain] = new Set(); }
  usedClients[chain].add(clientId);
}
const pair = (i: number) => "0x" + i.toString(16).padStart(40, "0");
const reqJson = (p: string, chain: string, clientId: string) =>
  JSON.stringify({ pairAddress: p, chain, reason: "t", requestedAt: 1, clientId });

// enqueue prin PRIMITIVA shared (ce rulează worker/mcp), cu tracking pt. cleanup
async function enq(chain: string, p: string, clientId: string) {
  track(chain, clientId);
  return enqueueWatchQueue(r, chain, p, reqJson(p, chain, clientId), clientId);
}
// enqueue pe o CONEXIUNE anume (pt. cursa cu 2 conexiuni)
async function enqOn(client: Redis, chain: string, p: string, clientId: string) {
  track(chain, clientId);
  return enqueueWatchQueue(client, chain, p, reqJson(p, chain, clientId), clientId);
}
// enqueue cu TTL custom (pt. testul de expirare) — apel direct la ACEEAȘI Lua, doar ttlSec diferit
async function enqTtl(chain: string, p: string, clientId: string, ttlSec: number) {
  track(chain, clientId);
  const res = await r.eval(
    WATCH_ENQUEUE_LUA, 5,
    REDIS_KEYS.agentWatchSeen(chain), REDIS_KEYS.agentWatchClientQueue(chain, clientId),
    REDIS_KEYS.agentWatchRotation(chain), REDIS_KEYS.agentWatchInRotation(chain), REDIS_KEYS.agentWatchMeta(chain),
    p, reqJson(p, chain, clientId), clientId, String(WATCH_PER_CLIENT_CAP), String(WATCH_GLOBAL_CAP), String(ttlSec),
  );
  return classifyWatchEnqueue(res);
}
async function cleanup() {
  for (const chain of usedChains) {
    const keys = [
      REDIS_KEYS.agentWatchSeen(chain), REDIS_KEYS.agentWatchRotation(chain),
      REDIS_KEYS.agentWatchInRotation(chain), REDIS_KEYS.agentWatchMeta(chain),
      ...[...(usedClients[chain] ?? [])].map(c => REDIS_KEYS.agentWatchClientQueue(chain, c)),
    ];
    if (keys.length) await r.del(...keys);
  }
}
/** Invariant: orice coadă client NEVIDĂ trebuie să aibă clientul în rotație (inRotation). */
async function noOrphanQueues(chain: string): Promise<boolean> {
  for (const c of usedClients[chain] ?? []) {
    const n = await r.zcard(REDIS_KEYS.agentWatchClientQueue(chain, c));
    if (n > 0 && (await r.sismember(REDIS_KEYS.agentWatchInRotation(chain), c)) !== 1) return false;
  }
  return true;
}
/** Coadă nevidă => clientul e prezent ȘI în SET-ul inRotation ȘI în LIST-ul rotation. */
async function inBothRosters(chain: string, clientId: string): Promise<boolean> {
  const inSet  = (await r.sismember(REDIS_KEYS.agentWatchInRotation(chain), clientId)) === 1;
  const inList = (await r.lpos(REDIS_KEYS.agentWatchRotation(chain), clientId)) !== null;
  return inSet && inList;
}
/** Toate structurile chain-ului sunt goale (queue+seen+meta+rotation+inRotation). */
async function fullyEmpty(chain: string, clientId: string): Promise<boolean> {
  return (await r.zcard(REDIS_KEYS.agentWatchClientQueue(chain, clientId))) === 0
      && (await r.zcard(REDIS_KEYS.agentWatchSeen(chain))) === 0
      && (await r.hlen(REDIS_KEYS.agentWatchMeta(chain))) === 0
      && (await r.llen(REDIS_KEYS.agentWatchRotation(chain))) === 0
      && (await r.scard(REDIS_KEYS.agentWatchInRotation(chain))) === 0;
}

async function main() {
  console.log("PH-10 INTEGRATION — real Redis @ " + URL + " (synthetic chains it_" + SUFFIX + "_*)");

  // ── A. Idempotency + cap per-client (reject-not-evict) ──────────────────────
  const A = CH("A");
  check("1. enqueue nou -> queued", (await enq(A, pair(1), "cA")) === "queued");
  check("2. ⭐ acelasi pair, acelasi client -> already_queued", (await enq(A, pair(1), "cA")) === "already_queued");
  check("3. ⭐⭐ acelasi pair, ALT client -> already_queued (dedup GLOBAL)", (await enq(A, pair(1), "cB")) === "already_queued");
  check("4. coada cA=1, coada cB=0 (fara duplicat)",
    (await r.zcard(REDIS_KEYS.agentWatchClientQueue(A, "cA"))) === 1 && (await r.zcard(REDIS_KEYS.agentWatchClientQueue(A, "cB"))) === 0);
  let allQ = true;
  for (let i = 1; i < WATCH_PER_CLIENT_CAP; i++) if ((await enq(A, pair(1000 + i), "cA")) !== "queued") allQ = false;
  check("5. ⭐ cA pana la cap -> toate queued", allQ && (await r.zcard(REDIS_KEYS.agentWatchClientQueue(A, "cA"))) === WATCH_PER_CLIENT_CAP);
  check("6. ⭐⭐ cA peste cap -> client_limit (coada ramane la cap, nu evacueaza)",
    (await enq(A, pair(9999), "cA")) === "client_limit" && (await r.zcard(REDIS_KEYS.agentWatchClientQueue(A, "cA"))) === WATCH_PER_CLIENT_CAP);

  // ── B. Cap global reject-not-evict (Lua direct, globalCap mic) ──────────────
  const B = CH("B");
  const evalG = (p: string, clientId: string, gcap: number) => { track(B, clientId); return r.eval(
    WATCH_ENQUEUE_LUA, 5, REDIS_KEYS.agentWatchSeen(B), REDIS_KEYS.agentWatchClientQueue(B, clientId),
    REDIS_KEYS.agentWatchRotation(B), REDIS_KEYS.agentWatchInRotation(B), REDIS_KEYS.agentWatchMeta(B),
    p, reqJson(p, B, clientId), clientId, "100", String(gcap), String(WATCH_QUEUE_TTL_SEC)); };
  check("7. global cap=2: p1 -> queued", classifyWatchEnqueue(await evalG(pair(1), "x", 2)) === "queued");
  check("8. global cap=2: p2 -> queued", classifyWatchEnqueue(await evalG(pair(2), "y", 2)) === "queued");
  check("9. ⭐⭐ global cap atins: p3 -> queue_full (reject nou)", classifyWatchEnqueue(await evalG(pair(3), "z", 2)) === "queue_full");
  check("10. ⭐⭐ pending NU evacuat (p1,p2 in seen; p3 nu)",
    (await r.zscore(REDIS_KEYS.agentWatchSeen(B), pair(1))) !== null &&
    (await r.zscore(REDIS_KEYS.agentWatchSeen(B), pair(2))) !== null &&
    (await r.zscore(REDIS_KEYS.agentWatchSeen(B), pair(3))) === null);

  // ── C. Drain round-robin (fair pe throughput) via PRIMITIVA reala ───────────
  const C = CH("C");
  for (let i = 0; i < 5; i++) await enq(C, pair(10000 + i), "big");
  for (let i = 0; i < 3; i++) await enq(C, pair(20000 + i), "small");
  const d1 = await drainWatchQueue(r, C, 100);
  const big = d1.filter(x => x.clientId === "big").length, small = d1.filter(x => x.clientId === "small").length;
  check("11. ⭐ drain (primitiva reala) big 5 + small 3", big === 5 && small === 3);
  check("12. ⭐ dupa drain: seen gol + rotatie goala + fara coada orfana",
    (await r.zcard(REDIS_KEYS.agentWatchSeen(C))) === 0 && (await r.llen(REDIS_KEYS.agentWatchRotation(C))) === 0 && (await noOrphanQueues(C)));

  // ── D. FAIR ACROSS CYCLES: > budget clienti + realimentarea grupului din fata ──
  const D = CH("D");
  const N = 7, BUD = 3, FRONT = ["d0", "d1", "d2"];
  for (let i = 0; i < N; i++) await enq(D, pair(30000 + i), "d" + i); // d0..d6, cate 1
  const servedByCycle: string[][] = [];
  let seed = 50000;
  for (let cyc = 0; cyc < 3; cyc++) {
    for (const f of FRONT) await enq(D, pair(seed++), f);            // grupul din fata realimenteaza CONTINUU
    const drained = await drainWatchQueue(r, D, BUD);
    servedByCycle.push(drained.map(x => x.clientId));
  }
  const everServed = new Set(servedByCycle.flat());
  const backServed = ["d3", "d4", "d5", "d6"].every(c => everServed.has(c));
  check("13. ⭐⭐⭐ > budget clienti + refill front: grupul din SPATE (d3..d6) e servit in <=3 cicluri (fara starvation)", backServed);
  check("14. ⭐ toti cei 7 clienti au fost serviti cel putin o data", ["d0","d1","d2","d3","d4","d5","d6"].every(c => everServed.has(c)));

  // ── E. ATOMICITATE la ULTIMUL item — AMBELE serializări explicite + cursă cu DOUĂ conexiuni ──────────────────
  const E = CH("E");
  // (E1) serializare EXPLICITĂ drain -> enqueue: drain golește A (scoate 'race'), apoi enqueue B (re-adaugă)
  await enq(E, pair(600001), "race");
  const e1d = await drainWatchQueue(r, E, 10);
  const e1e = await enq(E, pair(600002), "race");
  const e1all = [...e1d, ...(await drainWatchQueue(r, E, 10))].map(x => x.pairAddress).sort();
  check("15. ⭐⭐ serializare drain->enqueue: A,B drenate EXACT o data + stare complet goala la final",
    e1e === "queued" && e1all.length === 2 && e1all[0] === pair(600001) && e1all[1] === pair(600002) && (await fullyEmpty(E, "race")));
  // (E2) serializare EXPLICITĂ enqueue -> drain: enqueue B (queue {A,B}), apoi drain le ia pe amândouă
  await enq(E, pair(600003), "race");
  const e2e = await enq(E, pair(600004), "race");
  const e2all = (await drainWatchQueue(r, E, 10)).map(x => x.pairAddress).sort();
  check("16. ⭐⭐ serializare enqueue->drain: A,B drenate EXACT o data (acelasi drain) + stare goala",
    e2e === "queued" && e2all.length === 2 && e2all[0] === pair(600003) && e2all[1] === pair(600004) && (await fullyEmpty(E, "race")));
  // (E3) CURSĂ REALĂ: drain pe conexiunea `r`, enqueue pe conexiunea INDEPENDENTĂ `r2` — ordinea la Redis e
  // nedeterminstă (socket-uri diferite). 20 runde. Cele două EVAL-uri sunt atomice → orice serializare e validă.
  let raceOnce = true, raceInv = true, raceClean = true;
  for (let round = 0; round < 20; round++) {
    const A = pair(610000 + round * 2), B = pair(610000 + round * 2 + 1);
    await enq(E, A, "race");
    const [dNow] = await Promise.all([drainWatchQueue(r, E, 10), enqOn(r2, E, B, "race")]);
    // invariant (oricare ordine): coadă nevidă => 'race' în AMBELE (inRotation SET + rotation LIST)
    if ((await r.zcard(REDIS_KEYS.agentWatchClientQueue(E, "race"))) > 0 && !(await inBothRosters(E, "race"))) raceInv = false;
    const all = [...dNow, ...(await drainWatchQueue(r, E, 10))].map(x => x.pairAddress).sort();
    const exp = [A, B].sort();
    if (all.length !== 2 || all[0] !== exp[0] || all[1] !== exp[1]) raceOnce = false;
    if (!(await fullyEmpty(E, "race"))) raceClean = false;
  }
  check("17. ⭐⭐⭐ cursa 2 CONEXIUNI (20 runde): A,B drenate EXACT o data (orice serializare Redis)", raceOnce);
  check("18. ⭐⭐ invariant cursa: coada nevida => client in inRotation SI in LIST-ul rotation", raceInv);
  check("19. ⭐ dupa fiecare runda: queue+seen+meta+rotation+inRotation goale", raceClean);

  // ── F. EXPIRARE per-request: zombie pruned sub trafic continuu (TTL diferit intre clienti) ──
  const F = CH("F");
  await enqTtl(F, pair(70000), "short", 1);                          // client 'short': TTL 1s
  await enq(F, pair(70001), "long");                                 // client 'long': TTL normal, trafic continuu
  check("20. inainte de expirare: seen are ambii", (await r.zcard(REDIS_KEYS.agentWatchSeen(F))) === 2);
  await sleep(1300);
  await enq(F, pair(70002), "long");                                 // trafic de la ALT client -> enqueue prune expiratii
  check("21. ⭐⭐ dupa expirare + trafic: 'short' PRUNED din seen (fara zombie already_queued)",
    (await r.zscore(REDIS_KEYS.agentWatchSeen(F), pair(70000))) === null);
  check("22. ⭐⭐ pair-ul expirat e RE-ENQUEUE-abil (nu mai da already_queued zombie)", (await enq(F, pair(70000), "short")) === "queued");
  check("23. ⭐ invariant: nicio coada nevida in afara rotatiei (F)", await noOrphanQueues(F));

  // ── G. Fail-closed clasificator (Lua REAL) + path complet prin helper-ul mcp pe Redis viu ──
  const G = CH("G");
  check("24. ⭐⭐ classifyWatchEnqueue pe rezultat Lua REAL necunoscut (return 99) -> unexpected (NU queued)",
    classifyWatchEnqueue(await r.eval("return 99", 0)) === "unexpected");
  track(G, "gm");                                                    // înregistrat pt. cleanup
  check("25. ⭐ enqueueWatchRequest (helper mcp, getRedis viu) -> queued pt. pair nou (path end-to-end)",
    (await enqueueWatchRequest(G, pair(80000), reqJson(pair(80000), G, "gm"), "gm")) === "queued");

  console.log("\n" + passed + " passed, " + failed + " failed");
}

main()
  .catch((e) => { console.error("THREW:", e); failed++; })
  .finally(async () => { await cleanup(); r.disconnect(); r2.disconnect(); process.exit(failed > 0 ? 1 : 0); });
