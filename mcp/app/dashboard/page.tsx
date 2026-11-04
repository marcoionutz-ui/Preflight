/**
 * app/dashboard/page.tsx
 * Protected dashboard — server-side session check (no middleware.ts needed
 * for this alone; the check lives directly in the page, per the agreed MVP
 * security pattern: verified session -> user.id -> query scoped by user_id,
 * never trust client input).
 *
 * Lot OAuth staging §4.1 (O1): dashboard-ul NU mai creează automat clienți confidențiali (`createOAuthClient` scos).
 * Până acum, prima vizită proviziona un client `free_trial` cu secret → orice înscriere simplă primea un token
 * `client_credentials` fără expirare. Acum:
 *   - cont FĂRĂ client legacy → mesaj „acces doar pe invitație" + instrucțiunea de conectare din Claude („Use Claude's
 *     published identity", cu URL-ul MCP). Accesul real se decide la consimțământ (entitlement din invitație).
 *   - cont CU client legacy existent → afișat ca azi (citit prin `getClientByUserId`, care NU aplică regula de
 *     autorizare admin), ca titularul să-l vadă; dacă nu e autorizat de admin, secretul nu mai emite token (§4.1).
 *   - butonul „Revoke Claude's access" (§6) apare pentru orice cont logat și revocă DOAR grant-urile pe registration-urile Claude.
 * Secretul e afișat o singură dată DOAR după rotație (Server Action); nu mai există reveal la creare.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { getClientByUserId } from "@/lib/db/oauth-clients";
import { getPlanConfig } from "@/lib/mcp/billing";
import DashboardClient, { type LegacyClientView } from "./dashboard-client";
import { resolveBaseUrl } from "@/lib/oauth/baseUrl";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const client = await getClientByUserId(user.id);

  // U7: origine CANONICĂ din PUBLIC_BASE_URL (imun la host-header poisoning); fallback pe headers doar dev/compat.
  const h      = await headers();
  const mcpUrl = `${resolveBaseUrl(h, process.env)}/api/mcp`;

  let legacyClient: LegacyClientView | null = null;
  if (client) {
    const planConfig = getPlanConfig(client.plan);
    legacyClient = {
      clientId:           client.client_id,
      planName:           planConfig.name,
      scopes:             client.scopes,
      monthlyQuota:       planConfig.monthly_quota,
      rateLimitPerMinute: client.rate_limit_per_minute,
      redirectUris:       client.redirect_uris ?? [],
    };
  }

  return (
    <DashboardClient
      email={user.email ?? ""}
      mcpUrl={mcpUrl}
      legacyClient={legacyClient}
    />
  );
}
