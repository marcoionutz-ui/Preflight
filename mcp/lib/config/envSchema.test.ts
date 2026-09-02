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
console.log("PH-12 12.2a — validateMcpEnv (env fail-fast, pur)");

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
check("25. ⭐ catalogul expune exact 5 câmpuri (4 mereu + PUBLIC_BASE_URL prod-only)", MCP_ENV_FIELDS.length === 5);
check("26. ⭐⭐ exact 1 câmp e prod-only (PUBLIC_BASE_URL); restul required mereu", (() => {
  const prodOnly = MCP_ENV_FIELDS.filter((f) => f.required(true) && !f.required(false));
  const always   = MCP_ENV_FIELDS.filter((f) => f.required(true) && f.required(false));
  return prodOnly.length === 1 && prodOnly[0].name === "PUBLIC_BASE_URL" && always.length === 4;
})());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
