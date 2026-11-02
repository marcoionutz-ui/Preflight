/**
 * scripts/beta1/harness/fixtures/fakeAdmissionWorker.ts — BETA-1, treapta 2: WORKER FALS pentru self-testul admiterii.
 *
 * NU e workerul și nu spune nimic despre el. Imită DOAR suprafața folosită de `caseRuntime` și de corpul cazurilor
 * A2-* (`admissionDefs.ts`), după comportamentul citit în produs la `f679f4b`:
 *   - `scan()`: cele trei cereri Gecko (aceleași URL-uri), reconstruirea hărților doar pe scan nevid (păstrarea
 *     routing-only a pool-urilor urmărite dispărute din scan — D5), pool fără preț ignorat, pool cu preț → watch
 *     FRESH + rundă de reabonare 500/800/1100 ms (limitată la 2 s) + GoPlus, apoi subscrierile v4, v3, v2;
 *   - `runDsBoostedRefresh()` → boosted → token-pairs → follow-list; `runFollowRefresh()` → Gecko `pools/<addr>` →
 *     același `processPool`, care NU scrie în hărți (M1/M2 la baseline);
 *   - subscrierile: V3/V4 doar membrii hărților urmăriți; V2 restul, cu `length === 42`; listă goală → dezabonarea
 *     subscripției confirmate; înlocuire → `eth_unsubscribe` al celei vechi la confirmarea celei noi;
 *   - livrarea: swap V2 din `watchedPoolCache`, V3 doar din `v3PoolMap`, V4 doar din `v4PoolMap`;
 *   - (rev2) subscrierile iau doar intrările lanțului `base` (ca produsul: `entryChain === chain.id`); GoPlus își curăță
 *     timerul de abort la primirea răspunsului, ÎNAINTEA citirii corpului (packages/risk-layer/src/goplus.ts).
 * Defectele (`fault`) sunt singurul lucru stricat deliberat; fiecare e legat de un control al self-testului.
 * Folosește `fetch`-ul global (stubul gărzii) și timerele globale (observate) — exact ca produsul.
 */

import WebSocket from "ws";
import type { SrcModules } from "../caseRuntime";
import { realTimers } from "../observers";
import {
  URL_TRENDING_1, URL_TRENDING_2, URL_NEW_POOLS, URL_DS_BOOSTED, urlGeckoPool, urlDsTokenPairs, urlGoPlus,
  V2_TOPICS0, V3_TOPICS0, V4_TOPICS0, V4_POOL_MANAGER_BASE, SYM_TARGET,
} from "../admissionFixtures";
import { T_SWAP_V2, T_SWAP_V3, T_SWAP_V4 } from "../evmFixtures";

export const A2_FAULTS = [
  "none",
  // Varianta REPARATĂ (follow-refresh admite în hartă) și amestecurile între coloane.
  "fixed-admission", "mix-v2-v3", "spurious-v3", "never-subscribe-v3",
  // Bariera de reabonare (§3.1).
  "round-pending", "round-partial", "round-throws", "round-suppressed", "pending-left", "node-filter-mismatch",
  // Tipurile ABSENTE (rev3): subscripție V2 tranzitorie, dezabonată corect sau nu.
  "transient-v2", "transient-v2-keep-worker", "transient-v2-keep-node", "transient-v2-bad-unsub",
  // Montaj, rețea, import.
  "unserved-fetch", "extra-fetch", "not-admitted", "d5-no-rebuild", "import-timer", "import-fetch",
  // Martor și totaluri (§4.1).
  "missing-witness", "witness-flip", "extra-swap", "no-record-target",
  // rev2 (cgpt P1): ținta urmărită DOAR pe alt chain (aceeași adresă, cheia `arbitrum`).
  "watch-other-chain",
  // rev2 (cgpt P2): GoPlus primește răspunsul și curăță timerul de abort (ca produsul), dar corpul rămâne necitit:
  // pentru totdeauna (`body-pending`) sau până la o eliberare ulterioară, invizibilă observatorului de timere
  // (`body-delayed`, 1,5 s pe timerele reale).
  "body-pending", "body-delayed",
  // rev3 (cgpt P2): citirea corpului GoPlus RESPINSĂ (`formData()` pe un corp JSON): ignorată de apelant (fără
  // `await`/`catch` → `unhandledRejection`) sau tratată explicit (`.catch`) → operația `failed`, fără excepție.
  "body-reject-ignored", "body-reject-handled",
] as const;
export type A2Fault = typeof A2_FAULTS[number];

