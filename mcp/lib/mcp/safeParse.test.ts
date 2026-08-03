/**
 * lib/mcp/safeParse.test.ts — E8a (Zod la granițele de parse Redis Solana).
 *
 * Dovedește că `parseWithSchema` este fail-closed pe TREI căi: (1) raw null/gol → fallback;
 * (2) JSON sintactic invalid → fallback (ca vechiul safeJson); (3) JSON valid dar FORMĂ neconformă
 * → fallback (comportament NOU — safeJson dădea cast oarb). Pe payload valid întoarce datele cu
 * câmpurile necunoscute păstrate (`.passthrough()` = forward-compat).
 *
 * REGRESII ANCORĂ (review varu): Pool/PriceSnapshot/ObservedCandidate NU acceptă `{}` — un obiect gol
 * care altfel ar seta `found=true` în readSolanaPoolContext pică pe câmpurile-ancoră obligatorii.
 * Mover-ele trec prin SolanaMoverSchema: un câmp consumat greșit tipat → snapshot fallback.
 *
 * Import-heavy (zod + schemele) → rulat cu NODE_PATH către zod (nu leaf-pur, dar deterministic).
 * Verificat sub zod 3.25.76 ȘI 4.4.3 (versiunea hoisted în tree via porto).
 */
import { parseWithSchema } from "./safeParse";
import {
  SolanaHealthSchema, SolanaMoversSnapshotSchema, SolanaPoolSchema,
  SolanaLaunchSchema, SolanaPriceSnapshotSchema, SolanaPoolActivitySchema,
  SolanaPricePointSchema, SolanaObservedCandidateSchema,
} from "./schemas/solana";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

const FB = { __fallback__: true } as const;

// Payload-uri valide „minime dar reale" (au câmpurile-ancoră) — folosite ca bază pentru mutații.
const VALID_POOL = '{"poolAddress":"Po0l","program":"raydium"}';
const VALID_PRICE = '{"poolAddress":"P","priceInQuote":1.5,"lastUpdatedAt":1700000000000}';
const VALID_CAND = '{"poolAddress":"P","program":"raydium","sampleCount":9,"baseSymbol":null}';

