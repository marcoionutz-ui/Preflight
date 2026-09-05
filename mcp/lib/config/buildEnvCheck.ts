/**
 * lib/config/buildEnvCheck.ts — PH-12 12.2d-mcp: validare BUILD-time a `NEXT_PUBLIC_*` (înghețate la `next build`).
 *
 * AUTONOM — ZERO dependențe de workspace (`@preflight/*`). DE CE: `next.config.ts` e transpilat de Next cu un resolver
 * SEPARAT (`next-config-ts/transpile-config`) care NU rezolvă pachetele workspace — un import de `@preflight/schema`
 * din config eșuează cu `Cannot find module '../packages/preflight-schema/src'` și SPARGE tot `next build`. Deci
 * validatorul de build trăiește AICI, self-contained, importat RELATIV de `next.config.ts`.
 *
 * Regulile OGLINDESC motorul (`@preflight/config-env`) pentru cele 2 câmpuri de build, ca boot-check-ul de build să fie
 * echivalent cu validarea de runtime a aceluiași tip de câmp: `NEXT_PUBLIC_SUPABASE_URL` = URL absolut http(s), fără
 * credențiale, `https` obligatoriu în prod (`absoluteUrl`); `NEXT_PUBLIC_SUPABASE_ANON_KEY` = ne-gol (`nonEmpty`;
 * cheia publică anon, nu un secret). `""`/whitespace == absent. Sursă UNICĂ a build-env-ului (next.config + testul o folosesc).
 */
export interface BuildEnvProblem { name: string; kind: "missing" | "invalid"; detail: string; }
export type BuildEnvResult = { ok: true } | { ok: false; problems: BuildEnvProblem[] };

type Env = Record<string, string | undefined>;

const present = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";
const isProd = (env: Env): boolean => env.NODE_ENV === "production";

/** Oglindește `absoluteUrl` din motor: URL absolut, fără credențiale, `https` obligatoriu în prod. */
function checkAbsoluteUrl(value: string, prod: boolean): string | null {
  let u: URL;
  try { u = new URL(value); } catch { return "nu e un URL absolut valid"; }
  if (u.username !== "" || u.password !== "") return "URL-ul nu trebuie să conțină credențiale";
  if (u.protocol !== "https:" && u.protocol !== "http:") return "schemă http(s) obligatorie";
  if (prod && u.protocol !== "https:") return "https obligatoriu în producție";
  return null;
}

/** Validează câmpurile ÎNGHEȚATE la build (`NEXT_PUBLIC_*`). `null == valid`; ORICE non-null (inclusiv `""`) e eroare. */
export function validateBuildEnv(env: Env): BuildEnvResult {
  const prod = isProd(env);
  const problems: BuildEnvProblem[] = [];

  if (!present(env.NEXT_PUBLIC_SUPABASE_URL)) {
    problems.push({ name: "NEXT_PUBLIC_SUPABASE_URL", kind: "missing", detail: "obligatoriu (se îngheață în bundle la build)" });
  } else {
    const err = checkAbsoluteUrl(env.NEXT_PUBLIC_SUPABASE_URL, prod);
    if (err !== null) problems.push({ name: "NEXT_PUBLIC_SUPABASE_URL", kind: "invalid", detail: err });
  }

  if (!present(env.NEXT_PUBLIC_SUPABASE_ANON_KEY)) {
    problems.push({ name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", kind: "missing", detail: "obligatoriu (se îngheață în bundle la build)" });
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** Format fără VALORI (anti-leak, ca motorul): doar câmpul + tipul + detaliul static. */
export function formatBuildEnv(result: BuildEnvResult): string {
  if (result.ok) return "[env:mcp:build] OK";
  const lines = result.problems.map((p) => `  FAIL ${p.name} (${p.kind}): ${p.detail}`);
  return "[env:mcp:build] INVALID\n" + lines.join("\n");
}
