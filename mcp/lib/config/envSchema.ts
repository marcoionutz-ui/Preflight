/**
 * lib/config/envSchema.ts — PH-12 slice 12.2b-2 (schema env MCP, pe motorul PARTAJAT).
 *
 * Refactorizat pe `@preflight/config-env` (motorul generic pur din 12.2b-1). AICI rămân DOAR:
 *   - specs-urile specifice rolului MCP (`MCP_ENV_FIELDS`);
 *   - prefixele de surplus (`MCP_UNEXPECTED_PREFIXES`);
 *   - validatorul `PUBLIC_BASE_URL` cuplat la `resolvePublicBaseUrl` (boot-check == runtime fail-closed,
 *     de aceea trăiește în MCP, nu în motorul generic — motorul nu depinde de `oauth/baseUrl`).
 * Mecanica (uniune discriminată, field-runner, surplus sortat, validatoare de formă) e importată din motor.
 * Behavior-preserving față de 12.2a: `validateMcpEnv` produce EXACT aceleași verdicte (testul MCP rămâne verde).
 */

import {
  validateEnv,
  absoluteUrl,
  redisUrl,
  nonEmpty,
  formatEnvValidation,
  type Validate,
  type FieldSpec,
  type EnvSnapshot,
  type EnvValidation,
} from "@preflight/config-env";
import { resolvePublicBaseUrl } from "../oauth/baseUrl";

// Re-export pentru consumatorii care importau aceste tipuri/funcții din envSchema (compat + un singur punct de intrare MCP).
export { formatEnvValidation };
export type { EnvSnapshot, EnvValidation };

/**
 * `PUBLIC_BASE_URL` — ACELAȘI predicat ca runtime (`resolvePublicBaseUrl`, sursa lui `resolveBaseUrl`):
 * boot-check == runtime fail-closed. Nu poate trăi în motorul generic fiindcă motorul nu cunoaște `oauth/baseUrl`.
 */
const publicBaseUrl: Validate = (value, prod) =>
  resolvePublicBaseUrl(value, { NODE_ENV: prod ? "production" : "development" }) === null
    ? "PUBLIC_BASE_URL invalid ca issuer (RFC 8414; https obligatoriu în producție)"
    : null;

/**
 * Câmpurile MCP. OBLIGATORII (azi cu `process.env.X!` → crash criptic la primul request dacă lipsesc):
 * cele patru chei Supabase/Redis. `PUBLIC_BASE_URL` obligatoriu DOAR în prod (anti-poisoning; confirmat lipsă
 * la recon PH-12 → fluxul resource-owner ar arunca fail-closed în prod).
 */
export const MCP_ENV_FIELDS: readonly FieldSpec[] = [
  { name: "NEXT_PUBLIC_SUPABASE_URL",      required: () => true,     validate: absoluteUrl("NEXT_PUBLIC_SUPABASE_URL") },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", required: () => true,     validate: nonEmpty },
  { name: "SUPABASE_SERVICE_ROLE_KEY",     required: () => true,     validate: nonEmpty },
  { name: "REDIS_URL",                     required: () => true,     validate: redisUrl() },
  { name: "PUBLIC_BASE_URL",               required: (prod) => prod, validate: publicBaseUrl },
] as const;

/**
 * Prefixe care aparțin rolurilor de WORKER, NU MCP. Prezența lor pe MCP = env ne-separat pe rol (recon PH-12
 * finding #6; confirmat de cod: MCP NU citește `ALCHEMY_*`/`INDEXER_*`). NU oprește boot-ul — doar `warning`.
 */
export const MCP_UNEXPECTED_PREFIXES: readonly string[] = ["ALCHEMY_", "INDEXER_"] as const;

/** Validează env-ul pentru rolul MCP. Discriminat: `ok:true` (+ warnings) sau `ok:false` (+ problems + warnings). */
export function validateMcpEnv(env: EnvSnapshot): EnvValidation {
  return validateEnv("mcp", MCP_ENV_FIELDS, MCP_UNEXPECTED_PREFIXES, env);
}
