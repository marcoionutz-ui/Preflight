/**
 * config/envSchema.ts — PH-12 slice 12.2c-3b (schema env indexer-solana, pe motorul PARTAJAT `@preflight/config-env`).
 *
 * PARTICULARITĂȚI solana față de EVM:
 *
 * (1) GRUPURI cu precedență `??` (nu câmpuri unice). Redis: `REDIS_URL ?? REDIS_PRIVATE_URL ?? REDIS_PUBLIC_URL`
 *     (`infra/redis.ts`); RPC: `SOLANA_RPC_URL ?? HELIUS_RPC_URL ?? ALCHEMY_SOLANA_RPC_URL` (`infra/rpc.ts`). Runtime-ul
 *     alege PRIMUL membru non-undefined (capcana `??`: un membru cu precedență mare setat PREZENT-DAR-VID `""` blochează
 *     fallback-ul) și îl FOLOSEȘTE ca atare — NU cade la fallback dacă e prezent-dar-invalid. Deci membrul EFECTIV e
 *     OBLIGATORIU: absent/gol → `problem missing`; prezent-dar-invalid (URL greșit, credențiale) → `problem invalid`
 *     (blocker cgpt 12.2c-3b #1 — nu doar prezența). Membrii NEfolosiți prezenți-invalizi → `warning` (nu-s consumați).
 *
 * (2) WS EFECTIV, nu doar overrideul (blocker cgpt 12.2c-3b #2). `getSolanaWsUrl`: override TRUTHY (`if (process.env.
 *     SOLANA_WS_URL)` — non-gol, INCLUSIV `" "`) → folosit ca atare; altfel DERIVAT din RPC efectiv (`https→wss`,
 *     `http→ws`, doar prefixul → un `#fragment` din RPC se propagă). Rezolvăm endpoint-ul EXACT așa și validăm rezultatul
 *     (`wsUrl`): WS inutilizabil → `problem` (workerul solana ascultă logs prin WS; fără el nu funcționează).
 *
 * (3) Vocabular parsare (paritate runtime): `SOLANA_BACKFILL_{ENABLED,FORCE}` `=== "1"` → `exactFlag(["0","1"])`;
 *     `SOLANA_BACKFILL_MAX_ACCOUNTS` `parseInt(... ?? "1000")` → `positiveIntStrict` (trim, ca parseInt);
 *     `SOLANA_{PROGRAM_STALE,PROGRAM_GRACE,WS_STALL}_MS` `Number()` finite `>0` → `finiteNumber{gt:0}`; cele 19 numerice
 *     de COZI (`discovery/discoveryQueue.ts` ×11 + `discovery/enrichQueue.ts` ×8, `intEnv` STRICT `/^\d+$/` pe RAW,
 *     safe-int `>0`, FĂRĂ trim) → `positiveIntStrict({trim:false})` (un `" 5 "` → default la runtime → warning). Jupiter
 *     opțional. `SOLANA_ENRICH_MAX_AGE_MS` avea default ne-literal (ratat de recon-ul restrictiv inițial — vezi doctrina).
 *
 * RPC-urile folosesc `fetchHttpUrl` (endpoint `fetch` → credențialele în URL respinse de `Request`). Validatoarele
 * `fetchHttpUrl`/`wsUrl`/`positiveIntStrict` vin din motor (12.2c-3-engine3).
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

export { formatEnvValidation } from "@preflight/config-env";
export type { EnvSnapshot, EnvValidation } from "@preflight/config-env";

/** Grupul Redis, în ordinea de precedență `??` din `infra/redis.ts`. Primul e canonic. */
export const REDIS_GROUP = ["REDIS_URL", "REDIS_PRIVATE_URL", "REDIS_PUBLIC_URL"] as const;
/** Grupul RPC, în ordinea de precedență `??` din `infra/rpc.ts`. */
export const RPC_GROUP = ["SOLANA_RPC_URL", "HELIUS_RPC_URL", "ALCHEMY_SOLANA_RPC_URL"] as const;

/** Cele 19 numerice de cozi (discoveryQueue ×11 + enrichQueue ×8), toate `intEnv` STRICT `/^\d+$/` pe RAW, `>0`, FĂRĂ trim. */
const QUEUE_INT_FIELDS = [
  "SOLANA_DISC_BACKOFF_BASE_MS", "SOLANA_DISC_BACKOFF_MAX_MS", "SOLANA_DISC_DRAIN_BATCH", "SOLANA_DISC_DRAIN_CONCURRENCY",
  "SOLANA_DISC_DRAIN_INTERVAL_MS", "SOLANA_DISC_ENQUEUE_BACKOFF_BASE_MS", "SOLANA_DISC_ENQUEUE_BACKOFF_MAX_MS",
  "SOLANA_DISC_ENQUEUE_BUFFER_CAP", "SOLANA_DISC_ENQUEUE_FLUSH_INTERVAL_MS", "SOLANA_DISC_LEASE_MS", "SOLANA_DISC_MAX_ATTEMPTS",
  "SOLANA_ENRICH_BACKOFF_BASE_MS", "SOLANA_ENRICH_BACKOFF_MAX_MS", "SOLANA_ENRICH_DRAIN_BATCH", "SOLANA_ENRICH_DRAIN_CONCURRENCY",
  "SOLANA_ENRICH_DRAIN_INTERVAL_MS", "SOLANA_ENRICH_INITIAL_DELAY_MS", "SOLANA_ENRICH_LEASE_MS", "SOLANA_ENRICH_MAX_AGE_MS",
] as const;

/** „Prezent" local: non-gol după trim (un env `""`/whitespace NU numără ca setat). */
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
 * Câmpurile validate prin field-runner: backfill, MAX_ACCOUNTS, MS de program, Jupiter, cele 19 numerice de cozi.
 * GRUPURILE Redis/RPC + WS efectiv NU sunt aici — au semantică de grup/derivare, gestionate în post-check.
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

export const SOLANA_UNEXPECTED_PREFIXES: readonly string[] = [] as const;

/**
 * Validează un GRUP cu precedență `??`. Membrul EFECTIV (cel pe care runtime-l folosește) e OBLIGATORIU: absent/gol →
 * `problem missing`; prezent-dar-invalid → `problem invalid`. Membrii NEfolosiți prezenți-invalizi → `warning`.
 * Întoarce și valoarea efectivă VALIDĂ (pt. derivarea WS din RPC). Mesajele NU ecouă valoarea.
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
 * Dacă RPC-ul e deja invalid/absent (semnalat de grupul RPC) și nu există override, NU dublăm eroarea aici.
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
