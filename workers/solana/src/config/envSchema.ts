/**
 * config/envSchema.ts — PH-12 12.6 leaf 2a: re-export SUBȚIRE din pachetul neutru `@preflight/env-contracts`.
 *
 * Implementarea canonică a fost MUTATĂ în `@preflight/env-contracts/solana.ts`. Suprafața de export păstrată EXACT
 * (byte-compat pentru `bootstrap.ts` + `scripts/envSchema.test.ts`). Helper-ele private (grupuri, WS efectiv) rămân
 * private în modulul neutru.
 */
export {
  REDIS_GROUP,
  RPC_GROUP,
  solanaEnvFields,
  SOLANA_UNEXPECTED_PREFIXES,
  validateSolanaEnv,
  formatEnvValidation,
} from "@preflight/env-contracts";
export type { EnvSnapshot, EnvValidation } from "@preflight/env-contracts";
