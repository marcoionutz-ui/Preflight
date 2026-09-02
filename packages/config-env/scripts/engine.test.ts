/**
 * @preflight/config-env — engine.test.ts (PH-12 12.2b, motor generic pur).
 * Rulează: `tsx scripts/engine.test.ts`. Testează mecanica GENERICĂ (field-runner, surplus sortat, uniune
 * discriminată, validatoare de formă) cu un rol SINTETIC — independent de specs-urile MCP/worker.
 */
import {
  validateEnv, runFieldSpecs, detectUnexpected, formatEnvValidation,
  absoluteUrl, redisUrl, nonEmpty, nonNegativeInt, present, isProd,
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
