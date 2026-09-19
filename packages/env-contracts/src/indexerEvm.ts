/**
 * env-contracts/src/indexerEvm.ts — PH-12 12.6 leaf 2a: implementarea CANONICĂ a contractului de env indexer-evm.
 *
 * MUTAT din `workers/indexer-evm/src/config/envSchema.ts` (12.2c-3a) fără schimbare de comportament. Motorul rămâne
 * `@preflight/config-env`. Constantele de flags/numerice rămân PRIVATE (niciun consumator public) — sunt folosite DOAR
 * pentru derivarea câmpurilor ȘI a allowlist-ului de proveniență. NOU: `INDEXER_EVM_PROBLEM_KEYS` (leaf 2a).
 *
 * CROSS-FIELD: pentru fiecare chain care INDEXEAZĂ efectiv, `ALCHEMY_<CHAIN>_RPC` devine OBLIGATORIU. `base` MEREU activ;
 * restul pe `INDEXER_ENABLE_<CHAIN>=1`. Vocabular byte-exact (`exactFlag`), numerice pe DOUĂ parsere (`finiteNumber`
 * `Number()`-based vs `positiveIntStrict` parseInt-based). RPC-urile folosesc `fetchHttpUrl` (credențiale în URL respinse).
 * Naming 1:1 cu `rpc.ts` (`bsc`→`ALCHEMY_BNB_RPC`).
 */

import {
  validateEnv,
  redisUrl,
  fetchHttpUrl,
  exactFlag,
  finiteNumber,
  positiveIntStrict,
  type FieldSpec,
  type EnvSnapshot,
  type EnvValidation,
} from "@preflight/config-env";

/** Chain id canonic → env-ul RPC HTTP pe care `rpc.ts` îl citește. `bsc` → `ALCHEMY_BNB_RPC` (naming inconsistent, 1:1). */
export const CHAIN_RPC_ENV: Readonly<Record<string, string>> = Object.freeze({
  base:     "ALCHEMY_BASE_RPC",
  bsc:      "ALCHEMY_BNB_RPC",
  arbitrum: "ALCHEMY_ARB_RPC",
  ethereum: "ALCHEMY_ETH_RPC",
} as const);

/** Chain id (non-base) → flag-ul de activare (`=== "1"`). `base` NU e aici: e MEREU activ (Faza 6.0). PRIVAT + înghețat. */
const CHAIN_ENABLE_ENV: Readonly<Record<string, string>> = Object.freeze({
  bsc:      "INDEXER_ENABLE_BSC",
  arbitrum: "INDEXER_ENABLE_ARBITRUM",
  ethereum: "INDEXER_ENABLE_ETHEREUM",
} as const);

/** Flag-uri bool `1/0` (byte-exact `=== "1"` în `factories.ts`). PRIVAT (derivare câmpuri + catalog). */
const ZERO_ONE_FLAGS = ["INDEXER_ENABLE_BSC", "INDEXER_ENABLE_ARBITRUM", "INDEXER_ENABLE_ETHEREUM", "INDEXER_ENABLE_V4"] as const;
/** Flag-uri bool `true/false` (`!== "false"` / `=== "true"`). PRIVAT. */
const TRUE_FALSE_FLAGS = ["INDEXER_DRY_RUN", "INDEXER_DRY_RUN_ADVANCE_CURSOR", "INDEXER_SKIP_TO_LATEST"] as const;

/**
 * Numerice `Number()`-based, prag `> 0` (chei STATICE). Surse: `config/env.ts intEnv` + `quotePrices.ts envNum`
 * (`SEQUENCER_GRACE_SEC`/`CHAINLINK_MAX_STALE_SEC`) — ambele `Number(x)` finite `> 0` → floor. PRIVAT.
 */
const NUMERIC_GT0_FIELDS = [
  "INDEXER_METADATA_RPC_TIMEOUT_MS",
  "INDEXER_REPRICE_INTERVAL_MS", "INDEXER_REPRICE_STALE_MS", "INDEXER_REPRICE_TOP_K",
  "INDEXER_REPRICE_CONCURRENCY", "INDEXER_REPRICE_BATCH",
  "INDEXER_ENRICH_DRAIN_CONCURRENCY", "INDEXER_ENRICH_DRAIN_BATCH", "INDEXER_ENRICH_DRAIN_INTERVAL_MS",
  "INDEXER_ENRICH_LEASE_MS", "INDEXER_ENRICH_MAX_ATTEMPTS",
  "INDEXER_ENRICH_REPAIR_INTERVAL_MS", "INDEXER_ENRICH_REPAIR_SCAN_K",
  "INDEXER_ENRICH_BACKOFF_BASE_MS", "INDEXER_ENRICH_BACKOFF_MAX_MS",
  "INDEXER_SEQUENCER_GRACE_SEC", "INDEXER_CHAINLINK_MAX_STALE_SEC",
] as const;

