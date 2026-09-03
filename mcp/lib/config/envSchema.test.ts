/**
 * lib/config/envSchema.test.ts — PH-12 slice 12.2a (env fail-fast MCP, pur).
 *
 * Rulează: `tsx lib/config/envSchema.test.ts`. Verifică: required per prod/dev, tip (URL/redis/issuer),
 * `PUBLIC_BASE_URL` prod-only via ACELAȘI predicat ca runtime (paritate cu `isBaseUrlFailClosed`),
 * surplus pe rol → warning (nu problem), `""` == absent, uniune discriminată, colectare (nu short-circuit).
 */
import { validateMcpEnv, formatEnvValidation, MCP_ENV_FIELDS, type EnvSnapshot } from "./envSchema";
import { isBaseUrlFailClosed } from "../oauth/baseUrl";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

/** Env MINIM valid pentru dev (fără PUBLIC_BASE_URL — opțional în dev). */
function devEnv(over: EnvSnapshot = {}): EnvSnapshot {
  return {
    NODE_ENV: "development",
    NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-123",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-456",
    REDIS_URL: "redis://127.0.0.1:6379",
    ...over,
  };
}

/** Env MINIM valid pentru prod (PUBLIC_BASE_URL obligatoriu + https peste tot). */
function prodEnv(over: EnvSnapshot = {}): EnvSnapshot {
  return {
    NODE_ENV: "production",
    NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-123",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-456",
    REDIS_URL: "rediss://redis.internal:6379",
    PUBLIC_BASE_URL: "https://preflight.jackspools.lol",
    ...over,
  };
}

function problemNames(v: ReturnType<typeof validateMcpEnv>): string[] {
  return v.ok ? [] : v.problems.map((p) => p.name);
}
function warningNames(v: ReturnType<typeof validateMcpEnv>): string[] {
  return v.warnings.map((w) => w.name);
}

function main(): void {
console.log("PH-12 12.2a/12.2e-2 — validateMcpEnv (env fail-fast + inventar opționale, pur)");

// ── happy paths ──────────────────────────────────────────────────────────────────
check("1. ⭐⭐⭐ dev complet valid → ok (fără PUBLIC_BASE_URL)", validateMcpEnv(devEnv()).ok === true);
check("2. ⭐⭐⭐ prod complet valid → ok", validateMcpEnv(prodEnv()).ok === true);
check("3. ⭐ ok NU poartă cheia `problems` (uniune discriminată)", (() => {
  const v = validateMcpEnv(devEnv());
  return v.ok === true && !("problems" in v);
})());

// ── required lipsă (dev: 4 obligatorii) ────────────────────────────────────────────
for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "REDIS_URL"]) {
  check(`4.${name} ⭐⭐⭐ lipsă în dev → problem missing`, (() => {
    const v = validateMcpEnv(devEnv({ [name]: undefined }));
    return v.ok === false && v.problems.some((p) => p.name === name && p.kind === "missing");
  })());
}

