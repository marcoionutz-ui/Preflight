/**
 * scripts/envSchema.test.ts — PH-12 slice 12.2c-3a (env fail-fast indexer-evm, pur).
 *
 * Rulează: `tsx scripts/envSchema.test.ts`. Verifică: REDIS_URL obligatoriu; RPC HTTP cross-field per chain ACTIV
 * (base always-on + gate `INDEXER_ENABLE_<CHAIN>=1`); vocabular flag byte-exact (`ENABLE_* → 0/1`, `DRY_RUN/SKIP →
 * true/false`, cu capcana `DRY_RUN=0` care NU dezactivează dry); numerice `Number()`-based cu prag; `""`==absent;
 * uniune discriminată; mesaje care NU ecouă valoarea.
 */
import {
  validateIndexerEvmEnv, formatEnvValidation, enabledIndexerChains, CHAIN_RPC_ENV,
  indexerEvmEnvFields, type EnvSnapshot,
} from "../src/config/envSchema";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

/** Env MINIM valid (dev): Redis + RPC pentru base (singurul chain always-on). */
function devEnv(over: EnvSnapshot = {}): EnvSnapshot {
  return {
    NODE_ENV: "development",
    REDIS_URL: "redis://127.0.0.1:6379",
    ALCHEMY_BASE_RPC: "https://base-mainnet.g.alchemy.com/v2/key",
    ...over,
  };
}
function prodEnv(over: EnvSnapshot = {}): EnvSnapshot {
  return {
    NODE_ENV: "production",
    REDIS_URL: "rediss://redis.internal:6379",
    ALCHEMY_BASE_RPC: "https://base-mainnet.g.alchemy.com/v2/key",
    ...over,
  };
}
function problemNames(v: ReturnType<typeof validateIndexerEvmEnv>): string[] {
  return v.ok ? [] : v.problems.map((p) => p.name);
}
function warningNames(v: ReturnType<typeof validateIndexerEvmEnv>): string[] {
  return v.warnings.map((w) => w.name);
}

