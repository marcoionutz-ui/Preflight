/**
 * scripts/watchQueue.test.ts — PH-10 (coada de watch fair per-client, expirare per-request, drain atomic).
 * (a) pur — classifyWatchEnqueue (FAIL-CLOSED), parseWatchRequest; (b) GUARD pe WATCH_ENQUEUE_LUA + WATCH_DRAIN_LUA
 * (invariantele de prune/dedup/cap/rotație trăiesc în Lua). Runtime complet (Redis real) = integrarea din mcp.
 */
import {
  WATCH_ENQUEUE_LUA, WATCH_DRAIN_LUA, classifyWatchEnqueue, parseWatchRequest,
  WATCH_PER_CLIENT_CAP, WATCH_GLOBAL_CAP, WATCH_QUEUE_TTL_SEC, WATCH_DRAIN_BUDGET,
  REDIS_KEYS,
} from "../src/index";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-10 — watch queue (fair per-client, per-request expiry, atomic drain)");

// ── (a) classifyWatchEnqueue — FAIL-CLOSED ──
check("1. 0 -> queued", classifyWatchEnqueue(0) === "queued");
check("2. 1 -> already_queued", classifyWatchEnqueue(1) === "already_queued");
check("3. -1 -> client_limit", classifyWatchEnqueue(-1) === "client_limit");
check("4. -2 -> queue_full", classifyWatchEnqueue(-2) === "queue_full");
check("5. ⭐⭐ valoare necunoscuta (99) -> unexpected (NU queued)", classifyWatchEnqueue(99) === "unexpected");
check("6. ⭐⭐ null -> unexpected (fail-closed, nu raporteaza succes fara dovada)", classifyWatchEnqueue(null) === "unexpected");
check("7. ⭐⭐ NaN -> unexpected", classifyWatchEnqueue(NaN) === "unexpected");
check("8. ⭐ undefined -> unexpected", classifyWatchEnqueue(undefined) === "unexpected");
check("9. string '0'/'1'/'-2' din Lua -> mapate corect", classifyWatchEnqueue("0") === "queued" && classifyWatchEnqueue("1") === "already_queued" && classifyWatchEnqueue("-2") === "queue_full");

// ── (a) parseWatchRequest ──
check("10. parse valid -> WatchRequest", (() => { const r = parseWatchRequest(JSON.stringify({ pairAddress: "0xabc", chain: "base", reason: "r", requestedAt: 5, clientId: "c1" })); return r?.pairAddress === "0xabc" && r?.clientId === "c1"; })());
check("11. parse JSON stricat -> null", parseWatchRequest("{bad") === null);
check("12. parse fara pairAddress -> null", parseWatchRequest(JSON.stringify({ chain: "base" })) === null);
check("13. defaults pe campuri lipsa (reason/clientId)", (() => { const r = parseWatchRequest(JSON.stringify({ pairAddress: "0xabc", chain: "base" })); return r?.reason === "AGENT_SUPPLIED" && r?.clientId === "unknown"; })());

