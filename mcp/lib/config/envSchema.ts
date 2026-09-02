/**
 * lib/config/envSchema.ts — PH-12 slice 12.2a (env fail-fast la boot, rolul MCP).
 *
 * PUR (fără I/O): primește un snapshot de env (`Record<string,string|undefined>`, de regulă `process.env`) și
 * întoarce o uniune discriminată `{ ok } | { ok:false; problems }`. Un boot-guard subțire (12.2c) o cheamă la
 * pornire și crapă ZGOMOTOS cu un mesaj clar dacă lipsește ceva, în loc de comportamentul de azi: `process.env.X!`
 * (non-null assertion) construiește clientul Supabase cu `undefined` → crash CRIPTIC abia la primul request, nu la boot.
 *
 * SURSĂ UNICĂ cu runtime-ul (doctrina „boot-check == runtime fail-closed"): `PUBLIC_BASE_URL` NU e re-validat cu o
 * regulă paralelă — folosește ACELAȘI predicat `resolvePublicBaseUrl` pe care îl consultă `resolveBaseUrl` la runtime
 * (PH-8, `oauth/baseUrl.ts`). Altfel boot-ul ar putea trece un URL pe care runtime-ul îl respinge fail-closed (sau
 * invers) — două surse care pot deriva. `NODE_ENV === "production"` strict (aliniat cu `baseUrl.ts`).
 *
 * DECIZIE (Marco, 2026-09-02): „required + tip, FĂRĂ allowlist strictă". Variabilele OBLIGATORII lipsă/invalide →
 * `problems` (boot crapă). Variabile în plus (ex. `INDEXER_*`/`ALCHEMY_*` rămase pe MCP din env-ul ne-separat pe rol —
 * confirmat la recon PH-12: codul MCP NU le citește) → `warnings`, NU crapă. `PUBLIC_BASE_URL` obligatoriu DOAR în prod
 * (în dev `resolveBaseUrl` cade pe Host; fail-fast doar unde contează anti-poisoning).
 */

import { resolvePublicBaseUrl } from "../oauth/baseUrl";

export type EnvSnapshot = Record<string, string | undefined>;

/** O problemă care OPREȘTE boot-ul: o variabilă obligatorie lipsește sau are formă invalidă. */
export type EnvProblem = {
  name: string;
  kind: "missing" | "invalid";
  detail: string;
};

/** Un avertisment care NU oprește boot-ul: surplus pe rol, sau opțional-dar-malformat. */
export type EnvWarning = {
  name: string;
  detail: string;
};

export type EnvValidation =
  | { ok: true;  role: "mcp"; warnings: EnvWarning[] }
  | { ok: false; role: "mcp"; problems: EnvProblem[]; warnings: EnvWarning[] };

/** `production` strict — Next setează `NODE_ENV=production` la build-ul de prod (identic cu regula din baseUrl.ts). */
function isProd(env: EnvSnapshot): boolean {
  return (env.NODE_ENV ?? "") === "production";
}

/** „Prezent" = string ne-gol după trim (un env setat la `""` de deploy NU numără ca setat). */
function present(raw: string | undefined): raw is string {
  return typeof raw === "string" && raw.trim() !== "";
}

/** Validator de formă: întoarce `null` dacă e ok, sau un `detail` de eroare. Rulează DOAR pe valori prezente. */
type Validate = (value: string, prod: boolean) => string | null;

/**
 * Specificația unui câmp. `required(prod)` decide dacă absența e `problem` (obligatoriu) sau ignorată (opțional).
 * `validate` (opțional) verifică forma unei valori PREZENTE — dacă întoarce eroare pe un câmp obligatoriu → `problem`
 * `invalid`; pe un câmp opțional → `warning` (prezent dar malformat, ex. `PUBLIC_BASE_URL` greșit în dev).
 */
type FieldSpec = {
  name: string;
  required: (prod: boolean) => boolean;
  validate?: Validate;
};

// ── validatoare de formă (pure) ──────────────────────────────────────────────────
const nonEmpty: Validate = () => null; // prezența e deja verificată de `present`; nimic în plus de cerut

