/**
 * lib/db/grantRevoke.ts — lot OAuth staging §6 (revocarea, definită prin efect): butonul din dashboard
 * „Revoke Claude's access" → grant-urile ACTIVE ale contului logat, DOAR pe registration-urile Claude, trec în
 * `oauth_grants.status = 'revoked'`. Grant-urile oricărui alt client (alt public, confidențial backfill-uit) rămân
 * neatinse.
 *
 * „Registration Claude" = rând `oauth_client_registrations` al cărui `client_id` trece `isClaudeCimdClientId`
 * (lib/oauth/cimdDocValidate.ts) — EXACT regula URL-ului cu care `provisionCimdClient` acceptă rândul: `https:`, host
 * exact `claude.ai`/`claude.com`, fără userinfo/port/fragment, cu cale, canonic. Nu există un al doilea parser.
 *
 * Calea de interogare (o singură, în ordine):
 *   1. citește registration-urile PUBLICE (`registration_id, client_id`; CIMD e mereu `public`) → filtru PUR
 *      `selectClaudeRegistrationIds` → id-urile Claude. Fail-closed: eroare, rând malformat sau listă trunchiată (≥ plafon)
 *      → `unavailable` (nu revocăm „pe jumătate" pe o listă de care nu suntem siguri).
 *   2. niciun registration Claude → `revoked {count: 0}` fără UPDATE.
 *   3. `UPDATE oauth_grants SET status='revoked' WHERE user_id=$u AND status='active' AND registration_id IN ($claude)
 *      RETURNING …` → `classifyGrantRevokeResult` verifică fiecare rând întors (al userului, `revoked`, pe un id Claude).
 * IDEMPOTENT: al doilea apel nu mai găsește rânduri active → `revoked {count: 0}` (succes).
 *
 * Grant-ul e SURSA DE ADEVĂR a revocării; efectul vine din citirile existente (fără cod nou pe ele):
 *   - apelul MCP: `resolveAuth` → ramura user → `getGrant` (`getGrantById`, fără filtru pe status) → `verifyUserTokenGrant`
 *     cere `status === "active"` → altfel 401 INVALID_TOKEN (lib/mcp/authPolicy.ts, lib/oauth/userTokenGrantVerify.ts);
 *   - refresh-ul: `handleUserRefreshGrant` → `getGrantById` → `planUserRefreshRotation` → reject → 400 `invalid_grant`.
 * Familiile de refresh din Redis NU se marchează: nu există legătură persistată grant → familie (`family_id` e aleator,
 * doar în payload-urile Redis; fără coloană în `oauth_grants`, fără index). §6: „best effort; grant-ul e sursa de adevăr".
 *
 * Structură (convenția `grantInsert.ts`): piese PURE + orchestrare cu I/O INJECTAT. I/O-ul real (service-role) încarcă
 * `supabase-admin` DINAMIC, doar la apel — testul importă modulul fără env (`createClient` aruncă la load fără URL).
 */

import type { GrantStatus } from "../oauth/grant";
import { isClaudeCimdClientId } from "../oauth/cimdDocValidate";

export const GRANT_REVOKE_TABLE = "oauth_grants";
export const REGISTRATIONS_TABLE = "oauth_client_registrations";
/** Coloanele cerute înapoi de UPDATE (confirmarea rândurilor atinse). Grant-ul nu are secret. */
export const GRANT_REVOKE_RETURNING = "grant_id, user_id, registration_id, client_id, status";
/** Plafonul citirii registration-urilor publice; atins → listă posibil trunchiată → `unavailable` (fail-closed). */
export const REGISTRATION_READ_LIMIT = 1000;

export type GrantTransition =
  | { changed: true;  from: "active";  to: "revoked" }
  | { changed: false; from: "revoked"; to: "revoked" };

