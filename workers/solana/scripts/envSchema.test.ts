/**
 * scripts/envSchema.test.ts — PH-12 slice 12.2c-3b (env fail-fast indexer-solana, pur).
 *
 * Rulează: `tsx scripts/envSchema.test.ts`. Verifică: GRUPURILE Redis/RPC cu precedență `??` — membrul EFECTIV e
 * OBLIGATORIU (absent/gol/invalid → problem), membrii neutilizați → warning; WS EFECTIV (override truthy sau derivat din
 * RPC) validat → problem; backfill byte-exact; MAX_ACCOUNTS parseInt; cele 19 numerice de cozi (RAW /^d+$/, fără trim);
 * numerice MS; Jupiter; uniune discriminată; mesaje fără valoare.
 */
import {
  validateSolanaEnv, formatEnvValidation, solanaEnvFields, REDIS_GROUP, RPC_GROUP, type EnvSnapshot,
} from "../src/config/envSchema";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

/** Env MINIM valid: un membru Redis + un membru RPC. */
function devEnv(over: EnvSnapshot = {}): EnvSnapshot {
  return {
    NODE_ENV: "development",
    REDIS_URL: "redis://127.0.0.1:6379",
    SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    ...over,
  };
}
function problemNames(v: ReturnType<typeof validateSolanaEnv>): string[] {
  return v.ok ? [] : v.problems.map((p) => p.name);
}
function problemKind(v: ReturnType<typeof validateSolanaEnv>, name: string): string | undefined {
  return v.ok ? undefined : v.problems.find((p) => p.name === name)?.kind;
}
function warningNames(v: ReturnType<typeof validateSolanaEnv>): string[] {
  return v.warnings.map((w) => w.name);
}

