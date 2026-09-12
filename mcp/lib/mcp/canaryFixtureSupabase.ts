/**
 * lib/mcp/canaryFixtureSupabase.ts — PH-12 12.5b-4b (adaptorul REAL `FixtureStore` peste `supabaseAdmin`).
 *
 * Mapează portul PUR `FixtureStore` (12.5b-5) pe clientul real `@supabase/supabase-js` (service-role): auth.admin pentru
 * user + tabelele `account_entitlements`/`oauth_client_registrations` pentru entitlement + DCR. Traduce erorile clientului
 * în CODURILE ÎNCHISE ale portului (`created`/`conflict`/`unavailable` etc.) FĂRĂ să scurgă valori (nu logăm cheia
 * service-role, nu ecouăm rânduri). Se construiește DOAR prin `buildFixtureStoreAfterIsolation` (poarta anti-prod din
 * 12.5b-5) → un config care atinge producția nici nu ajunge aici.
 *
 * IDEMPOTENȚĂ: `create*` semnalează `conflict` pe cheie unică (PG `23505` la tabele; 422/email_exists la user) în loc să
 * arunce → orchestratorul re-citește + compară exact. `delete*` folosește `.delete().select()` ca să distingă
 * `deleted` (rânduri întoarse) de `not_found` (zero rânduri) — cleanup-ul tratează `not_found` ca benign.
 *
 * NON-HERMETIC: adaptorul lovește Supabase real → e validat de rularea LIVE Gate 1 (runner-ul `.mjs`), nu de un test
 * unitar (un fake fidel al clientului Supabase ar reintroduce exact capcana „verde fals" pe care portul o evită).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import type {
  FixtureStore, UserCreateOutcome, UserReadOutcome, CreateOutcome,
  EntitlementReadOutcome, RegistrationReadOutcome, DeleteOutcome,
  EntitlementRow, RegistrationRow, EntitlementSnapshot, RegistrationSnapshot,
} from "./canaryFixture";

/** PG unique_violation. Un insert care lovește o cheie unică → `conflict` (idempotent), NU `unavailable`. */
const PG_UNIQUE_VIOLATION = "23505";

/** Un error Supabase (PostgrestError sau AuthError) — citim doar `code`/`status`/`message` pt. clasificare, nu-l scurgem. */
interface SbError { code?: string | null; status?: number | null; message?: string | null; }

/**
 * Un email deja înregistrat la auth.admin.createUser. Fix cgpt (P1): NU tratăm orice `422` drept duplicat — un 422
 * generic poate fi altă eroare (validare, parolă etc.) → l-am trata greșit ca „adoptă" și am putea adopta un cont care
 * NU e al fixturii. Acceptăm duplicat DOAR pe codurile Supabase cunoscute sau pe un mesaj neechivoc de „already
 * registered/exists". Orice altceva → NU e duplicat → adaptorul întoarce `unavailable` (fail-closed, nu adoptă orbește).
 */
function isDuplicateUser(err: SbError): boolean {
  const code = (err.code ?? "").toLowerCase();
  if (code === "email_exists" || code === "user_already_exists") return true;
  const msg = (err.message ?? "").toLowerCase();
  return /already.*(registered|exists)/.test(msg);
}

/** Guard de formă pentru snapshot-ul de entitlement (fix cgpt P2): un rând corupt → `unavailable`, NU cast orb care ar
 *  face matcher-ul pur să arunce pe `scopes` lipsă. */
function isEntitlementSnapshot(o: unknown): o is EntitlementSnapshot {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return typeof r.plan === "string"
    && Array.isArray(r.scopes) && r.scopes.every((s) => typeof s === "string")
    && typeof r.rate_limit_per_minute === "number"
    && typeof r.rate_limit_per_day === "number"
    && typeof r.status === "string";
}
/** Guard de formă pentru snapshot-ul de registration (fix cgpt P2). `client_name` poate fi null (coloană nullable). */
function isRegistrationSnapshot(o: unknown): o is RegistrationSnapshot {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return typeof r.client_type === "string"
    && typeof r.token_endpoint_auth_method === "string"
    && Array.isArray(r.grant_types) && r.grant_types.every((s) => typeof s === "string")
    && Array.isArray(r.redirect_uris) && r.redirect_uris.every((s) => typeof s === "string")
    && (r.client_name === null || typeof r.client_name === "string")
    && typeof r.status === "string";
}

/**
 * Construiește un `FixtureStore` peste un client Supabase service-role. `supabaseUrl` e cel VETAT de izolare;
 * `serviceRoleKey` e citit din env de apelant (NU logat). Clientul nu persistă sesiune (admin pur).
 */
