/**
 * scripts/envSchema.test.ts — PH-12 12.2c-2 (schema env worker-evm, pur).
 * Rulează: `tsx scripts/envSchema.test.ts`. Testează cross-field-ul WS (chain pornit → `ALCHEMY_*_WS` obligatoriu),
 * paritatea cu filtrul `chains.ts` (default, ethereum shadow-first, id `bsc`→`ALCHEMY_BNB_WS`) și `?? ""` == lipsă.
 */
import {
  validateWorkerEvmEnv, enabledEvmChains, workerEvmEnvFields, wsEnabledForEnv, CHAIN_WS_ENV, formatEnvValidation,
  type EnvSnapshot,
} from "../src/config/envSchema";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const WS_BASE = "wss://base-mainnet.example/v2/k";
const WS_ARB  = "wss://arb-mainnet.example/v2/k";
const WS_BNB  = "wss://bnb-mainnet.example/v2/k";
const WS_ETH  = "wss://eth-mainnet.example/v2/k";

/** env cu default (base,arbitrum) + ambele WS + Redis. */
function baseEnv(over: EnvSnapshot = {}): EnvSnapshot {
  return { REDIS_URL: "rediss://r:6379", ALCHEMY_BASE_WS: WS_BASE, ALCHEMY_ARB_WS: WS_ARB, ...over };
}
function pnames(v: ReturnType<typeof validateWorkerEvmEnv>): string[] { return v.ok ? [] : v.problems.map((p) => p.name); }
function pkind(v: ReturnType<typeof validateWorkerEvmEnv>, name: string): string | undefined {
  return v.ok ? undefined : v.problems.find((p) => p.name === name)?.kind;
}
function wnames(v: ReturnType<typeof validateWorkerEvmEnv>): string[] { return v.warnings.map((w) => w.name); }

