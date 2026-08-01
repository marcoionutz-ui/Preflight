/**
 * scripts/nativePriceOracle.test.ts — E25c (freshness la sursă + fallback secvențial real).
 *
 * refreshNativePrices e apelat cu fetch/env/now INJECTATE (determinist). Dovedește:
 *   - Ethereum-only RPC → fetch + preț fresh (feedul ETH/USD Mainnet e configurat);
 *   - Base fetch fail → Arbitrum success (fallback REAL, în ordine base→arb);
 *   - oracle `updatedAt` stale → respins, state-ul NU e refresh-uit (valoarea veche rămâne);
 *   - oracle `updatedAt` viitor / zero → respins.
 * Rulează în tsx: nativePrice importă doar constants (pure) + leaf.
 */
import {
  refreshNativePrices,
  getNativePrice,
  __setNativePriceForTest,
  __getNativeStateForTest,
} from "../src/infra/nativePrice";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

// Encodează un răspuns latestRoundData(): 5 cuvinte (roundId, answer, startedAt, updatedAt, answeredInRound).
// `w` maschează la 256 biți → un answer NEGATIV devine two's-complement corect (ex. -1n → 64× 'f').
function encodeRound(answer: bigint, updatedAtSec: number): string {
  const w = (v: bigint) => (v & ((1n << 256n) - 1n)).toString(16).padStart(64, "0");
  return "0x" + w(1n) + w(answer) + w(0n) + w(BigInt(Math.trunc(updatedAtSec))) + w(1n);
}

type Route =
  | { price: number; updatedAtSec: number }
  | { answerRaw: bigint; updatedAtSec: number }   // answer brut (pentru negativ / two's-complement)
  | { rawResult: string }                          // răspuns brut (pentru ABI trunchiat/malformat)
  | "fail";
function makeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fn = async (url: unknown): Promise<Response> => {
    const u = String(url);
    calls.push(u);
    const r = routes[u];
    if (r === undefined) throw new Error("no route: " + u);
    if (r === "fail")    throw new Error("network down");
    let result: string;
    if ("rawResult" in r)      result = r.rawResult;
    else if ("answerRaw" in r) result = encodeRound(r.answerRaw, r.updatedAtSec);
    else                       result = encodeRound(BigInt(Math.round(r.price * 1e8)), r.updatedAtSec);
    return { json: async () => ({ result }) } as unknown as Response;
  };
  return { fetchImpl: fn as unknown as typeof fetch, calls: () => calls };
}