// ── PUBLIC_BASE_URL: prod-only ─────────────────────────────────────────────────────
check("5. ⭐⭐⭐ PUBLIC_BASE_URL lipsă în PROD → problem missing", (() => {
  const v = validateMcpEnv(prodEnv({ PUBLIC_BASE_URL: undefined }));
  return v.ok === false && v.problems.some((p) => p.name === "PUBLIC_BASE_URL" && p.kind === "missing");
})());
check("6. ⭐⭐⭐ PUBLIC_BASE_URL lipsă în DEV → ok (opțional)", validateMcpEnv(devEnv({ PUBLIC_BASE_URL: undefined })).ok === true);
check("7. ⭐⭐⭐ PUBLIC_BASE_URL http în PROD → problem invalid (https obligatoriu)", (() => {
  const v = validateMcpEnv(prodEnv({ PUBLIC_BASE_URL: "http://preflight.jackspools.lol" }));
  return v.ok === false && v.problems.some((p) => p.name === "PUBLIC_BASE_URL" && p.kind === "invalid");
})());
check("8. ⭐⭐ PUBLIC_BASE_URL http în DEV → ok (dev acceptă http)", validateMcpEnv(devEnv({ PUBLIC_BASE_URL: "http://localhost:8080" })).ok === true);
check("9. ⭐⭐ PUBLIC_BASE_URL malformat în DEV (prezent) → warning, NU problem", (() => {
  const v = validateMcpEnv(devEnv({ PUBLIC_BASE_URL: "not-a-url" }));
  return v.ok === true && warningNames(v).includes("PUBLIC_BASE_URL");
})());
check("10. ⭐⭐ PUBLIC_BASE_URL cu query în PROD → invalid (RFC 8414)", (() => {
  const v = validateMcpEnv(prodEnv({ PUBLIC_BASE_URL: "https://ok.tld/?x=1" }));
  return v.ok === false && v.problems.some((p) => p.name === "PUBLIC_BASE_URL" && p.kind === "invalid");
})());

// ── PARITATE boot-check == runtime fail-closed ─────────────────────────────────────
check("11. ⭐⭐⭐ paritate: dacă isBaseUrlFailClosed(prod)==true → validateMcpEnv marchează PUBLIC_BASE_URL", (() => {
  const env = prodEnv({ PUBLIC_BASE_URL: "http://poisonable" }); // runtime ar arunca fail-closed
  const failClosed = isBaseUrlFailClosed({ PUBLIC_BASE_URL: env.PUBLIC_BASE_URL, NODE_ENV: env.NODE_ENV });
  const v = validateMcpEnv(env);
  return failClosed === true && v.ok === false && v.problems.some((p) => p.name === "PUBLIC_BASE_URL");
})());
check("12. ⭐⭐⭐ paritate inversă: PUBLIC_BASE_URL valid în prod → isBaseUrlFailClosed==false ȘI env ok pe acest câmp", (() => {
  const env = prodEnv();
  const failClosed = isBaseUrlFailClosed({ PUBLIC_BASE_URL: env.PUBLIC_BASE_URL, NODE_ENV: env.NODE_ENV });
  const v = validateMcpEnv(env);
  return failClosed === false && problemNames(v).length === 0;
})());

