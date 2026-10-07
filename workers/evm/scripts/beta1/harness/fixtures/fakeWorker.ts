/**
 * scripts/beta1/harness/fixtures/fakeWorker.ts — BETA-1, felia 3: WORKER FALS, pentru controalele runtime-ului.
 *
 * NU e workerul și nu spune nimic despre el. Imită doar suprafața pe care o folosește `caseRuntime` (store-uri,
 * conectare, subscriere la 2,5/3/3,5 s după `open`, înregistrarea unui swap, închidere), ca ramurile de eșec ale
 * runtime-ului să poată fi exercitate cu defecte INJECTATE (`fault`). Un rezultat verde aici spune că runtime-ul
 * decide corect; nimic despre codul real din `src/`.
 */

import WebSocket from "ws";
import net from "node:net";
import type { SrcModules } from "../caseRuntime";

export const FAULTS = [
  "none", "no-record", "flip-direction", "handler-throws", "async-handler", "leaked-interval",
  "import-timer", "import-fetch", "other-port", "never-subscribes", "double-record", "starts-entrypoint",
  // Erori TÂRZII, vizibile doar în consolă sau deloc: după ultima verificare dinaintea cleanup-ului.
  "cleanup-console-error", "before-exit-console-error", "before-exit-transport-error", "exit-listener",
] as const;
export type Fault = typeof FAULTS[number];

const T_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const T_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const T_V4 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const USDC = "833589fcd6edb6e08f4c7c32d4f71b54bda02913";

class FakePairMap<V> {
  private readonly m = new Map<string, V>();
  private k(c: string, a: string): string { return `${c}:${a.toLowerCase()}`; }
  get(c: string, a: string): V | undefined { return this.m.get(this.k(c, a)); }
  set(c: string, a: string, v: V): this { this.m.set(this.k(c, a), v); return this; }
  has(c: string, a: string): boolean { return this.m.has(this.k(c, a)); }
  get size(): number { return this.m.size; }
  addresses(): string[] { return [...this.m.keys()].map(k => k.slice(k.indexOf(":") + 1)); }
}

interface FakePool { chain: string; pairAddress: string; symbol: string; dexType: string; priceUsd: number; stableQuote: boolean; }
interface FakeSwap { ts: number; isBuy: boolean; ethAmount: number; usdAmount: number; }

const signed = (hex64: string): bigint => { const x = BigInt("0x" + hex64); return x >= (1n << 255n) ? x - (1n << 256n) : x; };

