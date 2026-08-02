/**
 * scripts/solPriceSources.test.ts — E28 (leaf pur: parseri surse SOL/USD + validare + ordine cascadă).
 *
 * Fiecare parser primește forma REALĂ a răspunsului sursei și extrage prețul; validare comună
 * (finit & >0). Ordinea cascadei = Coinbase → Kraken → Binance. Pur → rulează în tsx.
 */
import {
  validateSolPrice,
  parseCoinbaseSol,
  parseKrakenSol,
  parseBinanceSol,
  resolveSolPriceFromSources,
  SOL_PRICE_SOURCES,
  type SolPriceSourceName,
} from "../src/infra/solPriceSources";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

// Fetch FAKE mapat pe numele sursei (rezolvă url→name via SOL_PRICE_SOURCES); numără apelurile în ordine.
type FakeResp = { status?: number; json?: any } | "throw";
function makeFetch(byName: Partial<Record<SolPriceSourceName, FakeResp>>) {
  const urlToName = new Map(SOL_PRICE_SOURCES.map(s => [s.url, s.name]));
  const calls: SolPriceSourceName[] = [];
  const fn = async (url: unknown): Promise<Response> => {
    const name = urlToName.get(String(url))!;
    calls.push(name);
    const r = byName[name];
    if (r === undefined || r === "throw") throw new Error("network fail " + name);
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => r.json } as unknown as Response;
  };
  return { fetchImpl: fn as unknown as typeof fetch, calls: () => calls };
}
// forme valide per sursă
const CB = (amt: string) => ({ json: { data: { amount: amt } } });
const KR = (px: string)  => ({ json: { error: [], result: { SOLUSD: { c: [px, "1"] } } } });
const BN = (px: string)  => ({ json: { symbol: "SOLUSDT", price: px } });

