/**
 * config/envSchema.ts — PH-12 slice 12.2c-3a (schema env indexer-evm, pe motorul PARTAJAT `@preflight/config-env`).
 *
 * CROSS-FIELD principal (oglindește `infra/rpc.ts` + `config/factories.ts`): pentru fiecare chain care INDEXEAZĂ efectiv,
 * `ALCHEMY_<CHAIN>_RPC` (HTTP RPC) devine OBLIGATORIU. Runtime: `getRpcUrl(chain)` întoarce `process.env.ALCHEMY_<X>_RPC`
 * SAU `""` (fallback tăcut) → un chain pornit fără RPC-ul lui eșuează la prima cerere (client cu URL gol), nu degradează
 * grațios. `base` e MEREU activ (Faza 6.0, `factories.ts` `enabled:true`); `bsc`/`arbitrum`/`ethereum` pornesc DOAR pe
 * `INDEXER_ENABLE_<CHAIN>=1`. `V4` e un KIND de pool pe chain-urile deja active (nu un chain nou) → nu adaugă RPC.
 *
 * PARITATE cu runtime-ul (vocabular byte-exact, NU bool permisiv — lecția 12.2e/12.2c):
 *   - `INDEXER_ENABLE_{BSC,ARBITRUM,ETHEREUM,V4}` — `=== "1"` (`factories.ts`) → `exactFlag(name, ["0","1"])`;
 *   - `INDEXER_DRY_RUN` — `!== "false"` (default DRY; `discoveryLoop.ts`) → `exactFlag(name, ["true","false"])`. Capcană:
 *     `INDEXER_DRY_RUN=0` NU dezactivează dry (`"0" !== "false"` → tot dry) — recunoaștem DOAR `true`/`false`;
 *   - `INDEXER_SKIP_TO_LATEST` / `INDEXER_DRY_RUN_ADVANCE_CURSOR` — `=== "true"` → `exactFlag(name, ["true","false"])`.
 *
 * NUMERICE — DOUĂ vocabulare de parsare (fix cgpt 12.2c-3a, obs. #2):
 *   - `Number()`-based (`config/env.ts intEnv` + `quotePrices.ts envNum`, ambele `Number(x)` finite `> 0` → floor):
 *     TOATE câmpurile de repricing/enrichment/metadata + `SEQUENCER_GRACE_SEC`/`CHAINLINK_MAX_STALE_SEC` → `finiteNumber
 *     {gt:0}` (tolerează `1e3` ca runtime). `INDEXER_CONFIRMATION_DEPTH*` (`cursor.ts` Number `>= 0`, 0 = dezactivat) → `{gte:0}`.
 *   - `parseInt`-based (`infra/rpc.ts intEnv` = `parseInt(v,10)` finite `> 0`): `INDEXER_RPC_TIMEOUT_MS` → `parseIntMs`
 *     LOCAL. CRUCIAL: `parseInt("1e3",10) === 1` (nu 1000) → o valoare exponent devine 1 ms TĂCUT. De aceea cerem cifre
 *     CURATE (`/^\d+$/`), respingând `1e3`/`15abc`/`1.5` pe care runtime le-ar tăia înșelător (NU e paritate oarbă:
 *     runtime le-ar „accepta" trunchiate, dar intenția operatorului e pierdută → semnalăm).
 *
 * `REDIS_URL` obligatoriu (`infra/redis.ts`/`cursor.ts` fail-closed fără el). RPC-urile folosesc `rpcHttpUrl` (nu doar
 * `absoluteUrl`): constructorul `Request`/`fetch` RESPINGE credențialele în URL (`user:pass@host`) ÎNAINTE de conexiune →
 * un RPC cu credențiale ar eșua la prima cerere, deci îl marcăm invalid la boot (fix cgpt 12.2c-3a, obs. #1). Câmpurile NU
 * sunt statice — RPC-urile obligatorii + override-urile de depth per-chain se DERIVĂ din chain-urile active. Naming 1:1
 * cu `rpc.ts`: id-ul canonic `bsc` → env-ul `ALCHEMY_BNB_RPC`.
 *
 * RĂMASE INTENȚIONAT ÎN AFARA acestui leaf (chei DINAMICE per chain/symbol/label + semantică non-int, low-stakes pricing;
 * merită un leaf dedicat dacă se dorește): `INDEXER_{WETH,BNB,...}_USD` (preț float fallback, `quotePrices.ts`),
 * `INDEXER_STABLE_FEED_<CHAIN>_<SYMBOL>` + `INDEXER_SEQUENCER_FEED_<CHAIN>` (adrese Chainlink), `INDEXER_FEED_MAX_STALE_
 * <CHAIN>_<LABEL>` (staleness sec) — cheile lor sunt template-derivate, ne-enumerabile static fără vocabularul chain×symbol.
 * `INDEXER_INITIAL_LOOKBACK_BLOCKS`/`INDEXER_VERSION`/`INDEXER_PRIMARY` NU sunt env (constante/comentarii în cod).
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

export { formatEnvValidation } from "@preflight/config-env";
export type { EnvSnapshot, EnvValidation } from "@preflight/config-env";

/** Chain id canonic → env-ul RPC HTTP pe care `rpc.ts` îl citește. `bsc` → `ALCHEMY_BNB_RPC` (naming inconsistent, 1:1 cu codul). */
export const CHAIN_RPC_ENV: Readonly<Record<string, string>> = {
  base:     "ALCHEMY_BASE_RPC",
  bsc:      "ALCHEMY_BNB_RPC",
  arbitrum: "ALCHEMY_ARB_RPC",
  ethereum: "ALCHEMY_ETH_RPC",
} as const;