export function makeSupabaseFixtureStore(
  supabaseUrl: string,
  serviceRoleKey: string,
  opts?: { fetch?: typeof fetch },
): FixtureStore {
  // fix cgpt (P1 timeout): apelantul poate injecta un `fetch` cu deadline (AbortController) → toate cererile Supabase
  // sunt mărginite (nu blochează gate-ul dacă backend-ul atârnă). Fără injecție, `fetch`-ul global (nemărginit).
  const sb: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(opts?.fetch ? { global: { fetch: opts.fetch } } : {}),
  });

  return {
    // ── USER (auth.users, confirmat) ──
    async createUser({ email }): Promise<UserCreateOutcome> {
      const { data, error } = await sb.auth.admin.createUser({ email, email_confirm: true });
      if (error) return isDuplicateUser(error as SbError) ? { status: "conflict" } : { status: "unavailable" };
      const id = data?.user?.id;
      if (typeof id !== "string" || id === "") return { status: "unavailable" };
      return { status: "created", userId: id };
    },

    async readUserByEmail(email): Promise<UserReadOutcome> {
      // auth.admin nu are get-by-email → listUsers PAGINAT. Fix cgpt (P1): paginare MĂRGINITĂ; dacă atingem plafonul
      // FĂRĂ a epuiza paginile, întoarcem `unavailable` (NU `not_found` — nu putem AFIRMA absența), ca să nu creăm un
      // duplicat pe o idempotență falsă.
      const target = email.toLowerCase();
      const perPage = 200;
      const maxPages = 50; // plafon dur: 10.000 utilizatori inspectați
      for (let page = 1; page <= maxPages; page++) {
        const { data, error } = await sb.auth.admin.listUsers({ page, perPage });
        if (error) return { status: "unavailable" };
        const users = data?.users ?? [];
        const user = users.find((u) => (u.email ?? "").toLowerCase() === target);
        if (user) {
          const emailConfirmed = Boolean(user.email_confirmed_at ?? user.confirmed_at);
          return { status: "found", userId: user.id, emailConfirmed };
        }
        if (users.length < perPage) return { status: "not_found" }; // ultima pagină, negăsit → absent cu certitudine
      }
      return { status: "unavailable" }; // plafon atins fără epuizare → nu putem afirma not_found (fail-closed)
    },

    async deleteUser(userId): Promise<DeleteOutcome> {
      const { error } = await sb.auth.admin.deleteUser(userId);
      if (error) {
        // 404 = deja dispărut (benign la cleanup); altă eroare = unavailable.
        if ((error as SbError).status === 404) return { status: "not_found" };
        return { status: "unavailable" };
      }
      return { status: "deleted" };
    },

    // ── ENTITLEMENT (account_entitlements) ──
    async createEntitlement(row: EntitlementRow): Promise<CreateOutcome> {
      const { error } = await sb.from("account_entitlements").insert(row);
      if (!error) return { status: "created" };
      return (error as SbError).code === PG_UNIQUE_VIOLATION ? { status: "conflict" } : { status: "unavailable" };
    },

    async readEntitlement(userId): Promise<EntitlementReadOutcome> {
      const { data, error } = await sb
        .from("account_entitlements")
        .select("plan, scopes, rate_limit_per_minute, rate_limit_per_day, status")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) return { status: "unavailable" };
      if (data === null) return { status: "not_found" };
      if (!isEntitlementSnapshot(data)) return { status: "unavailable" }; // rând corupt → fail-closed (nu-l dăm matcher-ului)
      return { status: "found", snapshot: data };
    },

    async deleteEntitlement(userId): Promise<DeleteOutcome> {
      const { data, error } = await sb
        .from("account_entitlements")
        .delete()
        .eq("user_id", userId)
        .select("user_id");
      if (error) return { status: "unavailable" };
      return data && data.length > 0 ? { status: "deleted" } : { status: "not_found" };
    },

    // ── REGISTRATION (oauth_client_registrations, DCR public) ──
    async createRegistration(row: RegistrationRow): Promise<CreateOutcome> {
      const { error } = await sb.from("oauth_client_registrations").insert(row);
      if (!error) return { status: "created" };
      return (error as SbError).code === PG_UNIQUE_VIOLATION ? { status: "conflict" } : { status: "unavailable" };
    },

    async readRegistrationByClientId(clientId): Promise<RegistrationReadOutcome> {
      const { data, error } = await sb
        .from("oauth_client_registrations")
        .select("client_type, token_endpoint_auth_method, grant_types, redirect_uris, client_name, status")
        .eq("client_id", clientId)
        .maybeSingle();
      if (error) return { status: "unavailable" };
      if (data === null) return { status: "not_found" };
      if (!isRegistrationSnapshot(data)) return { status: "unavailable" }; // rând corupt → fail-closed
      return { status: "found", snapshot: data };
    },

    async deleteRegistration(clientId): Promise<DeleteOutcome> {
      const { data, error } = await sb
        .from("oauth_client_registrations")
        .delete()
        .eq("client_id", clientId)
        .select("client_id");
      if (error) return { status: "unavailable" };
      return data && data.length > 0 ? { status: "deleted" } : { status: "not_found" };
    },
  };
}