/**
 * Numerice STATICE cu validatoare DISTINCTE (nu intră în `NUMERIC_GT0_FIELDS`): `INDEXER_RPC_TIMEOUT_MS` (parseInt-strict
 * via `positiveIntStrict`) + `INDEXER_CONFIRMATION_DEPTH` (`finiteNumber {gte:0}`, 0 = dezactivat). PRIVAT — sursă unică a
 * numelor pentru câmpuri ȘI catalog (evită drift între cele două literale).
 */
const STATIC_INT_FIELDS = ["INDEXER_RPC_TIMEOUT_MS", "INDEXER_CONFIRMATION_DEPTH"] as const;

/**
 * Chain-urile care INDEXEAZĂ efectiv (oglindește `factories.ts`). `base` mereu; restul pe `INDEXER_ENABLE_<CHAIN>=1`.
 * Setul nu e niciodată gol (base garantează ≥1).
 */
export function enabledIndexerChains(env: EnvSnapshot): string[] {
  const out: string[] = ["base"];
  for (const [chain, flag] of Object.entries(CHAIN_ENABLE_ENV)) {
    if (env[flag] === "1") out.push(chain);
  }
  return out;
}

/**
 * Câmpurile indexer-evm, DERIVATE din env. `REDIS_URL` obligatoriu. Flag-urile + numericele opționale. Cross-field:
 * fiecare chain activ adaugă `ALCHEMY_<CHAIN>_RPC` OBLIGATORIU + un override opțional `INDEXER_CONFIRMATION_DEPTH_<CHAIN>`.
 */
export function indexerEvmEnvFields(env: EnvSnapshot): FieldSpec[] {
  const fields: FieldSpec[] = [
    { name: "REDIS_URL", required: () => true, validate: redisUrl() },
  ];
  for (const name of ZERO_ONE_FLAGS) {
    fields.push({ name, required: () => false, validate: exactFlag(name, ["0", "1"]) });
  }
  for (const name of TRUE_FALSE_FLAGS) {
    fields.push({ name, required: () => false, validate: exactFlag(name, ["true", "false"]) });
  }
  for (const name of NUMERIC_GT0_FIELDS) {
    fields.push({ name, required: () => false, validate: finiteNumber(name, { gt: 0 }) });
  }
  fields.push(
    { name: STATIC_INT_FIELDS[0], required: () => false, validate: positiveIntStrict(STATIC_INT_FIELDS[0]) },
    { name: STATIC_INT_FIELDS[1], required: () => false, validate: finiteNumber(STATIC_INT_FIELDS[1], { gte: 0 }) },
  );
  for (const chain of enabledIndexerChains(env)) {
    const rpcEnv = CHAIN_RPC_ENV[chain];
    fields.push({ name: rpcEnv, required: () => true, validate: fetchHttpUrl(rpcEnv) });
    const depthEnv = `INDEXER_CONFIRMATION_DEPTH_${chain.toUpperCase()}`;
    fields.push({ name: depthEnv, required: () => false, validate: finiteNumber(depthEnv, { gte: 0 }) });
  }
  return fields;
}

/** Surplus pe rol: NEcablat deocamdată (`[]`). */
export const INDEXER_EVM_UNEXPECTED_PREFIXES: readonly string[] = Object.freeze([]);

/** Validează env-ul indexer-evm. Discriminat. */
export function validateIndexerEvmEnv(env: EnvSnapshot): EnvValidation {
  return validateEnv("indexer-evm", indexerEvmEnvFields(env), INDEXER_EVM_UNEXPECTED_PREFIXES, env);
}

/**
 * PROVENIENȚĂ (leaf 2a): numele pe care `validateIndexerEvmEnv` le poate emite în `problem.name` — DERIVAT din exact
 * constantele private de mai sus + `CHAIN_RPC_ENV` + template-ul de depth per-chain. `validateIndexerEvmEnv` NU are
 * post-check (toate numele vin din `indexerEvmEnvFields`), deci universul = câmpurile peste TOATE chain-urile active.
 */
export const INDEXER_EVM_PROBLEM_KEYS: readonly string[] = Object.freeze([
  "REDIS_URL",
  ...ZERO_ONE_FLAGS,
  ...TRUE_FALSE_FLAGS,
  ...NUMERIC_GT0_FIELDS,
  ...STATIC_INT_FIELDS,
  ...Object.values(CHAIN_RPC_ENV),
  ...Object.keys(CHAIN_RPC_ENV).map((c) => `INDEXER_CONFIRMATION_DEPTH_${c.toUpperCase()}`),
]);
