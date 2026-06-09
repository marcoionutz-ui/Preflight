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
    allowed_scopes:        ["read:all"],
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

export function getPlanConfig(plan: string): PlanConfig {
  return PLANS[plan] ?? PLANS.starter;
}

/**
 * Verifică dacă un request e permis pentru plan + scope.
 * Rate limiting e gestionat separat în oauth-tokens.ts.
 */
export function isRequestAllowed(plan: string, clientScopes: string[], toolScope: string): boolean {
  const config = getPlanConfig(plan);
  return config.allowed_scopes.some(s => clientScopes.includes(s) || s === toolScope);
}