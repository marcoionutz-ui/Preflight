/**
 * state/memory.ts
 * Pair memory — trackează istoricul fiecărei perechi văzute.
 * Load/save din Redis.
 */

import { detectPhase } from "../lib/engines/phaseDetector";
import type { PairMemoryEntry } from "../lib/engines/pairMemory";
import type { SourcePool } from "../sources/normalize";
import { memory, poolLiquidity } from "./stores";
import { tokenPoolKey, tokenPools } from "../infra/poolTracker";
import { getRedis } from "../infra/redis";
import { getNativePrice, getNativeSymbolForChain } from "../infra/nativePrice";
import { WORKER_VERSION } from "../config/constants";
import { CHAINS } from "../config/chains";
import { REDIS_KEYS, pairKey, splitPairKey, normalizeChainId, normalizePairAddress } from "@preflight/schema";
import type { PreflightWorkerSnapshot } from "@preflight/schema";
import { reserveSourceForRestore } from "../risk/liquidityClassify";

export function updatePoolLiquidity(addr: string, pool: SourcePool): void {
  const reserveUsd = pool.reserveUsd;
  if (reserveUsd > 0) {
    const nativeSymbol  = getNativeSymbolForChain(pool.chain);
    // E25 (fail-closed): fără preț nativ valid NU inventăm un curs (nici ETH-pentru-BNB, nici $1) → skip.
    const nativePrice   = getNativePrice(nativeSymbol);
    if (nativePrice === null) return;
    const reserveNative = reserveUsd / 2 / nativePrice;

    poolLiquidity.set(pool.chain, addr, {
      reserveUsd,
      reserveEth:    reserveNative,
      reserveNative,
      nativeSymbol,
      updatedAt: Date.now(),
      reserveSource: pool.reserveSource, // NF/U5: propagă proveniența (V4_STATE_LIQUIDITY = estimat)
    });
  }
}

export function updateMemory(pool: SourcePool, price: number): PairMemoryEntry {
  const addr         = pool.pairAddress;
  const symbol       = pool.symbol;
  const tokenAddress = pool.tokenAddress;
  const now          = Date.now();
  const m5           = pool.priceChange.m5;
  const h1           = pool.priceChange.h1;
  const h24          = pool.priceChange.h24;

  const existing = memory.get(pool.chain, addr);
  if (!existing) {
    const mem: PairMemoryEntry = {
      pairAddress: addr, symbol, tokenAddress,
      firstSeen: now, lastSeen: now, seenCount: 1,
      priceAtFirstSeen: price, highPrice: price, lowPrice: price, currentPrice: price,
	  priceChange: { m5, h1, h24 },
	  chain:       pool.chain,
      phase: detectPhase({
        seenCount: 1, m5, h24,
        highPrice: price, lowPrice: price, currentPrice: price,
      }),
    };
    memory.set(pool.chain, addr, mem);
    updatePoolLiquidity(addr, pool);
    return mem;
  }

  existing.lastSeen      = now;
  existing.seenCount    += 1;
  existing.currentPrice  = price;
  existing.tokenAddress  = tokenAddress;
  if (price > existing.highPrice) existing.highPrice = price;
  if (price < existing.lowPrice)  existing.lowPrice  = price;
  
  existing.priceChange = { m5, h1, h24 };
  existing.chain = pool.chain;

  existing.phase = detectPhase({
    seenCount: existing.seenCount,
    m5,
    h24,
    highPrice: existing.highPrice,
    lowPrice: existing.lowPrice,
    currentPrice: price,
  });
  
  if (pool.discoverySource) {
    if (!existing.firstDiscoveredAt) existing.firstDiscoveredAt = now;
    existing.lastDiscoveryAt = now;
    existing.discoverySources ??= [];
    if (!existing.discoverySources.includes(pool.discoverySource)) {
      existing.discoverySources.push(pool.discoverySource);
    }
    existing.primaryDiscoverySource ??= pool.discoverySource;
  }

  memory.set(pool.chain, addr, existing);
  updatePoolLiquidity(addr, pool);
  return existing;
}

/**
 * PH-13 (graceful shutdown, cgpt #3): varianta STRICTĂ a salvării — folosită la shutdown, unde o „reușită" falsă e
 * inacceptabilă (am ieși 0 și am pierde starea). Diferă de best-effort prin trei garanții:
 *   1. Redis lipsă (`getRedis()===null`, ex. REDIS_URL neconfigurat) → ARUNCĂ (nu „a mers", nimic scris).
 *   2. Erorile de rețea/pipeline se PROPAGĂ (fără `catch` care le înghite).
 *   3. Verifică rezultatele per-comandă ale `pipeline.exec()` — ioredis întoarce `[[err,res], …]`; o comandă `SET`
 *      eșuată individual NU aruncă din `exec()`, deci o inspectăm și aruncăm pe prima eroare (altfel un snapshot
 *      parțial scris ar trece drept succes).
 * Caller-ul (secvența de shutdown) transformă un throw de aici în exit 1.
 */