function main(): void {
  console.log("E8a — parseWithSchema (fail-closed) + scheme Solana + ancore anti-`{}`");

  // --- 1. căile fail-closed ale lui parseWithSchema ---------------------------------
  check("1. raw null -> fallback (fără parse)",
    parseWithSchema(null, SolanaPoolSchema, FB) === FB);
  check("2. raw string gol -> fallback",
    parseWithSchema("", SolanaPoolSchema, FB) === FB);
  check("3. JSON sintactic invalid -> fallback",
    parseWithSchema("{not json", SolanaPoolSchema, FB) === FB);
  check("4. * sintaxă OK dar câmp consumat greșit tipat -> fallback",
    parseWithSchema('{"poolAddress":"P","program":123}', SolanaPoolSchema, FB) === FB);
  check("5. * root array -> fallback (nu obiect)",
    parseWithSchema('[1,2,3]', SolanaPoolSchema, FB) === FB);
  check("6. * root primitiv (number) -> fallback",
    parseWithSchema('42', SolanaPoolSchema, FB) === FB);
  check("7. * root JSON null -> fallback",
    parseWithSchema('null', SolanaPoolSchema, FB) === FB);

  const okPool = parseWithSchema<{ program?: string } | typeof FB>(VALID_POOL, SolanaPoolSchema, FB);
  check("8. * payload valid -> date (nu fallback)", okPool !== FB);
  check("9. * câmpul consumat e păstrat", (okPool as any).program === "raydium");
  const withExtra = parseWithSchema<any>(
    '{"poolAddress":"P","program":"orca","futureField":"keep-me"}', SolanaPoolSchema, FB);
  check("10. * passthrough păstrează câmp necunoscut", withExtra.futureField === "keep-me");

  // --- 2. ANCORE: `{}` NU trece prin schemele care setează found=true --------------
  check("11. * Pool `{}` -> fallback (ancoră poolAddress+program)",
    parseWithSchema('{}', SolanaPoolSchema, FB) === FB);
  check("12. * Pool fără poolAddress (doar program) -> fallback",
    parseWithSchema('{"program":"raydium"}', SolanaPoolSchema, FB) === FB);
  check("13. * Pool fără program (doar poolAddress) -> fallback",
    parseWithSchema('{"poolAddress":"P"}', SolanaPoolSchema, FB) === FB);

  check("14. * PriceSnapshot `{}` -> fallback (ancoră poolAddress+priceInQuote+lastUpdatedAt)",
    parseWithSchema('{}', SolanaPriceSnapshotSchema, FB) === FB);
  check("15. * PriceSnapshot fără priceInQuote -> fallback",
    parseWithSchema('{"poolAddress":"P","lastUpdatedAt":1}', SolanaPriceSnapshotSchema, FB) === FB);
  check("16. * PriceSnapshot fără lastUpdatedAt -> fallback",
    parseWithSchema('{"poolAddress":"P","priceInQuote":1.5}', SolanaPriceSnapshotSchema, FB) === FB);

  check("17. * ObservedCandidate `{}` -> fallback (ancoră poolAddress+sampleCount)",
    parseWithSchema('{}', SolanaObservedCandidateSchema, FB) === FB);
  check("18. * ObservedCandidate fără sampleCount -> fallback",
    parseWithSchema('{"poolAddress":"P"}', SolanaObservedCandidateSchema, FB) === FB);

  // Payload-uri VALIDE cu ancorele prezente -> trec (nu fallback) — dovadă că ancora nu dă fals-negativ.
  check("19. Pool valid (ancore prezente) -> date",
    parseWithSchema<any>(VALID_POOL, SolanaPoolSchema, FB) !== FB);
  check("20. PriceSnapshot valid (ancore prezente, priceUsd null) -> date",
    parseWithSchema<any>('{"poolAddress":"P","priceInQuote":1.5,"priceUsd":null,"lastUpdatedAt":1700000000000}',
      SolanaPriceSnapshotSchema, FB) !== FB);
  check("21. ObservedCandidate valid (ancore prezente, baseSymbol null) -> date",
    parseWithSchema<any>(VALID_CAND, SolanaObservedCandidateSchema, FB) !== FB);
  check("22. * PriceSnapshot lastUpdatedAt string (ancoră greșit tipată) -> fallback",
    parseWithSchema('{"poolAddress":"P","priceInQuote":1.5,"lastUpdatedAt":"soon"}', SolanaPriceSnapshotSchema, FB) === FB);

  // --- 3. MOVERS: element validat prin SolanaMoverSchema ---------------------------
  check("23. Movers valid (mover complet) -> date",
    parseWithSchema<any>(
      '{"computedAt":1,"movers":[{"poolAddress":"P","program":"raydium","priceInQuote":2,"sampleCount":5,"currentAgeSec":10,"historyStatus":"READY","knownPool":true}]}',
      SolanaMoversSnapshotSchema, FB) !== FB);
  check("24. Movers cu mover `{}` -> trece (mover n-are ancoră, doar strict-când-prezent)",
    parseWithSchema<any>('{"computedAt":1,"movers":[{}]}', SolanaMoversSnapshotSchema, FB) !== FB);
  check("25. * Movers cu mover priceInQuote greșit tipat (string) -> snapshot fallback",
    parseWithSchema('{"computedAt":1,"movers":[{"priceInQuote":"nope"}]}', SolanaMoversSnapshotSchema, FB) === FB);
  check("26. * Movers cu mover poolAddress greșit tipat (number) -> snapshot fallback",
    parseWithSchema('{"movers":[{"poolAddress":123}]}', SolanaMoversSnapshotSchema, FB) === FB);
  check("27. * Movers cu mover historyStatus invalid -> snapshot fallback",
    parseWithSchema('{"movers":[{"historyStatus":"BOGUS"}]}', SolanaMoversSnapshotSchema, FB) === FB);
  check("28. * Movers movers=string -> fallback (nu array)",
    parseWithSchema('{"movers":"nope"}', SolanaMoversSnapshotSchema, FB) === FB);
  check("29. * Movers element non-obiect -> fallback",
    parseWithSchema('{"movers":[1,2]}', SolanaMoversSnapshotSchema, FB) === FB);

  // --- 4. Health / Launch / Activity / PricePoint (neschimbate de review) ----------
  check("30. Health updatedAt number OK",
    parseWithSchema<any>('{"updatedAt":1700000000000,"status":"OK"}', SolanaHealthSchema, FB) !== FB);
  check("31. Health updatedAt string OK (legacy)",
    parseWithSchema<any>('{"updatedAt":"2026-01-01"}', SolanaHealthSchema, FB) !== FB);
  check("32. * Health updatedAt boolean -> fallback",
    parseWithSchema('{"updatedAt":true}', SolanaHealthSchema, FB) === FB);
  check("33. Health gol {} OK (fără ancoră — health nu setează found)",
    parseWithSchema<any>('{}', SolanaHealthSchema, FB) !== FB);

  check("34. Launch valid OK",
    parseWithSchema<any>('{"symbol":"BONK","bondingCurveAddress":"Bc1"}', SolanaLaunchSchema, FB) !== FB);
  check("35. * Launch symbol=number -> fallback",
    parseWithSchema('{"symbol":7}', SolanaLaunchSchema, FB) === FB);

  check("36. Activity sampledQuoteIn5m string OK (BigInt-as-string)",
    parseWithSchema<any>('{"sampledSwaps5m":3,"sampledQuoteIn5m":"12345678901234567890"}', SolanaPoolActivitySchema, FB) !== FB);
  check("37. * Activity sampledQuoteIn5m number -> fallback (trebuie string)",
    parseWithSchema('{"sampledQuoteIn5m":123}', SolanaPoolActivitySchema, FB) === FB);

  check("38. PricePoint {p,ts} valid OK",
    parseWithSchema<any>('{"p":1.23,"ts":1700000000000}', SolanaPricePointSchema, FB) !== FB);
  check("39. * PricePoint fără p -> fallback (strict)",
    parseWithSchema('{"ts":1700000000000}', SolanaPricePointSchema, FB) === FB);
  check("40. * PricePoint p=string -> fallback",
    parseWithSchema('{"p":"1.23","ts":1}', SolanaPricePointSchema, FB) === FB);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
