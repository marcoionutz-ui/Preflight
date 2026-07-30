/**
 * lib/mcp/billing.ts
 * Plan entitlement abstraction
 *
 * Acum: OAuth subscription via Supabase oauth_clients
 * Viitor: x402 pay-per-request ca rail separat
 *
 * MCP endpoint-ul întreabă doar: isRequestAllowed(client, tool)?
 * Detaliile de billing sunt ascunse în spatele acestei interfețe.
 */

import { toolAuthorized } from "./scopes";

export type BillingRail = "subscription" | "x402" | "internal";

export interface PlanConfig {
  name:                  string;
  monthly_quota:         number;
  rate_limit_per_minute: number;
  rate_limit_per_day:    number;
  allowed_scopes:        string[];
  billing_rail:          BillingRail;
}

export const PLANS: Record<string, PlanConfig> = {
 free_trial: {
    name:                  "Free Trial",
    monthly_quota:         1_000,
    rate_limit_per_minute: 10,
    rate_limit_per_day:    500,
    allowed_scopes:        ["read:basic"],
    billing_rail:          "subscription",
  },
  basic: {
    name:                  "Basic",
    monthly_quota:         10_000,
    rate_limit_per_minute: 30,
    rate_limit_per_day:    2_000,
    allowed_scopes:        ["read:basic"],
    billing_rail:          "subscription",
  },
  starter: {
    name:                  "Starter",
    monthly_quota:         50_000,
    rate_limit_per_minute: 60,
    rate_limit_per_day:    10_000,
    allowed_scopes:        ["read:all"],
    billing_rail:          "subscription",
  },
  pro: {
    name:                  "Pro",
    monthly_quota:         500_000,
    rate_limit_per_minute: 120,
    rate_limit_per_day:    50_000,
    allowed_scopes:        ["read:all", "read:pipeline", "read:market", "read:pair", "read:safety", "read:reports"],
    billing_rail:          "subscription",
  },
  enterprise: {
    name:                  "Enterprise",
    monthly_quota:         -1, // unlimited
    rate_limit_per_minute: 300,
    rate_limit_per_day:    -1,
    allowed_scopes:        ["read:all", "admin"],
    billing_rail:          "subscription",
  },
  internal: {
    name:                  "Internal",
    monthly_quota:         -1,
    rate_limit_per_minute: 1000,
    rate_limit_per_day:    -1,
    allowed_scopes:        ["read:all", "admin"],
    billing_rail:          "internal",
  },
};

/**
 * E10 (design-decision): plan necunoscut/lipsă → `free_trial`, NU `starter`. Un typo sau un plan legacy
 * nu trebuie să acorde 50k quota + read:all; nici să scoată complet clientul din funcțiune (reject) — îl
 * degradăm conservator la podeaua sigură. `resolvePlan` semnalează `mismatch` pentru telemetrie zgomotoasă.
 */
export function resolvePlan(plan: string | null | undefined): { config: PlanConfig; mismatch: boolean; received: string } {
  const received = (plan ?? "").trim();
  const known    = received !== "" && Object.prototype.hasOwnProperty.call(PLANS, received);
  return {
    config:   known ? PLANS[received] : PLANS.free_trial,
    mismatch: !known,
    received,
  };
}

export function getPlanConfig(plan: string): PlanConfig {
  return resolvePlan(plan).config;
}

// ── Credit weights per tool ───────────────────────────────────────────────────

export const TOOL_CREDITS: Record<string, number> = {
  tp_situation_report: 1,
  tp_next_action:      1,
  tp_health_check:     1,
  tp_market_overview:  1,
  tp_chain_report:     1,
  tp_candidate_brief:  2,
  tp_late_move_context: 2,
  tp_pair_context:     2,
  tp_worker_pipeline:  2,
  tp_worker_snapshot:  2,
  tp_why_not:          2,
  tp_recent_pipeline_drops: 2,
  tp_position_context: 2,
  tp_watch_pair:       3,
  tp_preflight_safety: 5,
};

export function getToolCredits(toolName: string): number {
  return TOOL_CREDITS[toolName] ?? 1;
}

/**
 * Verifică dacă un request e permis pentru plan + tool. Rate limiting e gestionat separat în oauth-tokens.ts.
 *
 * E10: delegă la `toolAuthorized` = tokenul (clientScopes) AND planul rezolvat permit tool-ul. Vechea variantă
 * avea un OR periculos (`clientScopes.includes(s) || s === toolScope`) care putea autoriza DOAR fiindcă planul
 * conținea scope-ul cerut, chiar dacă tokenul nu-l avea — sursă unică de adevăr acum, fără capcană pt. viitori callers.
 */
export function isRequestAllowed(plan: string, clientScopes: string[], toolName: string): boolean {
  return toolAuthorized(toolName, clientScopes, getPlanConfig(plan).allowed_scopes);
}