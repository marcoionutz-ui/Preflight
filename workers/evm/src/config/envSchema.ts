/**
 * config/envSchema.ts — PH-12 12.6 leaf 2a: re-export SUBȚIRE din pachetul neutru `@preflight/env-contracts`.
 *
 * Implementarea canonică (validator + câmpuri + cross-field WS) a fost MUTATĂ în `@preflight/env-contracts/workerEvm.ts`
 * (pachet neutru, ca nicio aplicație să nu depindă de altă aplicație — vezi leaf 2a). Acest fișier păstrează EXACT
 * suprafața de export de dinainte, deci `bootstrap.ts` + `scripts/envSchema.test.ts` rezolvă neschimbat (byte-compat).
 */
export {
  CHAIN_WS_ENV,
  wsEnabledForEnv,
  enabledEvmChains,
  workerEvmEnvFields,
  WORKER_EVM_UNEXPECTED_PREFIXES,
  validateWorkerEvmEnv,
  formatEnvValidation,
} from "@preflight/env-contracts";
export type { EnvSnapshot, EnvValidation } from "@preflight/env-contracts";
