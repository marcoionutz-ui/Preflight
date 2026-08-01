/**
 * scripts/goplusParse.test.ts — E29 (parse tax strict 0..1 + predicat retry).
 *
 * Dovedește că `parseTaxPct` respectă scala GoPlus 0..1 (fracție → procent, monoton), respinge orice în afara ei
 * (>1, negativ, non-finit) și orice tip malformat (bool/array/object/whitespace) drept `null` (necunoscut, NU 0),
 * și că `isTransientGoPlusStatus` marchează DOAR 429 + 500..599. Leaf pur → tsx.
 */
import { parseTaxPct, isTransientGoPlusStatus } from "../src/goplusParse";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

function main(): void {
  console.log("E29 — parseTaxPct (scala GoPlus 0..1, monoton) + isTransientGoPlusStatus (429/5xx)");

  // Scala 0..1 → procent.
  check("1. '0.15' -> 15%", parseTaxPct("0.15") === 15);
  check("2. '0' -> 0%", parseTaxPct("0") === 0);
  check("3. '1' -> 100% (honeypot total)", parseTaxPct("1") === 100);
  check("4. '0.99' -> 99%", parseTaxPct("0.99") === 99);
  check("5. număr 0.5 -> 50%", parseTaxPct(0.5) === 50);
  check("6. '0.1234' -> 12.34% (2 zecimale)", parseTaxPct("0.1234") === 12.34);
  check("7. '0.12345' -> 12.35% (rotunjit)", parseTaxPct("0.12345") === 12.35);

  // * În afara scalei 0..1 → null (NU ghicim; fără prag arbitrar, fără discontinuitate).
  check("8. * '1.5' -> null (peste 1, NU 1.5% și NU 150%)", parseTaxPct("1.5") === null);
  check("9. * '2' -> null", parseTaxPct("2") === null);
  check("10. * '5' -> null (nu mai e prag magic)", parseTaxPct("5") === null);
  check("11. * '-0.1' -> null (negativ)", parseTaxPct("-0.1") === null);

  // Non-finit → null.
  check("12. 'abc' -> null (NaN)", parseTaxPct("abc") === null);
  check("13. NaN -> null", parseTaxPct(NaN) === null);
  check("14. Infinity -> null", parseTaxPct(Infinity) === null);

  // * Tipuri malformate → null (NU 0 = fail-open). Number(false)/Number([])/Number(' ') ar da 0.
  check("15. * false -> null (nu 0)", parseTaxPct(false) === null);
  check("16. * true -> null", parseTaxPct(true) === null);
  check("17. * [] -> null (nu 0)", parseTaxPct([]) === null);
  check("18. * {} -> null", parseTaxPct({}) === null);
  check("19. * ' ' (whitespace) -> null (nu 0)", parseTaxPct(" ") === null);
  check("20. '' -> null", parseTaxPct("") === null);
  check("21. null -> null", parseTaxPct(null) === null);
  check("22. undefined -> null", parseTaxPct(undefined) === null);
  check("23. * niciuna din false/[]/'' nu devine 0", parseTaxPct(false) !== 0 && parseTaxPct([]) !== 0 && parseTaxPct("") !== 0);

  // isTransientGoPlusStatus: 429 + 500..599; restul nu (inclusiv >=600).
  check("24. * 429 -> retry", isTransientGoPlusStatus(429) === true);
  check("25. * 500 -> retry", isTransientGoPlusStatus(500) === true);
  check("26. 502/503/599 -> retry", isTransientGoPlusStatus(502) && isTransientGoPlusStatus(503) && isTransientGoPlusStatus(599));
  check("27. * 400 -> NU retry (permanent)", isTransientGoPlusStatus(400) === false);
  check("28. 404/499 -> NU retry", !isTransientGoPlusStatus(404) && !isTransientGoPlusStatus(499));
  check("29. 200 -> NU retry", isTransientGoPlusStatus(200) === false);
  check("30. * 600 -> NU retry (nu-i status HTTP valid)", isTransientGoPlusStatus(600) === false);

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
}

main();
