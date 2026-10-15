/**
 * scripts/beta1/harness/fixtures/fakeWorker.ts — BETA-1, felia 3: WORKER FALS, pentru controalele runtime-ului.
 *
 * NU e workerul și nu spune nimic despre el. Imită doar suprafața pe care o folosește `caseRuntime` (store-uri,
 * conectare, subscriere la 2,5/3/3,5 s după `open`, înregistrarea unui swap, închidere), ca ramurile de eșec ale
 * runtime-ului să poată fi exercitate cu defecte INJECTATE (`fault`). Un rezultat verde aici spune că runtime-ul
 * decide corect; nimic despre codul real din `src/`.
 *
 * Felia T1: falsul urmează produsul REPARAT — filtrul V3 conține topicul Swap PancakeSwap V3 (ordinea din
 * `V3_SCOPED_TOPICS`), topicul e mapat la kind-ul `v3` (marcajul precede decodarea, doar pe subscripția activă),
 * iar handlerul decodează cu regula exactă de 448 hex (Uniswap ≥ 128), refuzând tăcut restul. Comportamentul vechi
 * devine defect injectat (`pancake-unsupported`).
 */

import WebSocket from "ws";
import net from "node:net";
import type { SrcModules } from "../caseRuntime";

export const FAULTS = [
  "none", "no-record", "flip-direction", "handler-throws", "async-handler", "leaked-interval",
  "import-timer", "import-fetch", "other-port", "never-subscribes", "double-record", "starts-entrypoint",
  // Erori TÂRZII, vizibile doar în consolă sau deloc: după ultima verificare dinaintea cleanup-ului.
  "cleanup-console-error", "before-exit-console-error", "before-exit-transport-error", "exit-listener",
  // Felia 4 — variante „REPARATE": workerul fals NU mai are defectul respectiv, deci cazul de defect corespunzător
  // trebuie să dea DEFECT_NOT_REPRODUCED / PARTIAL_NOT_OBSERVED. Fără ele, „reprodus" ar putea fi un verde fals.
  // (Felia T1: `fixed-pancake-topic` a dispărut odată cu T1, T1-LP și T1-FORCED, retrase; falsul e acum reparat.)
  "fixed-map-route", "fixed-v4-route", "fixed-solidly-topic",
  "fixed-price-fallback", "fixed-v3-dexes",
  // Felia D1: falsul urmează produsul REPARAT (metadatele DexScreener sunt citite). Varianta veche, cu metadate
  // necitibile, devine defect injectat: cu ea, controalele D1-DS-* trebuie să dea CONTROL_FAILED.
  "ds-quote-unreadable",
  // Defecte în LP-ul V2 al falsului, ca verificările controalelor LP să fie provocate direct.
  "lp-percent-off", "lp-flip-side", "lp-no-reserve",
  // Efecte LATERALE pe alte chei, pentru verificările globale ale controalelor LP: un swap înregistrat pe alt chain
  // fără linie în consolă; o linie de swap pe alt chain fără înregistrare; un eveniment LP pe altă pereche.
  "lp-extra-swap-silent", "lp-extra-swap-line", "lp-extra-lp-silent",
  // Felia T1 (design rev3, §4.1): comportamentul vechi (topicul Pancake lipsește din filtru și din handler); decodorul
  // Pancake aruncă (→ `[WS ERR` → HARNESS_ERROR, regula runtime-ului); topicul Pancake nemapat la kind-ul `v3`.
  "pancake-unsupported", "pancake-throws", "pancake-kind-unmapped",
  // Efecte LATERALE la sosirea unui log Pancake (înaintea decodării, deci și pentru logul refuzat de SHORT): swap
  // tăcut pe alt chain, eveniment LP tăcut pe altă pereche, linie de swap / LP pe alt chain fără înregistrare.
  "short-swap-other-chain", "short-lp-other-pair", "short-swap-line-other-chain", "short-lp-line-other-chain",
  "buy-extra-swap-other-chain",
  // Swapul Pancake cu sumele negate înaintea clasificării; linia de swap Pancake fără câmpul `swapVariant`.
  "buy-sign-negated", "buy-variant-missing",
] as const;
export type Fault = typeof FAULTS[number];

const T_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const T_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const T_V4 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const T_MINT_V2 = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
const T_BURN_V2 = "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496";
const T_MINT_V3 = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
const T_BURN_V3 = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c";
const T_PANCAKE_V3 = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";
const T_SOLIDLY = "0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b";
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const USDC = "833589fcd6edb6e08f4c7c32d4f71b54bda02913";

