/**
 * config/envSchema.ts — PH-12 12.6 leaf 2a: re-export SUBȚIRE din pachetul neutru `@preflight/env-contracts`.
 *
 * Implementarea canonică a fost MUTATĂ în `@preflight/env-contracts/indexerEvm.ts`. Suprafața de export păstrată EXACT
 * (byte-compat pentru `bootstrap.ts` + `scripts/envSchema.test.ts`). Constantele private de flags/numerice NU erau
 * exportate nici înainte — rămân private în modulul neutru.
 */
export {
  CHAIN_RPC_ENV,
  enabledIndexerChains,
  indexerEvmEnvFields,
  INDEXER_EVM_UNEXPECTED_PREFIXES,
  validateIndexerEvmEnv,
  formatEnvValidation,
} from "@preflight/env-contracts";
export type { EnvSnapshot, EnvValidation } from "@preflight/env-contracts";
