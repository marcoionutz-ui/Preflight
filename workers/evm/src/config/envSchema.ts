/**
 * config/envSchema.ts — PH-12 slice 12.2c-2 (schema env worker-evm, pe motorul PARTAJAT `@preflight/config-env`).
 *
 * CROSS-FIELD principal: pentru fiecare chain care pornește ÎNTR-UN MOD CU WS ACTIV, `ALCHEMY_<CHAIN>_WS` devine
 * OBLIGATORIU. Motivul real (NU „conectare la `""`"): în modurile cu `wsEnabled` (BURST/LIVE/PAID_LIVE), `manager.ts`
 * tratează un `wsUrl` absent drept SCAN-ONLY (`if (!chain.wsUrl)`) — deci un chain pornit fără WS-ul lui rulează TĂCUT
 * degradat (fără fluxul real-time pe care modul îl implică), în loc să folosească WebSocket-ul. În modul `DEV`
 * (`wsEnabled:false`, `index.ts` nici nu pornește subsistemul WS) WS-ul NU e cerut deloc.
 *
 * PARITATE cu runtime-ul:
 *   - lista de chain-uri active = filtrul `chains.ts`: `ENABLED_CHAINS` split → `trim().toLowerCase()` → apartenență la
 *     ids canonice (`PREFLIGHT_EVM_CHAINS`), FĂRĂ `normalizeChainId` (`eth` NErecunoscut; id-ul e `bsc`), `ethereum` cere
 *     ȘI `INDEXER_ENABLE_ETHEREUM===1` (shadow-first);
 *   - `wsEnabled` = `mode.ts`: `(PREFLIGHT_MODE ?? "LIVE").toUpperCase()` → doar `DEV` are `wsEnabled:false`.
 *
 * Câmpurile NU sunt statice — se DERIVĂ din env (ce WS e obligatoriu depinde de `ENABLED_CHAINS` + mod). Naming
 * inconsistent păstrat 1:1 cu `chains.ts`: id-ul canonic `bsc` mapează la env-ul `ALCHEMY_BNB_WS` (WBNB).
 */

import {
  validateEnv,
  redisUrl,
  csvKnownTokens,
  type Validate,
  type FieldSpec,
  type EnvSnapshot,
  type EnvValidation,
  type EnvProblem,
} from "@preflight/config-env";
import { PREFLIGHT_EVM_CHAINS } from "@preflight/schema";

export { formatEnvValidation } from "@preflight/config-env";
export type { EnvSnapshot, EnvValidation } from "@preflight/config-env";

/** Chain id canonic → env-ul WS pe care `chains.ts` îl citește. `bsc` → `ALCHEMY_BNB_WS` (naming inconsistent, 1:1 cu codul). */
export const CHAIN_WS_ENV: Readonly<Record<string, string>> = {
  base:     "ALCHEMY_BASE_WS",
  arbitrum: "ALCHEMY_ARB_WS",
  bsc:      "ALCHEMY_BNB_WS",
  ethereum: "ALCHEMY_ETH_WS",
} as const;

/**
 * URL WebSocket: `ws://` sau `wss://` cu host și FĂRĂ fragment. `ws` 8.20.1 respinge explicit un URL cu `#fragment`
 * (lib/websocket.js) → un URL cu hash ar duce workerul în retry-uri pe o configurație invalidă, nu într-o conexiune.
 */
const wsUrl = (label: string): Validate => (value) => {
  let u: URL;
  try { u = new URL(value.trim()); } catch { return `${label} nu e un URL valid`; }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return `${label} trebuie ws:// sau wss://`;
  if (u.hostname === "") return `${label} fără host`;
  if (u.hash !== "") return `${label} nu poate avea fragment (#...) — clientul ws îl respinge`;
  return null;
};

/**
 * `wsEnabled` efectiv (oglindește `mode.ts`): `(PREFLIGHT_MODE ?? "LIVE").toUpperCase()`; DOAR `DEV` are `wsEnabled:false`,
 * restul (BURST/LIVE/PAID_LIVE + necunoscut→LIVE) au `true`. În DEV subsistemul WS nici nu pornește (`index.ts`).
 */
export function wsEnabledForEnv(env: EnvSnapshot): boolean {
  return (env.PREFLIGHT_MODE ?? "LIVE").toUpperCase() !== "DEV";
}

/**
 * Chain-urile care PORNESC efectiv (oglindește filtrul `CHAINS` din `chains.ts`). Dedup, ordine de apariție. `ethereum`
 * inclus DOAR dacă `INDEXER_ENABLE_ETHEREUM===1` (altfel e în `ENABLED_CHAINS` dar nu pornește). `ENABLED_CHAINS` ABSENT
 * → default `base,arbitrum` (ca `chains.ts`); `""`/whitespace prezent → [] (ca runtime-ul: `"" ?? x` rămâne `""`).
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
 * Câmpurile worker-evm, DERIVATE din env. `REDIS_URL` obligatoriu (fără el `getRedis()` e null → `saveMemoryToRedisStrict`
 * aruncă). `ENABLED_CHAINS` opțional (default `base,arbitrum`) — chain necunoscut → warning (dropat tăcut la runtime).
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

/**
 * Surplus pe rol: NEcablat deocamdată (`[]`). Worker-evm citește legitim `NEXT_PUBLIC_SUPABASE_URL` (confirmat în cod),
 * deci un allowlist de prefixe ar da fals-pozitive — inventarul complet de surplus worker rămâne pentru un leaf ulterior.
 */
export const WORKER_EVM_UNEXPECTED_PREFIXES: readonly string[] = [] as const;

/**
 * Validează env-ul worker-evm. Discriminat. Pe lângă câmpuri: dacă selecția EFECTIVĂ de chain-uri (după gate-uri) e
 * GOALĂ, worker-ul n-ar porni niciun chain → `problem` pe `ENABLED_CHAINS` (absența listei păstrează default-ul, deci
 * asta prinde doar `ENABLED_CHAINS` prezent-dar-vid: `""`, ` , , `, sau `ethereum` fără gate-ul lui).
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