async function main(): Promise<void> {
  console.log("E25c — refreshNativePrices: oracle freshness + fallback secvențial");
  const NOW  = Date.now();            // real → getNativePrice (TTL local) vede state proaspăt
  const SEC  = NOW / 1000;

  // 1. Ethereum-only RPC → preț fresh.
  __setNativePriceForTest("ETH", null, null);
  {
    const m = makeFetch({ "eth-rpc": { price: 2500, updatedAtSec: SEC } });
    await refreshNativePrices({ fetchImpl: m.fetchImpl, env: { ALCHEMY_ETH_RPC: "eth-rpc" }, now: NOW });
    check("1. ETH-only RPC → fetch exact 1 sursă", m.calls().length === 1 && m.calls()[0] === "eth-rpc");
    check("2. ETH-only → preț fresh 2500", Math.abs((getNativePrice("ETH") ?? 0) - 2500) < 1e-6);
  }

  // 2. Base fetch fail → Arbitrum success (fallback real, ordine base→arb).
  __setNativePriceForTest("ETH", null, null);
  {
    const m = makeFetch({ "base-rpc": "fail", "arb-rpc": { price: 2600, updatedAtSec: SEC } });
    await refreshNativePrices({
      fetchImpl: m.fetchImpl,
      env: { ALCHEMY_BASE_RPC: "base-rpc", ALCHEMY_ARB_RPC: "arb-rpc" },
      now: NOW,
    });
    check("3. fallback: base încercat întâi, apoi arbitrum", m.calls()[0] === "base-rpc" && m.calls()[1] === "arb-rpc");
    check("4. fallback: preț din Arbitrum (2600)", Math.abs((getNativePrice("ETH") ?? 0) - 2600) < 1e-6);
  }

  // 3. Oracle stale (updatedAt 100h în urmă) → respins, state NU e refresh-uit.
  __setNativePriceForTest("ETH", 1234, NOW);   // valoare-santinelă prealabilă (fresh local)
  {
    const m = makeFetch({ "eth-rpc": { price: 9999, updatedAtSec: SEC - 100 * 3600 } });
    await refreshNativePrices({ fetchImpl: m.fetchImpl, env: { ALCHEMY_ETH_RPC: "eth-rpc" }, now: NOW });
    check("5. oracle stale → state neschimbat (rămâne 1234, nu 9999)", getNativePrice("ETH") === 1234);
    check("6. oracle stale → sourceUpdatedAt nu a fost suprascris", __getNativeStateForTest("ETH").sourceUpdatedAt === NOW);
  }

  // 4a. Oracle updatedAt în VIITOR → respins.
  __setNativePriceForTest("ETH", null, null);
  {
    const m = makeFetch({ "eth-rpc": { price: 8888, updatedAtSec: SEC + 3600 } });
    await refreshNativePrices({ fetchImpl: m.fetchImpl, env: { ALCHEMY_ETH_RPC: "eth-rpc" }, now: NOW });
    check("7. oracle viitor → respins (getNativePrice null)", getNativePrice("ETH") === null);
  }
  // 4b. Oracle updatedAt == 0 (round gol/necompletat) → respins.
  __setNativePriceForTest("ETH", null, null);
  {
    const m = makeFetch({ "eth-rpc": { price: 7777, updatedAtSec: 0 } });
    await refreshNativePrices({ fetchImpl: m.fetchImpl, env: { ALCHEMY_ETH_RPC: "eth-rpc" }, now: NOW });
    check("8. oracle updatedAt 0 → respins (null)", getNativePrice("ETH") === null);
  }

  // 5. Toate sursele configurate eșuează → state rămâne santinela veche (degradare doar prin TTL local).
  __setNativePriceForTest("ETH", 4321, NOW);
  {
    const m = makeFetch({ "base-rpc": "fail", "arb-rpc": "fail" });
    await refreshNativePrices({
      fetchImpl: m.fetchImpl,
      env: { ALCHEMY_BASE_RPC: "base-rpc", ALCHEMY_ARB_RPC: "arb-rpc" },
      now: NOW,
    });
    check("9. toate sursele fail → ambele încercate", m.calls().length === 2);
    check("10. toate sursele fail → valoarea veche păstrată (4321)", getNativePrice("ETH") === 4321);
  }

  // 6. answer = -1 (int256 SIGNED) → respins, state NU e suprascris (nu ~1.16e69).
  __setNativePriceForTest("ETH", 5555, NOW);
  {
    const m = makeFetch({ "eth-rpc": { answerRaw: -1n, updatedAtSec: SEC } });
    await refreshNativePrices({ fetchImpl: m.fetchImpl, env: { ALCHEMY_ETH_RPC: "eth-rpc" }, now: NOW });
    check("11. answer -1 → respins, state neschimbat (5555, nu preț uriaș)", getNativePrice("ETH") === 5555);
  }
  // 6b. answer = 0 → respins (signedAnswer <= 0).
  __setNativePriceForTest("ETH", null, null);
  {
    const m = makeFetch({ "eth-rpc": { answerRaw: 0n, updatedAtSec: SEC } });
    await refreshNativePrices({ fetchImpl: m.fetchImpl, env: { ALCHEMY_ETH_RPC: "eth-rpc" }, now: NOW });
    check("12. answer 0 → respins (null)", getNativePrice("ETH") === null);
  }
  // 7. ABI trunchiat/malformat → respins, state păstrat.
  __setNativePriceForTest("ETH", 6666, NOW);
  {
    const m = makeFetch({ "eth-rpc": { rawResult: "0x1234" } });
    await refreshNativePrices({ fetchImpl: m.fetchImpl, env: { ALCHEMY_ETH_RPC: "eth-rpc" }, now: NOW });
    check("13. ABI trunchiat → respins, state neschimbat (6666)", getNativePrice("ETH") === 6666);
  }
  // 7b. ABI cu caracter non-hex la lungime corectă → respins.
  __setNativePriceForTest("ETH", null, null);
  {
    const bad = "0x" + "z".repeat(320);
    const m = makeFetch({ "eth-rpc": { rawResult: bad } });
    await refreshNativePrices({ fetchImpl: m.fetchImpl, env: { ALCHEMY_ETH_RPC: "eth-rpc" }, now: NOW });
    check("14. ABI non-hex (lungime OK) → respins (null)", getNativePrice("ETH") === null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
