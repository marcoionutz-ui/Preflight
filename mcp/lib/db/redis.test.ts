/**
 * lib/db/redis.test.ts — E9 (Redis singleton lifecycle).
 *
 * Dovedeste regresia: un event `error` NU reface clientul (fara leak — ioredis reconnecteaza aceeasi
 * instanta); doar `end` (terminal) reseteaza singleton-ul; un `end` intarziat de la un client vechi nu
 * darama clientul curent. Zero conexiune reala — client fake (EventEmitter) injectat prin factory.
 */
import { EventEmitter } from "node:events";
import type Redis from "ioredis";
import { createRedisSingleton } from "./redis";

class FakeRedis extends EventEmitter {
  constructor(public readonly id: number) { super(); }
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

console.log("E9 — createRedisSingleton (Redis singleton lifecycle)");

let created = 0;
const clients: FakeRedis[] = [];
const getRedis = createRedisSingleton(() => {
  const client = new FakeRedis(++created);
  clients.push(client);
  return client as unknown as Redis;
});

// 1. Singleton normal — două get-uri consecutive → aceeași instanță, factory o dată.
const first = getRedis();
const again = getRedis();
check("1a. get consecutiv → aceeași instanță", first === again);
check("1b. factory apelată o singură dată", created === 1);

// 2. ⭐ E9 — `error` NU resetează (fără client nou / fără orfan).
clients[0].emit("error", new Error("ECONNRESET"));
const afterError = getRedis();
check("2a. error → aceeași instanță", afterError === first);
check("2b. error → factory NU a rerulat", created === 1);

// flap repetat → tot o singură instanță.
clients[0].emit("error", new Error("flap"));
clients[0].emit("error", new Error("Stream isn't writeable"));
check("2c. flap repetat → tot aceeași instanță, create 1", getRedis() === first && created === 1);

// 3. ⭐ E9 — `end` (terminal) resetează → următorul get creează instanță nouă.
clients[0].emit("end");
const second = getRedis();
check("3a. end → instanță nouă", second !== first);
check("3b. factory apelată din nou (create 2)", created === 2);

// 4. ⭐ E9 — `end` întârziat de la clientul VECHI nu afectează clientul curent.
clients[0].emit("end");
const afterStaleEnd = getRedis();
check("4a. stale end NU resetează clientul nou", afterStaleEnd === second);
check("4b. factory rămâne la două apeluri", created === 2);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