class FakePairMap<V> {
  private readonly m = new Map<string, V>();
  private k(c: string, a: string): string { return `${c}:${a.toLowerCase()}`; }
  get(c: string, a: string): V | undefined { return this.m.get(this.k(c, a)); }
  set(c: string, a: string, v: V): this { this.m.set(this.k(c, a), v); return this; }
  has(c: string, a: string): boolean { return this.m.has(this.k(c, a)); }
  get size(): number { return this.m.size; }
  values(): IterableIterator<V> { return this.m.values(); }
  addresses(): string[] { return [...this.m.keys()].map(k => k.slice(k.indexOf(":") + 1)); }
}

/** `quoteKnown: false` imită metadatele din care workerul nu poate citi base/quote (`ds-quote-unreadable`). */
interface FakePool { chain: string; pairAddress: string; symbol: string; dexType: string; dexId: string; priceUsd: number; reserveUsd: number; stableQuote: boolean; quoteKnown: boolean; }
interface FakeSwap { ts: number; isBuy: boolean; ethAmount: number; usdAmount: number; }

const signed = (hex64: string): bigint => { const x = BigInt("0x" + hex64); return x >= (1n << 255n) ? x - (1n << 256n) : x; };

/** Decodorul swapurilor V3 al falsului, după contractul produsului reparat: `null` = refuz tăcut, fără excepții. */
function fakeDecodeV3(topic0: string, data: unknown): { amount0: bigint; variant: "uniswap-v3" | "pancake-v3" } | null {
  if (typeof data !== "string" || !data.startsWith("0x")) return null;
  const hex = data.slice(2);
  if (topic0 === T_PANCAKE_V3) {
    if (hex.length !== 448 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
    return { amount0: signed(hex.slice(0, 64)), variant: "pancake-v3" };
  }
  if (hex.length < 128 || !/^[0-9a-fA-F]*$/.test(hex.slice(0, 128))) return null;
  return { amount0: signed(hex.slice(0, 64)), variant: "uniswap-v3" };
}

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
  const lpEvents = new FakePairMap<Array<{ ts: number; isAdd: boolean; ethAmount: number }>>();
  const poolLiquidity = new FakePairMap<{ reserveEth: number }>();
  const empty = (): FakePairMap<unknown> => new FakePairMap<unknown>();
  // `V3_DEXES` al workerului fals: ca în baseline, NU conține `pancakeswap-v3` (id-ul din indexer).
  const V3_DEXES = new Set(["uniswap-v3", "uniswap-v3-base", "pancakeswap-v3-base", ...(fault === "fixed-v3-dexes" ? ["pancakeswap-v3"] : [])]);
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

  // topic0 → kind (ca `TOPIC_TO_KIND` din produs). Topicul Pancake e mapat la `v3`, cu excepția defectelor injectate.
  const pancakeKind = fault !== "pancake-kind-unmapped" && fault !== "pancake-unsupported";
  const TOPIC_KIND: Record<string, "v2" | "v3" | "v4"> = {
    [T_V4]: "v4", [T_V3]: "v3", [T_MINT_V3]: "v3", [T_BURN_V3]: "v3", [T_V2]: "v2", [T_MINT_V2]: "v2", [T_BURN_V2]: "v2",
    ...(pancakeKind ? { [T_PANCAKE_V3]: "v3" as const } : {}),
  };
  const kindOf = (topic0: unknown): "v2" | "v3" | "v4" | null => (typeof topic0 === "string" ? TOPIC_KIND[topic0] ?? null : null);

  const connectChainWebSocket = (chain: { id: string; wsUrl: string }): void => {
    const ws = new WebSocket(chain.wsUrl);
    wsClients.set(chain.id, ws);
    heartbeat = setInterval(() => { ws.ping(); }, 30_000);
    ws.on("pong", () => { wsLastPongAt.set(chain.id, Date.now()); });

    const typed = (a: string): string | undefined => watchedPoolCache.get(chain.id, a)?.dexType;
    // Ruta imită workerul: V3/V4 DOAR pentru pool-urile din hărți; restul (cu adresă de 20 de octeți) merg pe V2.
    const onV3 = (a: string): boolean => v3PoolMap.has(chain.id, a) || (fault === "fixed-map-route" && typed(a) === "V3");
    const onV4 = (a: string): boolean => v4PoolMap.has(chain.id, a) || (fault === "fixed-v4-route" && a.length === 66);
    const subscribe = (kind: "v2" | "v3" | "v4"): void => {
      if (fault === "never-subscribes") return;
      const addrs = activeWatch.addresses().filter(a =>
        kind === "v3" ? onV3(a) :
        kind === "v4" ? onV4(a) :
        !onV3(a) && !onV4(a) && a.length === 42);
      if (addrs.length === 0) return;
      const id = ++reqId;
      const key = `${chain.id}:${kind}`;
      scopedSubStore.pending.set(id, { key, snapshot: addrs.join(","), sentAt: Date.now() });
      scopedSubStore.latestReq.set(key, id);
      // Felia T1: ordinea din `V3_SCOPED_TOPICS`; `pancake-unsupported` = filtrul de dinainte de fix.
      const v3Topics = fault === "pancake-unsupported" ? [T_V3, T_MINT_V3, T_BURN_V3] : [T_V3, T_PANCAKE_V3, T_MINT_V3, T_BURN_V3];
      const v2Topics = [T_V2, T_MINT_V2, T_BURN_V2, ...(fault === "fixed-solidly-topic" ? [T_SOLIDLY] : [])];
      const params = kind === "v4"
        ? ["logs", { address: POOL_MANAGER, topics: [[T_V4], addrs] }]
        : ["logs", { address: addrs, topics: [kind === "v3" ? v3Topics : v2Topics] }];
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
      const msg = JSON.parse(data.toString()) as { id?: unknown; result?: unknown; params?: { subscription?: unknown; result?: { address: string; topics: string[]; data: string } } };
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
      const topic0 = log.topics[0];
      // Ca în produs: marcajul per-kind PRECEDE filtrarea pe topic și decodarea, doar pentru subscripția activă.
      const kind = kindOf(topic0);
      if (kind && scopedSubStore.active.get(`${chain.id}:${kind}`)?.subId === msg.params?.subscription) {
        wsLastMessageAtByKind.set(`${chain.id}:${kind}`, Date.now());
      }
      if (fault === "handler-throws") throw new Error("defect injectat în handler");
      const raw = log.data.slice(2);
      let pair: string, quoteDelta: bigint, tag: "V2" | "V3" | "V4";
      let pool: FakePool | undefined;
      let variant: "uniswap-v3" | "pancake-v3" | null = null;
      const isPancake = topic0 === T_PANCAKE_V3;
      const asV3 = topic0 === T_V3 || (isPancake && fault !== "pancake-unsupported");
      const asV2 = topic0 === T_V2 || (fault === "fixed-solidly-topic" && topic0 === T_SOLIDLY);
      if (topic0 === T_V4) {
        pair = log.topics[1]; quoteDelta = -signed(raw.slice(0, 64)); tag = "V4";
        pool = v4PoolMap.get(chain.id, pair);                       // ca în worker: doar din hartă
      } else if (asV3) {
        if (isPancake) {
          // Efecte laterale injectate, ÎNAINTEA decodării (deci și pentru logul trunchiat refuzat de SHORT).
          const OTHER = "0x" + "99".repeat(20);
          if (fault === "short-swap-other-chain" || fault === "buy-extra-swap-other-chain") wsFlow.set("arbitrum", OTHER, [{ ts: Date.now(), isBuy: true, ethAmount: 1, usdAmount: 2_500 }]);
          if (fault === "short-lp-other-pair") lpEvents.set(chain.id, OTHER, [{ ts: Date.now(), isAdd: true, ethAmount: 1 }]);
          if (fault === "short-swap-line-other-chain") console.log(`[V3 SWAP arbitrum] ALT BUY (fals)`);
          if (fault === "short-lp-line-other-chain") console.log(`[LP ADD arbitrum] ALT +1.000 ETH quote=WETH (fals)`);
          if (fault === "pancake-throws") throw new Error("decodor Pancake: excepție injectată");
        }
        const dec = fakeDecodeV3(topic0, log.data);
        if (!dec) return;                                           // refuz tăcut, ca decodorul produsului
        pair = log.address; quoteDelta = dec.amount0; tag = "V3"; variant = dec.variant;
        if (isPancake && fault === "buy-sign-negated") quoteDelta = -quoteDelta;
        pool = v3PoolMap.get(chain.id, pair) ?? (fault === "fixed-map-route" ? watchedPoolCache.get(chain.id, pair) : undefined);
      } else if (asV2) {
        const amount0In = BigInt("0x" + raw.slice(0, 64)), amount1In = BigInt("0x" + raw.slice(64, 128));
        const amountOut = BigInt("0x" + raw.slice(128, 192));
        if (amount0In === 0n && amount1In === 0n) return;           // ca în worker: swap fără intrare, ignorat
        pair = log.address; quoteDelta = amount0In > 0n ? amount0In : -amountOut; tag = "V2";
        pool = watchedPoolCache.get(chain.id, pair);
      } else if (topic0 === T_MINT_V2 || topic0 === T_BURN_V2) {
        // LP V2 (felia D1), ca în worker: sumă nativă din rezerva de quote (token0), rezerva pool-ului pentru procent.
        const lpPool = watchedPoolCache.get(chain.id, log.address);
        const lpMem = memory.get(chain.id, log.address);
        if (!lpPool || !lpMem || !lpPool.quoteKnown || price === null) return;
        const amt = BigInt("0x" + raw.slice(0, 64));
        const quoteAmt = Number(amt) / (lpPool.stableQuote ? 1e6 : 1e18);
        const eth = lpPool.stableQuote ? quoteAmt / price : quoteAmt;
        const quoteSym = lpPool.stableQuote ? "USDC" : "WETH";
        const isAdd = (topic0 === T_MINT_V2) !== (fault === "lp-flip-side");
        lpEvents.set(chain.id, log.address, [...(lpEvents.get(chain.id, log.address) ?? []), { ts: Date.now(), isAdd, ethAmount: eth }]);
        const OTHER = "0x" + "99".repeat(20);
        if (fault === "lp-extra-swap-silent") wsFlow.set("arbitrum", OTHER, [{ ts: Date.now(), isBuy: true, ethAmount: 1, usdAmount: 2_500 }]);
        if (fault === "lp-extra-swap-line") console.log(`[V2 SWAP arbitrum] ALT BUY (fals)`);
        if (fault === "lp-extra-lp-silent") lpEvents.set(chain.id, OTHER, [{ ts: Date.now(), isAdd, ethAmount: eth }]);
        if (isAdd) {
          console.log(`[LP ADD ${chain.id}] ${lpMem.symbol} +${eth.toFixed(3)} ETH quote=${quoteSym}`);
        } else {
          const reserve = (poolLiquidity.get(chain.id, log.address)?.reserveEth ?? 0) * (fault === "lp-percent-off" ? 2 : 1);
          console.log(`[LP REMOVE ${chain.id}] ${lpMem.symbol} -${eth.toFixed(3)} ETH (quote=${quoteSym})`
            + (reserve > 0 ? ` (${((eth / reserve) * 100).toFixed(1)}% of pool)` : " (no reserve estimate)") + " ⚠️");
        }
        return;
      } else if (topic0 === T_MINT_V3) {
        // Log LP: sosit și procesat, fără niciun swap.
        if (v3PoolMap.has(chain.id, log.address) && memory.get(chain.id, log.address)) {
          lpEvents.set(chain.id, log.address, [...(lpEvents.get(chain.id, log.address) ?? []), { ts: Date.now(), isAdd: true, ethAmount: 0 }]);
          console.log(`[V3 LP ADD ${chain.id}] (fals)`);
        }
        return;
      } else return;
      const mem = memory.get(chain.id, pair);
      if (!mem || !pool) return;
      if (!pool.quoteKnown) return;                                 // base/quote necitibile → swap neînregistrat
      const usePrice = price ?? (fault === "fixed-price-fallback" ? 2_500 : null);
      if (usePrice === null) return;                                // preț absent → swap neînregistrat
      if (fault === "no-record") return;
      if (fault === "leaked-interval") setInterval(() => { /* injectat */ }, 50_000);
      if (fault === "flip-direction") quoteDelta = -quoteDelta;
      const abs = quoteDelta < 0n ? -quoteDelta : quoteDelta;
      const quote = Number(abs) / (pool.stableQuote ? 1e6 : 1e18);
      const event: FakeSwap = { ts: Date.now(), isBuy: quoteDelta > 0n, ethAmount: pool.stableQuote ? quote / usePrice : quote, usdAmount: pool.stableQuote ? quote : quote * usePrice };
      const events = wsFlow.get(chain.id, pair) ?? [];
      events.push(event);
      if (fault === "double-record") events.push({ ...event });
      wsFlow.set(chain.id, pair, events);
      const variantField = variant === null || (variant === "pancake-v3" && fault === "buy-variant-missing") ? "" : ` swapVariant=${variant}`;
      console.log(`[${tag} SWAP ${chain.id}] ${mem.symbol} ${event.isBuy ? "BUY" : "SELL"} (fals)${variantField}`);
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
      wsFlow, lpEvents, poolLiquidity, scopedSubStore,
      scopedConfirmedAt: new Map<string, number>(), lastImmediateSub: new Map<string, number>(),
      wsLastMessageAt, wsLastMessageAtByKind, wsLastPongAt, wsClients,
    },
    memory: {
      updateMemory: (pool: FakePool): { symbol: string } => {
        const m = { symbol: pool.symbol };
        memory.set(pool.chain, pool.pairAddress, m);
        // Ca `updatePoolLiquidity`: rezerva nativă = reserveUsd / 2 / preț; fără preț, nimic.
        if (pool.reserveUsd > 0 && price !== null && fault !== "lp-no-reserve") poolLiquidity.set(pool.chain, pool.pairAddress, { reserveEth: pool.reserveUsd / 2 / price });
        return m;
      },
    },
    transitions: { addWatchCandidate: (pair: string, info: { chain: string }, pool?: FakePool): void => { activeWatch.set(info.chain, pair, info); if (pool) watchedPoolCache.set(info.chain, pair, pool); } },
    normalize: {
      normalizePool: (raw: { attributes: Record<string, unknown>; relationships: Record<string, unknown> }, chain: { id: string }): FakePool => {
        const address = String(raw.attributes.address).toLowerCase();
        const dexId = String((raw.relationships.dex as { data: { id: string } }).data.id);
        const quoteId = String((raw.relationships.quote_token as { data: { id: string } }).data.id);
        return {
          chain: chain.id, pairAddress: address, symbol: String(raw.attributes.name).split("/")[0].trim(),
          dexType: address.length === 66 ? "V4" : V3_DEXES.has(dexId) ? "V3" : "V2", dexId,
          priceUsd: Number(raw.attributes.base_token_price_usd), reserveUsd: Number(raw.attributes.reserve_in_usd ?? 0),
          stableQuote: quoteId.includes(USDC), quoteKnown: true,
        };
      },
    },
    dexscreener: {
      // Forma DexScreener: base/quote sunt obiecte. Ca în produsul REPARAT (felia D1), workerul fals le citește;
      // `ds-quote-unreadable` reproduce comportamentul de dinainte de fix.
      normalizeDsPair: (raw: { pairAddress: string; dexId: string; priceUsd: string; liquidity?: { usd?: number }; baseToken: { symbol: string }; quoteToken: { address: string } }, chain: { id: string }): FakePool => {
        const address = String(raw.pairAddress).toLowerCase();
        return {
          chain: chain.id, pairAddress: address, symbol: raw.baseToken.symbol,
          dexType: address.length === 66 ? "V4" : V3_DEXES.has(raw.dexId) ? "V3" : "V2", dexId: raw.dexId,
          priceUsd: Number(raw.priceUsd), stableQuote: raw.quoteToken.address.toLowerCase().includes(USDC),
          reserveUsd: Number(raw.liquidity?.usd ?? 0),
          quoteKnown: fault !== "ds-quote-unreadable",
        };
      },
    },
    indexed: {
      // Ca în baseline: tipul vine dintr-o listă PROPRIE a sursei indexate, diferită de `V3_DEXES`.
      toSourcePool: (pair: { chain: string; pairAddress: string; dexId: string; baseSymbol?: string; priceUsd?: number }): FakePool => ({
        chain: pair.chain, pairAddress: pair.pairAddress, symbol: pair.baseSymbol ?? "UNKNOWN",
        dexType: pair.dexId === "uniswap-v3" || pair.dexId === "pancakeswap-v3" ? "V3" : "V2", dexId: pair.dexId,
        priceUsd: pair.priceUsd ?? 0, reserveUsd: 0, stableQuote: false, quoteKnown: true,
      }),
    },
    constants: { V3_DEXES },
    manager: { connectChainWebSocket, closeAllWebSockets },
    lifecycle: { isShuttingDown: (): boolean => shuttingDown, markShuttingDown: (): void => { shuttingDown = true; }, activeJobCount: (): number => jobs },
    nativePrice: { __setNativePriceForTest: (_symbol: string, value: number | null): void => { price = value; } },
  };
  // Suprafața folosită de runtime și de corpul controalelor; restul workerului real NU există aici.
  return fake as unknown as SrcModules;
}
