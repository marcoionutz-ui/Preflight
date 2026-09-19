/**
 * env-contracts/src/solana.ts — PH-12 12.6 leaf 2a: implementarea CANONICĂ a contractului de env indexer-solana.
 *
 * MUTAT din `workers/solana/src/config/envSchema.ts` (12.2c-3b) fără schimbare de comportament. Motorul rămâne
 * `@preflight/config-env`. NOU: `SOLANA_PROBLEM_KEYS` (leaf 2a) — include ȘI numele emise din POST-CHECK-uri (grupurile
 * Redis/RPC + `SOLANA_WS_URL`), nu doar `solanaEnvFields()`.
 *
 * PARTICULARITĂȚI: (1) GRUPURI cu precedență `??` (Redis/RPC) — membrul EFECTIV e obligatoriu; (2) WS EFECTIV (override
 * truthy INCLUSIV `" "`, altfel derivat din RPC); (3) 19 numerice de cozi `intEnv` STRICT `/^\d+$/` pe RAW fără trim.
 */

import {
  validateEnv,
  isProd,
  redisUrl,
  fetchHttpUrl,
  wsUrl,
  exactFlag,
  finiteNumber,
  positiveIntStrict,
  nonEmpty,
  type Validate,
  type FieldSpec,
  type EnvProblem,
  type EnvWarning,
  type EnvSnapshot,
  type EnvValidation,
} from "@preflight/config-env";

/** Grupul Redis, în ordinea de precedență `??` din `infra/redis.ts`. Primul e canonic. */
export const REDIS_GROUP = Object.freeze(["REDIS_URL", "REDIS_PRIVATE_URL", "REDIS_PUBLIC_URL"] as const);
/** Grupul RPC, în ordinea de precedență `??` din `infra/rpc.ts`. Înghețat (trust-root de proveniență, P1 cgpt). */
export const RPC_GROUP = Object.freeze(["SOLANA_RPC_URL", "HELIUS_RPC_URL", "ALCHEMY_SOLANA_RPC_URL"] as const);

/** Cele 19 numerice de cozi (discoveryQueue ×11 + enrichQueue ×8), `intEnv` STRICT `/^\d+$/` pe RAW, `>0`, FĂRĂ trim. PRIVAT. */
const QUEUE_INT_FIELDS = [
  "SOLANA_DISC_BACKOFF_BASE_MS", "SOLANA_DISC_BACKOFF_MAX_MS", "SOLANA_DISC_DRAIN_BATCH", "SOLANA_DISC_DRAIN_CONCURRENCY",
  "SOLANA_DISC_DRAIN_INTERVAL_MS", "SOLANA_DISC_ENQUEUE_BACKOFF_BASE_MS", "SOLANA_DISC_ENQUEUE_BACKOFF_MAX_MS",
  "SOLANA_DISC_ENQUEUE_BUFFER_CAP", "SOLANA_DISC_ENQUEUE_FLUSH_INTERVAL_MS", "SOLANA_DISC_LEASE_MS", "SOLANA_DISC_MAX_ATTEMPTS",
  "SOLANA_ENRICH_BACKOFF_BASE_MS", "SOLANA_ENRICH_BACKOFF_MAX_MS", "SOLANA_ENRICH_DRAIN_BATCH", "SOLANA_ENRICH_DRAIN_CONCURRENCY",
  "SOLANA_ENRICH_DRAIN_INTERVAL_MS", "SOLANA_ENRICH_INITIAL_DELAY_MS", "SOLANA_ENRICH_LEASE_MS", "SOLANA_ENRICH_MAX_AGE_MS",
] as const;

/** „Prezent" local: non-gol după trim. */
function isPresent(raw: string | undefined): raw is string {
  return typeof raw === "string" && raw.trim() !== "";
}

/** Membrul EFECTIV al unui grup, EXACT ca runtime (`a ?? b ?? c`): primul NON-undefined (poate fi `""`). */
function effectiveMember(env: EnvSnapshot, group: readonly string[]): { name: string; value: string } | { name: string; value: undefined } | null {
  for (const name of group) {
    if (env[name] !== undefined) return { name, value: env[name] as string };
  }
  return null; // toți absenți
}

/** Derivă WS din RPC EXACT ca `getSolanaWsUrl` (doar prefixul; un `#fragment` se propagă). */
function deriveWsFromRpc(rpc: string): string {
  return rpc.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
}

/**
 * Câmpurile validate prin field-runner. GRUPURILE Redis/RPC + WS efectiv NU sunt aici — au semantică de grup/derivare,
 * gestionate în post-check.
 */