async function main(): Promise<void> {
  console.log("E28 leaf — surse SOL/USD (parseri + validare + cascadă)");

  // validateSolPrice
  check("1. number valid → number", validateSolPrice(178.42) === 178.42);
  check("2. string-number valid → number", validateSolPrice("178.42") === 178.42);
  check("3. 0 → null", validateSolPrice(0) === null);
  check("4. negativ → null", validateSolPrice(-5) === null);
  check("5. NaN → null", validateSolPrice(NaN) === null);
  check("6. Infinity → null", validateSolPrice(Infinity) === null);
  check("7. string non-numeric → null", validateSolPrice("abc") === null);
  check("8. undefined → null", validateSolPrice(undefined) === null);
  check("9. null → null", validateSolPrice(null) === null);
  check("10. string gol → null", validateSolPrice("") === null);

  // Coinbase: { data: { amount: "178.42" } }
  check("11. Coinbase valid → data.amount", parseCoinbaseSol({ data: { amount: "178.42", base: "SOL", currency: "USD" } }) === 178.42);
  check("12. Coinbase fără data → null", parseCoinbaseSol({ foo: 1 }) === null);
  check("13. Coinbase amount 0 → null", parseCoinbaseSol({ data: { amount: "0" } }) === null);
  check("14. Coinbase amount non-numeric → null", parseCoinbaseSol({ data: { amount: "n/a" } }) === null);

  // Kraken: { result: { SOLUSD: { c: ["178.45","0.001"] } } }
  check("15. Kraken valid → result.<pair>.c[0]", parseKrakenSol({ error: [], result: { SOLUSD: { c: ["178.45", "0.001"] } } }) === 178.45);
  check("16. Kraken first-key generic (alt nume pair)", parseKrakenSol({ result: { XSOLZUSD: { c: ["10.5", "1"] } } }) === 10.5);
  check("17. Kraken result gol → null", parseKrakenSol({ error: ["EQuery:Unknown asset pair"], result: {} }) === null);
  check("18. Kraken fără result → null", parseKrakenSol({ error: ["x"] }) === null);
  check("19. Kraken c lipsă → null", parseKrakenSol({ result: { SOLUSD: { a: ["1"] } } }) === null);
  check("20. Kraken c nu-i array → null", parseKrakenSol({ result: { SOLUSD: { c: "178.45" } } }) === null);
  check("21. Kraken c[0] invalid → null", parseKrakenSol({ result: { SOLUSD: { c: ["0", "1"] } } }) === null);

  // Binance: { symbol: "SOLUSDT", price: "178.42" }
  check("22. Binance valid → price", parseBinanceSol({ symbol: "SOLUSDT", price: "178.42" }) === 178.42);
  check("23. Binance fără price → null", parseBinanceSol({ symbol: "SOLUSDT" }) === null);
  check("24. Binance 451-shape (msg/code) → null", parseBinanceSol({ code: 0, msg: "..." }) === null);

  // Cascadă: ordine + fiecare are url + parse
  check("25. ordine cascadă = COINBASE, KRAKEN, BINANCE",
    SOL_PRICE_SOURCES.map(s => s.name).join(",") === "COINBASE,KRAKEN,BINANCE");
  check("26. fiecare sursă are url (https) + parse funcție",
    SOL_PRICE_SOURCES.every(s => typeof s.url === "string" && s.url.startsWith("https://") && typeof s.parse === "function"));
  check("27. Coinbase URL corect", SOL_PRICE_SOURCES[0].url.includes("api.coinbase.com/v2/prices/SOL-USD/spot"));
  check("28. Kraken URL corect", SOL_PRICE_SOURCES[1].url.includes("api.kraken.com/0/public/Ticker?pair=SOLUSD"));
  check("29. parserii cablați corect (Coinbase parsează forma Coinbase)",
    SOL_PRICE_SOURCES[0].parse({ data: { amount: "1.5" } }) === 1.5 && SOL_PRICE_SOURCES[1].parse({ result: { SOLUSD: { c: ["2.5", "1"] } } }) === 2.5);

  console.log("\nE28 leaf — resolveSolPriceFromSources (cascadă cu fetch injectat)");

  // Coinbase valid → câștigă, SE OPREȘTE după primul request.
  {
    const m = makeFetch({ COINBASE: CB("73.5"), KRAKEN: KR("70"), BINANCE: BN("71") });
    const r = await resolveSolPriceFromSources(SOL_PRICE_SOURCES, m.fetchImpl, 1000);
    check("30. Coinbase valid → {price 73.5, source COINBASE}", r?.price === 73.5 && r?.source === "COINBASE");
    check("31. Coinbase valid → EXACT 1 request (nu mai încearcă)", m.calls().length === 1 && m.calls()[0] === "COINBASE");
  }
  // Coinbase HTTP fail (451) → Kraken câștigă.
  {
    const m = makeFetch({ COINBASE: { status: 451 }, KRAKEN: KR("70.2"), BINANCE: BN("71") });
    const r = await resolveSolPriceFromSources(SOL_PRICE_SOURCES, m.fetchImpl, 1000);
    check("32. Coinbase 451 → fallback Kraken {70.2, KRAKEN}", r?.price === 70.2 && r?.source === "KRAKEN");
    check("33. ordine apeluri COINBASE→KRAKEN (2)", m.calls().join(",") === "COINBASE,KRAKEN");
  }
  // Coinbase 200-dar-INVALID (amount 0) + Kraken throw → Binance câștigă (valoarea invalidă declanșează fallback).
  {
    const m = makeFetch({ COINBASE: CB("0"), KRAKEN: "throw", BINANCE: BN("71.3") });
    const r = await resolveSolPriceFromSources(SOL_PRICE_SOURCES, m.fetchImpl, 1000);
    check("34. Coinbase invalid(0) + Kraken throw → Binance {71.3, BINANCE}", r?.price === 71.3 && r?.source === "BINANCE");
    check("35. valoarea invalidă declanșează fallback (3 apeluri)", m.calls().join(",") === "COINBASE,KRAKEN,BINANCE");
  }
  // Toate eșuează → null.
  {
    const m = makeFetch({ COINBASE: { status: 500 }, KRAKEN: "throw", BINANCE: { status: 451 } });
    const r = await resolveSolPriceFromSources(SOL_PRICE_SOURCES, m.fetchImpl, 1000);
    check("36. toate eșuează → null", r === null);
    check("37. toate cele 3 surse încercate", m.calls().length === 3);
  }
  // source corespunde EXACT sursei câștigătoare (nu prima din listă).
  {
    const m = makeFetch({ COINBASE: "throw", KRAKEN: { status: 503 }, BINANCE: BN("72") });
    const r = await resolveSolPriceFromSources(SOL_PRICE_SOURCES, m.fetchImpl, 1000);
    check("38. source = sursa REALĂ câștigătoare (BINANCE), nu COINBASE", r?.source === "BINANCE" && r?.price === 72);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
