/**
 * env-contracts/src/workerEvm.ts — PH-12 12.6 leaf 2a: implementarea CANONICĂ a contractului de env worker-evm.
 *
 * MUTAT din `workers/evm/src/config/envSchema.ts` (12.2c-2) fără schimbare de comportament — `workers/evm/.../envSchema.ts`
 * devine un re-export subțire din barrel-ul acestui pachet (boot-guard + call-site-uri byte-compatible). Motorul rămâne
 * `@preflight/config-env`. NOU: `WORKER_EVM_PROBLEM_KEYS` = allowlist-ul de PROVENIENȚĂ (numele pe care validatorul le
 * poate emite în `problem.name`), consumat de `bindRoleCaps` (leaf 2a) pentru `Caps.envKeys["worker-evm"]`.
 *
 * CROSS-FIELD principal: pentru fiecare chain care pornește ÎNTR-UN MOD CU WS ACTIV, `ALCHEMY_<CHAIN>_WS` devine
 * OBLIGATORIU (în modurile `wsEnabled`, `manager.ts` tratează `wsUrl` absent drept SCAN-ONLY tăcut). Paritate cu runtime:
 * lista de chain-uri = filtrul `chains.ts` (`ENABLED_CHAINS` split → `trim().toLowerCase()` → apartenență la
 * `PREFLIGHT_EVM_CHAINS`, FĂRĂ `normalizeChainId`; `ethereum` cere ȘI `INDEXER_ENABLE_ETHEREUM===1`); `wsEnabled` =
 * `mode.ts` (`(PREFLIGHT_MODE ?? "LIVE").toUpperCase()`, doar `DEV` → false). Naming 1:1 cu `chains.ts` (`bsc`→`ALCHEMY_BNB_WS`).
 */

import {
  validateEnv,
  redisUrl,
  csvKnownTokens,
  wsUrl,
  type FieldSpec,
  type EnvSnapshot,
  type EnvValidation,
  type EnvProblem,
} from "@preflight/config-env";
import { PREFLIGHT_EVM_CHAINS } from "@preflight/schema";

/** Chain id canonic → env-ul WS pe care `chains.ts` îl citește. `bsc` → `ALCHEMY_BNB_WS` (naming inconsistent, 1:1 cu codul). */
export const CHAIN_WS_ENV: Readonly<Record<string, string>> = Object.freeze({
  base:     "ALCHEMY_BASE_WS",
  arbitrum: "ALCHEMY_ARB_WS",
  bsc:      "ALCHEMY_BNB_WS",
  ethereum: "ALCHEMY_ETH_WS",
} as const);

/**
 * `wsEnabled` efectiv (oglindește `mode.ts`): `(PREFLIGHT_MODE ?? "LIVE").toUpperCase()`; DOAR `DEV` are `wsEnabled:false`,
 * restul (BURST/LIVE/PAID_LIVE + necunoscut→LIVE) au `true`. În DEV subsistemul WS nici nu pornește (`index.ts`).
 */
export function wsEnabledForEnv(env: EnvSnapshot): boolean {
  return (env.PREFLIGHT_MODE ?? "LIVE").toUpperCase() !== "DEV";
}

/**
 * Chain-urile care PORNESC efectiv (oglindește filtrul `CHAINS` din `chains.ts`). Dedup, ordine de apariție. `ethereum`
 * inclus DOAR dacă `INDEXER_ENABLE_ETHEREUM===1`. `ENABLED_CHAINS` ABSENT → default `base,arbitrum`; `""`/whitespace
 * prezent → [] (ca runtime-ul: `"" ?? x` rămâne `""`).
 */
export function enabledEvmChains(env: EnvSnapshot): string[] {
  const raw = env.ENABLED_CHAINS ?? "base,arbitrum";
  const valid = new Set<string>(PREFLIGHT_EVM_CHAINS);
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const c = part.trim().toLowerCase();
    if (c === "" || !valid.has(c) || out.includes(c)) continue;
    if (c === "ethereum" && env.INDEXER_ENABLE_ETHEREUM !== "1") continue; // shadow-first (chains.ts)
    out.push(c);
  }
  return out;
}

/**
 * Câmpurile worker-evm, DERIVATE din env. `REDIS_URL` obligatoriu. `ENABLED_CHAINS` opțional (default `base,arbitrum`).
 * Cross-field: DOAR dacă modul are WS activ, fiecare chain care pornește adaugă un câmp `ALCHEMY_<CHAIN>_WS` OBLIGATORIU.
 */
export function workerEvmEnvFields(env: EnvSnapshot): FieldSpec[] {
  const fields: FieldSpec[] = [
    { name: "REDIS_URL",      required: () => true,  validate: redisUrl() },
    { name: "ENABLED_CHAINS", required: () => false, validate: csvKnownTokens("ENABLED_CHAINS", PREFLIGHT_EVM_CHAINS) },
  ];
  if (wsEnabledForEnv(env)) {
    for (const chain of enabledEvmChains(env)) {
      fields.push({ name: CHAIN_WS_ENV[chain], required: () => true, validate: wsUrl(CHAIN_WS_ENV[chain]) });
    }
  }
  return fields;
}

/** Surplus pe rol: NEcablat deocamdată (`[]`). Worker-evm citește legitim `NEXT_PUBLIC_SUPABASE_URL`. */
export const WORKER_EVM_UNEXPECTED_PREFIXES: readonly string[] = Object.freeze([]);

/**
 * Validează env-ul worker-evm. Discriminat. Pe lângă câmpuri: selecția EFECTIVĂ de chain-uri goală (după gate-uri) →
 * `problem` pe `ENABLED_CHAINS` (prinde `ENABLED_CHAINS` prezent-dar-vid: `""`, ` , , `, sau `ethereum` fără gate).
 */
export function validateWorkerEvmEnv(env: EnvSnapshot): EnvValidation {
  const base = validateEnv("worker-evm", workerEvmEnvFields(env), WORKER_EVM_UNEXPECTED_PREFIXES, env);
  if (enabledEvmChains(env).length > 0) return base;
  const emptyProblem: EnvProblem = {
    name: "ENABLED_CHAINS",
    kind: "invalid",
    detail: "selecție de chain-uri goală după gate-uri — worker-ul n-ar porni niciun chain",
  };
  const problems = base.ok ? [emptyProblem] : [...base.problems, emptyProblem];
  return { ok: false, role: base.role, problems, warnings: base.warnings };
}

/**
 * PROVENIENȚĂ (leaf 2a): numele pe care `validateWorkerEvmEnv` le poate emite în `problem.name` — DERIVAT din aceleași
 * constante folosite de `workerEvmEnvFields` + post-check. NU e inventarul complet al env-urilor citite indirect: e
 * allowlist-ul strict pentru `Caps.envKeys["worker-evm"]`. `REDIS_URL` + `ENABLED_CHAINS` (câmp + post-check-ul de
 * selecție goală) + toate cheile WS posibile (peste toate chain-urile) = `Object.values(CHAIN_WS_ENV)`.
 */
export const WORKER_EVM_PROBLEM_KEYS: readonly string[] = Object.freeze([
  "REDIS_URL",
  "ENABLED_CHAINS",
  ...Object.values(CHAIN_WS_ENV),
]);