function main(): void {
console.log("PH-12 12.2c-3a — validateIndexerEvmEnv (env fail-fast indexer-evm, pur)");

// ── happy paths ──────────────────────────────────────────────────────────────────
check("1. ⭐⭐⭐ dev minim valid (Redis + base RPC) → ok", validateIndexerEvmEnv(devEnv()).ok === true);
check("2. ⭐⭐⭐ prod minim valid → ok", validateIndexerEvmEnv(prodEnv()).ok === true);
check("3. ⭐ ok NU poartă cheia `problems` (uniune discriminată)", (() => {
  const v = validateIndexerEvmEnv(devEnv());
  return v.ok === true && !("problems" in v);
})());

// ── REDIS_URL obligatoriu ──────────────────────────────────────────────────────────
check("4. ⭐⭐⭐ REDIS_URL lipsă → problem missing", (() => {
  const v = validateIndexerEvmEnv(devEnv({ REDIS_URL: undefined }));
  return v.ok === false && v.problems.some((p) => p.name === "REDIS_URL" && p.kind === "missing");
})());
check("5. ⭐⭐ REDIS_URL = \"\" → missing (nu invalid)", (() => {
  const v = validateIndexerEvmEnv(devEnv({ REDIS_URL: "" }));
  return v.ok === false && v.problems.some((p) => p.name === "REDIS_URL" && p.kind === "missing");
})());
check("6. ⭐⭐ REDIS_URL schemă greșită (http://) → invalid", (() => {
  const v = validateIndexerEvmEnv(devEnv({ REDIS_URL: "http://x:6379" }));
  return v.ok === false && v.problems.some((p) => p.name === "REDIS_URL" && p.kind === "invalid");
})());

// ── RPC cross-field: base always-on ────────────────────────────────────────────────
check("7. ⭐⭐⭐ ALCHEMY_BASE_RPC lipsă → problem missing (base e MEREU activ)", (() => {
  const v = validateIndexerEvmEnv(devEnv({ ALCHEMY_BASE_RPC: undefined }));
  return v.ok === false && v.problems.some((p) => p.name === "ALCHEMY_BASE_RPC" && p.kind === "missing");
})());
check("8. ⭐⭐ ALCHEMY_BASE_RPC non-URL → invalid", (() => {
  const v = validateIndexerEvmEnv(devEnv({ ALCHEMY_BASE_RPC: "not-a-url" }));
  return v.ok === false && v.problems.some((p) => p.name === "ALCHEMY_BASE_RPC" && p.kind === "invalid");
})());
check("9. ⭐⭐ ALCHEMY_BASE_RPC http în PROD → invalid (https obligatoriu); http în DEV → ok", (() => {
  const vp = validateIndexerEvmEnv(prodEnv({ ALCHEMY_BASE_RPC: "http://base.local" }));
  const vd = validateIndexerEvmEnv(devEnv({ ALCHEMY_BASE_RPC: "http://base.local" }));
  return vp.ok === false && vp.problems.some((p) => p.name === "ALCHEMY_BASE_RPC") && vd.ok === true;
})());

// ── RPC cross-field: chain gated → RPC devine obligatoriu DOAR când chain-ul e activ ──
check("10. ⭐⭐⭐ INDEXER_ENABLE_BSC=1 fără ALCHEMY_BNB_RPC → problem missing (naming bsc→BNB)", (() => {
  const v = validateIndexerEvmEnv(devEnv({ INDEXER_ENABLE_BSC: "1" }));
  return v.ok === false && v.problems.some((p) => p.name === "ALCHEMY_BNB_RPC" && p.kind === "missing");
})());
check("11. ⭐⭐⭐ bsc NEACTIVAT → ALCHEMY_BNB_RPC absent NU e cerut → ok", (() => {
  const v = validateIndexerEvmEnv(devEnv()); // fără INDEXER_ENABLE_BSC
  return v.ok === true && !problemNames(v).includes("ALCHEMY_BNB_RPC");
})());
check("12. ⭐⭐⭐ INDEXER_ENABLE_BSC=1 + ALCHEMY_BNB_RPC valid → ok", (() => {
  const v = validateIndexerEvmEnv(devEnv({ INDEXER_ENABLE_BSC: "1", ALCHEMY_BNB_RPC: "https://bnb.g.alchemy.com/v2/k" }));
  return v.ok === true;
})());
check("13. ⭐⭐ INDEXER_ENABLE_ARBITRUM=1 → ALCHEMY_ARB_RPC obligatoriu; ETHEREUM=1 → ALCHEMY_ETH_RPC obligatoriu", (() => {
  const va = validateIndexerEvmEnv(devEnv({ INDEXER_ENABLE_ARBITRUM: "1" }));
  const ve = validateIndexerEvmEnv(devEnv({ INDEXER_ENABLE_ETHEREUM: "1" }));
  return problemNames(va).includes("ALCHEMY_ARB_RPC") && problemNames(ve).includes("ALCHEMY_ETH_RPC");
})());

// ── enabledIndexerChains ────────────────────────────────────────────────────────────
check("14. ⭐⭐⭐ enabledIndexerChains: default = ['base']; +bsc pe '1'; NU pe 'true' (byte-exact)", (() => {
  const d = enabledIndexerChains(devEnv());
  const b = enabledIndexerChains(devEnv({ INDEXER_ENABLE_BSC: "1" }));
  const t = enabledIndexerChains(devEnv({ INDEXER_ENABLE_BSC: "true" }));
  return JSON.stringify(d) === JSON.stringify(["base"]) && b.includes("bsc") && !t.includes("bsc");
})());
check("15. ⭐ CHAIN_RPC_ENV mapare completă (base→BASE, bsc→BNB, arbitrum→ARB, ethereum→ETH)",
  CHAIN_RPC_ENV.base === "ALCHEMY_BASE_RPC" && CHAIN_RPC_ENV.bsc === "ALCHEMY_BNB_RPC"
  && CHAIN_RPC_ENV.arbitrum === "ALCHEMY_ARB_RPC" && CHAIN_RPC_ENV.ethereum === "ALCHEMY_ETH_RPC");

// ── flags vocabular byte-exact: ENABLE_* (0/1) ──────────────────────────────────────
check("16. ⭐⭐⭐ INDEXER_ENABLE_BSC='true' → warning (runtime `=== \"1\"` → off tăcut; typo vizibil), ok rămâne true (fără gate RPC)", (() => {
  const v = validateIndexerEvmEnv(devEnv({ INDEXER_ENABLE_BSC: "true" }));
  return v.ok === true && warningNames(v).includes("INDEXER_ENABLE_BSC");
})());
check("17. ⭐⭐⭐ INDEXER_ENABLE_BSC=' 1 ' (spații) → warning (runtime compară BRUT, ' 1 ' !== '1')", (() => {
  const v = validateIndexerEvmEnv(devEnv({ INDEXER_ENABLE_BSC: " 1 " }));
  return v.ok === true && warningNames(v).includes("INDEXER_ENABLE_BSC");
})());
check("18. ⭐⭐ INDEXER_ENABLE_BSC='0' → ok, fără warning (dezactivare intenționată)", (() => {
  const v = validateIndexerEvmEnv(devEnv({ INDEXER_ENABLE_BSC: "0" }));
  return v.ok === true && !warningNames(v).includes("INDEXER_ENABLE_BSC");
})());
check("19. ⭐⭐ INDEXER_ENABLE_V4='1'/'0' → ok fără warning; ='yes' → warning", (() => {
  const on  = validateIndexerEvmEnv(devEnv({ INDEXER_ENABLE_V4: "1" }));
  const off = validateIndexerEvmEnv(devEnv({ INDEXER_ENABLE_V4: "0" }));
  const bad = validateIndexerEvmEnv(devEnv({ INDEXER_ENABLE_V4: "yes" }));
  return on.ok === true && !warningNames(on).includes("INDEXER_ENABLE_V4")
    && off.ok === true && !warningNames(off).includes("INDEXER_ENABLE_V4")
    && warningNames(bad).includes("INDEXER_ENABLE_V4");
})());

// ── flags vocabular byte-exact: DRY_RUN/SKIP (true/false) + capcana DRY_RUN=0 ─────────
check("20. ⭐⭐⭐ CAPCANĂ: INDEXER_DRY_RUN='0' → warning (runtime `!== \"false\"` → tot DRY; '0' NU e write)", (() => {
  const v = validateIndexerEvmEnv(devEnv({ INDEXER_DRY_RUN: "0" }));
  return v.ok === true && warningNames(v).includes("INDEXER_DRY_RUN");
})());
check("21. ⭐⭐ INDEXER_DRY_RUN='false' (write) / 'true' (dry) → ok fără warning", (() => {
  const w = validateIndexerEvmEnv(devEnv({ INDEXER_DRY_RUN: "false" }));
  const d = validateIndexerEvmEnv(devEnv({ INDEXER_DRY_RUN: "true" }));
  return w.ok === true && !warningNames(w).includes("INDEXER_DRY_RUN")
    && d.ok === true && !warningNames(d).includes("INDEXER_DRY_RUN");
})());
check("22. ⭐⭐ INDEXER_SKIP_TO_LATEST='1' → warning (runtime `=== \"true\"`); ='true' → ok", (() => {
  const bad = validateIndexerEvmEnv(devEnv({ INDEXER_SKIP_TO_LATEST: "1" }));
  const ok  = validateIndexerEvmEnv(devEnv({ INDEXER_SKIP_TO_LATEST: "true" }));
  return warningNames(bad).includes("INDEXER_SKIP_TO_LATEST") && !warningNames(ok).includes("INDEXER_SKIP_TO_LATEST");
})());

// ── numerice Number()-based cu prag ─────────────────────────────────────────────────
check("23. ⭐⭐⭐ INDEXER_METADATA_RPC_TIMEOUT_MS='abc' → warning; '1e3' → ok (Number acceptă exponent, ca runtime)", (() => {
  const bad = validateIndexerEvmEnv(devEnv({ INDEXER_METADATA_RPC_TIMEOUT_MS: "abc" }));
  const ok  = validateIndexerEvmEnv(devEnv({ INDEXER_METADATA_RPC_TIMEOUT_MS: "1e3" }));
  return warningNames(bad).includes("INDEXER_METADATA_RPC_TIMEOUT_MS") && ok.ok === true
    && !warningNames(ok).includes("INDEXER_METADATA_RPC_TIMEOUT_MS");
})());
check("24. ⭐⭐⭐ INDEXER_CONFIRMATION_DEPTH='0' → ok (0 = dezactivat, gte); '-1' → warning", (() => {
  const zero = validateIndexerEvmEnv(devEnv({ INDEXER_CONFIRMATION_DEPTH: "0" }));
  const neg  = validateIndexerEvmEnv(devEnv({ INDEXER_CONFIRMATION_DEPTH: "-1" }));
  return zero.ok === true && !warningNames(zero).includes("INDEXER_CONFIRMATION_DEPTH")
    && warningNames(neg).includes("INDEXER_CONFIRMATION_DEPTH");
})());
check("25. ⭐⭐ INDEXER_CONFIRMATION_DEPTH_BSC (override per-chain) validat DOAR când bsc e activ", (() => {
  // bsc inactiv → override-ul per-chain nu e în câmpuri → nu se validează (nici warning)
  const inactive = validateIndexerEvmEnv(devEnv({ INDEXER_CONFIRMATION_DEPTH_BSC: "-9" }));
  // bsc activ (+ RPC) → override invalid → warning
  const active   = validateIndexerEvmEnv(devEnv({ INDEXER_ENABLE_BSC: "1", ALCHEMY_BNB_RPC: "https://b.g.alchemy.com/v2/k", INDEXER_CONFIRMATION_DEPTH_BSC: "-9" }));
  return !warningNames(inactive).includes("INDEXER_CONFIRMATION_DEPTH_BSC")
    && warningNames(active).includes("INDEXER_CONFIRMATION_DEPTH_BSC");
})());

// ── colectare + formatare + anti-leak ───────────────────────────────────────────────
check("26. ⭐⭐ mai multe probleme colectate (Redis + base RPC lipsă)", (() => {
  const v = validateIndexerEvmEnv(devEnv({ REDIS_URL: undefined, ALCHEMY_BASE_RPC: undefined }));
  return v.ok === false && problemNames(v).includes("REDIS_URL") && problemNames(v).includes("ALCHEMY_BASE_RPC");
})());
check("27. ⭐ formatEnvValidation(ok) → „[env:indexer-evm] OK\"", formatEnvValidation(validateIndexerEvmEnv(devEnv())).includes("[env:indexer-evm] OK"));
check("28. ⭐⭐ mesajele NU ecouă valoarea (flag='s3cr3t' → nu apare în output)", (() => {
  const s = formatEnvValidation(validateIndexerEvmEnv(devEnv({ INDEXER_ENABLE_BSC: "s3cr3t" })));
  return !/s3cr3t/.test(s) && /INDEXER_ENABLE_BSC/.test(s);
})());
check("29. ⭐ câmpurile derivate: base activ → exact 1 RPC obligatoriu (ALCHEMY_BASE_RPC)", (() => {
  const required = indexerEvmEnvFields(devEnv()).filter((f) => f.required(false) && f.name.startsWith("ALCHEMY_"));
  return required.length === 1 && required[0].name === "ALCHEMY_BASE_RPC";
})());

// ── fix cgpt #1: RPC cu credențiale în URL → invalid (Request/fetch le respinge) ─────
check("30. ⭐⭐⭐ ALCHEMY_BASE_RPC='https://user:pass@rpc.test' → problem invalid (credențiale în URL)", (() => {
  const v = validateIndexerEvmEnv(devEnv({ ALCHEMY_BASE_RPC: "https://user:pass@rpc.example.test" }));
  return v.ok === false && v.problems.some((p) => p.name === "ALCHEMY_BASE_RPC" && p.kind === "invalid");
})());
check("31. ⭐⭐ doar username (fără parolă) în RPC → tot invalid", (() => {
  const v = validateIndexerEvmEnv(devEnv({ ALCHEMY_BASE_RPC: "https://token@rpc.example.test" }));
  return v.ok === false && v.problems.some((p) => p.name === "ALCHEMY_BASE_RPC" && p.kind === "invalid");
})());
check("32. ⭐⭐⭐ mesajul de credențiale NU ecouă valoarea (parola 'pass' nu apare în output)", (() => {
  const s = formatEnvValidation(validateIndexerEvmEnv(devEnv({ ALCHEMY_BASE_RPC: "https://user:s3cr3tpass@rpc.example.test" })));
  return !/s3cr3tpass/.test(s) && /ALCHEMY_BASE_RPC/.test(s);
})());
check("33. ⭐⭐ RPC valid FĂRĂ credențiale (path/query cu key e ok) → ok", (() => {
  const v = validateIndexerEvmEnv(devEnv({ ALCHEMY_BASE_RPC: "https://base-mainnet.g.alchemy.com/v2/my-api-key" }));
  return v.ok === true;
})());

// ── fix cgpt #2: INDEXER_RPC_TIMEOUT_MS (parseInt-based; 1e3 → 1ms înșelător) ─────────
check("34. ⭐⭐⭐ INDEXER_RPC_TIMEOUT_MS='1e3' → warning (parseInt îl taie la 1ms, NU 1000)", (() => {
  const v = validateIndexerEvmEnv(devEnv({ INDEXER_RPC_TIMEOUT_MS: "1e3" }));
  return v.ok === true && warningNames(v).includes("INDEXER_RPC_TIMEOUT_MS");
})());
check("35. ⭐⭐ INDEXER_RPC_TIMEOUT_MS='15000' → ok; '15abc'/'0'/'-1' → warning", (() => {
  const ok  = validateIndexerEvmEnv(devEnv({ INDEXER_RPC_TIMEOUT_MS: "15000" }));
  const dirty = validateIndexerEvmEnv(devEnv({ INDEXER_RPC_TIMEOUT_MS: "15abc" }));
  const zero  = validateIndexerEvmEnv(devEnv({ INDEXER_RPC_TIMEOUT_MS: "0" }));
  return ok.ok === true && !warningNames(ok).includes("INDEXER_RPC_TIMEOUT_MS")
    && warningNames(dirty).includes("INDEXER_RPC_TIMEOUT_MS") && warningNames(zero).includes("INDEXER_RPC_TIMEOUT_MS");
})());

// ── fix cgpt #2: numerice consumate de indexer, ratate inițial (Number()-based >0) ────
check("36. ⭐⭐⭐ INDEXER_ENRICH_DRAIN_CONCURRENCY='broken' → warning (runtime → default tăcut)", (() => {
  const v = validateIndexerEvmEnv(devEnv({ INDEXER_ENRICH_DRAIN_CONCURRENCY: "broken" }));
  return v.ok === true && warningNames(v).includes("INDEXER_ENRICH_DRAIN_CONCURRENCY");
})());
check("37. ⭐⭐⭐ INDEXER_REPRICE_INTERVAL_MS='broken' → warning; '30000' → ok; '3e4' → ok (Number acceptă exponent)", (() => {
  const bad = validateIndexerEvmEnv(devEnv({ INDEXER_REPRICE_INTERVAL_MS: "broken" }));
  const ok  = validateIndexerEvmEnv(devEnv({ INDEXER_REPRICE_INTERVAL_MS: "30000" }));
  const exp = validateIndexerEvmEnv(devEnv({ INDEXER_REPRICE_INTERVAL_MS: "3e4" }));
  return warningNames(bad).includes("INDEXER_REPRICE_INTERVAL_MS")
    && !warningNames(ok).includes("INDEXER_REPRICE_INTERVAL_MS") && !warningNames(exp).includes("INDEXER_REPRICE_INTERVAL_MS");
})());
check("38. ⭐⭐ INDEXER_CHAINLINK_MAX_STALE_SEC / INDEXER_SEQUENCER_GRACE_SEC (envNum) invalid → warning", (() => {
  const a = validateIndexerEvmEnv(devEnv({ INDEXER_CHAINLINK_MAX_STALE_SEC: "nope" }));
  const b = validateIndexerEvmEnv(devEnv({ INDEXER_SEQUENCER_GRACE_SEC: "-5" }));
  return warningNames(a).includes("INDEXER_CHAINLINK_MAX_STALE_SEC") && warningNames(b).includes("INDEXER_SEQUENCER_GRACE_SEC");
})());
check("39. ⭐ catalog: toate cele 17 numerice Number()-based + RPC_TIMEOUT (parseInt) + CONFIRMATION_DEPTH sunt validate", (() => {
  const names = new Set(indexerEvmEnvFields(devEnv()).map((f) => f.name));
  const expected = [
    "INDEXER_METADATA_RPC_TIMEOUT_MS", "INDEXER_REPRICE_INTERVAL_MS", "INDEXER_REPRICE_STALE_MS", "INDEXER_REPRICE_TOP_K",
    "INDEXER_REPRICE_CONCURRENCY", "INDEXER_REPRICE_BATCH", "INDEXER_ENRICH_DRAIN_CONCURRENCY", "INDEXER_ENRICH_DRAIN_BATCH",
    "INDEXER_ENRICH_DRAIN_INTERVAL_MS", "INDEXER_ENRICH_LEASE_MS", "INDEXER_ENRICH_MAX_ATTEMPTS", "INDEXER_ENRICH_REPAIR_INTERVAL_MS",
    "INDEXER_ENRICH_REPAIR_SCAN_K", "INDEXER_ENRICH_BACKOFF_BASE_MS", "INDEXER_ENRICH_BACKOFF_MAX_MS", "INDEXER_SEQUENCER_GRACE_SEC",
    "INDEXER_CHAINLINK_MAX_STALE_SEC", "INDEXER_RPC_TIMEOUT_MS", "INDEXER_CONFIRMATION_DEPTH",
  ];
  return expected.every((n) => names.has(n));
})());
check("40. ⭐⭐ happy-path NU regresează: dev minim + toate numericele valide → ok fără warnings numerice", (() => {
  const v = validateIndexerEvmEnv(devEnv({
    INDEXER_RPC_TIMEOUT_MS: "15000", INDEXER_REPRICE_INTERVAL_MS: "30000",
    INDEXER_ENRICH_DRAIN_CONCURRENCY: "4", INDEXER_CHAINLINK_MAX_STALE_SEC: "86400",
  }));
  return v.ok === true && v.warnings.length === 0;
})());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
