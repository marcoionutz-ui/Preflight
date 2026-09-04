/**
 * src/bootstrap.ts — PH-12 slice 12.2d (boot-guard indexer-solana).
 *
 * ENTRY-POINT REAL al serviciului (cablat în `package.json` `start`/`dev` → Railway `npm run start`). Ordinea e
 * ESENȚIALĂ (12.2d): env (din `--env-file`/Railway, deja în `process.env`) → validare → ABIA APOI `import()` DINAMIC al
 * modulului care pornește serviciul. `src/index.ts` importă module cu efecte (`getRedis`, RPC, subscripții) și pornește
 * `main().catch(...)` la top-level; importul dinamic amână toate astea până după ce env-ul e dovedit valid.
 *
 * SOLANA nu folosește `dotenv` (spre deosebire de indexer-evm) — env-ul vine din `tsx --env-file` (dev) sau Railway (prod),
 * deci bootstrap-ul NU cheamă `dotenv.config()` (ar schimba precedența). Doar validează `process.env`. Runtime-ul aruncă
 * ferm pe config lipsă (`getRedis`/`getSolanaRpcUrl` throw pe grup Redis/RPC gol) — boot-guard-ul le prinde ÎNAINTE, cu
 * diagnostic clar, în loc de un stack-trace criptic la prima folosire.
 *
 * POLITICĂ (neschimbată): `problems` → `formatEnvValidation` (fără valori/secrete) + `exitCode = 1`, `./index` NU se
 * încarcă. DOAR `warnings` → log + continuare. Motorul rămâne PUR; oprirea aparține AICI. NU pinguim Redis/RPC.
 * `process.exitCode = 1` (NU `process.exit(1)`): fără import, event-loop-ul se golește și procesul iese cu 1 DUPĂ ce
 * output-ul s-a scris complet.
 */

import { validateSolanaEnv, formatEnvValidation } from "./config/envSchema";

const result = validateSolanaEnv(process.env);

if (!result.ok) {
  console.error(formatEnvValidation(result));
  console.error("[BOOT][indexer-solana] configurație env invalidă — opresc înainte de pornire (niciun modul de serviciu nu s-a încărcat).");
  process.exitCode = 1;
} else {
  console.log(formatEnvValidation(result)); // pe OK: „[env:indexer-solana] OK"; pe warnings le listează (nu opresc)
  console.log("[BOOT][indexer-solana] env valid — pornesc serviciul.");
  void import("./index").catch((err) => {
    console.error("[BOOT][indexer-solana] pornire eșuată după validare:", err);
    process.exitCode = 1;
  });
}