// ── (b) GUARD WATCH_ENQUEUE_LUA — prune-by-score + dedup + cap + rotatie ──
check("14. ⭐⭐ enqueue: PRUNE-BY-SCORE la intrare (ZREMRANGEBYSCORE seen + coada client, HDEL meta pe expirati)",
  /ZRANGEBYSCORE', KEYS\[1\], '-inf', now/.test(WATCH_ENQUEUE_LUA) &&
  /HDEL', KEYS\[5\], dead\[i\]/.test(WATCH_ENQUEUE_LUA) &&
  /ZREMRANGEBYSCORE', KEYS\[1\], '-inf', now/.test(WATCH_ENQUEUE_LUA) &&
  /ZREMRANGEBYSCORE', KEYS\[2\], '-inf', now/.test(WATCH_ENQUEUE_LUA));
check("15. ⭐ enqueue: timp din ceasul REDIS (TIME), nu din client (fara skew)", /redis\.call\('TIME'\)/.test(WATCH_ENQUEUE_LUA));
check("16. ⭐⭐ enqueue: idempotency prin ZSCORE seen (pair inca LIVE dupa prune) -> return 1", /ZSCORE', KEYS\[1\], ARGV\[1\]\) then return 1/.test(WATCH_ENQUEUE_LUA));
check("17. ⭐ enqueue: cap per-client (ZCARD coada >= perClientCap) -> return -1", /ZCARD', KEYS\[2\]\) >= tonumber\(ARGV\[4\]\) then return -1/.test(WATCH_ENQUEUE_LUA));
check("18. ⭐ enqueue: cap global (ZCARD seen >= globalCap) -> return -2 (reject nou, nu evacueaza)", /ZCARD', KEYS\[1\]\) >= tonumber\(ARGV\[5\]\) then return -2/.test(WATCH_ENQUEUE_LUA));
check("19. ⭐⭐ enqueue: la queued scrie seen(ZADD exp) + coada client(ZADD exp) + meta(HSET) cu score de expirare",
  /ZADD', KEYS\[1\], exp, ARGV\[1\]/.test(WATCH_ENQUEUE_LUA) && /ZADD', KEYS\[2\], exp, ARGV\[1\]/.test(WATCH_ENQUEUE_LUA) && /HSET', KEYS\[5\], ARGV\[1\], ARGV\[2\]/.test(WATCH_ENQUEUE_LUA));
check("20. ⭐⭐ enqueue: clientul intra in rotatie o SINGURA data (SADD inRotation == 1 -> RPUSH rotation)",
  /SADD', KEYS\[4\], ARGV\[3\]\) == 1 then redis\.call\('RPUSH', KEYS\[3\], ARGV\[3\]\)/.test(WATCH_ENQUEUE_LUA));
check("21. enqueue: key-TTL de igiena pe toate 5 cheile (GC chei idle; corectitudinea e prin scor)",
  (WATCH_ENQUEUE_LUA.match(/EXPIRE'/g) ?? []).length === 5);
check("22. ⭐ enqueue: NU exista LTRIM (nu mai evacueaza cererile vechi — bug-ul varu)", !/LTRIM/.test(WATCH_ENQUEUE_LUA));

// ── (b) GUARD WATCH_DRAIN_LUA — atomic + fair across cycles + prune ──
check("23. ⭐⭐ drain: ATOMIC — LPOP client din rotatie + ZPOPMIN din coada lui (cel mai vechi)",
  /LPOP', KEYS\[1\]/.test(WATCH_DRAIN_LUA) && /ZPOPMIN', qk/.test(WATCH_DRAIN_LUA));
check("24. ⭐⭐ drain: FAIR across cycles — clientul servit e RPUSH-uit la COADA rotatiei (daca mai are)",
  /ZCARD', qk\) > 0 then\s*\n\s*redis\.call\('RPUSH', KEYS\[1\], client\)/.test(WATCH_DRAIN_LUA));
check("25. ⭐ drain: clientul golit iese din rotatie (SREM inRotation)", /SREM', KEYS\[2\], client/.test(WATCH_DRAIN_LUA));
check("26. ⭐⭐ drain: curata seen(ZREM) + meta(HDEL) pe pair-ul drenat (fara zombie)", /ZREM', KEYS\[3\], pair/.test(WATCH_DRAIN_LUA) && /HDEL', KEYS\[4\], pair/.test(WATCH_DRAIN_LUA));
check("27. ⭐ drain: PRUNE-BY-SCORE per client inainte de pop (zero zombie)", /ZREMRANGEBYSCORE', qk, '-inf', now/.test(WATCH_DRAIN_LUA));
check("28. ⭐ drain: timp din ceasul REDIS + bound pe iteratii (fara loop infinit pe cozi goale)",
  /redis\.call\('TIME'\)/.test(WATCH_DRAIN_LUA) && /steps < bound/.test(WATCH_DRAIN_LUA));

// ── (c) capuri + chei ──
check("29. capuri sane", WATCH_PER_CLIENT_CAP > 0 && WATCH_PER_CLIENT_CAP <= WATCH_GLOBAL_CAP && WATCH_DRAIN_BUDGET > 0 && WATCH_QUEUE_TTL_SEC > 0);
check("30. ⭐ chei chain-scoped disjuncte (seen/clientQueue/rotation/inRotation/meta)",
  REDIS_KEYS.agentWatchSeen("base") !== REDIS_KEYS.agentWatchSeen("arbitrum") &&
  REDIS_KEYS.agentWatchRotation("base") !== REDIS_KEYS.agentWatchRotation("arbitrum") &&
  REDIS_KEYS.agentWatchInRotation("base") !== REDIS_KEYS.agentWatchInRotation("arbitrum") &&
  REDIS_KEYS.agentWatchMeta("base") !== REDIS_KEYS.agentWatchMeta("arbitrum") &&
  REDIS_KEYS.agentWatchClientQueue("base", "c1") !== REDIS_KEYS.agentWatchClientQueue("arbitrum", "c1"));
check("31. ⭐ prefixul cozii per-client = agentWatchClientQueue(chain, '') + clientId",
  REDIS_KEYS.agentWatchClientQueue("base", "") + "c1" === REDIS_KEYS.agentWatchClientQueue("base", "c1"));
check("32. vechea cheie flat agent_watch_requests a fost ELIMINATA", !("agentWatchRequests" in REDIS_KEYS));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
