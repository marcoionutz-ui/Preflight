/**
 * lib/mcp/canaryGate1StagingIo.ts — lotul OAuth staging, partea C: adaptoarele REALE ale probei (subțiri, fără decizii).
 *
 * Se construiește DOAR din `StagingTargets`/`StagingSecrets` vetate (fabrica e invocată de `runGate1Staging` după
 * izolare). Traduce erorile în rezultate închise; NU loghează nimic (nici chei, nici tokenuri, nici emailuri).
 *
 * Biblioteci de produs refolosite (design: „createBetaInvite (library, not CLI)”, „createOAuthClient”, aceeași
 * funcție ca ramura legacy a codului): importate DINAMIC, la primul apel — `supabase-admin` construiește clientul la
 * încărcare din `process.env`, iar orchestratorul a verificat înainte (`vetProcessEnvBinding`) că env-ul procesului e
 * exact cel vetat. Restul apelurilor service-role folosesc un client propriu legat de URL-ul + cheia vetate.
 *
 * Tabela de captură a emailurilor de auth (`MAIL_CAPTURE_TABLE`, creată DOAR în staging de mcp/staging/auth_mail_capture.sql)
 * e citită/ștearsă cu service-role, doar după vetting (proiectul de producție e refuzat înainte de orice acces).
 *
 * NON-HERMETIC: validat doar de rularea live (runGate1Live.mjs), ca `canaryFixtureSupabase.ts`.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { makeFetchPostForm, makeFetchPostJson, headersToRecord, DEFAULT_CANARY_TIMEOUT_MS } from "./canaryFetch";
import type { DeleteStatus, PgRequest, PgRole, ReadResult, StagingProbeIo } from "./canaryGate1Staging";
import type { StagingSecrets, StagingTargets } from "./canaryGate1StagingTargets";
import type { RawHttp } from "./canaryGate1StagingChecks";
import { openBrowserSession, type PwBrowserLike } from "./canaryGate1StagingBrowser";
import { getPlanConfig } from "./billing";
import { ADMIN_CLIENT_COLUMNS } from "../db/adminClientAccess";
import { DEFAULT_INVITE_TTL_DAYS, normalizeInviteEmail } from "../oauth/inviteRedeem";

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** Tabela Send Email Hook-ului de STAGING (mcp/staging/auth_mail_capture.sql). */
export const MAIL_CAPTURE_TABLE = "staging_auth_mail_capture";

/**
 * `fetch` mărginit pentru supabase-js: deadline-ul acoperă ȘI citirea corpului (corpul e citit integral sub același
 * `AbortController`, apoi re-împachetat într-un `Response` nou). Throw-ul de transport se propagă (supabase-js îl
 * transformă în `error`, pe care adaptorul îl mapează la `unavailable`).
 */
export function makeBoundedFetch(timeoutMs = DEFAULT_CANARY_TIMEOUT_MS): typeof fetch {
  const bounded = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(input, { ...init, signal: ctrl.signal });
      const body = await res.text();
      return new Response(NULL_BODY_STATUS.has(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } finally {
      clearTimeout(timer);
    }
  };
  return bounded as typeof fetch;
}

function isLegacyJwtKey(key: string): boolean {
  return key.split(".").length === 3;
}

export interface StagingIoDeps {
  browser: PwBrowserLike; // obiectul `chromium.launch()` real (runnerul îl deține și îl închide)
}

