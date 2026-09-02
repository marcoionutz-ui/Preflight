/**
 * @preflight/config-env — engine.test.ts (PH-12 12.2b, motor generic pur).
 * Rulează: `tsx scripts/engine.test.ts`. Testează mecanica GENERICĂ (field-runner, surplus sortat, uniune
 * discriminată, validatoare de formă) cu un rol SINTETIC — independent de specs-urile MCP/worker.
 */
import {
  validateEnv, runFieldSpecs, detectUnexpected, formatEnvValidation,
  absoluteUrl, redisUrl, nonEmpty, nonNegativeInt, boolFlag, flagMustBeOffInProd, unknownCsvTokens, csvKnownTokens, present, isProd,
  type FieldSpec, type EnvSnapshot, type EnvValidation,
} from "../src/engine";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

// rol sintetic: A obligatoriu mereu (URL), B obligatoriu doar în prod, C opțional (redis)
const FIELDS: FieldSpec[] = [
  { name: "A_URL",   required: () => true,        validate: absoluteUrl("A_URL") },
  { name: "B_PROD",  required: (prod) => prod,    validate: nonEmpty },
  { name: "C_REDIS", required: () => false,       validate: redisUrl() },
];
const PREFIXES = ["WORKER_", "OTHER_"];

function dev(over: EnvSnapshot = {}): EnvSnapshot {
  return { NODE_ENV: "development", A_URL: "https://a.tld", ...over };
}
function prod(over: EnvSnapshot = {}): EnvSnapshot {
  return { NODE_ENV: "production", A_URL: "https://a.tld", B_PROD: "x", ...over };
}
function pnames(v: EnvValidation): string[] { return v.ok ? [] : v.problems.map((p) => p.name); }
function wnames(v: EnvValidation): string[] { return v.warnings.map((w) => w.name); }