/** URL http(s) absolut cu host; în prod cere https (Supabase/OAuth trăiesc pe https în producție). */
function absoluteUrl(label: string): Validate {
  return (value, prod) => {
    let u: URL;
    try { u = new URL(value.trim()); } catch { return `${label} nu e un URL absolut valid`; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return `${label} trebuie http(s)`;
    if (u.hostname === "") return `${label} fără host`;
    if (prod && u.protocol !== "https:") return `${label} trebuie https în producție`;
    return null;
  };
}

/** URL Redis: schema `redis:` sau `rediss:` (TLS), cu host. */
const redisUrl: Validate = (value) => {
  let u: URL;
  try { u = new URL(value.trim()); } catch { return "REDIS_URL nu e un URL valid"; }
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") return "REDIS_URL trebuie redis:// sau rediss://";
  if (u.hostname === "") return "REDIS_URL fără host";
  return null;
};

/** `PUBLIC_BASE_URL` — ACELAȘI predicat ca runtime (`resolvePublicBaseUrl`): boot-check == runtime fail-closed. */
const publicBaseUrl: Validate = (value, prod) =>
  resolvePublicBaseUrl(value, { NODE_ENV: prod ? "production" : "development" }) === null
    ? "PUBLIC_BASE_URL invalid ca issuer (RFC 8414; https obligatoriu în producție)"
    : null;

/**
 * Catalogul câmpurilor MCP. OBLIGATORII (azi cu `process.env.X!` → crash criptic la runtime dacă lipsesc):
 * cele patru chei Supabase/Redis. `PUBLIC_BASE_URL` obligatoriu DOAR în prod (anti-poisoning; azi LIPSEȘTE pe MCP —
 * confirmat la recon PH-12 → fluxul resource-owner ar arunca fail-closed în prod).
 */
export const MCP_ENV_FIELDS: readonly FieldSpec[] = [
  { name: "NEXT_PUBLIC_SUPABASE_URL",      required: () => true,  validate: absoluteUrl("NEXT_PUBLIC_SUPABASE_URL") },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", required: () => true,  validate: nonEmpty },
  { name: "SUPABASE_SERVICE_ROLE_KEY",     required: () => true,  validate: nonEmpty },
  { name: "REDIS_URL",                     required: () => true,  validate: redisUrl },
  { name: "PUBLIC_BASE_URL",               required: (prod) => prod, validate: publicBaseUrl },
] as const;

/**
 * Prefixe de variabile care aparțin rolurilor de WORKER, NU MCP. Prezența lor pe MCP = env ne-separat pe rol
 * (recon PH-12 finding #6). NU oprește boot-ul (decizia Marco: fără allowlist strictă) — doar `warning`
 * „unexpected for role mcp", ca reminder că separarea pe rol (12.6) încă nu s-a făcut.
 */
export const MCP_UNEXPECTED_PREFIXES: readonly string[] = ["ALCHEMY_", "INDEXER_"] as const;

/**
 * Validează env-ul pentru rolul MCP. Discriminat: `ok:true` (+ warnings) sau `ok:false` (+ problems + warnings).
 * PUR — nu citește `process.env` direct; primește snapshot-ul, ca să fie tsx-testabil determinist.
 */
export function validateMcpEnv(env: EnvSnapshot): EnvValidation {
  const prod = isProd(env);
  const problems: EnvProblem[] = [];
  const warnings: EnvWarning[] = [];

  for (const spec of MCP_ENV_FIELDS) {
    const raw = env[spec.name];
    const req = spec.required(prod);
    if (!present(raw)) {
      if (req) problems.push({ name: spec.name, kind: "missing", detail: prod ? "lipsă (obligatoriu în producție)" : "lipsă" });
      continue; // opțional + absent → nimic
    }
    const err = spec.validate ? spec.validate(raw, prod) : null;
    if (err) {
      if (req) problems.push({ name: spec.name, kind: "invalid", detail: err });
      else     warnings.push({ name: spec.name, detail: `${err} (opțional — ignorat)` });
    }
  }

  // Surplus pe rol: variabile de worker rămase pe MCP (env ne-separat). Warning, nu problem.
  // `.sort()` → ordine deterministă (altfel `Object.keys` = ordine de inserție → warnings ne-stabile între boot-uri).
  for (const key of Object.keys(env).sort()) {
    if (!present(env[key])) continue;
    if (MCP_UNEXPECTED_PREFIXES.some((p) => key.startsWith(p))) {
      warnings.push({ name: key, detail: "unexpected for role mcp (variabilă de worker — separă pe rol, 12.6)" });
    }
  }

  return problems.length > 0
    ? { ok: false, role: "mcp", problems, warnings }
    : { ok: true,  role: "mcp", warnings };
}

/**
 * Formatare pentru boot-log (PUR, un string). Boot-guard-ul (12.2c) o printează; nu face I/O aici.
 * Linie compactă, deterministă (ordinea din catalog + cheile sortate pentru surplus).
 */
export function formatEnvValidation(v: EnvValidation): string {
  const lines: string[] = [];
  if (v.ok) {
    lines.push(`[env:${v.role}] OK`);
  } else {
    lines.push(`[env:${v.role}] FAIL — ${v.problems.length} problemă(e) obligatorie:`);
    for (const p of v.problems) lines.push(`  ✗ ${p.name}: ${p.kind} — ${p.detail}`);
  }
  for (const w of v.warnings) lines.push(`  ⚠ ${w.name}: ${w.detail}`);
  return lines.join("\n");
}