export function makeStagingProbeIo(t: StagingTargets, s: StagingSecrets, deps: StagingIoDeps): StagingProbeIo {
  const bfetch = makeBoundedFetch();
  const sbOpts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: bfetch } };
  const admin: SupabaseClient = createClient(t.supabaseUrl, s.serviceKey, sbOpts);
  let redisTouched = false;

  const read = async <T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<ReadResult<T>> => {
    try {
      const { data, error } = await q;
      if (error) return { status: "unavailable" };
      if (data === null || data === undefined) return { status: "not_found" };
      return { status: "found", row: data as T };
    } catch {
      return { status: "unavailable" };
    }
  };
  const deleted = async (q: PromiseLike<{ data: unknown; error: unknown }>): Promise<DeleteStatus> => {
    try {
      const { data, error } = await q;
      if (error) return "unavailable";
      return Array.isArray(data) && data.length > 0 ? "deleted" : "not_found";
    } catch {
      return "unavailable";
    }
  };
  const tokenHashFor = async (email: string): Promise<{ ok: true; tokenHash: string; type: string } | { ok: false }> => {
    try {
      const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
      const p = data?.properties;
      if (error || !p || typeof p.hashed_token !== "string" || p.hashed_token === "") return { ok: false };
      return { ok: true, tokenHash: p.hashed_token, type: String(p.verification_type) };
    } catch {
      return { ok: false };
    }
  };

  const pgHeaders = (role: PgRole, prefer: boolean): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json", "Accept": "application/json" };
    if (prefer) h["Prefer"] = "return=representation";
    if (role.kind === "service") {
      h["apikey"] = s.serviceKey;
      if (isLegacyJwtKey(s.serviceKey)) h["Authorization"] = `Bearer ${s.serviceKey}`;
    } else if (role.kind === "anon") {
      h["apikey"] = s.anonKey;
      if (isLegacyJwtKey(s.anonKey)) h["Authorization"] = `Bearer ${s.anonKey}`;
    } else {
      h["apikey"] = s.anonKey;
      h["Authorization"] = `Bearer ${role.jwt}`;
    }
    return h;
  };

  return {
    postJson: makeFetchPostJson(),
    postForm: makeFetchPostForm(),

    async get(url): Promise<RawHttp | null> {
      try {
        const res = await bfetch(url, { method: "GET", redirect: "manual", headers: { Accept: "application/json" } });
        return { status: res.status, headers: headersToRecord(res.headers), body: await res.text() };
      } catch {
        return null;
      }
    },

    admin: {
      readCimdRegistration: (clientId) => read(admin.from("oauth_client_registrations")
        .select("client_id, client_type, token_endpoint_auth_method, grant_types, redirect_uris, status, expires_at")
        .eq("client_id", clientId).maybeSingle()),

      async createUser(email) {
        try {
          const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
          const id = data?.user?.id;
          return !error && typeof id === "string" && id !== "" ? { ok: true, userId: id } : { ok: false };
        } catch {
          return { ok: false };
        }
      },

      async deleteUser(userId) {
        try {
          const { error } = await admin.auth.admin.deleteUser(userId);
          if (!error) return "deleted";
          return (error as { status?: number }).status === 404 ? "not_found" : "unavailable";
        } catch {
          return "unavailable";
        }
      },

      async findUserIdByEmail(email) {
        // auth.admin nu are get-by-email → listUsers paginat, MĂRGINIT; plafon atins fără epuizare → unavailable.
        const target = email.toLowerCase();
        try {
          for (let page = 1; page <= 50; page++) {
            const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
            if (error) return { status: "unavailable" };
            const users = data?.users ?? [];
            const hit = users.find((u) => (u.email ?? "").toLowerCase() === target);
            if (hit) return { status: "found", row: hit.id };
            if (users.length < 200) return { status: "not_found" };
          }
          return { status: "unavailable" };
        } catch {
          return { status: "unavailable" };
        }
      },

      async readMailCaptures(email) {
        try {
          const { data, error } = await admin.from(MAIL_CAPTURE_TABLE)
            .select("id, user_id, email, email_action_type, token_hash, redirect_to")
            .eq("email", email.toLowerCase()).order("id", { ascending: true });
          if (error || !Array.isArray(data)) return { status: "unavailable" };
          return { status: "found", row: data as unknown[] };
        } catch {
          return { status: "unavailable" };
        }
      },

      deleteMailCaptures: (email) => deleted(admin.from(MAIL_CAPTURE_TABLE).delete().eq("email", email.toLowerCase()).select("id")),

      async userAccessToken(email) {
        const h = await tokenHashFor(email);
        if (!h.ok || h.type !== "magiclink") return { ok: false };
        try {
          const anon = createClient(t.supabaseUrl, s.anonKey, sbOpts);
          const { data, error } = await anon.auth.verifyOtp({ token_hash: h.tokenHash, type: "magiclink" });
          const jwt = data?.session?.access_token;
          return !error && typeof jwt === "string" && jwt !== "" ? { ok: true, jwt } : { ok: false };
        } catch {
          return { ok: false };
        }
      },

      async createInvite(email) {
        const norm = normalizeInviteEmail(email);
        if (norm === null) return { ok: false };
        try {
          const { createBetaInvite } = await import("../db/betaInvites");
          const r = await createBetaInvite(norm, DEFAULT_INVITE_TTL_DAYS);
          return r.ok ? { ok: true, inviteId: r.inviteId, token: r.token } : { ok: false };
        } catch {
          return { ok: false };
        }
      },

      deleteInvite: (inviteId) => deleted(admin.from("beta_invites").delete().eq("invite_id", inviteId).select("invite_id")),

      readInvite: (inviteId) => read(admin.from("beta_invites")
        .select("invite_id, email_normalized, expires_at, redeemed_at, redeemed_by").eq("invite_id", inviteId).maybeSingle()),

      readEntitlement: (userId) => read(admin.from("account_entitlements")
        .select("user_id, plan, scopes, rate_limit_per_minute, rate_limit_per_day, status, access_expires_at").eq("user_id", userId).maybeSingle()),

      async setEntitlementExpiry(userId, iso) {
        try {
          const { data, error } = await admin.from("account_entitlements").update({ access_expires_at: iso }).eq("user_id", userId).select("user_id");
          return !error && Array.isArray(data) && data.length === 1;
        } catch {
          return false;
        }
      },

      async createLegacyClient(spec) {
        try {
          const { createOAuthClient } = await import("../db/oauth-clients");
          let created: Awaited<ReturnType<typeof createOAuthClient>>;
          if (spec.model === "dashboard_free_trial") {
            // Exact modelul vechi al dashboard-ului (git show 6fecb3a:mcp/app/dashboard/page.tsx).
            const cfg = getPlanConfig("free_trial");
            created = await createOAuthClient({
              name: spec.name, plan: "free_trial", scopes: cfg.allowed_scopes, user_id: spec.userId,
              rate_limit_per_minute: cfg.rate_limit_per_minute, rate_limit_per_day: cfg.rate_limit_per_day,
            });
          } else {
            created = await createOAuthClient({ name: spec.name, plan: "starter", notes: "gate1 staging probe M2M (temporar)", user_id: spec.userId });
          }
          return created ? { ok: true, clientId: created.client.client_id, secret: created.client_secret } : { ok: false };
        } catch {
          return { ok: false };
        }
      },

      readClient: (clientId) => read(admin.from("oauth_clients")
        .select(`${ADMIN_CLIENT_COLUMNS}, secret_rotated_at`).eq("client_id", clientId).maybeSingle()),

      async patchClientAuthorization(clientId, patch, requireActive) {
        try {
          let q = admin.from("oauth_clients").update(patch).eq("client_id", clientId);
          if (requireActive) q = q.eq("status", "active");
          const { data, error } = await q.select("client_id");
          return !error && Array.isArray(data) && data.length === 1;
        } catch {
          return false;
        }
      },

      deleteClient: (clientId) => deleted(admin.from("oauth_clients").delete().eq("client_id", clientId).select("client_id")),

      async readGrants(userId) {
        try {
          const { data, error } = await admin.from("oauth_grants").select("grant_id, client_id, status").eq("user_id", userId);
          if (error || !Array.isArray(data)) return { status: "unavailable" };
          return { status: "found", row: data as Array<Record<string, unknown>> };
        } catch {
          return { status: "unavailable" };
        }
      },
    },

    async postgrest(role: PgRole, req: PgRequest) {
      try {
        const res = await bfetch(`${t.restUrl}/${req.path}`, {
          method:   req.method,
          headers:  pgHeaders(role, req.returnRepresentation === true),
          body:     req.body === undefined ? undefined : JSON.stringify(req.body),
          redirect: "manual",
        });
        return { status: res.status, body: await res.text() };
      } catch {
        return null;
      }
    },

    redis: {
      async exists(key) {
        try {
          const { getRedis } = await import("../db/redis");
          redisTouched = true;
          const r = getRedis();
          if (!r) return "unavailable";
          return (await r.exists(key)) >= 1 ? "present" : "absent";
        } catch {
          return "unavailable";
        }
      },

      async mintLegacyRefresh(payload, access) {
        try {
          const codes = await import("../db/oauth-codes");
          redisTouched = true;
          const code = await codes.issueAuthCode(payload);
          if (code === null) return { ok: false };
          const peek = await codes.peekAuthCode(code);
          if (peek.status !== "found") return { ok: false };
          const issued = await codes.consumeCodeAndIssueWithRefresh(code, peek.raw, access);
          return issued.status === "issued" ? { ok: true, refreshToken: issued.refreshToken } : { ok: false };
        } catch {
          return { ok: false };
        }
      },
    },

    newBrowserSession: () => openBrowserSession(deps.browser, t),

    async close() {
      if (!redisTouched) return;
      try {
        const { getRedis } = await import("../db/redis");
        getRedis()?.disconnect();
      } catch { /* best-effort */ }
    },
  };
}