function main(): void {
console.log("PH-12 12.2c-3b — validateSolanaEnv (env fail-fast indexer-solana, pur)");

// ── happy paths ──────────────────────────────────────────────────────────────────
check("1. ⭐⭐⭐ dev minim valid (un Redis + un RPC) → ok", validateSolanaEnv(devEnv()).ok === true);
check("2. ⭐ ok NU poartă cheia `problems` (uniune discriminată)", (() => {
  const v = validateSolanaEnv(devEnv());
  return v.ok === true && !("problems" in v);
})());

// ── GRUP Redis (precedență ??) — membrul EFECTIV e obligatoriu ───────────────────────
check("3. ⭐⭐⭐ toate cele 3 Redis absente → problem missing", (() => {
  const v = validateSolanaEnv(devEnv({ REDIS_URL: undefined }));
  return v.ok === false && problemKind(v, "REDIS_URL") === "missing";
})());
check("4. ⭐⭐⭐ doar REDIS_PRIVATE_URL → ok; doar REDIS_PUBLIC_URL → ok (oricare acoperă grupul)", (() => {
  const p = validateSolanaEnv(devEnv({ REDIS_URL: undefined, REDIS_PRIVATE_URL: "redis://priv:6379" }));
  const u = validateSolanaEnv(devEnv({ REDIS_URL: undefined, REDIS_PUBLIC_URL: "rediss://pub:6379" }));
  return p.ok === true && u.ok === true;
})());
check("5. ⭐⭐⭐ CAPCANĂ ??: REDIS_URL=\"\" PREZENT + PRIVATE valid → problem missing (\"\" blochează fallback-ul)", (() => {
  const v = validateSolanaEnv(devEnv({ REDIS_URL: "", REDIS_PRIVATE_URL: "redis://priv:6379" }));
  return v.ok === false && problemKind(v, "REDIS_URL") === "missing";
})());
check("6. ⭐⭐⭐ FIX #1: membrul EFECTIV Redis prezent-dar-invalid (http://) → problem INVALID (nu warning)", (() => {
  const v = validateSolanaEnv(devEnv({ REDIS_URL: "http://x:6379" }));
  return v.ok === false && problemKind(v, "REDIS_URL") === "invalid";
})());
check("7. ⭐⭐ membru Redis NEUTILIZAT invalid (PUBLIC malformat, dar REDIS_URL valid ales) → warning, ok rămâne true", (() => {
  const v = validateSolanaEnv(devEnv({ REDIS_PUBLIC_URL: "http://junk" }));
  return v.ok === true && warningNames(v).includes("REDIS_PUBLIC_URL");
})());

// ── GRUP RPC (precedență ??) ────────────────────────────────────────────────────────
check("8. ⭐⭐⭐ toate cele 3 RPC absente → problem missing", (() => {
  const v = validateSolanaEnv(devEnv({ SOLANA_RPC_URL: undefined }));
  return v.ok === false && problemKind(v, "SOLANA_RPC_URL") === "missing";
})());
check("9. ⭐⭐⭐ doar HELIUS_RPC_URL → ok; doar ALCHEMY_SOLANA_RPC_URL → ok", (() => {
  const h = validateSolanaEnv(devEnv({ SOLANA_RPC_URL: undefined, HELIUS_RPC_URL: "https://helius.example/k" }));
  const a = validateSolanaEnv(devEnv({ SOLANA_RPC_URL: undefined, ALCHEMY_SOLANA_RPC_URL: "https://alch.example/k" }));
  return h.ok === true && a.ok === true;
})());
check("10. ⭐⭐⭐ FIX #1: RPC efectiv cu credențiale în URL → problem INVALID (nu warning; Request le respinge)", (() => {
  const v = validateSolanaEnv(devEnv({ SOLANA_RPC_URL: "https://user:pass@rpc.example" }));
  return v.ok === false && problemKind(v, "SOLANA_RPC_URL") === "invalid";
})());
check("11. ⭐⭐⭐ FIX #1: RPC efectiv 'not-a-url' → problem invalid", (() => {
  const v = validateSolanaEnv(devEnv({ SOLANA_RPC_URL: "not-a-url" }));
  return v.ok === false && problemKind(v, "SOLANA_RPC_URL") === "invalid";
})());
check("12. ⭐⭐ CAPCANĂ ??: SOLANA_RPC_URL=\"\" + HELIUS valid → problem missing (\"\" blochează fallback-ul)", (() => {
  const v = validateSolanaEnv(devEnv({ SOLANA_RPC_URL: "", HELIUS_RPC_URL: "https://helius.example/k" }));
  return v.ok === false && problemKind(v, "SOLANA_RPC_URL") === "missing";
})());

// ── WS EFECTIV (FIX #2): override truthy sau derivat din RPC ─────────────────────────
check("13. ⭐⭐⭐ SOLANA_WS_URL absent + RPC https valid → ok (WS derivat wss valid)", validateSolanaEnv(devEnv()).ok === true);
check("14. ⭐⭐⭐ FIX #2: SOLANA_WS_URL=\" \" (override truthy la runtime) → problem (WS efectiv inutilizabil)", (() => {
  const v = validateSolanaEnv(devEnv({ SOLANA_WS_URL: " " }));
  return v.ok === false && problemNames(v).includes("SOLANA_WS_URL");
})());
check("15. ⭐⭐⭐ SOLANA_WS_URL override 'https://...' (schemă greșită) → problem (WS efectiv folosit ca atare)", (() => {
  const v = validateSolanaEnv(devEnv({ SOLANA_WS_URL: "https://rpc.example" }));
  return v.ok === false && problemNames(v).includes("SOLANA_WS_URL");
})());
check("16. ⭐⭐⭐ FIX #2: RPC valid cu #fragment, FĂRĂ override → WS derivat are fragment → problem", (() => {
  const v = validateSolanaEnv(devEnv({ SOLANA_RPC_URL: "https://rpc.example/ws#x" }));
  return v.ok === false && problemNames(v).includes("SOLANA_WS_URL");
})());
check("17. ⭐⭐ SOLANA_WS_URL='wss://...' override valid → ok", validateSolanaEnv(devEnv({ SOLANA_WS_URL: "wss://rpc.example/ws" })).ok === true);
check("18. ⭐⭐ RPC absent + WS override valid → tot problem pe RPC (WS nu compensează grupul RPC)", (() => {
  const v = validateSolanaEnv(devEnv({ SOLANA_RPC_URL: undefined, SOLANA_WS_URL: "wss://rpc.example/ws" }));
  return v.ok === false && problemNames(v).includes("SOLANA_RPC_URL") && !problemNames(v).includes("SOLANA_WS_URL");
})());

// ── backfill flags + MAX_ACCOUNTS ───────────────────────────────────────────────────
check("19. ⭐⭐⭐ SOLANA_BACKFILL_ENABLED='true' → warning (runtime `=== \"1\"`); ='1'/'0' → ok", (() => {
  const bad = validateSolanaEnv(devEnv({ SOLANA_BACKFILL_ENABLED: "true" }));
  const on  = validateSolanaEnv(devEnv({ SOLANA_BACKFILL_ENABLED: "1" }));
  return warningNames(bad).includes("SOLANA_BACKFILL_ENABLED") && !warningNames(on).includes("SOLANA_BACKFILL_ENABLED");
})());
check("20. ⭐⭐ SOLANA_BACKFILL_MAX_ACCOUNTS='1e3' → warning (parseInt→1); '1000' → ok", (() => {
  const bad = validateSolanaEnv(devEnv({ SOLANA_BACKFILL_MAX_ACCOUNTS: "1e3" }));
  const ok  = validateSolanaEnv(devEnv({ SOLANA_BACKFILL_MAX_ACCOUNTS: "1000" }));
  return warningNames(bad).includes("SOLANA_BACKFILL_MAX_ACCOUNTS") && !warningNames(ok).includes("SOLANA_BACKFILL_MAX_ACCOUNTS");
})());

// ── numerice MS (Number()-based > 0) ────────────────────────────────────────────────
check("21. ⭐⭐⭐ SOLANA_PROGRAM_STALE_MS='broken' → warning; '5000'/'5e3' → ok", (() => {
  const bad = validateSolanaEnv(devEnv({ SOLANA_PROGRAM_STALE_MS: "broken" }));
  const ok  = validateSolanaEnv(devEnv({ SOLANA_PROGRAM_STALE_MS: "5000" }));
  const exp = validateSolanaEnv(devEnv({ SOLANA_PROGRAM_STALE_MS: "5e3" }));
  return warningNames(bad).includes("SOLANA_PROGRAM_STALE_MS")
    && !warningNames(ok).includes("SOLANA_PROGRAM_STALE_MS") && !warningNames(exp).includes("SOLANA_PROGRAM_STALE_MS");
})());

// ── FIX #3: cele 19 numerice de cozi (intEnv RAW /^d+$/, FĂRĂ trim) ──────────────────
check("22. ⭐⭐⭐ SOLANA_DISC_DRAIN_CONCURRENCY='broken' → warning (runtime → default tăcut)", (() =>
  warningNames(validateSolanaEnv(devEnv({ SOLANA_DISC_DRAIN_CONCURRENCY: "broken" }))).includes("SOLANA_DISC_DRAIN_CONCURRENCY"))());
check("23. ⭐⭐⭐ coadă RAW (fără trim): SOLANA_ENRICH_LEASE_MS=' 5 ' → warning; '5' → ok (paritate intEnv /^d+$/)", (() => {
  const spaced = validateSolanaEnv(devEnv({ SOLANA_ENRICH_LEASE_MS: " 5 " }));
  const clean  = validateSolanaEnv(devEnv({ SOLANA_ENRICH_LEASE_MS: "5" }));
  return warningNames(spaced).includes("SOLANA_ENRICH_LEASE_MS") && !warningNames(clean).includes("SOLANA_ENRICH_LEASE_MS");
})());
check("24. ⭐⭐ SOLANA_ENRICH_MAX_AGE_MS (câmpul cu default ne-literal, ratat inițial) e validat: 'x' → warning", (() =>
  warningNames(validateSolanaEnv(devEnv({ SOLANA_ENRICH_MAX_AGE_MS: "x" }))).includes("SOLANA_ENRICH_MAX_AGE_MS"))());
check("25. ⭐⭐ '0' pe o coadă → warning (>0; 0 ar bloca drenajul)", (() =>
  warningNames(validateSolanaEnv(devEnv({ SOLANA_DISC_DRAIN_BATCH: "0" }))).includes("SOLANA_DISC_DRAIN_BATCH"))());

// ── Jupiter opțional ────────────────────────────────────────────────────────────────
check("26. ⭐⭐ JUPITER_TOKEN_SEARCH_URL valid → ok; non-URL → warning; JUPITER_API_KEY prezent → ok", (() => {
  const ok  = validateSolanaEnv(devEnv({ JUPITER_TOKEN_SEARCH_URL: "https://lite-api.jup.ag/token/v2/search" }));
  const bad = validateSolanaEnv(devEnv({ JUPITER_TOKEN_SEARCH_URL: "not-a-url" }));
  const key = validateSolanaEnv(devEnv({ JUPITER_API_KEY: "sk-jup-123" }));
  return ok.ok === true && warningNames(bad).includes("JUPITER_TOKEN_SEARCH_URL") && key.ok === true;
})());

// ── colectare + formatare + anti-leak + catalog ─────────────────────────────────────
check("27. ⭐⭐ ambele grupuri goale → 2 probleme colectate (Redis + RPC)", (() => {
  const v = validateSolanaEnv(devEnv({ REDIS_URL: undefined, SOLANA_RPC_URL: undefined }));
  return v.ok === false && problemNames(v).includes("REDIS_URL") && problemNames(v).includes("SOLANA_RPC_URL");
})());
check("28. ⭐ formatEnvValidation(ok) → „[env:indexer-solana] OK\"", formatEnvValidation(validateSolanaEnv(devEnv())).includes("[env:indexer-solana] OK"));
check("29. ⭐⭐⭐ mesajele NU ecouă valoarea (credențiale 's3cr3t' din RPC efectiv → problem, dar valoarea nu apare)", (() => {
  const s = formatEnvValidation(validateSolanaEnv(devEnv({ SOLANA_RPC_URL: "https://user:s3cr3t@rpc.example" })));
  return !/s3cr3t/.test(s) && /SOLANA_RPC_URL/.test(s);
})());
check("30. ⭐ catalog field-runner: 8 fixe + 19 cozi = 27 (grupuri+WS în post-check, NU aici)", solanaEnvFields().length === 27);
check("31. ⭐ REDIS_GROUP/RPC_GROUP au ordinea de precedență din runtime", (() =>
  REDIS_GROUP[0] === "REDIS_URL" && REDIS_GROUP[1] === "REDIS_PRIVATE_URL" && REDIS_GROUP[2] === "REDIS_PUBLIC_URL"
  && RPC_GROUP[0] === "SOLANA_RPC_URL" && RPC_GROUP[1] === "HELIUS_RPC_URL" && RPC_GROUP[2] === "ALCHEMY_SOLANA_RPC_URL")());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
