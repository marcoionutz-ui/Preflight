/**
 * env-contracts/src/index.ts — PH-12 12.6 leaf 2a: barrel-ul public al contractelor de env pentru cele trei roluri worker.
 *
 * Pachet NEUTRU: deține implementarea canonică a validatoarelor + cataloagelor de proveniență (`*_PROBLEM_KEYS`) pentru
 * worker-evm / indexer-evm / indexer-solana. Workerii îl re-exportă subțire (`workers/<rol>/src/config/envSchema.ts`), iar
 * tooling-ul de profil (`bindRoleCaps`, leaf 2a) importă DOAR de aici — nicio aplicație nu depinde de altă aplicație.
 *
 * P1 (anti-TS2308): `formatEnvValidation` + tipurile `EnvSnapshot`/`EnvValidation` se exportă O SINGURĂ DATĂ, direct din
 * motor. Modulele de rol NU le mai re-exportă (altfel `export *` ar produce export ambiguu). Fiecare `export *` de rol
 * aduce DOAR simbolurile UNICE ale rolului.
 */

export { formatEnvValidation } from "@preflight/config-env";
export type { EnvSnapshot, EnvValidation } from "@preflight/config-env";

export * from "./workerEvm";
export * from "./indexerEvm";
export * from "./solana";
