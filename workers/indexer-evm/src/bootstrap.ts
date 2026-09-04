/**
 * src/bootstrap.ts — PH-12 slice 12.2d (boot-guard indexer-evm).
 *
 * ENTRY-POINT REAL al serviciului (cablat în `package.json` `start`/`dev` → Railway `npm run start`). Ordinea e
 * ESENȚIALĂ (cerință Marco 12.2d): (1) încarcă env cu ACELEAȘI reguli ca runtime-ul → (2) validează → (3) ABIA APOI
 * `import()` DINAMIC al modulului care pornește serviciul. `src/index.ts` are constante calculate la import (`intEnv(...)`)
 * și module cu efecte (Redis, factories) — un simplu apel adăugat după importurile STATICE ar rula acele efecte ÎNAINTE
 * de validare. Importul dinamic amână încărcarea lui `./index` până după ce env-ul e dovedit valid.
 *
 * POLITICĂ (neschimbată față de deciziile aprobate): `problems` → diagnostic FĂRĂ valori/secrete (`formatEnvValidation`,
 * care nu ecouă valorile), `exitCode = 1`, NU se importă `./index` (nimic nu pornește). DOAR `warnings` → se loghează și
 * se continuă. Motorul de validare rămâne PUR; oprirea procesului aparține AICI, entry-point-ului. NU pinguim Redis/RPC —
 * o configurație invalidă (boot-check) și un serviciu extern temporar indisponibil (runtime) sunt lucruri diferite.
 *
 * `process.exitCode = 1` (NU `process.exit(1)`): fără importul lui `./index` event-loop-ul se golește și procesul iese
 * cu cod 1 de la sine, DUPĂ ce stdout/stderr s-au scris complet (un `exit()` sincron poate trunchia output-ul pe pipe).
 */

import * as dotenv from "dotenv";
dotenv.config(); // ACELAȘI mecanism ca `index.ts` (idempotent — a doua chemare din index nu suprascrie); dev-ul mai are `--env-file`

import { validateIndexerEvmEnv, formatEnvValidation } from "./config/envSchema";

const result = validateIndexerEvmEnv(process.env);

if (!result.ok) {
  console.error(formatEnvValidation(result));
  console.error("[BOOT][indexer-evm] configurație env invalidă — opresc înainte de pornire (niciun modul de serviciu nu s-a încărcat).");
  process.exitCode = 1;
} else {
  console.log(formatEnvValidation(result)); // pe OK conține „[env:indexer-evm] OK"; pe warnings le listează (nu opresc)
  console.log("[BOOT][indexer-evm] env valid — pornesc serviciul.");
  void import("./index").catch((err) => {
    console.error("[BOOT][indexer-evm] pornire eșuată după validare:", err);
    process.exitCode = 1;
  });
}