function main(): void {
console.log("PH-12 12.2c-2 — validateWorkerEvmEnv (cross-field WS, pur)");

// ── enabledEvmChains: paritate cu filtrul chains.ts ──────────────────────────────────
check("1. ⭐⭐⭐ default (fără ENABLED_CHAINS) → [base, arbitrum]", (() => {
  const c = enabledEvmChains({});
  return c.length === 2 && c.includes("base") && c.includes("arbitrum");
})());
check("2. ⭐⭐ trim + lowercase + dedup (' BASE , base , arbitrum ')", (() => {
  const c = enabledEvmChains({ ENABLED_CHAINS: " BASE , base , arbitrum " });
  return c.length === 2 && c[0] === "base" && c[1] === "arbitrum";
})());
check("3. ⭐⭐⭐ token necunoscut ('base,polygon') → sărit (doar base)", (() => {
  const c = enabledEvmChains({ ENABLED_CHAINS: "base,polygon" });
  return c.length === 1 && c[0] === "base";
})());
check("4. ⭐⭐⭐ 'eth' NU e recunoscut (worker nu normalizează; id-ul e 'ethereum')", enabledEvmChains({ ENABLED_CHAINS: "eth", INDEXER_ENABLE_ETHEREUM: "1" }).length === 0);
check("5. ⭐⭐⭐ ethereum FĂRĂ INDEXER_ENABLE_ETHEREUM=1 → NU pornește (shadow-first)", enabledEvmChains({ ENABLED_CHAINS: "ethereum" }).length === 0);
check("6. ⭐⭐⭐ ethereum + INDEXER_ENABLE_ETHEREUM=1 → pornește", (() => {
  const c = enabledEvmChains({ ENABLED_CHAINS: "ethereum", INDEXER_ENABLE_ETHEREUM: "1" });
  return c.length === 1 && c[0] === "ethereum";
})());
check("7. ⭐⭐ token gol ('base,,arbitrum') sărit", enabledEvmChains({ ENABLED_CHAINS: "base,,arbitrum" }).length === 2);

// ── cross-field: chain pornit → WS obligatoriu ───────────────────────────────────────
check("8. ⭐⭐⭐ default complet (base+arb WS + Redis) → ok", validateWorkerEvmEnv(baseEnv()).ok === true);
check("9. ⭐⭐⭐ base pornit fără ALCHEMY_BASE_WS → problem missing (fix pt. `?? \"\"`)", (() => {
  const v = validateWorkerEvmEnv(baseEnv({ ALCHEMY_BASE_WS: undefined }));
  return v.ok === false && pkind(v, "ALCHEMY_BASE_WS") === "missing";
})());
check("10. ⭐⭐⭐ ALCHEMY_BASE_WS = \"\" (mod cu WS activ, chain pornit) → missing, NU invalid", (() => {
  const v = validateWorkerEvmEnv(baseEnv({ ALCHEMY_BASE_WS: "" }));
  return v.ok === false && pkind(v, "ALCHEMY_BASE_WS") === "missing";
})());
check("11. ⭐⭐ ALCHEMY_BASE_WS http:// → problem invalid (trebuie ws/wss)", (() => {
  const v = validateWorkerEvmEnv(baseEnv({ ALCHEMY_BASE_WS: "http://x" }));
  return v.ok === false && pkind(v, "ALCHEMY_BASE_WS") === "invalid";
})());
check("12. ⭐⭐ ws:// (local) acceptat", validateWorkerEvmEnv(baseEnv({ ALCHEMY_BASE_WS: "ws://localhost:8545" })).ok === true);
check("13. ⭐⭐⭐ ENABLED_CHAINS=base → DOAR ALCHEMY_BASE_WS cerut (arbitrum absent → NU e problem)", (() => {
  const v = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", ENABLED_CHAINS: "base", ALCHEMY_BASE_WS: WS_BASE });
  return v.ok === true;
})());
check("14. ⭐⭐⭐ id 'bsc' → cere ALCHEMY_BNB_WS (naming inconsistent, 1:1 cu chains.ts)", (() => {
  const withoutWs = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", ENABLED_CHAINS: "bsc" });
  const withWs    = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", ENABLED_CHAINS: "bsc", ALCHEMY_BNB_WS: WS_BNB });
  return withoutWs.ok === false && pkind(withoutWs, "ALCHEMY_BNB_WS") === "missing" && withWs.ok === true;
})());
check("15. ⭐⭐⭐ ethereum shadow-first: în ENABLED_CHAINS dar fără INDEXER_ENABLE_ETHEREUM=1 → ALCHEMY_ETH_WS NU e cerut", (() => {
  const v = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", ENABLED_CHAINS: "base,ethereum", ALCHEMY_BASE_WS: WS_BASE });
  return v.ok === true && !pnames(v).includes("ALCHEMY_ETH_WS");
})());
check("16. ⭐⭐⭐ ethereum activat (INDEXER_ENABLE_ETHEREUM=1) → ALCHEMY_ETH_WS OBLIGATORIU", (() => {
  const missing = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", ENABLED_CHAINS: "base,ethereum", INDEXER_ENABLE_ETHEREUM: "1", ALCHEMY_BASE_WS: WS_BASE });
  const ok      = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", ENABLED_CHAINS: "base,ethereum", INDEXER_ENABLE_ETHEREUM: "1", ALCHEMY_BASE_WS: WS_BASE, ALCHEMY_ETH_WS: WS_ETH });
  return missing.ok === false && pkind(missing, "ALCHEMY_ETH_WS") === "missing" && ok.ok === true;
})());
check("17. ⭐⭐⭐ multi-lipsă: base+arb pornite, ambele WS lipsă → AMBELE probleme colectate", (() => {
  const v = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379" });
  return v.ok === false && pnames(v).includes("ALCHEMY_BASE_WS") && pnames(v).includes("ALCHEMY_ARB_WS");
})());

// ── REDIS_URL + ENABLED_CHAINS warning ───────────────────────────────────────────────
check("18. ⭐⭐⭐ REDIS_URL lipsă → problem missing", (() => {
  const v = validateWorkerEvmEnv(baseEnv({ REDIS_URL: undefined }));
  return v.ok === false && pkind(v, "REDIS_URL") === "missing";
})());
check("19. ⭐⭐ REDIS_URL http:// → invalid", (() => {
  const v = validateWorkerEvmEnv(baseEnv({ REDIS_URL: "http://r" }));
  return v.ok === false && pkind(v, "REDIS_URL") === "invalid";
})());
check("20. ⭐⭐⭐ ENABLED_CHAINS cu token necunoscut ('base,polygon') → warning, dar base cere tot WS-ul lui", (() => {
  const v = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", ENABLED_CHAINS: "base,polygon", ALCHEMY_BASE_WS: WS_BASE });
  return v.ok === true && wnames(v).includes("ENABLED_CHAINS");
})());
check("21. ⭐⭐ mesajul ENABLED_CHAINS NU ecouă valoarea ('polygon' nu apare) — anti-leak", (() => {
  const v = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", ENABLED_CHAINS: "base,polygon", ALCHEMY_BASE_WS: WS_BASE });
  const s = formatEnvValidation(v);
  return !/polygon/.test(s) && /ENABLED_CHAINS/.test(s);
})());

// ── maparea + câmpuri derivate ───────────────────────────────────────────────────────
check("22. ⭐⭐ CHAIN_WS_ENV: bsc→ALCHEMY_BNB_WS, base→ALCHEMY_BASE_WS, arbitrum→ALCHEMY_ARB_WS, ethereum→ALCHEMY_ETH_WS", (() =>
  CHAIN_WS_ENV.bsc === "ALCHEMY_BNB_WS" && CHAIN_WS_ENV.base === "ALCHEMY_BASE_WS"
  && CHAIN_WS_ENV.arbitrum === "ALCHEMY_ARB_WS" && CHAIN_WS_ENV.ethereum === "ALCHEMY_ETH_WS")());
check("23. ⭐⭐ workerEvmEnvFields DERIVAT din env: base-only (mod LIVE) → 3 câmpuri (REDIS_URL, ENABLED_CHAINS, ALCHEMY_BASE_WS)", (() => {
  const f = workerEvmEnvFields({ ENABLED_CHAINS: "base" }).map((x) => x.name);
  return f.length === 3 && f.includes("REDIS_URL") && f.includes("ENABLED_CHAINS") && f.includes("ALCHEMY_BASE_WS") && !f.includes("ALCHEMY_ARB_WS");
})());

// ── fix cgpt #1: WS obligatoriu DOAR când modul are WS activ (mode.ts: DEV → wsEnabled:false) ──────
check("24. ⭐⭐⭐ PREFLIGHT_MODE=DEV + base pornit, FĂRĂ WS → ok (DEV nu pornește WS-ul; nu-l cerem)", (() => {
  const v = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", PREFLIGHT_MODE: "DEV", ENABLED_CHAINS: "base" });
  return v.ok === true;
})());
check("25. ⭐⭐⭐ DEV: workerEvmEnvFields NU adaugă niciun câmp ALCHEMY_*_WS (doar REDIS_URL + ENABLED_CHAINS)", (() => {
  const f = workerEvmEnvFields({ PREFLIGHT_MODE: "dev", ENABLED_CHAINS: "base,arbitrum" }).map((x) => x.name);
  return f.length === 2 && !f.some((n) => n.startsWith("ALCHEMY_"));
})());
check("26. ⭐⭐ BURST (wsEnabled) tot cere WS (nu doar LIVE): base fără WS → missing", (() => {
  const v = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", PREFLIGHT_MODE: "BURST", ENABLED_CHAINS: "base" });
  return v.ok === false && pkind(v, "ALCHEMY_BASE_WS") === "missing";
})());
check("27. ⭐⭐ wsEnabledForEnv: DEV→false; LIVE/BURST/PAID_LIVE/absent/necunoscut→true", (() =>
  wsEnabledForEnv({ PREFLIGHT_MODE: "DEV" }) === false && wsEnabledForEnv({ PREFLIGHT_MODE: "dev" }) === false
  && wsEnabledForEnv({}) === true && wsEnabledForEnv({ PREFLIGHT_MODE: "BURST" }) === true
  && wsEnabledForEnv({ PREFLIGHT_MODE: "PAID_LIVE" }) === true && wsEnabledForEnv({ PREFLIGHT_MODE: "wat" }) === true)());

// ── fix cgpt #2: selecție efectivă goală → problem (absența listei păstrează default-ul) ───────────
check("28. ⭐⭐⭐ ENABLED_CHAINS=\"\" → problem (selecție goală; worker n-ar porni niciun chain)", (() => {
  const v = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", ENABLED_CHAINS: "" });
  return v.ok === false && v.problems.some((p) => p.name === "ENABLED_CHAINS" && p.kind === "invalid");
})());
check("29. ⭐⭐⭐ ENABLED_CHAINS=\" , , \" → problem (selecție goală)", (() => {
  const v = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", ENABLED_CHAINS: " , , " });
  return v.ok === false && v.problems.some((p) => p.name === "ENABLED_CHAINS");
})());
check("30. ⭐⭐⭐ ENABLED_CHAINS=\"ethereum\" fără gate → problem (0 chain-uri după shadow-first)", (() => {
  const v = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", ENABLED_CHAINS: "ethereum" });
  return v.ok === false && v.problems.some((p) => p.name === "ENABLED_CHAINS");
})());
check("31. ⭐⭐⭐ ENABLED_CHAINS ABSENT → default base,arbitrum → NU e problem de selecție goală (cu WS → ok)", (() => {
  const v = validateWorkerEvmEnv(baseEnv()); // fără ENABLED_CHAINS → default
  return v.ok === true;
})());
check("32. ⭐⭐ selecție goală în DEV tot e problem (independent de WS)", (() => {
  const v = validateWorkerEvmEnv({ REDIS_URL: "rediss://r:6379", PREFLIGHT_MODE: "DEV", ENABLED_CHAINS: "" });
  return v.ok === false && v.problems.some((p) => p.name === "ENABLED_CHAINS");
})());

// ── fix cgpt #3: validatorul WS respinge fragment (ws 8.20.1 îl respinge) ──────────────────────────
check("33. ⭐⭐⭐ ALCHEMY_BASE_WS cu #fragment → invalid (ws client îl respinge)", (() => {
  const v = validateWorkerEvmEnv(baseEnv({ ALCHEMY_BASE_WS: "wss://example.invalid/v2/key#frag" }));
  return v.ok === false && pkind(v, "ALCHEMY_BASE_WS") === "invalid";
})());
check("34. ⭐⭐ wss:// curat (fără fragment) rămâne valid", validateWorkerEvmEnv(baseEnv({ ALCHEMY_BASE_WS: "wss://example.invalid/v2/key" })).ok === true);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
