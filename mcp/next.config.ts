import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { validateBuildEnv, formatBuildEnv } from "./lib/config/buildEnvCheck";

// PH-5: release gates. Build-ul TREBUIE să PICE pe erori de tip sau lint — altfel livrăm cod neverificat (varu:
// „release gates permit livrare neverificată"). Înainte, ambele erau `true` → `next build` (și deploy-ul Railway)
// treceau chiar cu erori TS/ESLint. Acum `false` (default Next, dar explicit + comentat ca să nu regreseze):
// `next build` rulează typecheck-ul complet + ESLint și eșuează la prima eroare. CI rulează separat
// `typecheck --workspaces` + `test --workspaces` + lint mcp (workflow-ul post-E32a).
const nextConfig: NextConfig = {
  eslint: {
    // NU ignora ESLint la build — o eroare de lint trebuie să spargă build-ul.
    ignoreDuringBuilds: false,
  },
  typescript: {
    // NU ignora erorile de tip la build — o eroare TS trebuie să spargă build-ul.
    ignoreBuildErrors: false,
  },
};

/**
 * PH-12 12.2d-mcp (SEPARARE build-env vs runtime-env — blocker cgpt P1): `NEXT_PUBLIC_*` se ÎNGHEAȚĂ în bundle la
 * `next build` (Next le inline-uiește; codul livrat folosește literalul, nu `process.env`). Deci le validăm EXACT în
 * faza de production build — momentul fixării. Invalid → ARUNCĂ → build oprit (valorile n-ajung înghețate greșit).
 * NU validăm aici la `next start` (`PHASE_PRODUCTION_SERVER`): valorile sunt deja în bundle, iar `process.env.NEXT_PUBLIC_*`
 * poate nici nu mai e setat la runtime → un check acolo ar fi fals-negativ. Env-ul de RUNTIME (`REDIS_URL`, service-role,
 * `PUBLIC_BASE_URL`, flag-uri) e validat separat de `instrumentation.register()`.
 *
 * IMPORTANT: validatorul de build trăiește în `./lib/config/buildEnvCheck` — AUTONOM, FĂRĂ import de `@preflight/*`.
 * `next.config.ts` e transpilat cu un resolver care NU rezolvă pachetele workspace; un import de `envSchema` (care trage
 * `@preflight/schema`) SPARGE `next build` (`Cannot find module '../packages/preflight-schema/src'`). Doar relativ, self-contained.
 * Exportul e FUNCȚIE de fază (Next acceptă `object | (phase, ctx) => config`) ca să putem discrimina faza.
 */
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const result = validateBuildEnv(process.env);
    if (!result.ok) {
      console.error(formatBuildEnv(result));
      console.error("[BUILD][mcp] NEXT_PUBLIC_* invalide — opresc build-ul (valorile se îngheață ACUM în bundle-ul livrat).");
      throw new Error("[BUILD][mcp] configurație NEXT_PUBLIC_* invalidă la build");
    }
    console.log(formatBuildEnv(result)); // „[env:mcp:build] OK"
    console.log("[BUILD][mcp] NEXT_PUBLIC_* valide — build permis.");
  }
  return nextConfig;
}
