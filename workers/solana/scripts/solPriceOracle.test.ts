/**
 * scripts/solPriceOracle.test.ts — E28b (wiring cache: fetchAndCacheSolPrice → Redis EX 300 + source real).
 *
 * fetch + redis + now INJECTATE. Dovedește: cascada aleasă e cache-uită corect (mode "EX", ttl 300),
 * `source` = sursa câștigătoare, fallback real, iar când toate eșuează NU se scrie în Redis.
 * Import-heavy (oracle importă ./redis → ioredis) → rulează la GATE/CI, nu standalone în container.
 */
import { fetchAndCacheSolPrice } from "../src/infra/solPriceOracle";
import { SOL_PRICE_SOURCES, type SolPriceSourceName } from "../src/infra/solPriceSources";
import { KEY_SOL_USD_PRICE } from "../src/config/constants";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

type FakeResp = { status?: number; json?: any } | "throw";
function makeFetch(byName: Partial<Record<SolPriceSourceName, FakeResp>>) {
  const urlToName = new Map(SOL_PRICE_SOURCES.map(s => [s.url, s.name]));
  const fn = async (url: unknown): Promise<Response> => {
    const name = urlToName.get(String(url))!;
    const r = byName[name];
    if (r === undefined || r === "throw") throw new Error("network fail " + name);
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => r.json } as unknown as Response;
  };
  return fn as unknown as typeof fetch;
}
const CB = (amt: string) => ({ json: { data: { amount: amt } } });
const KR = (px: string)  => ({ json: { error: [], result: { SOLUSD: { c: [px, "1"] } } } });
const BN = (px: string)  => ({ json: { symbol: "SOLUSDT", price: px } });

function makeRedis() {
  const calls: Array<{ key: string; val: string; mode: string; ttl: number }> = [];
  const redis = {
    set: async (key: string, val: string, mode: "EX", ttl: number) => { calls.push({ key, val, mode, ttl }); return "OK"; },
  };
  return { redis, calls: () => calls };
}

const NOW = 1_700_000_000_000;

async function main(): Promise<void> {
  console.log("E28b — fetchAndCacheSolPrice (cache Redis EX 300 + source real)");

  // 1. Coinbase valid → entry corect + cache cu EX 300.
  {
    const fetchImpl = makeFetch({ COINBASE: CB("73.5"), KRAKEN: KR("70"), BINANCE: BN("71") });
    const r = makeRedis();
    const entry = await fetchAndCacheSolPrice({ fetchImpl, redis: r.redis, now: () => NOW });
    check("1. entry.priceUsd = 73.5", entry?.priceUsd === 73.5);
    check("2. entry.source = COINBASE (real)", entry?.source === "COINBASE");
    check("3. entry.fetchedAt = now injectat", entry?.fetchedAt === NOW);
    check("4. Redis.set apelat exact o dată", r.calls().length === 1);
    check("5. cache: cheia = KEY_SOL_USD_PRICE", r.calls()[0]?.key === KEY_SOL_USD_PRICE);
    check("6. cache: mode EX, ttl 300", r.calls()[0]?.mode === "EX" && r.calls()[0]?.ttl === 300);
    check("7. cache: JSON conține source COINBASE + priceUsd 73.5", (() => {
      const p = JSON.parse(r.calls()[0]?.val ?? "{}"); return p.source === "COINBASE" && p.priceUsd === 73.5;
    })());
  }

  // 2. Fallback: Coinbase 451 → Kraken câștigă → source KRAKEN cache-uit.
  {
    const fetchImpl = makeFetch({ COINBASE: { status: 451 }, KRAKEN: KR("70.2"), BINANCE: BN("71") });
    const r = makeRedis();
    const entry = await fetchAndCacheSolPrice({ fetchImpl, redis: r.redis, now: () => NOW });
    check("8. fallback → entry.source = KRAKEN, price 70.2", entry?.source === "KRAKEN" && entry?.priceUsd === 70.2);
    check("9. cache scris cu source KRAKEN + EX 300", (() => {
      const c = r.calls()[0]; if (!c) return false; const p = JSON.parse(c.val);
      return p.source === "KRAKEN" && c.mode === "EX" && c.ttl === 300;
    })());
  }

  // 3. Toate eșuează → null ȘI NU se scrie în Redis.
  {
    const fetchImpl = makeFetch({ COINBASE: { status: 500 }, KRAKEN: "throw", BINANCE: { status: 451 } });
    const r = makeRedis();
    const entry = await fetchAndCacheSolPrice({ fetchImpl, redis: r.redis, now: () => NOW });
    check("10. toate eșuează → null", entry === null);
    check("11. Redis NU e scris când nu avem preț", r.calls().length === 0);
  }

  // 4. Valoare invalidă (Coinbase amount 0) → fallback Kraken, apoi cache (nu cache pe invalid).
  {
    const fetchImpl = makeFetch({ COINBASE: CB("0"), KRAKEN: KR("69.9"), BINANCE: BN("71") });
    const r = makeRedis();
    const entry = await fetchAndCacheSolPrice({ fetchImpl, redis: r.redis, now: () => NOW });
    check("12. Coinbase invalid → fallback Kraken cache-uit (69.9, KRAKEN)",
      entry?.source === "KRAKEN" && entry?.priceUsd === 69.9 && JSON.parse(r.calls()[0]?.val ?? "{}").source === "KRAKEN");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