function main(): void {
console.log("PH-12 12.2b — config-env engine (generic, pur)");

// ── helpers de bază ────────────────────────────────────────────────────────────────
check("1. isProd: production → true; altele → false", isProd({ NODE_ENV: "production" }) && !isProd({ NODE_ENV: "development" }) && !isProd({}));
check("2. present: '' / '  ' / undefined → false; 'x' → true",
  !present("") && !present("   ") && !present(undefined) && present("x"));

// ── happy paths + uniune discriminată ──────────────────────────────────────────────
check("3. ⭐⭐⭐ dev complet valid → ok", validateEnv("syn", FIELDS, PREFIXES, dev()).ok === true);
check("4. ⭐⭐⭐ prod complet valid → ok", validateEnv("syn", FIELDS, PREFIXES, prod()).ok === true);
check("5. ⭐ ok NU poartă `problems` (uniune discriminată)", (() => {
  const v = validateEnv("syn", FIELDS, PREFIXES, dev());
  return v.ok === true && !("problems" in v);
})());
check("6. ⭐ role propagat în rezultat", validateEnv("syn", FIELDS, PREFIXES, dev()).role === "syn");

// ── required per mediu ─────────────────────────────────────────────────────────────
check("7. ⭐⭐⭐ A_URL lipsă în dev → problem missing", (() => {
  const v = validateEnv("syn", FIELDS, PREFIXES, dev({ A_URL: undefined }));
  return v.ok === false && v.problems.some((p) => p.name === "A_URL" && p.kind === "missing");
})());
check("8. ⭐⭐⭐ B_PROD lipsă în PROD → problem missing", (() => {
  const v = validateEnv("syn", FIELDS, PREFIXES, prod({ B_PROD: undefined }));
  return v.ok === false && v.problems.some((p) => p.name === "B_PROD" && p.kind === "missing");
})());
check("9. ⭐⭐⭐ B_PROD lipsă în DEV → ok (opțional în dev)", validateEnv("syn", FIELDS, PREFIXES, dev()).ok === true);

// ── validare de formă ──────────────────────────────────────────────────────────────
check("10. ⭐⭐ A_URL non-URL → invalid", (() => {
  const v = validateEnv("syn", FIELDS, PREFIXES, dev({ A_URL: "nope" }));
  return v.ok === false && v.problems.some((p) => p.name === "A_URL" && p.kind === "invalid");
})());
check("11. ⭐⭐ A_URL http în PROD → invalid; http în DEV → ok", (() => {
  const vp = validateEnv("syn", FIELDS, PREFIXES, prod({ A_URL: "http://a.tld" }));
  const vd = validateEnv("syn", FIELDS, PREFIXES, dev({ A_URL: "http://a.tld" }));
  return vp.ok === false && vd.ok === true;
})());
check("12. ⭐⭐ C_REDIS (opțional) malformat prezent → warning, NU problem", (() => {
  const v = validateEnv("syn", FIELDS, PREFIXES, dev({ C_REDIS: "http://x" }));
  return v.ok === true && wnames(v).includes("C_REDIS");
})());
check("13. ⭐⭐ C_REDIS rediss:// → ok, fără warning", (() => {
  const v = validateEnv("syn", FIELDS, PREFIXES, dev({ C_REDIS: "rediss://h:6379" }));
  return v.ok === true && !wnames(v).includes("C_REDIS");
})());
check("14. redisUrl schemă greșită → detaliu; rediss ok", redisUrl()("http://h", false) !== null && redisUrl()("rediss://h:1", false) === null);
check("15. nonNegativeInt: '8080'/'0'/'007' ok; '-1'/'x'/'1.5' → detaliu",
  nonNegativeInt("P")("8080", false) === null && nonNegativeInt("P")("0", false) === null && nonNegativeInt("P")("007", false) === null
  && nonNegativeInt("P")("-1", false) !== null && nonNegativeInt("P")("x", false) !== null && nonNegativeInt("P")("1.5", false) !== null);
check("15b. ⭐⭐⭐ nonNegativeInt HARDENED (fix cgpt): respinge 1e3/0x10/float-care-rotunjește/peste-sigur", (() => {
  const nn = nonNegativeInt("P");
  return nn("1e3", false) !== null          // exponent (parseInt(...,10) → 1, nu 1000)
    && nn("0x10", false) !== null           // hex
    && nn("1.0000000000000001", false) !== null  // zecimală care Number-rotunjește la 1
    && nn("9007199254740993", false) !== null    // > MAX_SAFE_INTEGER (rotunjire)
    && nn(" 42 ", false) === null;          // trim aplicat, valid
})());
check("16. nonEmpty pe valoare prezentă → null", nonEmpty("anything", false) === null);

// ── "" == absent ───────────────────────────────────────────────────────────────────
check("17. ⭐⭐⭐ A_URL = \"\" → missing (nu invalid)", (() => {
  const v = validateEnv("syn", FIELDS, PREFIXES, dev({ A_URL: "" }));
  return v.ok === false && v.problems.some((p) => p.name === "A_URL" && p.kind === "missing");
})());

// ── surplus sortat + determinism ────────────────────────────────────────────────────
check("18. ⭐⭐⭐ prefixe de alt rol → warnings, env rămâne ok", (() => {
  const v = validateEnv("syn", FIELDS, PREFIXES, dev({ WORKER_X: "1", OTHER_Y: "2" }));
  const w = wnames(v);
  return v.ok === true && w.includes("WORKER_X") && w.includes("OTHER_Y");
})());
check("19. ⭐⭐⭐ surplus ORDINE deterministă (sortată) indiferent de inserție", (() => {
  const v = validateEnv("syn", FIELDS, PREFIXES, dev({ WORKER_Z: "1", OTHER_A: "1", WORKER_A: "1", OTHER_Z: "1" }));
  const surplus = wnames(v).filter((n) => n.startsWith("WORKER_") || n.startsWith("OTHER_"));
  return JSON.stringify(surplus) === JSON.stringify([...surplus].sort());
})());
check("20. ⭐⭐ surplus setat la \"\" → NU warned (present check)", (() => {
  const v = validateEnv("syn", FIELDS, PREFIXES, dev({ WORKER_X: "" }));
  return v.ok === true && !wnames(v).includes("WORKER_X");
})());
check("21. ⭐ variabilă necunoscută non-prefix (FOO) → NU warned (fără allowlist strictă)", (() => {
  const v = validateEnv("syn", FIELDS, PREFIXES, dev({ FOO: "bar" }));
  return v.ok === true && !wnames(v).includes("FOO");
})());
check("22. ⭐ warnings de câmp ÎNAINTE de surplus (ordine: catalog apoi sortat)", (() => {
  const v = validateEnv("syn", FIELDS, PREFIXES, dev({ C_REDIS: "bad", WORKER_A: "1" }));
  const names = wnames(v);
  return names.indexOf("C_REDIS") >= 0 && names.indexOf("C_REDIS") < names.indexOf("WORKER_A");
})());

// ── colectare + primitive expuse ────────────────────────────────────────────────────
check("23. ⭐⭐⭐ mai multe probleme → TOATE colectate (nu short-circuit)", (() => {
  const v = validateEnv("syn", FIELDS, PREFIXES, prod({ A_URL: undefined, B_PROD: undefined }));
  return v.ok === false && pnames(v).includes("A_URL") && pnames(v).includes("B_PROD");
})());
check("24. runFieldSpecs direct: A lipsă → 1 problem, 0 warning (dev)", (() => {
  const r = runFieldSpecs(FIELDS, { NODE_ENV: "development" }, false);
  return r.problems.length === 1 && r.problems[0].name === "A_URL" && r.warnings.length === 0;
})());
check("24b. ⭐⭐⭐ validator întoarce \"\" pe câmp OBLIGATORIU prezent → problem invalid (fix cgpt: '' ≠ succes)", (() => {
  const spec: FieldSpec[] = [{ name: "X", required: () => true, validate: () => "" }];
  const r = runFieldSpecs(spec, { X: "present" }, false);
  return r.problems.length === 1 && r.problems[0].name === "X" && r.problems[0].kind === "invalid" && r.problems[0].detail.trim() !== "";
})());
check("24c. ⭐⭐⭐ validator întoarce \"\" pe câmp OPȚIONAL prezent → warning (NU ok tăcut)", (() => {
  const spec: FieldSpec[] = [{ name: "Y", required: () => false, validate: () => "" }];
  const r = runFieldSpecs(spec, { Y: "present" }, false);
  return r.problems.length === 0 && r.warnings.length === 1 && r.warnings[0].name === "Y";
})());
check("24d. ⭐⭐ null RĂMÂNE valid (nu regresăm succesul): validator → null → 0 probleme", (() => {
  const spec: FieldSpec[] = [{ name: "Z", required: () => true, validate: () => null }];
  const r = runFieldSpecs(spec, { Z: "present" }, false);
  return r.problems.length === 0 && r.warnings.length === 0;
})());
check("25. detectUnexpected direct: doar prefixele, sortat", (() => {
  const w = detectUnexpected({ WORKER_B: "1", WORKER_A: "1", KEEP: "1" }, PREFIXES, "syn");
  return w.length === 2 && w[0].name === "WORKER_A" && w[1].name === "WORKER_B";
})());

// ── forbid / must-be-OFF-in-prod (categorie de securitate, decizie Marco 2026-09-02) ──
// câmp OPȚIONAL cu `forbid`: un flag de dev/bypass care nu are voie activ în prod.
const BYPASS: FieldSpec[] = [{ name: "DEV_BYPASS", required: () => false, forbid: flagMustBeOffInProd("DEV_BYPASS") }];
function pkind(v: EnvValidation, name: string): string | undefined {
  return v.ok ? undefined : v.problems.find((p) => p.name === name)?.kind;
}

check("28. ⭐⭐⭐ forbid: flag truthy în PROD → problem kind 'forbidden' (boot crapă)", (() => {
  const v = validateEnv("syn", BYPASS, [], { NODE_ENV: "production", DEV_BYPASS: "1" });
  return v.ok === false && pkind(v, "DEV_BYPASS") === "forbidden";
})());
check("29. ⭐⭐⭐ forbid e PROBLEM chiar dacă câmpul e OPȚIONAL (NU warning)", (() => {
  const v = validateEnv("syn", BYPASS, [], { NODE_ENV: "production", DEV_BYPASS: "true" });
  return v.ok === false && !wnames(v).includes("DEV_BYPASS");
})());
check("30. ⭐⭐⭐ forbid: OFF explicit în prod ('0'/'false'/'off') → ok (dezactivare intenționată permisă)", (() => {
  return validateEnv("syn", BYPASS, [], { NODE_ENV: "production", DEV_BYPASS: "0" }).ok === true
    && validateEnv("syn", BYPASS, [], { NODE_ENV: "production", DEV_BYPASS: "false" }).ok === true
    && validateEnv("syn", BYPASS, [], { NODE_ENV: "production", DEV_BYPASS: "off" }).ok === true;
})());
check("31. ⭐⭐⭐ forbid: absent în prod → ok (categoria e „OFF SAU absent\")", validateEnv("syn", BYPASS, [], { NODE_ENV: "production" }).ok === true);
check("32. ⭐⭐⭐ forbid: truthy în DEV → ok (dev-ul folosește bypass-ul legitim)", validateEnv("syn", BYPASS, [], { NODE_ENV: "development", DEV_BYPASS: "1" }).ok === true);
check("33. ⭐⭐⭐ forbid FAIL-LOUD: gunoi/typo în prod ('treu') → forbidden (nu tratat tăcut ca off)", (() => {
  const v = validateEnv("syn", BYPASS, [], { NODE_ENV: "production", DEV_BYPASS: "treu" });
  return v.ok === false && pkind(v, "DEV_BYPASS") === "forbidden";
})());
check("34. forbid direct (runFieldSpecs): prod truthy → 1 problem forbidden, 0 warning", (() => {
  const r = runFieldSpecs(BYPASS, { DEV_BYPASS: "yes" }, true);
  return r.problems.length === 1 && r.problems[0].kind === "forbidden" && r.warnings.length === 0;
})());
check("35. ⭐ forbidden apare în formatEnvValidation (✗ + nume)", (() => {
  const s = formatEnvValidation(validateEnv("syn", BYPASS, [], { NODE_ENV: "production", DEV_BYPASS: "1" }));
  return /✗/.test(s) && /DEV_BYPASS/.test(s) && /forbidden/.test(s);
})());

// ── boolFlag (validare de formă pt. toggle-uri opționale) ─────────────────────────────
check("36. boolFlag: tokeni recunoscuți (case/trim) → null", (() =>
  boolFlag("1", false) === null && boolFlag("0", false) === null && boolFlag("TRUE", false) === null
  && boolFlag(" off ", false) === null && boolFlag("Yes", false) === null && boolFlag("NO", false) === null)());
check("37. boolFlag: token nerecunoscut → detaliu", (() =>
  boolFlag("treu", false) !== null && boolFlag("2", false) !== null && boolFlag("enabled", false) !== null)());
check("38. ⭐⭐ boolFlag ca validate pe câmp OPȚIONAL → present+bad → warning (nu problem)", (() => {
  const spec: FieldSpec[] = [{ name: "TOGGLE", required: () => false, validate: boolFlag }];
  const r = runFieldSpecs(spec, { TOGGLE: "treu" }, false);
  return r.problems.length === 0 && r.warnings.length === 1 && r.warnings[0].name === "TOGGLE";
})());

// ── csvKnownTokens / unknownCsvTokens (liste de chain, 12.2c-1) ───────────────────────
// worker-style: normalize = identitate, ids literale (eth NU → ethereum; id-ul e bsc).
const CHAINS = ["base", "arbitrum", "bsc", "ethereum"] as const;
// MCP-style: replica EXACTĂ a `normalizeChainId` din @preflight/schema — mapează DOAR eth→ethereum, restul pass-through
// (verificat în schema/src/index.ts: `c === "eth" ? "ethereum" : c`). `bnb` NU → `bsc` (canonic e `bsc`).
const norm = (s: string): string => (s === "eth" ? "ethereum" : s);

check("39. ⭐⭐⭐ worker-style: 'base,arbitrum' → 0 necunoscute", unknownCsvTokens("base,arbitrum", CHAINS).length === 0);
check("40. ⭐⭐⭐ worker-style: 'base,bnb' → 'bnb' necunoscut (canonic e bsc; nici worker nici normalizeChainId nu mapează bnb)", (() => {
  const u = unknownCsvTokens("base,bnb", CHAINS);
  return u.length === 1 && u[0] === "bnb";
})());
check("41. ⭐⭐ worker-style: ' base , ARBITRUM ' (spații+case) → trim+lower → 0 necunoscute", unknownCsvTokens(" base , ARBITRUM ", CHAINS).length === 0);
check("42. ⭐⭐ token gol ('base,,arbitrum') sărit → 0 necunoscute (dropat tăcut de consumatori)", unknownCsvTokens("base,,arbitrum", CHAINS).length === 0);
check("43. ⭐⭐ dedup: 'base,base,foo,foo' → ['foo'] o singură dată", (() => {
  const u = unknownCsvTokens("base,base,foo,foo", CHAINS);
  return u.length === 1 && u[0] === "foo";
})());
check("44. ⭐⭐⭐ normalizeChainId REAL (fix cgpt): 'eth,bnb' → doar 'bnb' necunoscut (eth→ethereum; bnb NU → bsc)", (() => {
  const u = unknownCsvTokens("eth,bnb", CHAINS, norm);
  return u.length === 1 && u[0] === "bnb";
})());
check("45. ⭐⭐⭐ MCP-style normalize: 'eth,foo' → doar 'foo' necunoscut", (() => {
  const u = unknownCsvTokens("eth,foo", CHAINS, norm);
  return u.length === 1 && u[0] === "foo";
})());
check("46. ⭐⭐⭐ PARITATE rol: 'eth' e necunoscut worker-style DAR cunoscut MCP-style (singura diferență reală = eth)", (() => {
  return unknownCsvTokens("eth", CHAINS).length === 1 && unknownCsvTokens("eth", CHAINS, norm).length === 0;
})());
check("47. ⭐⭐ csvKnownTokens: toate cunoscute → null; necunoscut → detaliu cu numărul + opțiunile permise", (() => {
  const v = csvKnownTokens("ENABLED_CHAINS", CHAINS);
  const msg = v("base,foo", false) ?? "";
  return v("base,arbitrum", false) === null && msg.includes("ENABLED_CHAINS") && msg.includes("base/arbitrum/bsc/ethereum");
})());
check("48. ⭐⭐⭐ csvKnownTokens NU ecouă VALOAREA din env în mesaj (fix cgpt: anti-leak în boot-log)", (() => {
  const v = csvKnownTokens("ENABLED_CHAINS", CHAINS);
  const msg = v("base,sup3rs3cr3t_t0ken", false) ?? "";
  return msg !== "" && !msg.includes("sup3rs3cr3t") && /1 token/.test(msg); // raportează 1 necunoscut, fără să-l afișeze
})());
check("49. ⭐⭐⭐ csvKnownTokens ca validate pe câmp OPȚIONAL → present+necunoscut → warning (nu problem)", (() => {
  const spec: FieldSpec[] = [{ name: "ENABLED_CHAINS", required: () => false, validate: csvKnownTokens("ENABLED_CHAINS", CHAINS) }];
  const r = runFieldSpecs(spec, { ENABLED_CHAINS: "base,foo" }, false);
  return r.problems.length === 0 && r.warnings.length === 1 && r.warnings[0].name === "ENABLED_CHAINS";
})());

// ── formatare ───────────────────────────────────────────────────────────────────────
check("26. ⭐ formatEnvValidation(ok) → „[env:syn] OK\"", formatEnvValidation(validateEnv("syn", FIELDS, PREFIXES, dev())).includes("[env:syn] OK"));
check("27. ⭐ formatEnvValidation(fail) listează câmpul + FAIL", (() => {
  const s = formatEnvValidation(validateEnv("syn", FIELDS, PREFIXES, dev({ A_URL: undefined })));
  return /FAIL/.test(s) && /A_URL/.test(s);
})());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