interface FakePool { chain: string; pairAddress: string; tokenAddress: string; symbol: string; dexType: "V2" | "V3" | "V4"; dexId: string; priceUsd: number; reserveUsd: number; }
interface FakeSwap { ts: number; isBuy: boolean; ethAmount: number; usdAmount: number; }
type Key = { chain: string; address: string };

class FakePairMap<V> {
  private readonly m = new Map<string, { key: Key; v: V }>();
  private k(c: string, a: string): string { return `${c}:${a.toLowerCase()}`; }
  get(c: string, a: string): V | undefined { return this.m.get(this.k(c, a))?.v; }
  set(c: string, a: string, v: V): this { this.m.set(this.k(c, a), { key: { chain: c, address: a.toLowerCase() }, v }); return this; }
  has(c: string, a: string): boolean { return this.m.has(this.k(c, a)); }
  delete(c: string, a: string): boolean { return this.m.delete(this.k(c, a)); }
  get size(): number { return this.m.size; }
  values(): V[] { return [...this.m.values()].map(e => e.v); }
  entries(): Array<[Key, V]> { return [...this.m.values()].map(e => [e.key, e.v]); }
  addresses(): string[] { return [...this.m.values()].map(e => e.key.address); }
}

const signed = (hex64: string): bigint => { const x = BigInt("0x" + hex64); return x >= (1n << 255n) ? x - (1n << 256n) : x; };
const V3_DEXES = new Set(["uniswap-v3", "uniswap-v3-base", "aerodrome-slipstream", "pancakeswap-v3-base"]);

function normalizeGecko(raw: unknown): FakePool | null {
  const r = raw as { attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id?: string } }> } | null;
  const addr = typeof r?.attributes?.address === "string" ? (r.attributes.address as string).toLowerCase() : "";
  if (!addr) return null;
  const dexId = r?.relationships?.dex?.data?.id ?? "";
  const token = (r?.relationships?.base_token?.data?.id ?? "").replace(/^base_/, "").toLowerCase();
  const symbol = String(r?.attributes?.name ?? "?").split("/")[0].trim();
  const dexType = addr.length === 66 ? "V4" : V3_DEXES.has(dexId) ? "V3" : "V2";
  return {
    chain: "base", pairAddress: addr, tokenAddress: token, symbol, dexType, dexId,
    priceUsd: Number(r?.attributes?.base_token_price_usd ?? 0), reserveUsd: Number(r?.attributes?.reserve_in_usd ?? 0),
  };
}

