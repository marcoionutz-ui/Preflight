/**
 * @preflight/config-env — barrel. Motor GENERIC de validare env fail-fast (PH-12 12.2b), PUR, zero I/O.
 * Specs-urile per-rol trăiesc lângă fiecare serviciu; aici doar mecanica + validatoarele de formă reutilizabile.
 */
export {
  isProd,
  present,
  nonEmpty,
  absoluteUrl,
  redisUrl,
  nonNegativeInt,
  boolFlag,
  exactFlag,
  flagMustBeOffInProd,
  unknownCsvTokens,
  csvKnownTokens,
  runFieldSpecs,
  detectUnexpected,
  validateEnv,
  formatEnvValidation,
  type EnvSnapshot,
  type EnvProblem,
  type EnvWarning,
  type EnvValidation,
  type Validate,
  type FieldSpec,
} from "./engine";