/** Construiește un worker fals proaspăt. `fault` = singurul lucru stricat deliberat. */
export async function loadFakeSrc(fault: Fault): Promise<SrcModules> {
  // Defecte care trebuie să se producă LA IMPORT (faza „import" a runtime-ului).
  if (fault === "import-timer") setTimeout(() => { /* injectat */ }, 5);
  if (fault === "import-fetch") void fetch("https://example.invalid/fake").catch(() => { /* refuzat de gardă */ });
  if (fault === "starts-entrypoint") console.log("Preflight Worker fals starting...");
  // Erori scrise DOAR în consolă, abia când bucla de evenimente s-a golit (după toate verificările dinainte de G).
  if (fault === "before-exit-console-error" || fault === "before-exit-transport-error") {
    let once = false;
    process.on("beforeExit", () => {
      if (once) return;
      once = true;
      console.log(fault === "before-exit-console-error" ? "[WS ERR base] injectat la beforeExit" : "[WS base] Error: injectat la beforeExit");
    });
  }
  // Ascultător de `exit` înregistrat de „worker": rulează DUPĂ scrierea rezultatului, deci nu poate fi observat.
  if (fault === "exit-listener") process.on("exit", () => { /* injectat */ });

  const memory = new FakePairMap<{ symbol: string }>();
  const activeWatch = new FakePairMap<unknown>();
  const v3PoolMap = new FakePairMap<FakePool>();
  const v4PoolMap = new FakePairMap<FakePool>();
  const watchedPoolCache = new FakePairMap<FakePool>();
  const wsFlow = new FakePairMap<FakeSwap[]>();
  const empty = (): FakePairMap<unknown> => new FakePairMap<unknown>();
  const scopedSubStore = {
    active: new Map<string, { subId: string; snapshot: string }>(),
    pending: new Map<number, { key: string; snapshot: string; sentAt: number }>(),
    latestReq: new Map<string, number>(),
  };
  const wsClients = new Map<string, WebSocket>();
  const wsLastMessageAt = new Map<string, number>();
  const wsLastMessageAtByKind = new Map<string, number>();
  const wsLastPongAt = new Map<string, number>();

  let shuttingDown = false;
  let jobs = 0;
  let price: number | null = null;
  let reqId = 20_000;
  let heartbeat: NodeJS.Timeout | null = null;
  let stable: NodeJS.Timeout | null = null;

  const connectChainWebSocket = (chain: { id: string; wsUrl: string }): void => {
    const ws = new WebSocket(chain.wsUrl);
    wsClients.set(chain.id, ws);
    heartbeat = setInterval(() => { ws.ping(); }, 30_000);
    ws.on("pong", () => { wsLastPongAt.set(chain.id, Date.now()); });

    const subscribe = (kind: "v2" | "v3" | "v4"): void => {
      if (fault === "never-subscribes") return;
      const addrs = activeWatch.addresses().filter(a =>
        kind === "v3" ? v3PoolMap.has(chain.id, a) :
        kind === "v4" ? v4PoolMap.has(chain.id, a) :
        !v3PoolMap.has(chain.id, a) && !v4PoolMap.has(chain.id, a) && a.length === 42);
      if (addrs.length === 0) return;
      const id = ++reqId;
      const key = `${chain.id}:${kind}`;
      scopedSubStore.pending.set(id, { key, snapshot: addrs.join(","), sentAt: Date.now() });
      scopedSubStore.latestReq.set(key, id);
      const params = kind === "v4"
        ? ["logs", { address: POOL_MANAGER, topics: [[T_V4], addrs] }]
        : ["logs", { address: addrs, topics: [[kind === "v3" ? T_V3 : T_V2]] }];
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "eth_subscribe", params }));
    };

    ws.on("open", () => {
      console.log(`[WS] (fals) conectat ${chain.id}`);
      if (fault === "other-port") { const s = net.connect(1, "127.0.0.1"); s.on("error", () => { /* refuzat de gardă */ }); }
      stable = setTimeout(() => { /* stabilitate */ }, 60_000);
      setTimeout(() => subscribe("v4"), 2_500);
      setTimeout(() => subscribe("v3"), 3_000);
      setTimeout(() => subscribe("v2"), 3_500);
    });

    const handle = (data: Buffer): void => {
      const msg = JSON.parse(data.toString()) as { id?: unknown; result?: unknown; params?: { result?: { address: string; topics: string[]; data: string } } };
      if (typeof msg.id === "number" && scopedSubStore.pending.has(msg.id)) {
        const p = scopedSubStore.pending.get(msg.id) as { key: string; snapshot: string };
        scopedSubStore.pending.delete(msg.id);
        scopedSubStore.active.set(p.key, { subId: String(msg.result), snapshot: p.snapshot });
        scopedSubStore.latestReq.delete(p.key);
        console.log(`[SCOPED SUB ${chain.id}] req#${msg.id} → promoted`);
        return;
      }
      const log = msg.params?.result;
      if (!log) return;
      wsLastMessageAt.set(chain.id, Date.now());
      const raw = log.data.slice(2);
      let pair: string, quoteDelta: bigint, tag: "V2" | "V3" | "V4";
      if (log.topics[0] === T_V4)      { pair = log.topics[1]; quoteDelta = -signed(raw.slice(0, 64)); tag = "V4"; }
      else if (log.topics[0] === T_V3) { pair = log.address;   quoteDelta = signed(raw.slice(0, 64));  tag = "V3"; }
      else if (log.topics[0] === T_V2) {
        const amountIn = BigInt("0x" + raw.slice(0, 64)), amountOut = BigInt("0x" + raw.slice(128, 192));
        pair = log.address; quoteDelta = amountIn > 0n ? amountIn : -amountOut; tag = "V2";
      } else return;
      wsLastMessageAtByKind.set(`${chain.id}:${tag.toLowerCase()}`, Date.now());
      const mem = memory.get(chain.id, pair);
      const pool = watchedPoolCache.get(chain.id, pair);
      if (!mem || !pool || price === null) return;
      if (fault === "no-record") return;
      if (fault === "handler-throws") throw new Error("defect injectat în handler");
      if (fault === "leaked-interval") setInterval(() => { /* injectat */ }, 50_000);
      if (fault === "flip-direction") quoteDelta = -quoteDelta;
      const abs = quoteDelta < 0n ? -quoteDelta : quoteDelta;
      const quote = Number(abs) / (pool.stableQuote ? 1e6 : 1e18);
      const event: FakeSwap = { ts: Date.now(), isBuy: quoteDelta > 0n, ethAmount: pool.stableQuote ? quote / price : quote, usdAmount: pool.stableQuote ? quote : quote * price };
      const events = wsFlow.get(chain.id, pair) ?? [];
      events.push(event);
      if (fault === "double-record") events.push({ ...event });
      wsFlow.set(chain.id, pair, events);
      console.log(`[${tag} SWAP ${chain.id}] ${mem.symbol} ${event.isBuy ? "BUY" : "SELL"} (fals)`);
    };

    ws.on("message", (data: Buffer) => {
      if (shuttingDown) return;
      jobs++;
      if (fault === "async-handler") {
        // Handler ASINCRON: procesarea continuă după ce ascultătorii următori au văzut cadrul.
        void (async () => {
          try { await new Promise<void>(res => { setTimeout(res, 40); }); handle(data); }
          catch (e) { console.log(`[WS ERR ${chain.id}]`, e); }
          finally { jobs--; }
        })();
        return;
      }
      try { handle(data); }
      catch (e) { console.log(`[WS ERR ${chain.id}]`, e); }
      finally { jobs--; }
    });
    ws.on("close", () => { if (heartbeat) clearInterval(heartbeat); });
  };

  const closeAllWebSockets = async (): Promise<void> => {
    if (stable) clearTimeout(stable);
    const sockets = [...wsClients.values()];
    wsClients.clear();
    await Promise.all(sockets.map(s => new Promise<void>(res => { s.once("close", () => res()); s.close(); })));
  };

  const fake = {
    stores: {
      memory, activeWatch, hotCandidates: empty(), armedEntries: empty(), v3PoolMap, v4PoolMap, watchedPoolCache,
      wsFlow, lpEvents: empty(), poolLiquidity: empty(), scopedSubStore,
      scopedConfirmedAt: new Map<string, number>(), lastImmediateSub: new Map<string, number>(),
      wsLastMessageAt, wsLastMessageAtByKind, wsLastPongAt, wsClients,
    },
    memory: { updateMemory: (pool: FakePool): { symbol: string } => { const m = { symbol: pool.symbol }; memory.set(pool.chain, pool.pairAddress, m); return m; } },
    transitions: { addWatchCandidate: (pair: string, info: { chain: string }, pool?: FakePool): void => { activeWatch.set(info.chain, pair, info); if (pool) watchedPoolCache.set(info.chain, pair, pool); } },
    normalize: {
      normalizePool: (raw: { attributes: Record<string, unknown>; relationships: Record<string, unknown> }, chain: { id: string }): FakePool => {
        const address = String(raw.attributes.address).toLowerCase();
        const dexId = String((raw.relationships.dex as { data: { id: string } }).data.id);
        const quoteId = String((raw.relationships.quote_token as { data: { id: string } }).data.id);
        return {
          chain: chain.id, pairAddress: address, symbol: String(raw.attributes.name).split("/")[0].trim(),
          dexType: address.length === 66 ? "V4" : dexId.includes("v3") ? "V3" : "V2",
          priceUsd: Number(raw.attributes.base_token_price_usd), stableQuote: quoteId.includes(USDC),
        };
      },
    },
    manager: { connectChainWebSocket, closeAllWebSockets },
    lifecycle: { isShuttingDown: (): boolean => shuttingDown, markShuttingDown: (): void => { shuttingDown = true; }, activeJobCount: (): number => jobs },
    nativePrice: { __setNativePriceForTest: (_symbol: string, value: number | null): void => { price = value; } },
  };
  // Suprafața folosită de runtime și de corpul controalelor; restul workerului real NU există aici.
  return fake as unknown as SrcModules;
}
