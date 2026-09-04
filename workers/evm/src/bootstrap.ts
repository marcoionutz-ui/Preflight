/**
 * src/bootstrap.ts — PH-12 slice 12.2d (boot-guard worker-evm).
 *
 * ENTRY-POINT REAL (cablat în `package.json` `start`/`dev` → Railway `npm run start`). Ordinea e ESENȚIALĂ (12.2d):
 * `dotenv.config()` (ACELAȘI mecanism ca `index.ts`; dev-ul mai are `--env-file`) → validare → ABIA APOI `import()`
 * DINAMIC al modulului care pornește serviciul. `src/index.ts` are markere + `connectChainWebSocket` la top-level și un
 * IIFE async care restaurează memoria din Redis — un simplu apel după importurile STATICE ar rula acele efecte ÎNAINTE
 * de validare. Importul dinamic le amână până după ce env-ul e dovedit valid.
 *
 * POLITICĂ (neschimbată): `problems` → `formatEnvValidation` (fără valori/secrete) + `exitCode = 1`, `./index` NU se
 * încarcă. DOAR `warnings` → log + continuare. Motorul rămâne PUR; oprirea aparține AICI. NU pinguim Redis/WS/RPC.
 * `process.exitCode = 1` (NU `exit()`): fără import, event-loop-ul se golește și procesul iese cu 1 DUPĂ ce output-ul e scris.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { validateWorkerEvmEnv, formatEnvValidation } from "./config/envSchema";

const result = validateWorkerEvmEnv(process.env);

if (!result.ok) {
  console.error(formatEnvValidation(result));
  console.error("[BOOT][worker-evm] configurație env invalidă — opresc înainte de pornire (niciun modul de serviciu nu s-a încărcat).");
  process.exitCode = 1;
} else {
  console.log(formatEnvValidation(result)); // pe OK: „[env:worker-evm] OK"; pe warnings le listează (nu opresc)
  console.log("[BOOT][worker-evm] env valid — pornesc serviciul.");
  void import("./index").catch((err) => {
    console.error("[BOOT][worker-evm] pornire eșuată după validare:", err);
    process.exitCode = 1;
  });
}
