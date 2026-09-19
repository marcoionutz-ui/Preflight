/**
 * lib/mcp/profileCaps.ts — PH-12 12.6 leaf 2a: adaptorul care LEAGĂ `Caps` (leaf 1, `profilePlan.ts`) de validatoarele
 * CANONICE reale ale rolurilor. Consumă lock-ul de leaf 2: `validateService` ȘI `envKeys` derivate din ACEEAȘI schemă
 * canonică (nu din env-ul Railway observat).
 *
 * SURSE (toate API-uri PUBLICE, niciodată `src/...`):
 *   - worker-evm / indexer-evm / indexer-solana → `@preflight/env-contracts` (pachet neutru; validator + `*_PROBLEM_KEYS`);
 *   - MCP runtime → `../config/envSchema` (`validateMcpEnv` + `MCP_ENV_FIELDS`), COMBINAT cu build-time
 *     `../config/buildEnvCheck` (`validateBuildEnv` + `BUILD_ENV_FIELD_NAMES`);
 *   - staging POZITIV → `./releaseGate` (`isApprovedStagingSupabaseUrl`, allowlist, NU `!isProdSupabaseHost`).
 *
 * NORMALIZATOR (anti-leak): forma canonică `{ ok, role, problems:[{name,kind,detail}], warnings }` → forma planner-ului
 * `{ ok, problems:[{name,kind}] }`. `role`, `warnings` și `detail` sunt ELIMINATE complet — planner-ul nu vede niciodată
 * text liber (un `detail` cu secret nu traversează). Invariantul `ok ⟺ problems.length===0` e păstrat prin construcție.
 *
 * `envKeys` = allowlist de PROVENIENȚĂ (numele pe care validatorul le poate emite în `problem.name`), NU inventarul
 * complet al env-urilor citite indirect. Pentru MCP: `MCP_ENV_FIELDS` (runtime) ∪ `BUILD_ENV_FIELD_NAMES` (build).
 */

import type { Caps, EnvValidation, EnvProblem, ServiceEnvValidator } from "./profilePlan";
import {
  validateWorkerEvmEnv,
  WORKER_EVM_PROBLEM_KEYS,
  validateIndexerEvmEnv,
  INDEXER_EVM_PROBLEM_KEYS,
  validateSolanaEnv,
  SOLANA_PROBLEM_KEYS,
  type EnvValidation as CanonEnvValidation,
} from "@preflight/env-contracts";
import { validateMcpEnv, MCP_ENV_FIELDS } from "../config/envSchema";
import { validateBuildEnv, BUILD_ENV_FIELD_NAMES, type BuildEnvResult } from "../config/buildEnvCheck";
import { isApprovedStagingSupabaseUrl } from "./releaseGate";

/** Îngheață recursiv (obiecte + array-uri). Funcțiile sunt înghețate ca valori (nu le parcurgem membrii). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Canonic `EnvValidation` → forma planner-ului. Șterge `role`/`warnings`/`detail`; păstrează DOAR `{name,kind}`. */
function normalize(v: CanonEnvValidation): EnvValidation {
  if (v.ok) return { ok: true, problems: [] };
  return { ok: false, problems: v.problems.map((p): EnvProblem => ({ name: p.name, kind: p.kind })) };
}

/** Build-check → probleme `{name,kind}` (kind ∈ missing|invalid). Fără `detail`. */
function normalizeBuild(v: BuildEnvResult): EnvProblem[] {
  return v.ok ? [] : v.problems.map((p): EnvProblem => ({ name: p.name, kind: p.kind }));
}

/**
 * Validatorul MCP: runtime (`validateMcpEnv`) COMBINAT cu build-time (`validateBuildEnv`). Rulează AMBELE și unește
 * problemele — inclusiv când AMBELE pică. `ok` = conjuncție (⇔ `problems` gol). Fără text liber în ieșire.
 */
const mcpValidator: ServiceEnvValidator = (env) => {
  const runtime = normalize(validateMcpEnv(env));
  const buildProblems = normalizeBuild(validateBuildEnv(env));
  const problems: EnvProblem[] = [...runtime.problems, ...buildProblems];
  return { ok: problems.length === 0, problems };
};

const workerEvmValidator: ServiceEnvValidator = (env) => normalize(validateWorkerEvmEnv(env));
const indexerEvmValidator: ServiceEnvValidator = (env) => normalize(validateIndexerEvmEnv(env));
const solanaValidator: ServiceEnvValidator = (env) => normalize(validateSolanaEnv(env));

/** Allowlist de proveniență MCP: runtime ∪ build (sursă unică cu ce EMIT validatoarele). */
const MCP_PROBLEM_KEYS: readonly string[] = Object.freeze([
  ...MCP_ENV_FIELDS.map((f) => f.name),
  ...BUILD_ENV_FIELD_NAMES,
]);

/** Plasa anti-prod (POZITIVĂ): Supabase-ul observat e un staging APROBAT (ref allowlist SAU loopback), origine curată. */
const isStagingSupabase = (env: Readonly<Record<string, string>>): boolean =>
  isApprovedStagingSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL);

/**
 * Construiește `Caps` din validatoarele + cataloagele CANONICE. Întregul obiect (incl. `envKeys` per rol) e înghețat
 * runtime. Leaf 2b/2c vor invoca `bindRoleCaps()` o dată și vor trece rezultatul lui `buildObservation`.
 */
export function bindRoleCaps(): Caps {
  const caps: Caps = {
    validateService: {
      mcp: mcpValidator,
      "worker-evm": workerEvmValidator,
      "indexer-evm": indexerEvmValidator,
      "solana-worker": solanaValidator,
    },
    envKeys: {
      mcp: MCP_PROBLEM_KEYS,
      "worker-evm": WORKER_EVM_PROBLEM_KEYS,
      "indexer-evm": INDEXER_EVM_PROBLEM_KEYS,
      "solana-worker": SOLANA_PROBLEM_KEYS,
    },
    isStagingSupabase,
  };
  return deepFreeze(caps);
}
