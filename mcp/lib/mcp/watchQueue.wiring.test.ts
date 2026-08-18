/**
 * lib/mcp/watchQueue.wiring.test.ts — PH-10 GUARD de sursă (cablarea cozii fair per-client).
 * (a) tp_watch_pair folosește clientId + enqueue fair (fără vechea listă flat); (b) helper-ul `watchQueue.ts`
 * folosește PRIMITIVA shared `enqueueWatchQueue` și mapează `unexpected`→`unavailable`; (c) worker-ul `scan.ts`
 * drenează prin PRIMITIVA `drainWatchQueue` (nu o replică locală), fără rpop pe lista flat.
 */
import { readFileSync } from "node:fs";
import { WATCH_ENQUEUE_LUA, WATCH_DRAIN_LUA, classifyWatchEnqueue, enqueueWatchQueue, drainWatchQueue } from "@preflight/schema";
import { resolveEnqueueResult } from "../db/watchQueue";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-10 — wiring guard (tool + helper + worker, primitive shared)");

check("1. @preflight/schema exportă primitivele shared (enqueue/drain Lua + runnere + classifier)",
  typeof WATCH_ENQUEUE_LUA === "string" && typeof WATCH_DRAIN_LUA === "string" &&
  typeof enqueueWatchQueue === "function" && typeof drainWatchQueue === "function" && classifyWatchEnqueue(0) === "queued");

// (a) tp_watch_pair.ts
const tool = readFileSync("lib/mcp/tools/tp_watch_pair.ts", "utf8");
check("2. ⭐ tp_watch_pair atribuie clientId din getToolContext()", /getToolContext\(\)\.clientId/.test(tool));
check("3. ⭐⭐ tp_watch_pair cheamă enqueueWatchRequest, NU mai face lpush/ltrim direct",
  /enqueueWatchRequest\(/.test(tool) && !/\.ltrim\(/.test(tool) && !/agentWatchRequests/.test(tool));
check("4. ⭐ tp_watch_pair tratează already_queued + client_limit + queue_full + unavailable",
  /already_queued/.test(tool) && /client_limit/.test(tool) && /queue_full/.test(tool) && /unavailable/.test(tool));
check("5. ⭐ tp_watch_pair include clientId în payload", /clientId,/.test(tool));

// (b) watchQueue.ts (helper Redis-bound) — foloseste primitiva shared + fail-closed
const helper = readFileSync("lib/db/watchQueue.ts", "utf8");
check("6. ⭐⭐ watchQueue.ts foloseste PRIMITIVA shared enqueueWatchQueue (nu re-implementeaza Lua)",
  /enqueueWatchQueue\(/.test(helper) && /from "@preflight\/schema"/.test(helper));
check("7. ⭐⭐ resolveEnqueueResult (PUR): unexpected -> unavailable; restul verdictelor trec neschimbate",
  resolveEnqueueResult("unexpected") === "unavailable" &&
  resolveEnqueueResult("queued") === "queued" &&
  resolveEnqueueResult("already_queued") === "already_queued" &&
  resolveEnqueueResult("client_limit") === "client_limit" &&
  resolveEnqueueResult("queue_full") === "queue_full");
check("7b. ⭐ enqueueWatchRequest foloseste resolveEnqueueResult + Redis jos -> unavailable",
  /resolveEnqueueResult\(/.test(helper) && /return "unavailable"/.test(helper));

// (c) worker scan.ts — cross-package readFileSync (mcp cwd -> ../workers)
const scan = readFileSync("../workers/evm/src/pipeline/scan.ts", "utf8");
check("8. ⭐⭐ scan.ts drenează prin PRIMITIVA drainWatchQueue (nu replica locala cu rpop/plan)",
  /drainWatchQueue\(/.test(scan) && !/roundRobinDrainPlan/.test(scan) && !/\.rpop\(/.test(scan));
check("9. ⭐⭐ scan.ts NU mai atinge lista flat agent_watch_requests, nici SREM/LLEN manual pe coada",
  !/agentWatchRequests/.test(scan) && !/\.srem\(/.test(scan) && !/agentWatchClients\b/.test(scan));
check("10. ⭐ scan.ts foloseste WATCH_DRAIN_BUDGET + proceseaza req.pairAddress/req.clientId din primitiva",
  /WATCH_DRAIN_BUDGET/.test(scan) && /req\.pairAddress/.test(scan) && /req\.clientId/.test(scan));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