// ── tipuri: URL / redis ────────────────────────────────────────────────────────────
check("13. ⭐⭐⭐ REDIS_URL cu schemă greșită (http://) → invalid", (() => {
  const v = validateMcpEnv(devEnv({ REDIS_URL: "http://127.0.0.1:6379" }));
  return v.ok === false && v.problems.some((p) => p.name === "REDIS_URL" && p.kind === "invalid");
})());
check("14. ⭐⭐ REDIS_URL rediss:// (TLS) → ok", validateMcpEnv(devEnv({ REDIS_URL: "rediss://host:6379" })).ok === true);
check("15. ⭐⭐⭐ NEXT_PUBLIC_SUPABASE_URL non-URL → invalid", (() => {
  const v = validateMcpEnv(devEnv({ NEXT_PUBLIC_SUPABASE_URL: "proj.supabase.co" }));
  return v.ok === false && v.problems.some((p) => p.name === "NEXT_PUBLIC_SUPABASE_URL" && p.kind === "invalid");
})());
check("16. ⭐⭐ SUPABASE_URL http în PROD → invalid; http în DEV → ok", (() => {
  const vp = validateMcpEnv(prodEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://proj.supabase.co" }));
  const vd = validateMcpEnv(devEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://proj.supabase.co" }));
  return vp.ok === false && vp.problems.some((p) => p.name === "NEXT_PUBLIC_SUPABASE_URL") && vd.ok === true;
})());

// ── "" == absent ───────────────────────────────────────────────────────────────────
check("17. ⭐⭐⭐ REDIS_URL = \"\" (setat gol de deploy) → tratat ca lipsă, NU invalid", (() => {
  const v = validateMcpEnv(devEnv({ REDIS_URL: "" }));
  return v.ok === false && v.problems.some((p) => p.name === "REDIS_URL" && p.kind === "missing");
})());
check("18. ⭐⭐ whitespace-only == absent", (() => {
  const v = validateMcpEnv(devEnv({ SUPABASE_SERVICE_ROLE_KEY: "   " }));
  return v.ok === false && v.problems.some((p) => p.name === "SUPABASE_SERVICE_ROLE_KEY" && p.kind === "missing");
})());

// ── surplus pe rol (worker vars pe MCP) → warning, NU problem ───────────────────────
check("19. ⭐⭐⭐ ALCHEMY_BASE_WS / INDEXER_ENABLE_ETHEREUM pe MCP → warnings, env rămâne ok", (() => {
  const v = validateMcpEnv(devEnv({ ALCHEMY_BASE_WS: "wss://x", INDEXER_ENABLE_ETHEREUM: "1" }));
  const w = warningNames(v);
  return v.ok === true && w.includes("ALCHEMY_BASE_WS") && w.includes("INDEXER_ENABLE_ETHEREUM");
})());
check("20. ⭐⭐ surplus setat la \"\" → NU warned (present check)", (() => {
  const v = validateMcpEnv(devEnv({ ALCHEMY_BASE_WS: "" }));
  return v.ok === true && !warningNames(v).includes("ALCHEMY_BASE_WS");
})());
check("21. ⭐⭐ o variabilă necunoscută NON-worker (ex. PORT) NU e warned (fără allowlist strictă)", (() => {
  const v = validateMcpEnv(devEnv({ PORT: "8080" }));
  return v.ok === true && !warningNames(v).includes("PORT");
})());
check("21b. ⭐⭐ surplus → ordine DETERMINISTĂ (sortată), indiferent de ordinea de inserție (fix cgpt)", (() => {
  // inserție deliberat ne-alfabetică: INDEXER_ENABLE_V4, ALCHEMY_ETH_WS, INDEXER_DRY_RUN, ALCHEMY_BASE_WS
  const v = validateMcpEnv(devEnv({ INDEXER_ENABLE_V4: "1", ALCHEMY_ETH_WS: "wss://e", INDEXER_DRY_RUN: "1", ALCHEMY_BASE_WS: "wss://b" }));
  const surplus = warningNames(v).filter((n) => n.startsWith("ALCHEMY_") || n.startsWith("INDEXER_"));
  const sorted = [...surplus].sort();
  return v.ok === true && surplus.length === 4 && JSON.stringify(surplus) === JSON.stringify(sorted);
})());

// ── colectare (nu short-circuit) + formatare ───────────────────────────────────────
check("22. ⭐⭐⭐ mai multe lipsă → TOATE colectate (nu se oprește la prima)", (() => {
  const v = validateMcpEnv(devEnv({ REDIS_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }));
  return v.ok === false && problemNames(v).includes("REDIS_URL") && problemNames(v).includes("SUPABASE_SERVICE_ROLE_KEY");
})());
check("23. ⭐ formatEnvValidation(ok) conține „[env:mcp] OK\"", formatEnvValidation(validateMcpEnv(devEnv())).includes("[env:mcp] OK"));
check("24. ⭐ formatEnvValidation(fail) listează câmpul lipsă", (() => {
  const s = formatEnvValidation(validateMcpEnv(devEnv({ REDIS_URL: undefined })));
  return /FAIL/.test(s) && /REDIS_URL/.test(s);
})());
check("25. ⭐ catalog: 5 bază + 7 inventar (12.2e-2) + 2 chain-list (12.2c-mcp) = 14 câmpuri", MCP_ENV_FIELDS.length === 14);
check("26. ⭐⭐ exact 1 câmp e prod-only (PUBLIC_BASE_URL); 4 required mereu; restul opționale", (() => {
  const prodOnly = MCP_ENV_FIELDS.filter((f) => f.required(true) && !f.required(false));
  const always   = MCP_ENV_FIELDS.filter((f) => f.required(true) && f.required(false));
  return prodOnly.length === 1 && prodOnly[0].name === "PUBLIC_BASE_URL" && always.length === 4;
})());

// ── 12.2e-2 inventar: securitate must-be-OFF-in-prod (forbid) ──────────────────────
for (const flag of ["MCP_DEV_AUTH_BYPASS", "QUOTA_INTEGRATION_ALLOW", "PH4_INTEGRATION_ALLOW"]) {
  check(`27.${flag} ⭐⭐⭐ truthy în PROD → problem 'forbidden' (boot crapă)`, (() => {
    const v = validateMcpEnv(prodEnv({ [flag]: "1" }));
    return v.ok === false && v.problems.some((p) => p.name === flag && p.kind === "forbidden");
  })());
  check(`28.${flag} ⭐⭐ truthy în DEV → ok (dev-ul folosește flag-ul legitim)`, validateMcpEnv(devEnv({ [flag]: "1" })).ok === true);
  check(`29.${flag} ⭐⭐ OFF explicit ('0') în PROD → ok (dezactivare intenționată)`, validateMcpEnv(prodEnv({ [flag]: "0" })).ok === true);
}
check("30. ⭐⭐⭐ fail-loud: MCP_DEV_AUTH_BYPASS='treu' (typo) în PROD → forbidden (nu tăcut off)", (() => {
  const v = validateMcpEnv(prodEnv({ MCP_DEV_AUTH_BYPASS: "treu" }));
  return v.ok === false && v.problems.some((p) => p.name === "MCP_DEV_AUTH_BYPASS" && p.kind === "forbidden");
})());
check("31. ⭐⭐ bypass absent în PROD → ok (categoria e „OFF SAU absent\")", validateMcpEnv(prodEnv()).ok === true);

// ── 12.2e-2 inventar: toggle-uri strict 0/1 (present + altceva → warning, NU crapă) ──
check("32. ⭐⭐⭐ HEALTH_WS_ENABLED='false' → warning (runtime îl ține ON pe !== '0')", (() => {
  const v = validateMcpEnv(devEnv({ HEALTH_WS_ENABLED: "false" }));
  return v.ok === true && warningNames(v).includes("HEALTH_WS_ENABLED");
})());
check("33. ⭐⭐ HEALTH_WS_ENABLED='0' → ok, fără warning", (() => {
  const v = validateMcpEnv(devEnv({ HEALTH_WS_ENABLED: "0" }));
  return v.ok === true && !warningNames(v).includes("HEALTH_WS_ENABLED");
})());
check("34. ⭐⭐⭐ DEMO_TRUST_XFF='true' → warning (runtime îl tratează OFF pe !== '1')", (() => {
  const v = validateMcpEnv(devEnv({ DEMO_TRUST_XFF: "true" }));
  return v.ok === true && warningNames(v).includes("DEMO_TRUST_XFF");
})());
check("35. ⭐⭐ DEMO_TRUST_XFF='1' → ok, fără warning", (() => {
  const v = validateMcpEnv(devEnv({ DEMO_TRUST_XFF: "1" }));
  return v.ok === true && !warningNames(v).includes("DEMO_TRUST_XFF");
})());
check("35b. ⭐⭐⭐ HEALTH_WS_ENABLED=' 0 ' (spații) → warning (fix cgpt: runtime compară BRUT, ' 0 ' !== '0' → WS ON)", (() => {
  const v = validateMcpEnv(devEnv({ HEALTH_WS_ENABLED: " 0 " }));
  return v.ok === true && warningNames(v).includes("HEALTH_WS_ENABLED");
})());
check("35c. ⭐⭐⭐ DEMO_TRUST_XFF=' 1 ' (spații) → warning (runtime ' 1 ' !== '1' → trust OFF)", (() => {
  const v = validateMcpEnv(devEnv({ DEMO_TRUST_XFF: " 1 " }));
  return v.ok === true && warningNames(v).includes("DEMO_TRUST_XFF");
})());

// ── 12.2e-2 inventar: flag-uri PH-2 (boolFlag — token bool nerecunoscut → warning) ──
check("36. ⭐⭐⭐ PH2_RESOURCE_OWNER_AUTHORIZE='treu' → warning (typo → OFF silent la runtime)", (() => {
  const v = validateMcpEnv(devEnv({ PH2_RESOURCE_OWNER_AUTHORIZE: "treu" }));
  return v.ok === true && warningNames(v).includes("PH2_RESOURCE_OWNER_AUTHORIZE");
})());
check("37. ⭐⭐ PH2_RESOURCE_OWNER_AUTHORIZE='1' → ok, fără warning", (() => {
  const v = validateMcpEnv(devEnv({ PH2_RESOURCE_OWNER_AUTHORIZE: "1" }));
  return v.ok === true && !warningNames(v).includes("PH2_RESOURCE_OWNER_AUTHORIZE");
})());
check("38. ⭐⭐ PH2_REJECT_LEGACY_AUTHCODE='off' → ok (token bool recunoscut)", (() => {
  const v = validateMcpEnv(devEnv({ PH2_REJECT_LEGACY_AUTHCODE: "off" }));
  return v.ok === true && !warningNames(v).includes("PH2_REJECT_LEGACY_AUTHCODE");
})());
check("39. ⭐⭐⭐ inventarul NU regresează happy-path: prod complet valid + zero flag-uri → ok", validateMcpEnv(prodEnv()).ok === true);
check("40. ⭐ exact 3 câmpuri `forbid` (must-be-OFF-in-prod)", MCP_ENV_FIELDS.filter((f) => typeof f.forbid === "function").length === 3);

// ── 12.2c-mcp: chain-list validate-when-present (PREFLIGHT_EVM_CHAINS + normalizeChainId) ──
check("41. ⭐⭐⭐ HEALTH_EXPECTED_CHAINS='base,arbitrum' → ok, fără warning", (() => {
  const v = validateMcpEnv(devEnv({ HEALTH_EXPECTED_CHAINS: "base,arbitrum" }));
  return v.ok === true && !warningNames(v).includes("HEALTH_EXPECTED_CHAINS");
})());
check("42. ⭐⭐⭐ HEALTH_EXPECTED_CHAINS='base,bnb' → warning (bnb necunoscut; canonic e bsc)", (() => {
  const v = validateMcpEnv(devEnv({ HEALTH_EXPECTED_CHAINS: "base,bnb" }));
  return v.ok === true && warningNames(v).includes("HEALTH_EXPECTED_CHAINS");
})());
check("43. ⭐⭐⭐ HEALTH_EXPECTED_CHAINS='eth' → ok (normalizeChainId eth→ethereum), fără warning", (() => {
  const v = validateMcpEnv(devEnv({ HEALTH_EXPECTED_CHAINS: "eth" }));
  return v.ok === true && !warningNames(v).includes("HEALTH_EXPECTED_CHAINS");
})());
check("44. ⭐⭐ ENABLED_CHAINS='base,polygon' pe MCP → warning (polygon necunoscut)", (() => {
  const v = validateMcpEnv(devEnv({ ENABLED_CHAINS: "base,polygon" }));
  return v.ok === true && warningNames(v).includes("ENABLED_CHAINS");
})());
check("45. ⭐⭐ ENABLED_CHAINS 'bsc' (canonic) → ok, fără warning", (() => {
  const v = validateMcpEnv(devEnv({ ENABLED_CHAINS: "bsc" }));
  return v.ok === true && !warningNames(v).includes("ENABLED_CHAINS");
})());
check("46. ⭐⭐⭐ mesajul chain-list NU ecouă valoarea ('polygon' nu apare) — anti-leak", (() => {
  const s = formatEnvValidation(validateMcpEnv(devEnv({ HEALTH_EXPECTED_CHAINS: "base,polygon" })));
  return !/polygon/.test(s) && /HEALTH_EXPECTED_CHAINS/.test(s);
})());

// ── 12.2c-mcp: selecție EFECTIVĂ goală (override prezent-dar-vid blochează fallback-ul `??`) → WARNING, NU problem ──
// Runtime `readHealthSignals`: `HEALTH_EXPECTED_CHAINS ?? ENABLED_CHAINS ?? "base,arbitrum"`. `??` prinde doar null/undef,
// deci un `HEALTH_EXPECTED_CHAINS=""` PREZENT oprește fallback-ul → `parseExpectedChains("")` → [] → health strict 503 tăcut.
for (const [label, override] of [["gol", ""], ["whitespace", "   "], ["doar virgule", ",,"]] as const) {
  check(`47.${label} ⭐⭐⭐ HEALTH_EXPECTED_CHAINS=${JSON.stringify(override)} peste ENABLED_CHAINS=base → warning (selecție efectivă goală), ok rămâne true`, (() => {
    const v = validateMcpEnv(devEnv({ HEALTH_EXPECTED_CHAINS: override, ENABLED_CHAINS: "base" }));
    return v.ok === true && warningNames(v).includes("HEALTH_EXPECTED_CHAINS");
  })());
}
check("48. ⭐⭐⭐ ENABLED_CHAINS=\"\" singur (fără HEALTH_EXPECTED_CHAINS) → warning (fallback blocat, expectedChains=[])", (() => {
  // `HEALTH_EXPECTED_CHAINS` absent → `?? ENABLED_CHAINS` → `""` prezent → blochează `?? "base,arbitrum"` → [].
  const v = validateMcpEnv(devEnv({ ENABLED_CHAINS: "" }));
  return v.ok === true && warningNames(v).includes("HEALTH_EXPECTED_CHAINS");
})());
check("49. ⭐⭐⭐ ambele absente → default 'base,arbitrum' → FĂRĂ avertisment de selecție goală", (() => {
  const v = validateMcpEnv(devEnv()); // niciun override de chain
  return v.ok === true && !warningNames(v).includes("HEALTH_EXPECTED_CHAINS");
})());
check("50. ⭐⭐⭐ override VALID ('bsc') peste fallback gol (ENABLED_CHAINS=\"\") → FĂRĂ avertisment de selecție goală", (() => {
  const v = validateMcpEnv(devEnv({ HEALTH_EXPECTED_CHAINS: "bsc", ENABLED_CHAINS: "" }));
  return v.ok === true && !warningNames(v).includes("HEALTH_EXPECTED_CHAINS");
})());
check("51. ⭐⭐ selecția goală e WARNING, NU problem (ok rămâne true, boot-ul NU crapă)", (() => {
  const v = validateMcpEnv(devEnv({ HEALTH_EXPECTED_CHAINS: "" }));
  return v.ok === true;
})());
check("52. ⭐⭐⭐ warning-ul de selecție goală NU ecouă valoarea brută (anti-leak: 'polygon' din override nu apare)", (() => {
  // override cu DOAR tokeni necunoscuți → selecție efectivă goală ȘI valoare brută sensibilă de mascat.
  const s = formatEnvValidation(validateMcpEnv(devEnv({ HEALTH_EXPECTED_CHAINS: "polygon,foobar" })));
  return !/polygon/.test(s) && !/foobar/.test(s) && /HEALTH_EXPECTED_CHAINS/.test(s);
})());
check("53. ⭐⭐ selecție goală NU regresează required: env cu REDIS_URL lipsă + override gol → ok:false (problem) + warning coexistă", (() => {
  const v = validateMcpEnv(devEnv({ REDIS_URL: undefined, HEALTH_EXPECTED_CHAINS: "" }));
  return v.ok === false && v.problems.some((p) => p.name === "REDIS_URL") && warningNames(v).includes("HEALTH_EXPECTED_CHAINS");
})());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