export async function saveMemoryToRedisStrict(): Promise<void> {
  const r = getRedis();
  if (!r) throw new Error("saveMemoryToRedisStrict: Redis indisponibil (REDIS_URL lipsă) — memoria NU a fost persistată");

  // B4: worker_snapshot chain-scoped — partiționăm pe chain (din cheia PairMap)
  // și scriem o cheie per-chain (fiecare chain restaurează independent).
  const memByChain: Record<string, Record<string, PairMemoryEntry>> = {};
  for (const [{ chain, address: addr }, mem] of memory.entries()) {
    (memByChain[chain] ??= {})[pairKey(chain, addr)] = { ...mem, chain, pairAddress: addr };
  }
  const resByChain: Record<string, Record<string, number>> = {};
  for (const [{ chain, address: addr }, liqCtx] of poolLiquidity.entries()) {
    (resByChain[chain] ??= {})[pairKey(chain, addr)] = liqCtx.reserveEth;
  }
  const savedAt = Date.now();
  const pipe    = r.pipeline();
  // Iterăm chain-urile RUNTIME-ului (CHAINS = ENABLED_CHAINS), nu doar cele cu date:
  // fiecare chain deținut primește o cheie proaspătă (chiar goală `{}`) → suprascrie
  // orice cheie stale și confirmă ownership-ul. Un chain din afara runtime-ului NU e scris.
  for (const { id: chain } of CHAINS) {
    const snapshot: PreflightWorkerSnapshot = {
      version:        WORKER_VERSION,
      savedAt,
      memory:         memByChain[chain] ?? {},
      poolReserveEth: resByChain[chain] ?? {},
    };
    pipe.set(REDIS_KEYS.workerSnapshot(chain), JSON.stringify(snapshot), "EX", 24 * 60 * 60);
  }
  const results = await pipe.exec();
  // ioredis: `null` dacă pipeline-ul a fost abortat/gol; altfel un tuplu [err,res] per comandă.
  if (results) {
    for (const [err] of results) {
      if (err) throw err; // o singură comandă eșuată = persist parțial → tratăm ca eșec total (fail-closed)
    }
  } else if (CHAINS.length > 0) {
    throw new Error("saveMemoryToRedisStrict: pipeline.exec() a întors null deși existau chain-uri de scris");
  }
  console.log(`[REDIS] Worker snapshot saved (strict, per-chain): ${memory.size} pairs, ${poolLiquidity.size} reserves`);
}

/**
 * Salvare BEST-EFFORT — folosită de save-ul PERIODIC (la fiecare 60s): o eroare tranzitorie de Redis nu trebuie să
 * dărâme worker-ul între snapshot-uri. Delegă la varianta strictă și înghite doar la acest nivel (log, fără throw).
 * La SHUTDOWN folosim `saveMemoryToRedisStrict` direct, ca eșecul să conteze.
 */
