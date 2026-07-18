/**
 * app/dashboard/page.tsx
 * Protected dashboard — server-side session check (no middleware.ts needed
 * for this alone; the check lives directly in the page, per the agreed MVP
 * security pattern: verified session -> user.id -> query scoped by user_id,
 * never trust client input).
 *
 * First visit: no oauth_clients row for this user yet -> provision one on
 * free_trial and pass the freshly generated secret down to the client
 * component for the one-time reveal. Every visit after that, the secret is
 * never re-derivable — only its hash is stored.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { getClientByUserId, createOAuthClient } from "@/lib/db/oauth-clients";
import { getPlanConfig } from "@/lib/mcp/billing";
import DashboardClient from "./dashboard-client";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  let client = await getClientByUserId(user.id);
  let freshSecret: string | null = null;

  if (!client) {
    // Provisioning correctă: ratele trebuie luate din PLANS (billing.ts),
    // NU din defaults-urile lui createOAuthClient() (acelea sunt gândite
    // pentru clienți admin-provisioned pe plan "starter", nu free_trial).
    const freeTrialConfig = getPlanConfig("free_trial");

    const created = await createOAuthClient({
      name:                  user.email ?? user.id,
      plan:                  "free_trial",
      scopes:                freeTrialConfig.allowed_scopes,
      user_id:               user.id,
      rate_limit_per_minute: freeTrialConfig.rate_limit_per_minute,
      rate_limit_per_day:    freeTrialConfig.rate_limit_per_day,
    });

    if (!created) {
      return (
        <ErrorShell message="Could not provision your account. Refresh to try again." />
      );
    }

    freshSecret = created.client_secret;
    client      = created.client;
  }

  const h     = await headers();
  const host  = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? "https";
  const mcpUrl = `${proto}://${host}/api/mcp`;

  const planConfig = getPlanConfig(client.plan);

  return (
    <DashboardClient
      email={user.email ?? ""}
      clientId={client.client_id}
      freshSecret={freshSecret}
      planName={planConfig.name}
      scopes={client.scopes}
      monthlyQuota={planConfig.monthly_quota}
      rateLimitPerMinute={client.rate_limit_per_minute}
      mcpUrl={mcpUrl}
      redirectUris={client.redirect_uris ?? []}
    />
  );
}

function ErrorShell({ message }: { message: string }) {
  return (
    <div style={styles.page}>
      <div style={styles.errorCard}>{message}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight:      "100vh",
    background:     "#030303",
    color:          "#e0e0e0",
    fontFamily:     "'Courier New', Courier, monospace",
    display:        "flex",
    alignItems:     "center",
    justifyContent: "center",
    padding:        "20px",
  },
  errorCard: {
    background:   "#240a0a",
    border:       "1px solid #3a0f0f",
    borderRadius: "8px",
    color:        "#ff5c5c",
    fontSize:     "13px",
    padding:      "20px 24px",
    maxWidth:     "420px",
  },
};