export function solanaEnvFields(): FieldSpec[] {
  const fields: FieldSpec[] = [
    { name: "SOLANA_BACKFILL_ENABLED",      required: () => false, validate: exactFlag("SOLANA_BACKFILL_ENABLED", ["0", "1"]) },
    { name: "SOLANA_BACKFILL_FORCE",        required: () => false, validate: exactFlag("SOLANA_BACKFILL_FORCE", ["0", "1"]) },
    { name: "SOLANA_BACKFILL_MAX_ACCOUNTS", required: () => false, validate: positiveIntStrict("SOLANA_BACKFILL_MAX_ACCOUNTS") },
    { name: "SOLANA_PROGRAM_STALE_MS",      required: () => false, validate: finiteNumber("SOLANA_PROGRAM_STALE_MS", { gt: 0 }) },
    { name: "SOLANA_PROGRAM_GRACE_MS",      required: () => false, validate: finiteNumber("SOLANA_PROGRAM_GRACE_MS", { gt: 0 }) },
    { name: "SOLANA_WS_STALL_MS",           required: () => false, validate: finiteNumber("SOLANA_WS_STALL_MS", { gt: 0 }) },
    { name: "JUPITER_API_KEY",              required: () => false, validate: nonEmpty },
    { name: "JUPITER_TOKEN_SEARCH_URL",     required: () => false, validate: fetchHttpUrl("JUPITER_TOKEN_SEARCH_URL") },
  ];
  for (const name of QUEUE_INT_FIELDS) {
    fields.push({ name, required: () => false, validate: positiveIntStrict(name, { trim: false }) });
  }
  return fields;
}

export const SOLANA_UNEXPECTED_PREFIXES: readonly string[] = Object.freeze([]);

/**
 * Validează un GRUP cu precedență `??`. Membrul EFECTIV e OBLIGATORIU: absent/gol → `problem missing`; prezent-dar-invalid
 * → `problem invalid`. Membrii NEfolosiți prezenți-invalizi → `warning`. Întoarce și valoarea efectivă VALIDĂ (pt. WS).
 */
function validateGroup(
  env: EnvSnapshot, group: readonly string[], validator: (label: string) => Validate, label: string, prod: boolean,
): { problems: EnvProblem[]; warnings: EnvWarning[]; validValue: string | null } {
  const problems: EnvProblem[] = [];
  const warnings: EnvWarning[] = [];
  const eff = effectiveMember(env, group);
  let validValue: string | null = null;

  if (eff === null || !isPresent(eff.value)) {
    problems.push({
      name: eff?.name ?? group[0],
      kind: "missing",
      detail: `niciun ${label} utilizabil din ${group.join(" / ")} (absent, sau un membru prezent-dar-vid blochează fallback-ul ??) — workerul solana n-ar porni`,
    });
  } else {
    const err = validator(eff.name)(eff.value, prod);
    if (err !== null) problems.push({ name: eff.name, kind: "invalid", detail: err });
    else validValue = eff.value;
  }

  for (const name of group) {
    if (eff !== null && name === eff.name) continue;
    const v = env[name];
    if (isPresent(v)) {
      const err = validator(name)(v, prod);
      if (err !== null) warnings.push({ name, detail: `${err} — membru neutilizat (${eff?.name ?? group[0]} are precedență ??)` });
    }
  }
  return { problems, warnings, validValue };
}

/**
 * Validează endpoint-ul WS EFECTIV (override truthy → folosit; altfel derivat din RPC valid). WS inutilizabil → `problem`.
 * Dacă RPC-ul e deja invalid/absent și nu există override, NU dublăm eroarea aici.
 */
function validateEffectiveWs(env: EnvSnapshot, rpcValid: string | null, prod: boolean): EnvProblem[] {
  const override = env.SOLANA_WS_URL;
  let wsEff: string | null = null;
  if (override !== undefined && override !== "") {
    wsEff = override; // runtime: `if (process.env.SOLANA_WS_URL)` — truthy, INCLUSIV " "
  } else if (rpcValid !== null) {
    wsEff = deriveWsFromRpc(rpcValid);
  }
  if (wsEff === null) return []; // fără override și fără RPC valid → grupul RPC acoperă deja
  const err = wsUrl("SOLANA_WS_URL")(wsEff, prod);
  return err !== null ? [{ name: "SOLANA_WS_URL", kind: "invalid", detail: err }] : [];
}

/** Validează env-ul indexer-solana. Discriminat. Grupuri Redis/RPC + WS efectiv gestionate în post-check. */
export function validateSolanaEnv(env: EnvSnapshot): EnvValidation {
  const prod = isProd(env);
  const base = validateEnv("indexer-solana", solanaEnvFields(), SOLANA_UNEXPECTED_PREFIXES, env);

  const redis = validateGroup(env, REDIS_GROUP, redisUrl, "Redis", prod);
  const rpc = validateGroup(env, RPC_GROUP, fetchHttpUrl, "RPC", prod);
  const wsProblems = validateEffectiveWs(env, rpc.validValue, prod);

  const problems: EnvProblem[] = [...(base.ok ? [] : base.problems), ...redis.problems, ...rpc.problems, ...wsProblems];
  const warnings: EnvWarning[] = [...base.warnings, ...redis.warnings, ...rpc.warnings];

  if (problems.length === 0) return { ok: true, role: base.role, warnings };
  return { ok: false, role: base.role, problems, warnings };
}

/**
 * PROVENIENȚĂ (leaf 2a): numele pe care `validateSolanaEnv` le poate emite în `problem.name`. Include câmpurile
 * field-runner (`solanaEnvFields()`) + POST-CHECK-urile: membrii grupurilor Redis/RPC (emiși ca missing/invalid) +
 * `SOLANA_WS_URL`. Dedup prin `Set`.
 */
export const SOLANA_PROBLEM_KEYS: readonly string[] = Object.freeze([
  ...new Set<string>([
    ...solanaEnvFields().map((f) => f.name),
    ...REDIS_GROUP,
    ...RPC_GROUP,
    "SOLANA_WS_URL",
  ]),
]);