export async function saveMemoryToRedis(): Promise<void> {
  try {
    await saveMemoryToRedisStrict();
  } catch (e) {
    console.log(`[REDIS] Snapshot save failed (best-effort): ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function loadMemoryFromRedis(): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = getRedis();
      if (!r) return;

      // B4: worker_snapshot chain-scoped → citim chain-urile runtime-ului și agregăm.
      // Fiecare chain e validat independent (version + age); merge pe memory +
      // poolReserveEth (keysets pairKey disjuncte). Blind cast, fără Zod (același
      // risk-tolerance ca restul codebase-ului).
      // Doar chain-urile RUNTIME-ului (CHAINS = ENABLED_CHAINS): un worker per-chain
      // NU restaurează (și apoi rescrie) memoria altor chain-uri → ownership curat.
      const runtimeChains = CHAINS.map(c => c.id);
      const raws = await r.mget(...runtimeChains.map(c => REDIS_KEYS.workerSnapshot(c)));
      const mergedMemory:  Record<string, PairMemoryEntry> = {};
      const mergedReserve: Record<string, number> = {};
      let newestSavedAt = 0;
      let anyLoaded = false;
      const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60_000;
      for (const raw of raws) {
        if (!raw) continue;
        const snap = JSON.parse(raw) as Partial<PreflightWorkerSnapshot>;
        if (snap.version && snap.version !== WORKER_VERSION) {
          console.log(`[REDIS] Snapshot from ${snap.version} ignored — current is ${WORKER_VERSION}`);
          continue;
        }
        if (snap.savedAt && Date.now() - snap.savedAt > SNAPSHOT_MAX_AGE_MS) {
          console.log(`[REDIS] Snapshot too old ignored — age:${Math.round((Date.now() - snap.savedAt) / 60_000)}m`);
          continue;
        }
        Object.assign(mergedMemory,  snap.memory ?? {});
        Object.assign(mergedReserve, snap.poolReserveEth ?? {});
        if (snap.savedAt && snap.savedAt > newestSavedAt) newestSavedAt = snap.savedAt;
        anyLoaded = true;
      }
      if (!anyLoaded) return;

      let count = 0;
      for (const [k, mem] of Object.entries(mergedMemory)) {
        // k e `pairKey` (chain:address) de la B3e; snapshot-uri vechi aveau doar
        // adresa → splitPairKey dă chain="" și cădem pe mem.chain.
        const { chain: keyChain, address } = splitPairKey(k);
        const rawChain = keyChain !== "" ? keyChain : (mem.chain ?? "");
        if (!rawChain) continue;
        // Canonicalizăm ȘI realiniem valoarea (mem.chain/pairAddress) la cheie,
        // ca modulele care citesc mem.chain să nu vadă `eth` necanonic.
        const setChain   = normalizeChainId(rawChain);
        const setAddress = normalizePairAddress(setChain, address);
        const restoredMem: PairMemoryEntry = { ...mem, chain: setChain, pairAddress: setAddress };
        memory.set(setChain, setAddress, restoredMem);
        count++;
        const key = tokenPoolKey(setChain, restoredMem.tokenAddress);
        if (!tokenPools.has(key)) tokenPools.set(key, new Set());
        tokenPools.get(key)!.add(setAddress);
      }

     for (const [key, nativeReserveRaw] of Object.entries(mergedReserve)) {
        // key e `pairKey` (chain:address) de la B3d-1; snapshot-urile vechi aveau
        // doar adresa → splitPairKey dă chain="".
        const { chain: keyChain, address } = splitPairKey(key);
        const nativeReserve = Number(nativeReserveRaw);
        if (Number.isFinite(nativeReserve) && nativeReserve > 0) {
          // memory[key] e pregătit pt. B3e (când memory devine pairKey); acum cade pe [address].
          const mem          = mergedMemory[key] ?? mergedMemory[address];
          // Cheia NOUĂ (pairKey) e source-of-truth; mem.chain e DOAR fallback pt.
          // snapshot-uri vechi unde keyChain="". Altfel, dacă memory (încă bare-addr
          // până la B3e) a fost suprascris de alt chain, ai restaura pe chain greșit.
          const rawChain     = keyChain !== "" ? keyChain : mem?.chain;
          if (!rawChain) continue;
          const setChain     = normalizeChainId(rawChain);
          const setAddress   = normalizePairAddress(setChain, address);
          const nativeSymbol = getNativeSymbolForChain(setChain);
          // E25 (fail-closed): fără preț nativ valid nu putem recompune reserveUsd corect → sărim entry-ul.
          const nativePrice  = getNativePrice(nativeSymbol);
          if (nativePrice === null) continue;

          poolLiquidity.set(setChain, setAddress, {
            reserveUsd:    nativeReserve * 2 * nativePrice,
            reserveEth:    nativeReserve, // legacy alias
            reserveNative: nativeReserve,
            nativeSymbol,
            updatedAt: newestSavedAt || Date.now(),
            // NF/U5 (R3/R4 varu — restart honesty): snapshot-ul (poolReserveEth) NU persistă reserveSource. Dar o
            // adresă V4 (poolId bytes32) are ÎNTOTDEAUNA rezervă din virtual reserves → o marcăm CONSERVATOR ca
            // estimat V4 la restore (ca să NU redevină CONFIRMED până la primul scan). Non-V4 = real → undefined.
            // Logica trăiește în reserveSourceForRestore (partajat cu testele — nu o copie a ternarului).
            reserveSource: reserveSourceForRestore(setAddress),
          });
        }
      }

      console.log(`[REDIS] Worker snapshot loaded: ${count} pairs, ${poolLiquidity.size} reserves`);
      return;

    } catch (e) {
      console.log(`[REDIS] Snapshot load attempt ${attempt}/5 failed: ${e}`);
      if (attempt < 5) await new Promise(res => setTimeout(res, attempt * 1000));
    }
  }
  console.log(`[REDIS] Snapshot load gave up after 5 attempts`);
}
