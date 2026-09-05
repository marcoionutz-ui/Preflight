/**
 * instrumentation.ts — PH-12 slice 12.2d (boot-guard MCP, echivalentul Next al lui `bootstrap.ts`).
 *
 * DE CE `instrumentation.register()` (nu un `bootstrap.ts` + `tsx` ca la workeri): entry-point-ul MCP e `next start`
 * (CLI-ul Next), nu un modul de-al nostru — nu-l putem înveli într-un tsx care face `import()` dinamic. Next EXPUNE
 * exact hook-ul de care avem nevoie: `register()` din `instrumentation.ts` (stabil în Next 15) e rulat O DATĂ la
 * pornirea serverului, ÎNAINTE de a servi cereri, ȘI la `next dev` ȘI la `next start`. Env-ul e deja încărcat de Next
 * (`@next/env`, cu PRECEDENȚA `.env*` corectă) ÎNAINTE de `register()` → boot-check-ul vede EXACT valorile runtime,
 * fără să duplicăm încărcarea (paritate gratuită; un preflight extern ar reface `loadEnvConfig` și ar risca drift).
 *
 * ORDINE (ca la 12.2d): env încărcat de Next → validare → (fără efecte). `import()` DINAMIC al `envSchema` ÎN register:
 * top-level-ul acestui fișier NU are efecte (doar declarația funcției), deci `next build`, care bundle-uiește modulul,
 * NU execută validarea; ea rulează DOAR când Next cheamă `register()` la runtime. `validateMcpEnv` e PUR — ZERO I/O
 * (fără ping Redis/RPC/Supabase); doar inspectează `process.env`.
 *
 * DOMENIU (blocker cgpt P1 — build-env vs runtime-env): aici validăm DOAR env-ul de RUNTIME al serverului
 * (`validateMcpEnv`: `REDIS_URL`, service-role, `PUBLIC_BASE_URL`, flag-uri — citite proaspăt din `process.env`).
 * `NEXT_PUBLIC_*` NU se validează AICI: se îngheață în bundle la `next build`, deci se validează la BUILD în
 * `next.config.ts` (`validateMcpBuildEnv` la `PHASE_PRODUCTION_BUILD`). Un check runtime pe ele ar fi falsă încredere.
 *
 * POLITICĂ (neschimbată): `problems` → `formatEnvValidation` (fără valori/secrete) + `process.exit(1)` → serverul NU
 * servește nicio cerere. `process.exit` (NU `exitCode`): Next AȘTEAPTĂ `register()` și ar CONTINUA să servească dacă
 * doar am seta `exitCode`; oprirea trebuie să fie efectivă aici. DOAR `warnings` → log + continuare (serverul pornește).
 *
 * `NEXT_RUNTIME === "nodejs"`: Next poate invoca `register()` per-runtime (nodejs/edge). Boot-guard-ul (și `process.exit`)
 * aparțin DOAR runtime-ului Node al serverului — în edge `process.exit` n-are sens și env-ul de boot nu se validează acolo.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { validateMcpEnv, formatEnvValidation } = await import("./lib/config/envSchema");
  const result = validateMcpEnv(process.env);

  if (!result.ok) {
    console.error(formatEnvValidation(result));
    console.error("[BOOT][mcp] configurație env invalidă — opresc înainte de a servi cereri (serverul NU pornește).");
    process.exit(1);
  }

  // Diagnostic de boot pe STDERR (nu stdout): (a) e log de observabilitate, nu output de program — convenția e stderr;
  // (b) `next start` înghite/buferează stdout-ul din register, dar stderr-ul se scrie imediat — deci markerul de boot e
  // observabil fiabil (dovadă smoke: calea invalidă, pe console.error, se capta; cea validă, pe console.log, nu).
  console.error(formatEnvValidation(result)); // pe OK: „[env:mcp] OK"; pe warnings le listează (nu opresc)
  console.error("[BOOT][mcp] env valid — serverul poate porni.");
}