/** Chain id (non-base) → flag-ul de activare (`=== "1"`). `base` NU e aici: e MEREU activ (Faza 6.0). */
const CHAIN_ENABLE_ENV: Readonly<Record<string, string>> = {
  bsc:      "INDEXER_ENABLE_BSC",
  arbitrum: "INDEXER_ENABLE_ARBITRUM",
  ethereum: "INDEXER_ENABLE_ETHEREUM",
} as const;

/** Flag-uri bool `1/0` (byte-exact `=== "1"` în `factories.ts`). */
const ZERO_ONE_FLAGS = ["INDEXER_ENABLE_BSC", "INDEXER_ENABLE_ARBITRUM", "INDEXER_ENABLE_ETHEREUM", "INDEXER_ENABLE_V4"] as const;
/** Flag-uri bool `true/false` (`!== "false"` / `=== "true"` în `discoveryLoop.ts`/`index.ts`). */
const TRUE_FALSE_FLAGS = ["INDEXER_DRY_RUN", "INDEXER_DRY_RUN_ADVANCE_CURSOR", "INDEXER_SKIP_TO_LATEST"] as const;

/**
 * Numerice `Number()`-based, prag `> 0` (chei STATICE consumate la config). Sursele: `config/env.ts intEnv` (repricing/
 * enrichment/metadata) + `quotePrices.ts envNum` (`SEQUENCER_GRACE_SEC`/`CHAINLINK_MAX_STALE_SEC`) — ambele `Number(x)`
 * finite `> 0` → floor, deci un vocabular unic. Valoare invalidă → runtime cade TĂCUT pe default → warning.
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
 * Chain-urile care INDEXEAZĂ efectiv (oglindește `factories.ts`). `base` mereu; restul pe `INDEXER_ENABLE_<CHAIN>=1`
 * (byte-exact). Ordine stabilă (base întâi). Setul nu e niciodată gol (base garantează ≥1) → fără caz de selecție goală.
 */
export function enabledIndexerChains(env: EnvSnapshot): string[] {
  const out: string[] = ["base"];
  for (const [chain, flag] of Object.entries(CHAIN_ENABLE_ENV)) {
    if (env[flag] === "1") out.push(chain);
  }
  return out;
}

/**
 * Câmpurile indexer-evm, DERIVATE din env. `REDIS_URL` obligatoriu. Flag-urile + numericele opționale (validate-when-
 * present → warning). Cross-field: fiecare chain activ adaugă `ALCHEMY_<CHAIN>_RPC` OBLIGATORIU (rpcHttpUrl) + un override
 * opțional `INDEXER_CONFIRMATION_DEPTH_<CHAIN>` (finiteNumber `>= 0`).
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
    { name: "INDEXER_RPC_TIMEOUT_MS",     required: () => false, validate: positiveIntStrict("INDEXER_RPC_TIMEOUT_MS") },
    { name: "INDEXER_CONFIRMATION_DEPTH", required: () => false, validate: finiteNumber("INDEXER_CONFIRMATION_DEPTH", { gte: 0 }) },
  );
  for (const chain of enabledIndexerChains(env)) {
    const rpcEnv = CHAIN_RPC_ENV[chain];
    fields.push({ name: rpcEnv, required: () => true, validate: fetchHttpUrl(rpcEnv) });
    const depthEnv = `INDEXER_CONFIRMATION_DEPTH_${chain.toUpperCase()}`;
    fields.push({ name: depthEnv, required: () => false, validate: finiteNumber(depthEnv, { gte: 0 }) });
  }
  return fields;
}

/**
 * Surplus pe rol: NEcablat deocamdată (`[]`). Indexer citește legitim `ALCHEMY_*_RPC` + `INDEXER_*`; un allowlist de
 * prefixe fără inventarul Railway al indexer-ului ar risca fals-pozitive. Inventarul complet de surplus rămâne pt. un leaf ulterior.
 */
export const INDEXER_EVM_UNEXPECTED_PREFIXES: readonly string[] = [] as const;

/** Validează env-ul indexer-evm. Discriminat: `ok:true` (+ warnings) sau `ok:false` (+ problems + warnings). */
export function validateIndexerEvmEnv(env: EnvSnapshot): EnvValidation {
  return validateEnv("indexer-evm", indexerEvmEnvFields(env), INDEXER_EVM_UNEXPECTED_PREFIXES, env);
}