/** Construiește un worker fals proaspăt. `fault` = singurul lucru stricat deliberat. */
export async function loadFakeAdmissionSrc(fault: A2Fault): Promise<SrcModules> {
  if (fault === "import-timer") setTimeout(() => { /* injectat la import */ }, 5);
  if (fault === "import-fetch") void fetch("https://example.invalid/a2-import").catch(() => { /* refuzat de gardă */ });

  const memory = new FakePairMap<{ symbol: string }>();
  const activeWatch = new FakePairMap<{ chain: string; addedAt: number; kind: string }>();
  const v3PoolMap = new FakePairMap<FakePool>();
  const v4PoolMap = new FakePairMap<FakePool>();
  const routingOnlyPools = new FakePairMap<boolean>();
  const marketFollowList = new FakePairMap<{ chain: string; attentionScore: number; source: string }>();
  const watchedPoolCache = new FakePairMap<FakePool>();
  const wsFlow = new FakePairMap<FakeSwap[]>();
  const lpEvents = new FakePairMap<unknown[]>();
  const empty = (): FakePairMap<unknown> => new FakePairMap<unknown>();
  const scopedSubStore = {
    active: new Map<string, { subId: string; snapshot: string }>(),
    pending: new Map<number, { key: string; snapshot: string; sentAt: number }>(),
    latestReq: new Map<string, number>(),
  };
  const wsClients = new Map<string, WebSocket>();
  const lastImmediateSub = new Map<string, number>();
  const wsLastMessageAt = new Map<string, number>();
  const wsLastMessageAtByKind = new Map<string, number>();

  let shuttingDown = false;
  let jobs = 0;
  let price: number | null = null;
  let reqId = 30_000;
  let scanCount = 0;
  let lastDsBoostedFetchAt = 0;

  const getJson = async (url: string): Promise<unknown> => {
    try { const res = await fetch(url); return res.ok ? await res.json() : null; }
    catch { return null; }
  };

  /** GoPlus, fire-and-forget: abort-ul curățat la răspuns, apoi corpul (ca `goPlusFetchWithRetry` + `fetchGoPlusRaw`). */
  const goPlus = async (url: string): Promise<void> => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (fault === "body-pending") return;                                   // corpul nu se citește niciodată
      if (fault === "body-delayed") await new Promise<void>(r => { realTimers.setTimeout(r, 1_500); });
      if (fault === "body-reject-ignored") { void res.formData(); return; }          // respingere neprelucrată
      if (fault === "body-reject-handled") { await res.formData().catch(() => { /* tratată de apelant */ }); return; }
      if (res.ok) await res.json();
    } catch { clearTimeout(t); }
  };

  // ── Subscrieri (ws/subscriptions.ts, simplificat) ──────────────────────────────────────────────────────────
  const send = (payload: unknown): void => { wsClients.get("base")?.send(JSON.stringify(payload)); };
  const subscribe = (kind: "v2" | "v3" | "v4"): void => {
    const ws = wsClients.get("base");
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (fault === "never-subscribe-v3" && kind === "v3") return;
    const watched = activeWatch.entries().filter(([k]) => k.chain === "base").map(([k]) => k.address);
    const inV3 = (a: string): boolean => v3PoolMap.has("base", a);
    const inV4 = (a: string): boolean => v4PoolMap.has("base", a);
    let addrs: string[];
    if (kind === "v3") addrs = fault === "spurious-v3" ? [...new Set([...watched.filter(inV3), ...v3PoolMap.addresses()])] : watched.filter(inV3);
    else if (kind === "v4") addrs = watched.filter(inV4);
    else if (fault.startsWith("transient-v2") && scanCount === 1) addrs = watched.filter(a => a.length === 42);   // ca și cum hărțile n-ar exista încă
    else addrs = watched.filter(a => (fault === "mix-v2-v3" ? !inV4(a) : !inV3(a) && !inV4(a)) && a.length === 42);
    const key = `base:${kind}`;
    if (addrs.length === 0) {
      const active = scopedSubStore.active.get(key);
      scopedSubStore.latestReq.delete(key);
      if (!active) return;
      if (fault === "transient-v2-keep-worker" && kind === "v2") return;          // nici intrarea, nici dezabonarea
      scopedSubStore.active.delete(key);
      if (fault === "transient-v2-keep-node" && kind === "v2") return;            // intrarea ștearsă, dezabonarea netrimisă
      const target = fault === "transient-v2-bad-unsub" && kind === "v2" ? "0xbad" : active.subId;
      send({ jsonrpc: "2.0", id: kind === "v4" ? 50 : kind === "v3" ? 51 : 53, method: "eth_unsubscribe", params: [target] });
      return;
    }
    const desired = addrs.join(",");
    const latestId = scopedSubStore.latestReq.get(key);
    const latest = latestId !== undefined ? scopedSubStore.pending.get(latestId) : undefined;
    if (latest && latest.snapshot === desired) return;
    const act = scopedSubStore.active.get(key);
    if (act && act.snapshot === desired && !latest) return;
    const id = ++reqId;
    const stored = fault === "node-filter-mismatch" && kind === "v3" ? desired + ",0xalterat" : desired;
    scopedSubStore.pending.set(id, { key, snapshot: stored, sentAt: Date.now() });
    scopedSubStore.latestReq.set(key, id);
    const params = kind === "v4"
      ? ["logs", { address: V4_POOL_MANAGER_BASE, topics: [[...V4_TOPICS0], addrs] }]
      : ["logs", { address: addrs, topics: [[...(kind === "v3" ? V3_TOPICS0 : V2_TOPICS0)]] }];
    send({ jsonrpc: "2.0", id, method: "eth_subscribe", params });
  };

  const requestImmediate = (): void => {
    if (fault === "round-suppressed") return;
    const now = Date.now();
    if (now - (lastImmediateSub.get("base") ?? 0) < 2_000) return;
    lastImmediateSub.set("base", now);
    setTimeout(() => subscribe("v4"), 500);
    setTimeout(() => {
      if (fault === "round-throws") throw new Error("rundă de reabonare: excepție injectată");
      subscribe("v3");
    }, 800);
    if (fault === "round-partial") return;
    const t1100: NodeJS.Timeout = setTimeout(() => {
      subscribe("v2");
      if (fault === "round-pending") t1100.refresh();   // rămâne „pending” la nesfârșit; joburile rămân 0
    }, 1_100);
  };

  // ── Pipeline (pipeline/scan.ts, simplificat) ──────────────────────────────────────────────────────────────
  const processPool = (p: FakePool, source: "scan" | "follow"): void => {
    if (!p.priceUsd) return;
    memory.set("base", p.pairAddress, { symbol: p.symbol });
    if (activeWatch.has("base", p.pairAddress)) return;
    if (fault === "not-admitted" && p.symbol === SYM_TARGET) return;
    const watchChain = fault === "watch-other-chain" && p.symbol === SYM_TARGET ? "arbitrum" : "base";
    if (activeWatch.has(watchChain, p.pairAddress)) return;
    activeWatch.set(watchChain, p.pairAddress, { chain: watchChain, addedAt: Date.now(), kind: "FRESH_WATCH" });
    watchedPoolCache.set(watchChain, p.pairAddress, p);
    if (source === "follow" && (fault === "fixed-admission" || fault === "mix-v2-v3")) {
      if (p.dexType === "V3") v3PoolMap.set("base", p.pairAddress, p);
      if (p.dexType === "V4") v4PoolMap.set("base", p.pairAddress, p);
    }
    console.log(`[FRESH_WATCH] ${p.symbol} (base) (fals)`);
    requestImmediate();
    void goPlus(fault === "unserved-fetch" ? urlGoPlus("0x" + "de".repeat(20)) : urlGoPlus(p.tokenAddress));
  };

  const scan = async (): Promise<void> => {
    scanCount++;
    const pools: FakePool[] = [];
    const urls = [URL_TRENDING_1, ...(fault === "extra-fetch" && scanCount === 1 ? [URL_TRENDING_1] : []), URL_TRENDING_2, URL_NEW_POOLS];
    const seen = new Set<string>();
    for (const u of urls) {
      const d = await getJson(u) as { data?: unknown[] } | null;
      for (const raw of d?.data ?? []) {
        const p = normalizeGecko(raw);
        if (p && !seen.has(p.pairAddress)) { seen.add(p.pairAddress); pools.push(p); }
      }
    }
    if (pools.length > 0 && !(fault === "d5-no-rebuild" && scanCount === 2)) {
      for (const map of [v3PoolMap, v4PoolMap]) {
        for (const a of map.addresses()) {
          if (seen.has(a)) continue;
          if (activeWatch.has("base", a)) routingOnlyPools.set("base", a, true);
          else { map.delete("base", a); routingOnlyPools.delete("base", a); }
        }
      }
      for (const p of pools) {
        if (p.dexType === "V3" && V3_DEXES.has(p.dexId)) { v3PoolMap.set("base", p.pairAddress, p); routingOnlyPools.delete("base", p.pairAddress); }
        if (p.dexType === "V4") { v4PoolMap.set("base", p.pairAddress, p); routingOnlyPools.delete("base", p.pairAddress); }
      }
    } else {
      console.log("[MAPS] Keeping previous V3/V4 maps — Gecko returned empty (fals)");
    }
    for (const p of pools) processPool(p, "scan");
    subscribe("v4"); subscribe("v3"); subscribe("v2");
  };

  const runDsBoostedRefresh = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastDsBoostedFetchAt < 5 * 60_000) return;
    lastDsBoostedFetchAt = now;
    const items = await getJson(URL_DS_BOOSTED);
    if (!Array.isArray(items)) return;
    for (const it of items as Array<{ chainId?: string; tokenAddress?: string }>) {
      if (it.chainId !== "base" || typeof it.tokenAddress !== "string") continue;
      const pairs = await getJson(urlDsTokenPairs(it.tokenAddress.toLowerCase()));
      const first = Array.isArray(pairs) ? pairs[0] as { pairAddress?: string } | undefined : undefined;
      if (!first?.pairAddress) continue;
      marketFollowList.set("base", first.pairAddress.toLowerCase(), { chain: "base", attentionScore: 75, source: "DEXSCREENER_BOOSTED" });
    }
  };

  const runFollowRefresh = async (): Promise<void> => {
    for (const a of marketFollowList.addresses()) {
      const d = await getJson(urlGeckoPool(a)) as { data?: unknown } | null;
      const p = d?.data ? normalizeGecko(d.data) : null;
      if (p) processPool(p, "follow");
    }
  };

  // ── Managerul WS (ws/manager.ts, simplificat) ─────────────────────────────────────────────────────────────
  const handle = (data: Buffer): void => {
    const msg = JSON.parse(data.toString()) as { id?: unknown; result?: unknown; params?: { result?: { address: string; topics: string[]; data: string } } };
    if (typeof msg.id === "number" && scopedSubStore.pending.has(msg.id)) {
      if (fault === "pending-left") return;                                       // confirmarea ignorată
      const p = scopedSubStore.pending.get(msg.id) as { key: string; snapshot: string };
      scopedSubStore.pending.delete(msg.id);
      if (scopedSubStore.latestReq.get(p.key) !== msg.id) {
        send({ jsonrpc: "2.0", id: 88, method: "eth_unsubscribe", params: [String(msg.result)] });
        return;
      }
      const prev = scopedSubStore.active.get(p.key);
      scopedSubStore.active.set(p.key, { subId: String(msg.result), snapshot: p.snapshot });
      scopedSubStore.latestReq.delete(p.key);
      if (prev && prev.subId !== String(msg.result)) send({ jsonrpc: "2.0", id: 88, method: "eth_unsubscribe", params: [prev.subId] });
      console.log(`[SCOPED SUB base] req#${msg.id} → promoted (fals)`);
      return;
    }
    const log = msg.params?.result;
    if (!log) return;
    wsLastMessageAt.set("base", Date.now());
    const raw = log.data.slice(2);
    let pair: string, quoteDelta: bigint, tag: "V2" | "V3" | "V4", pool: FakePool | undefined;
    if (log.topics[0] === T_SWAP_V2) {
      pair = log.address.toLowerCase(); pool = watchedPoolCache.get("base", pair); tag = "V2";
      const in0 = BigInt("0x" + raw.slice(0, 64)), out0 = BigInt("0x" + raw.slice(128, 192));
      quoteDelta = in0 > 0n ? in0 : -out0;
      if (fault === "missing-witness") return;
      if (fault === "witness-flip") quoteDelta = -quoteDelta;
    } else if (log.topics[0] === T_SWAP_V3) {
      pair = log.address.toLowerCase(); pool = v3PoolMap.get("base", pair); tag = "V3";
      quoteDelta = signed(raw.slice(0, 64));
      if (fault === "no-record-target" && pool?.symbol === SYM_TARGET) return;
    } else if (log.topics[0] === T_SWAP_V4) {
      pair = log.topics[1].toLowerCase(); pool = v4PoolMap.get("base", pair); tag = "V4";
      quoteDelta = -signed(raw.slice(0, 64));
    } else return;
    if (!pool || price === null) return;
    wsLastMessageAtByKind.set(`base:${tag.toLowerCase()}`, Date.now());
    const eth = Number(quoteDelta < 0n ? -quoteDelta : quoteDelta) / 1e18;
    const ev: FakeSwap = { ts: Date.now(), isBuy: quoteDelta > 0n, ethAmount: eth, usdAmount: eth * price };
    wsFlow.set("base", pair, [...(wsFlow.get("base", pair) ?? []), ev]);
    console.log(`[${tag} SWAP base] ${pool.symbol} ${ev.isBuy ? "BUY" : "SELL"} (fals)`);
    if (fault === "extra-swap") wsFlow.set("base", "0x" + "99".repeat(20), [{ ...ev }]);   // tăcut, pe altă cheie
  };

  const connectChainWebSocket = (chain: { id: string; wsUrl: string }): void => {
    const ws = new WebSocket(chain.wsUrl);
    wsClients.set(chain.id, ws);
    ws.on("open", () => {
      setTimeout(() => subscribe("v4"), 2_500);
      setTimeout(() => subscribe("v3"), 3_000);
      setTimeout(() => subscribe("v2"), 3_500);
    });
    ws.on("message", (data: Buffer) => {
      if (shuttingDown) return;
      jobs++;
      try { handle(data); }
      catch (e) { console.log(`[WS ERR ${chain.id}]`, e); }
      finally { jobs--; }
    });
  };

  const closeAllWebSockets = async (): Promise<void> => {
    const sockets = [...wsClients.values()];
    wsClients.clear();
    await Promise.all(sockets.map(s => new Promise<void>(res => { s.once("close", () => res()); s.close(); })));
  };

  const fake = {
    stores: {
      memory, activeWatch, hotCandidates: empty(), armedEntries: empty(), v3PoolMap, v4PoolMap, watchedPoolCache,
      wsFlow, lpEvents, poolLiquidity: empty(), scopedSubStore, scopedConfirmedAt: new Map<string, number>(),
      lastImmediateSub, wsLastMessageAt, wsLastMessageAtByKind, wsLastPongAt: new Map<string, number>(), wsClients,
      routingOnlyPools, marketFollowList,
      get lastDsBoostedFetchAt(): number { return lastDsBoostedFetchAt; },
    },
    scan: { scan, runDsBoostedRefresh, runFollowRefresh },
    manager: { connectChainWebSocket, closeAllWebSockets },
    lifecycle: { isShuttingDown: (): boolean => shuttingDown, markShuttingDown: (): void => { shuttingDown = true; }, activeJobCount: (): number => jobs },
    nativePrice: { __setNativePriceForTest: (_symbol: string, value: number | null): void => { price = value; } },
  };
  // Suprafața folosită de runtime și de corpul cazurilor A2-*; restul workerului real NU există aici.
  return fake as unknown as SrcModules;
}