/** Tranziția pe care o aplică revocarea unui grant. Totală pe `GrantStatus`; fără drum înapoi la `active`. */
export function nextGrantStatus(current: GrantStatus): GrantTransition {
  return current === "active"
    ? { changed: true,  from: "active",  to: "revoked" }
    : { changed: false, from: "revoked", to: "revoked" };
}

type DbReply = { data: unknown; error: { message?: string } | null };

export type ClaudeRegistrationIds =
  | { status: "ok";          ids: string[] }
  | { status: "unavailable"; reason: string };

/**
 * Răspunsul citirii `oauth_client_registrations (registration_id, client_id)` → id-urile registration-urilor Claude.
 * Fail-closed: eroare / non-listă / rând malformat / listă la plafon → `unavailable`. Ne-Claude → ignorat (nu revocat).
 */
export function selectClaudeRegistrationIds(data: unknown, error: { message?: string } | null | undefined): ClaudeRegistrationIds {
  if (error) return { status: "unavailable", reason: error.message ?? "supabase_error" };
  if (!Array.isArray(data)) return { status: "unavailable", reason: "răspuns neașteptat (data nu e listă)" };
  if (data.length >= REGISTRATION_READ_LIMIT) return { status: "unavailable", reason: "listă de registration-uri posibil trunchiată" };
  const ids: string[] = [];
  for (const r of data) {
    if (typeof r !== "object" || r === null) return { status: "unavailable", reason: "rând registration malformat" };
    const o = r as Record<string, unknown>;
    if (typeof o.registration_id !== "string" || o.registration_id === "" || typeof o.client_id !== "string") {
      return { status: "unavailable", reason: "rând registration malformat" };
    }
    if (isClaudeCimdClientId(o.client_id) && !ids.includes(o.registration_id)) ids.push(o.registration_id);
  }
  return { status: "ok", ids };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GrantRevokePlan =
  | { kind: "plan";    filter: { user_id: string; status: "active"; registration_ids: string[] }; patch: { status: "revoked" } }
  | { kind: "nothing" }                                   // niciun registration Claude → nimic de revocat
  | { kind: "refuse";  reason: string };

/**
 * Planul UPDATE-ului: rândurile ACTIVE ale acestui user (`auth.users.id` e uuid — FK în `oauth_grants`), DOAR pe
 * registration-urile Claude date. userId non-uuid → `refuse` (nu trimitem un UPDATE cu filtru ciudat). Listă goală de
 * registration-uri → `nothing` (un `IN ()` gol nu se trimite).
 */
export function planUserGrantRevoke(userId: unknown, claudeRegistrationIds: readonly string[]): GrantRevokePlan {
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return { kind: "refuse", reason: "user_id invalid" };
  const ids = [...new Set(claudeRegistrationIds.filter((x) => typeof x === "string" && x !== ""))];
  if (ids.length === 0) return { kind: "nothing" };
  return { kind: "plan", filter: { user_id: userId, status: "active", registration_ids: ids }, patch: { status: "revoked" } };
}

export type GrantRevokeResult =
  | { status: "revoked";     count: number; grantIds: string[] }
  | { status: "refused";     reason: string }
  | { status: "unavailable"; reason: string };

/**
 * Răspunsul UPDATE … RETURNING → rezultat. Fail-closed: eroare / non-listă / un rând care nu e al userului, nu e
 * `revoked`, nu e pe un registration Claude din plan sau n-are `client_id` Claude → `unavailable` (răspuns incoerent cu
 * filtrul — nu raportăm succes). Altfel `revoked {count, grantIds}`; `count = 0` = nimic activ (idempotent).
 */
export function classifyGrantRevokeResult(
  data:  unknown,
  error: { message?: string } | null | undefined,
  plan:  Extract<GrantRevokePlan, { kind: "plan" }>,
): GrantRevokeResult {
  if (error) return { status: "unavailable", reason: error.message ?? "supabase_error" };
  if (!Array.isArray(data)) return { status: "unavailable", reason: "răspuns neașteptat (data nu e listă)" };
  const ids: string[] = [];
  for (const r of data) {
    if (typeof r !== "object" || r === null) return { status: "unavailable", reason: "rând malformat" };
    const o = r as Record<string, unknown>;
    if (o.user_id !== plan.filter.user_id)                                   return { status: "unavailable", reason: "rând al altui user" };
    if (o.status !== "revoked")                                              return { status: "unavailable", reason: "rând nerevocat" };
    if (typeof o.registration_id !== "string" || !plan.filter.registration_ids.includes(o.registration_id)) {
      return { status: "unavailable", reason: "rând pe un registration din afara planului" };
    }
    if (!isClaudeCimdClientId(o.client_id))                                  return { status: "unavailable", reason: "rând cu client_id ne-Claude" };
    if (typeof o.grant_id !== "string" || o.grant_id === "")                 return { status: "unavailable", reason: "rând fără grant_id" };
    ids.push(o.grant_id);
  }
  return { status: "revoked", count: ids.length, grantIds: ids };
}

/** I/O-ul revocării (injectabil în teste). Fiecare pas întoarce `{data, error}` în forma Supabase; nu aruncă. */
export interface GrantRevokeIo {
  readPublicRegistrations(): Promise<DbReply>;
  revokeGrants(plan: Extract<GrantRevokePlan, { kind: "plan" }>): Promise<DbReply>;
}

function toReplyError(err: unknown): DbReply {
  return { data: null, error: { message: err instanceof Error ? err.message : "supabase_throw" } };
}

/** I/O-ul real: service-role. `supabase-admin` încărcat dinamic (vezi header). */
const defaultGrantRevokeIo: GrantRevokeIo = {
  async readPublicRegistrations() {
    try {
      const { supabaseAdmin } = await import("./supabase-admin");
      const { data, error } = await supabaseAdmin
        .from(REGISTRATIONS_TABLE)
        .select("registration_id, client_id")
        .eq("client_type", "public")
        .limit(REGISTRATION_READ_LIMIT);
      return { data, error };
    } catch (err) {
      return toReplyError(err);
    }
  },
  async revokeGrants(plan) {
    try {
      const { supabaseAdmin } = await import("./supabase-admin");
      const { data, error } = await supabaseAdmin
        .from(GRANT_REVOKE_TABLE)
        .update(plan.patch)
        .eq("user_id", plan.filter.user_id)
        .eq("status", plan.filter.status)
        .in("registration_id", plan.filter.registration_ids)
        .select(GRANT_REVOKE_RETURNING);
      return { data, error };
    } catch (err) {
      return toReplyError(err);
    }
  },
};

/**
 * Revocă grant-urile ACTIVE ale userului pe registration-urile Claude. `userId` TREBUIE să vină din sesiunea verificată
 * pe server (`supabase.auth.getUser()`), niciodată din input-ul browserului. Nu aruncă.
 */
export async function revokeClaudeGrantsForUser(
  userId: string,
  io: GrantRevokeIo = defaultGrantRevokeIo,
): Promise<GrantRevokeResult> {
  // userId verificat ÎNAINTE de orice I/O (planul cu listă goală doar validează userId-ul).
  const pre = planUserGrantRevoke(userId, []);
  if (pre.kind === "refuse") return { status: "refused", reason: pre.reason };

  const regs = await io.readPublicRegistrations();
  const claude = selectClaudeRegistrationIds(regs.data, regs.error);
  if (claude.status === "unavailable") return { status: "unavailable", reason: claude.reason };

  const plan = planUserGrantRevoke(userId, claude.ids);
  if (plan.kind === "refuse")  return { status: "refused", reason: plan.reason };
  if (plan.kind === "nothing") return { status: "revoked", count: 0, grantIds: [] };

  const { data, error } = await io.revokeGrants(plan);
  return classifyGrantRevokeResult(data, error, plan);
}
