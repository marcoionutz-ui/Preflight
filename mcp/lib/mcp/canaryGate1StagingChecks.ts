/**
 * lib/mcp/canaryGate1StagingChecks.ts — lotul OAuth staging, partea C: TOATE deciziile probei automate (design rev3 §8).
 *
 * Frunză PURĂ (zero I/O): primește răspunsuri deja citite (status + corp, rânduri din DB, URL-uri capturate) și întoarce
 * verdicte cu coduri ÎNCHISE. Orchestratorul (canaryGate1Staging.ts) doar înlănțuie; adaptoarele doar fac I/O.
 * Anti-leak: niciun verdict nu conține valori primite (tokenuri, coduri, emailuri, corpuri) — doar coduri.
 *
 * „Apel valid” (E0a, E0d, E6, E7, E11) = HTTP 200 + `result.isError` absent/false + `structuredContent` obiect cu
 * `ok === true` ȘI valid față de `outputSchema`-ul tool-ului din `tools/list`. Validarea folosește EXACT validatorul pe
 * care îl folosește clientul SDK MCP (`AjvJsonSchemaValidator`, `@modelcontextprotocol/sdk/validation/ajv`).
 */

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import type { McpCallResult } from "./canaryMcpClient";
import type { TokenResult } from "./canaryTokenClient";
import { parseCallbackParams, verifyCallback } from "./canaryCallback";
import { assertTokenResponse, parseTokenResponse } from "./releaseGate";
import { parseRedeemStatus } from "../oauth/inviteRedeem";
import type { AuthCodePayload } from "../db/oauthAtomic";

export type Verdict<C extends string> = { ok: true } | { ok: false; code: C };
const OK = { ok: true } as const;
const no = <C extends string>(code: C): { ok: false; code: C } => ({ ok: false, code });

/** Răspuns HTTP brut (corp deja citit). `null` în locul lui = eroare de transport. */
export interface RawHttp {
  status:  number;
  headers: Record<string, string>; // chei lowercased
  body:    string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
function strArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function header(h: Record<string, string> | undefined, name: string): string | null {
  if (!h) return null;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === want) return v;
  return null;
}

/** Calea unui URL absolut, sau null. */
export function pathOf(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  try { return new URL(url).pathname; } catch { return null; }
}
/** True dacă `url` e pe `origin` și are EXACT calea `path`. */
export function landedOn(url: string | null | undefined, origin: string, path: string): boolean {
  if (typeof url !== "string") return false;
  try { const u = new URL(url); return u.origin === origin && u.pathname === path; } catch { return false; }
}

// ────────────────────────────── E1: descoperire ──────────────────────────────

/** Parsează `WWW-Authenticate: <scheme> k="v", k2="v2"`. Parametru duplicat / formă stricată → null. */
export function parseWwwAuthenticate(value: string | null): { scheme: string; params: Record<string, string> } | null {
  if (typeof value !== "string") return null;
  const m = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s+(.*\S)\s*$/.exec(value);
  if (!m) return null;
  const params: Record<string, string> = {};
  const re = /\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"([^"\\]*)"|([^\s",]+))\s*(?:,|$)/y;
  const rest = m[2];
  let pos = 0;
  while (pos < rest.length) {
    re.lastIndex = pos;
    const p = re.exec(rest);
    if (!p || p.index !== pos) return null;
    const key = p[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(params, key)) return null;
    params[key] = p[2] !== undefined ? p[2] : p[3];
    pos = re.lastIndex;
  }
  return { scheme: m[1], params };
}

export type DiscoveryCode =
  | "discovery_transport" | "discovery_not_401" | "discovery_www_auth_missing" | "discovery_www_auth_malformed"
  | "discovery_resource_metadata_mismatch" | "discovery_scope_mismatch";

/** E1a: `initialize` fără token → 401 cu `resource_metadata` ABSOLUT = PRM-ul originii + `scope="read:basic"`. */
export function checkDiscovery401(res: RawHttp | null, origin: string): Verdict<DiscoveryCode> {
  if (!res) return no("discovery_transport");
  if (res.status !== 401) return no("discovery_not_401");
  const raw = header(res.headers, "www-authenticate");
  if (raw === null || raw.trim() === "") return no("discovery_www_auth_missing");
  const p = parseWwwAuthenticate(raw);
  if (!p || p.scheme.toLowerCase() !== "bearer") return no("discovery_www_auth_malformed");
  if (p.params.resource_metadata !== `${origin}/.well-known/oauth-protected-resource`) return no("discovery_resource_metadata_mismatch");
  if (p.params.scope !== "read:basic") return no("discovery_scope_mismatch");
  return OK;
}

export type PrmCode = "prm_transport" | "prm_http_error" | "prm_malformed" | "prm_resource_mismatch" | "prm_as_mismatch";

/** E1b: PRM (RFC 9728) — `resource` === `<origin>/api/mcp`, `authorization_servers` conține originea. */
export function checkPrm(res: RawHttp | null, origin: string): Verdict<PrmCode> {
  if (!res) return no("prm_transport");
  if (res.status !== 200) return no("prm_http_error");
  const j = parseJson(res.body);
  if (!isObj(j)) return no("prm_malformed");
  if (j.resource !== `${origin}/api/mcp`) return no("prm_resource_mismatch");
  if (!strArr(j.authorization_servers) || !j.authorization_servers.includes(origin)) return no("prm_as_mismatch");
  return OK;
}

export type AsMetaCode =
  | "as_transport" | "as_http_error" | "as_malformed" | "as_issuer_mismatch" | "as_endpoints_mismatch"
  | "as_cimd_not_supported" | "as_none_missing" | "as_s256_missing" | "as_registration_endpoint_present";

/** E1c: metadata AS (RFC 8414) — CIMD `true`, `none`, `S256`, FĂRĂ `registration_endpoint` (fără DCR). */
export function checkAsMetadata(res: RawHttp | null, origin: string): Verdict<AsMetaCode> {
  if (!res) return no("as_transport");
  if (res.status !== 200) return no("as_http_error");
  const j = parseJson(res.body);
  if (!isObj(j)) return no("as_malformed");
  if (j.issuer !== origin) return no("as_issuer_mismatch");
  if (j.authorization_endpoint !== `${origin}/authorize` || j.token_endpoint !== `${origin}/api/oauth/token`) return no("as_endpoints_mismatch");
  if (j.client_id_metadata_document_supported !== true) return no("as_cimd_not_supported");
  if (!strArr(j.token_endpoint_auth_methods_supported) || !j.token_endpoint_auth_methods_supported.includes("none")) return no("as_none_missing");
  if (!strArr(j.code_challenge_methods_supported) || !j.code_challenge_methods_supported.includes("S256")) return no("as_s256_missing");
  if (Object.prototype.hasOwnProperty.call(j, "registration_endpoint")) return no("as_registration_endpoint_present");
  return OK;
}

// ────────────────────────────── „apel valid” ──────────────────────────────

/** Validator de schemă: `valid` / `invalid` / `error` (schemă necompilabilă). Nu aruncă. */
export type SchemaValidate = (schema: unknown, data: unknown) => "valid" | "invalid" | "error";

/** Validatorul clientului SDK MCP (Ajv, aceeași configurare ca `Client.callTool`). */
export function makeSdkOutputSchemaValidator(): SchemaValidate {
  const provider = new AjvJsonSchemaValidator();
  return (schema, data) => {
    try {
      if (!isObj(schema)) return "error";
      const fn = provider.getValidator<unknown>(schema as JsonSchemaType);
      return fn(data).valid ? "valid" : "invalid";
    } catch {
      return "error";
    }
  };
}

/** `outputSchema` (obiect) al tool-ului `name` din rezultatul `tools/list`; absent / duplicat / ne-obiect → null. */
export function findToolOutputSchema(tools: readonly unknown[], name: string): Record<string, unknown> | null {
  const hits = tools.filter((t) => isObj(t) && t.name === name);
  if (hits.length !== 1) return null;
  const s = (hits[0] as Record<string, unknown>).outputSchema;
  return isObj(s) ? s : null;
}

export type McpFailCode =
  | "mcp_transport" | "mcp_unauthorized" | "mcp_rate_limited" | "mcp_http_error" | "mcp_bad_shape" | "mcp_protocol_error";

/** Eșec de client MCP (stage + status) → cod închis. */
export function mapMcpFailure(r: { stage: "transport" | "http" | "parse" | "jsonrpc"; status: number | null }): McpFailCode {
  if (r.stage === "transport") return "mcp_transport";
  if (r.stage === "parse") return "mcp_bad_shape";
  if (r.stage === "jsonrpc") return "mcp_protocol_error";
  if (r.status === 401 || r.status === 403) return "mcp_unauthorized";
  if (r.status === 429) return "mcp_rate_limited";
  return "mcp_http_error";
}

export type ValidCallCode =
  | McpFailCode | "call_is_error" | "structured_missing" | "structured_not_ok" | "output_schema_invalid" | "output_schema_unusable";

/** Criteriile E6 pe un `tools/call` deja făcut. `isError:true` cu HTTP 200 = EȘEC. */
export function checkValidToolCall(call: McpCallResult, schema: Record<string, unknown>, validate: SchemaValidate): Verdict<ValidCallCode> {
  if (!call.ok) return no(mapMcpFailure(call));
  if (call.isError) return no("call_is_error");
  const sc = call.structuredContent;
  if (!isObj(sc)) return no("structured_missing");
  if (sc.ok !== true) return no("structured_not_ok");
  const v = validate(schema, sc);
  if (v === "error") return no("output_schema_unusable");
  if (v === "invalid") return no("output_schema_invalid");
  return OK;
}

/** E9/E0c/E11b: un `tools/call` care TREBUIE refuzat cu 401. */
export function checkCallRejected401(call: McpCallResult): Verdict<"call_not_rejected" | "call_rejected_wrong_status" | "mcp_transport"> {
  if (call.ok) return no("call_not_rejected");
  if (call.stage === "transport") return no("mcp_transport");
  if (call.stage === "http" && call.status === 401) return OK;
  return no("call_rejected_wrong_status");
}

// ────────────────────────────── /token ──────────────────────────────

export type TokenRefusalCode =
  | "refusal_transport" | "refusal_wrong_status" | "refusal_wrong_error" | "refusal_body_has_token" | "refusal_body_malformed";

/** Corpul conține vreun token? (cheie `access_token`/`refresh_token` în JSON SAU în textul brut). */
export function bodyHasToken(body: string): boolean {
  if (/"(access|refresh)_token"\s*:/.test(body)) return true;
  const j = parseJson(body);
  return isObj(j) && ("access_token" in j || "refresh_token" in j);
}

/** Un refuz la `/token` (E0b: 401 invalid_client; E0e/E10/E12: 400 invalid_grant) — fără niciun token în corp. */
export function checkTokenRefusal(res: { status: number; body: string } | null, expect: { status: number; error: string }): Verdict<TokenRefusalCode> {
  if (!res) return no("refusal_transport");
  if (bodyHasToken(res.body)) return no("refusal_body_has_token");
  if (res.status !== expect.status) return no("refusal_wrong_status");
  const j = parseJson(res.body);
  if (!isObj(j)) return no("refusal_body_malformed");
  if (j.error !== expect.error) return no("refusal_wrong_error");
  return OK;
}

export type CcCode = "cc_transport" | "cc_invalid_client" | "cc_http_error" | "cc_malformed";

/** Răspunsul `client_credentials` → access token (formă validată cu contractul unic 12.5a). */
export function parseClientCredentialsResponse(res: { status: number; body: string } | null): { ok: true; accessToken: string } | { ok: false; code: CcCode } {
  if (!res) return no("cc_transport");
  if (res.status === 401) return no("cc_invalid_client");
  if (res.status !== 200) return no("cc_http_error");
  if (!assertTokenResponse(res.body, { expectRefresh: false }).ok) return no("cc_malformed");
  const t = parseTokenResponse(res.body);
  if (!t) return no("cc_malformed");
  return { ok: true, accessToken: t.access_token };
}

export type UserTokenCode = "token_transport" | "token_http_error" | "token_malformed" | "token_scope_mismatch";

/** E5/E7: rezultatul clientului /token (user-flow) + scope EXACT `read:basic`. */
export function checkUserToken(r: TokenResult): Verdict<UserTokenCode> {
  if (!r.ok) {
    if (r.stage === "assert") return no("token_malformed");
    return no(r.status === null ? "token_transport" : "token_http_error");
  }
  const scopes = r.scope.split(/\s+/).filter(Boolean);
  if (scopes.length !== 1 || scopes[0] !== "read:basic") return no("token_scope_mismatch");
  return OK;
}

// ────────────────────────────── login PKCE prin formularul real + Send Email Hook (staging) ──────────────────────────────

/**
 * Marcajul GoTrue pentru un token de link emis pe fluxul PKCE (`PKCEPrefix` în GoTrue `internal/api`): `/verify` cu un
 * token `pkce_…` emite un authorization code (`redirect_to?code=…`) în loc de tokenuri în fragment. ASUMPȚIE (nu există
 * cod server în node_modules): hook-ul primește în `email_data.token_hash` exact tokenul cu prefix pus în link. Dacă nu,
 * proba pică ÎNCHIS cu `mail_token_not_pkce` (nu ghicim alt format).
 */
export const GOTRUE_PKCE_TOKEN_PREFIX = "pkce_";
/** Tipurile de email pe care `signInWithOtp` (formularul /signup) le poate declanșa: cont nou → signup, existent → magiclink. */
export const LOGIN_MAIL_ACTION_TYPES: readonly string[] = Object.freeze(["signup", "magiclink"]);

/** Un rând din `public.staging_auth_mail_capture` (mcp/staging/auth_mail_capture.sql), citit cu service-role. */
export interface CapturedMail {
  id:                number;
  user_id:           string;
  email:             string;
  email_action_type: string;
  token_hash:        string;
  redirect_to:       string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCapturedMail(row: unknown): CapturedMail | null {
  if (!isObj(row)) return null;
  const id = typeof row.id === "number" ? row.id : typeof row.id === "string" && /^\d+$/.test(row.id) ? Number(row.id) : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  for (const k of ["user_id", "email", "email_action_type", "token_hash", "redirect_to"] as const) {
    if (typeof row[k] !== "string" || row[k] === "") return null;
  }
  if (!UUID_RE.test(row.user_id as string)) return null;
  return {
    id, user_id: row.user_id as string, email: row.email as string, email_action_type: row.email_action_type as string,
    token_hash: row.token_hash as string, redirect_to: row.redirect_to as string,
  };
}

/** Id-ul maxim din rândurile capturate deja (înainte de submit) — „proaspăt” = id strict mai mare. Rând corupt → null. */
export function maxCaptureId(rows: readonly unknown[]): number | null {
  let max = 0;
  for (const r of rows) {
    const m = parseCapturedMail(r);
    if (!m) return null;
    if (m.id > max) max = m.id;
  }
  return max;
}

export type MailCaptureCode =
  | "mail_capture_absent" | "mail_capture_multiple" | "mail_capture_shape" | "mail_token_not_pkce"
  | "mail_action_unexpected" | "mail_redirect_unexpected";

/**
 * Rândurile PROASPETE (id > `afterId`) ale emailului de test → exact unul, bine format, cu token PKCE, tip de login și
 * `redirect_to` = callback-ul produsului (dacă Supabase a căzut pe Site URL, callback-ul n-ar primi `?code=`).
 */
export function checkCapturedMail(
  rows: readonly unknown[],
  exp: { email: string; afterId: number; callbackUrl: string },
): { ok: true; mail: CapturedMail } | { ok: false; code: MailCaptureCode } {
  const fresh: CapturedMail[] = [];
  for (const r of rows) {
    const m = parseCapturedMail(r);
    if (!m) return no("mail_capture_shape");
    if (m.id > exp.afterId && m.email.toLowerCase() === exp.email.toLowerCase()) fresh.push(m);
  }
  if (fresh.length === 0) return no("mail_capture_absent");
  if (fresh.length > 1) return no("mail_capture_multiple");
  const m = fresh[0];
  if (!m.token_hash.startsWith(GOTRUE_PKCE_TOKEN_PREFIX) || m.token_hash.length <= GOTRUE_PKCE_TOKEN_PREFIX.length) return no("mail_token_not_pkce");
  if (!LOGIN_MAIL_ACTION_TYPES.includes(m.email_action_type)) return no("mail_action_unexpected");
  if (m.redirect_to !== exp.callbackUrl) return no("mail_redirect_unexpected");
  return { ok: true, mail: m };
}

/** Linkul pe care l-ar conține emailul: `/auth/v1/verify` al Supabase-ului vetat → GoTrue redirecționează cu `?code=`. */
export function buildVerifyUrl(supabaseUrl: string, m: CapturedMail): string {
  const q = new URLSearchParams({ token: m.token_hash, type: m.email_action_type, redirect_to: m.redirect_to });
  return `${supabaseUrl}/auth/v1/verify?${q.toString()}`;
}

/** Cookie-ul verifier PKCE pus de `@supabase/ssr` în browser la `signInWithOtp` (doar numele, niciodată valoarea). */
export function hasPkceVerifierCookie(names: readonly string[], ref: string): boolean {
  return names.includes(`sb-${ref}-auth-token-code-verifier`);
}
/** Cookie-ul de sesiune `@supabase/ssr` (eventual fragmentat `.0`, `.1`…) după schimbul de cod din /auth/callback. */
export function hasSessionCookie(names: readonly string[], ref: string): boolean {
  const base = `sb-${ref}-auth-token`;
  return names.some((n) => n === base || (n.startsWith(`${base}.`) && /^\d+$/.test(n.slice(base.length + 1))));
}

// ────────────────────────────── E4: captura callback-ului Claude ──────────────────────────────

export type CaptureCode =
  | "capture_wrong_target" | "capture_malformed" | "capture_state_mismatch" | "capture_iss_mismatch" | "capture_error_returned";

/** `origin + pathname` al unui URL === `redirectUri` (care nu are query). */
function targetsRedirect(location: string, redirectUri: string): boolean {
  try { const u = new URL(location); return u.hash === "" && `${u.origin}${u.pathname}` === redirectUri; } catch { return false; }
}

/**
 * E4: URL-ul spre care serverul a redirecționat după Approve (capturat, cererea NU a plecat). Cere: ținta EXACTĂ
 * (callback-ul Claude), `code` + `state` exact + `iss` = originea (RFC 9207). Întoarce codul DOAR în memorie.
 */
export function checkClaudeCallbackCapture(
  location: string,
  exp: { redirectUri: string; expectedState: string; issuer: string },
): { ok: true; code: string } | { ok: false; code: CaptureCode } {
  if (!targetsRedirect(location, exp.redirectUri)) return no("capture_wrong_target");
  const parsed = parseCallbackParams(location);
  const v = verifyCallback(parsed, { expectedState: exp.expectedState, issuer: exp.issuer });
  if (v.ok) return { ok: true, code: v.code };
  if (parsed.kind === "malformed") return no("capture_malformed");
  if (/state mismatch/.test(v.reason)) return no("capture_state_mismatch");
  if (/iss/.test(v.reason)) return no("capture_iss_mismatch");
  if (parsed.kind === "error") return no("capture_error_returned");
  return no("capture_malformed");
}

/** E2n: o captură (dacă există) poate fi DOAR `error=access_denied` cu state/iss corecte. */
export function classifyDeniedCapture(
  location: string,
  exp: { redirectUri: string; expectedState: string; issuer: string },
): "access_denied" | "code_issued" | "other" {
  if (!targetsRedirect(location, exp.redirectUri)) return "other";
  const parsed = parseCallbackParams(location);
  if (parsed.kind === "code") return "code_issued";
  if (parsed.kind !== "error") return "other";
  const v = verifyCallback(parsed, { expectedState: exp.expectedState, issuer: exp.issuer });
  // verifyCallback pe un `error` cu state/iss corecte → reason static „authorization error returned…”.
  if (!v.ok && /authorization error returned/.test(v.reason) && parsed.error === "access_denied") return "access_denied";
  return "other";
}

export type UnentitledCode =
  | "unentitled_consent_rendered" | "unentitled_code_issued" | "unentitled_unexpected_redirect" | "unentitled_entitlement_created";

/** E2n: cont fără invitație → fără ecran de consimțământ utilizabil, fără cod, fără entitlement. */
export function checkUnentitledRefusal(o: {
  approveVisible:   boolean;
  captures:         readonly string[];
  entitlementFound: boolean;
  exp:              { redirectUri: string; expectedState: string; issuer: string };
}): Verdict<UnentitledCode> {
  if (o.entitlementFound) return no("unentitled_entitlement_created");
  for (const c of o.captures) {
    const k = classifyDeniedCapture(c, o.exp);
    if (k === "code_issued") return no("unentitled_code_issued");
    if (k !== "access_denied") return no("unentitled_unexpected_redirect");
  }
  if (o.approveVisible) return no("unentitled_consent_rendered");
  return OK;
}

/**
 * E3n fără browser-follow: următorul pas al unei navigări manuale. Un 3xx (sau meta-refresh-ul de redirect al Next,
 * `__next-page-redirect`, emis când redirect-ul vine după începutul streaming-ului) dă ținta ABSOLUTĂ; o țintă pe altă
 * origine NU se urmează (`offsite`). Orice altceva = răspuns final.
 */
export function nextHop(res: { status: number; headers: Record<string, string>; body: string }, currentUrl: string, origin: string):
  | { kind: "final" } | { kind: "same_origin"; url: string } | { kind: "offsite"; url: string } {
  let target: string | null = null;
  if (res.status >= 300 && res.status < 400) {
    target = header(res.headers, "location");
    if (target === null) return { kind: "final" };
  } else if (res.status === 200) {
    const m = /<meta[^>]*id="__next-page-redirect"[^>]*content="\d+;\s*url=([^"]+)"/i.exec(res.body);
    if (m) target = m[1].replace(/&amp;/g, "&");
  }
  if (target === null) return { kind: "final" };
  let abs: URL;
  try { abs = new URL(target, currentUrl); } catch { return { kind: "offsite", url: target }; }
  return abs.origin === origin ? { kind: "same_origin", url: abs.href } : { kind: "offsite", url: abs.href };
}

export type LocalRefusalCode = "refusal_redirected" | "refusal_not_400" | "refusal_consent_rendered" | "refusal_offsite_request";

/** E3n: redirect_uri neînregistrat → eroare LOCALĂ (400 la /start), fără niciun redirect, fără consimțământ. */
export function checkLocalRefusal(o: { startStatus: number | null; redirectLocation: string | null; approveVisible: boolean; offsiteCaptures: number }): Verdict<LocalRefusalCode> {
  if (o.offsiteCaptures > 0) return no("refusal_offsite_request");
  if (o.redirectLocation !== null) return no("refusal_redirected");
  if (o.approveVisible) return no("refusal_consent_rendered");
  if (o.startStatus !== 400) return no("refusal_not_400");
  return OK;
}

// ────────────────────────────── rânduri din DB (service-role) ──────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_SLACK_MS = 5 * 60 * 1000;

export type EntitlementCode = "entitlement_shape" | "entitlement_expiry_off";

/** E2: entitlement-ul creat de răscumpărare = `{free_trial, [read:basic], 10/min, 500/zi, active}` + expirare ≈ +14 zile. */
export function checkRedeemedEntitlement(row: unknown, userId: string, windowStartMs: number, windowEndMs: number, accessDays: number): Verdict<EntitlementCode> {
  if (!isObj(row)) return no("entitlement_shape");
  if (row.user_id !== userId || row.plan !== "free_trial" || row.status !== "active") return no("entitlement_shape");
  if (!strArr(row.scopes) || row.scopes.length !== 1 || row.scopes[0] !== "read:basic") return no("entitlement_shape");
  if (row.rate_limit_per_minute !== 10 || row.rate_limit_per_day !== 500) return no("entitlement_shape");
  if (typeof row.access_expires_at !== "string") return no("entitlement_expiry_off");
  const at = Date.parse(row.access_expires_at);
  if (!Number.isFinite(at)) return no("entitlement_expiry_off");
  const lo = windowStartMs + accessDays * DAY_MS - EXPIRY_SLACK_MS;
  const hi = windowEndMs + accessDays * DAY_MS + EXPIRY_SLACK_MS;
  return at >= lo && at <= hi ? OK : no("entitlement_expiry_off");
}

export type InviteCode = "invite_shape" | "invite_not_redeemed" | "invite_redeemed_by_other";

/** E2: invitația e marcată răscumpărată, de userul probei. */
export function checkInviteRedeemed(row: unknown, inviteId: string, userId: string): Verdict<InviteCode> {
  if (!isObj(row) || row.invite_id !== inviteId) return no("invite_shape");
  if (typeof row.redeemed_at !== "string" || row.redeemed_at === "") return no("invite_not_redeemed");
  if (row.redeemed_by !== userId) return no("invite_redeemed_by_other");
  return OK;
}

export type GrantsCode = "grants_shape" | "grant_none_for_client" | "grant_still_active";

/** E8: toate grant-urile contului sunt `revoked`, iar cel puțin unul e pe clientul CIMD. */
export function checkGrantsRevoked(rows: unknown, cimdClientId: string): Verdict<GrantsCode> {
  if (!Array.isArray(rows) || !rows.every(isObj)) return no("grants_shape");
  if (!rows.some((r) => r.client_id === cimdClientId)) return no("grant_none_for_client");
  if (rows.some((r) => r.status !== "revoked")) return no("grant_still_active");
  return OK;
}

export type CimdRowCode = "cimd_row_shape" | "cimd_not_public" | "cimd_inactive" | "cimd_grant_types" | "cimd_redirect_missing" | "cimd_expired";

/** Precondiție: rândul CIMD provizionat (S0) există, e public/none/activ, are redirect-ul probei. Nu-l scriem niciodată. */
export function checkCimdRegistrationRow(row: unknown, clientId: string, redirectUri: string, nowMs: number): Verdict<CimdRowCode> {
  if (!isObj(row) || row.client_id !== clientId) return no("cimd_row_shape");
  if (row.client_type !== "public" || row.token_endpoint_auth_method !== "none") return no("cimd_not_public");
  if (row.status !== "active") return no("cimd_inactive");
  if (!strArr(row.grant_types) || !row.grant_types.includes("authorization_code") || !row.grant_types.includes("refresh_token")) return no("cimd_grant_types");
  if (!strArr(row.redirect_uris) || !row.redirect_uris.includes(redirectUri)) return no("cimd_redirect_missing");
  if (row.expires_at !== null && row.expires_at !== undefined) {
    const e = typeof row.expires_at === "string" ? Date.parse(row.expires_at) : Number.NaN;
    if (!Number.isFinite(e) || e <= nowMs) return no("cimd_expired");
  }
  return OK;
}

/** Vederea unui rând legacy `oauth_clients` citit de probă (fără `secret_hash`). */
export interface LegacyClientView {
  client_id:           string;
  user_id:             string | null;
  name:                string | null;
  plan:                string | null;
  scopes:              string[];
  status:              string;
  created_at:          string | null;
  admin_authorized_at: string | null;
  admin_authorized_by: string | null;
  secret_rotated_at:   string;
}

export function parseLegacyClientView(row: unknown): LegacyClientView | null {
  if (!isObj(row)) return null;
  const nOrS = (v: unknown): v is string | null => v === null || typeof v === "string";
  if (typeof row.client_id !== "string" || typeof row.status !== "string" || !strArr(row.scopes)) return null;
  if (typeof row.secret_rotated_at !== "string" || row.secret_rotated_at === "") return null;
  if (!nOrS(row.user_id) || !nOrS(row.name) || !nOrS(row.plan) || !nOrS(row.created_at)) return null;
  if (!nOrS(row.admin_authorized_at) || !nOrS(row.admin_authorized_by)) return null;
  return {
    client_id: row.client_id, user_id: row.user_id, name: row.name, plan: row.plan, scopes: [...row.scopes],
    status: row.status, created_at: row.created_at, admin_authorized_at: row.admin_authorized_at,
    admin_authorized_by: row.admin_authorized_by, secret_rotated_at: row.secret_rotated_at,
  };
}

export type LegacyStableCode = "legacy_row_changed" | "legacy_row_status_changed" | "legacy_row_still_authorized";

/** E0d: rândul clientului E0a e același (status inclus) — doar autorizarea a fost retrasă (starea de după 0002). */
export function checkLegacyRowStable(before: LegacyClientView, after: LegacyClientView): Verdict<LegacyStableCode> {
  if (after.status !== before.status) return no("legacy_row_status_changed");
  const same = after.client_id === before.client_id && after.user_id === before.user_id && after.name === before.name
    && after.plan === before.plan && after.created_at === before.created_at && after.secret_rotated_at === before.secret_rotated_at
    && after.scopes.length === before.scopes.length && after.scopes.every((s, i) => s === before.scopes[i]);
  if (!same) return no("legacy_row_changed");
  if (after.admin_authorized_at !== null || after.admin_authorized_by !== null) return no("legacy_row_still_authorized");
  return OK;
}

// ────────────────────────────── E0e: fixture-ul refresh-ului legacy ──────────────────────────────

/** Redirect-ul (nefolosit pentru vreo navigare) sigilat în codul legacy al fixture-ului. `.invalid` = nerezolvabil. */
export const LEGACY_FIXTURE_REDIRECT_URI = "https://gate1-probe.invalid/legacy-fixture";

/**
 * Payload-ul unui cod CLIENT (legacy, fără claim-uri de user) — forma pe care o emitea ruta legacy `/api/oauth/authorize`.
 * Emiterea refresh-ului se face cu ACEEAȘI funcție ca ramura legacy a `/token` (`consumeCodeAndIssueWithRefresh`) și cu
 * planul legacy al aceluiași planner (`planAuthCodeTokenIssuance`), deci refresh-ul are exact forma emisă de producție.
 */
export function buildLegacyFixtureAuthCode(p: { clientId: string; scopes: readonly string[]; resource: string; codeChallenge: string; nowMs: number }): AuthCodePayload {
  return {
    client_id:             p.clientId,
    scopes:                [...p.scopes],
    redirect_uri:          LEGACY_FIXTURE_REDIRECT_URI,
    code_challenge:        p.codeChallenge,
    code_challenge_method: "S256",
    issued_at:             p.nowMs,
    resource:              p.resource,
  };
}

// ────────────────────────────── E14: drepturile pe PostgREST ──────────────────────────────

/**
 * Clasificarea unui răspuns PostgREST pentru un rol care NU trebuie să aibă drept:
 *   `denied`    — 401/403 cu codul Postgres `42501` (permission denied);
 *   `zero_rows` — 2xx cu `[]` (RLS a ascuns rândul) — acceptat DOAR acolo unde controlul a dovedit că rândul există;
 *   `rows`      — 2xx cu rânduri / alt corp de succes (dreptul EXISTĂ → eșec);
 *   `unexpected`— transport sau orice altă eroare (nu putem afirma refuzul → eșec).
 */
export type PgClass = "denied" | "zero_rows" | "rows" | "unexpected";

export function classifyPostgrestNegative(res: { status: number; body: string } | null): PgClass {
  if (!res) return "unexpected";
  const j = parseJson(res.body);
  if ((res.status === 401 || res.status === 403) && isObj(j) && j.code === "42501") return "denied";
  if (res.status >= 200 && res.status < 300) {
    if (Array.isArray(j) && j.length === 0) return "zero_rows";
    return "rows";
  }
  return "unexpected";
}

/** Control RPC (service-role): ACEEAȘI cerere bine-formată întoarce un status închis — aici `redeemed`. */
export function checkRpcControl(res: { status: number; body: string } | null): Verdict<"control_failed"> {
  if (!res || res.status !== 200) return no("control_failed");
  return parseRedeemStatus(parseJson(res.body)) === "redeemed" ? OK : no("control_failed");
}

/** Control SELECT/PATCH (service-role): EXACT un rând, cel țintit (`idField === expectedId`). */
export function checkSingleRowControl(res: { status: number; body: string } | null, idField: string, expectedId: string): Verdict<"control_failed"> {
  if (!res || res.status < 200 || res.status >= 300) return no("control_failed");
  const j = parseJson(res.body);
  if (!Array.isArray(j) || j.length !== 1 || !isObj(j[0]) || j[0][idField] !== expectedId) return no("control_failed");
  return OK;
}

/** Primul (singurul) rând dintr-un răspuns PostgREST `select`, sau null. */
export function singleRowOf(res: { status: number; body: string } | null): Record<string, unknown> | null {
  if (!res || res.status !== 200) return null;
  const j = parseJson(res.body);
  return Array.isArray(j) && j.length === 1 && isObj(j[0]) ? j[0] : null;
}

/** Egalitate structurală (chei sortate) — „nimic schimbat” între snapshot-uri. */
export function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (isObj(v)) return Object.keys(v).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = norm(v[k]); return acc; }, {});
    return v;
  };
  return a !== undefined && b !== undefined && JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

export type RightsCode = "control_failed" | "anon_not_denied" | "user_not_denied" | "state_changed";

/**
 * Verdictul unui caz E14. Ordinea: controlul pozitiv trebuie să fi trecut (altfel „zero rânduri” ar putea trece pe o
 * probă greșit construită) → fiecare negativ e `denied` (sau `zero_rows` DOAR unde `allowZeroRows`) → re-citirea cu
 * service-role arată că nimic nu s-a schimbat.
 */
export function decideRightsCase(o: { control: Verdict<"control_failed">; anon: PgClass; user: PgClass; allowZeroRows: boolean; unchanged: boolean }): Verdict<RightsCode> {
  if (!o.control.ok) return no("control_failed");
  const refused = (c: PgClass): boolean => c === "denied" || (o.allowZeroRows && c === "zero_rows");
  if (!refused(o.anon)) return no("anon_not_denied");
  if (!refused(o.user)) return no("user_not_denied");
  if (!o.unchanged) return no("state_changed");
  return OK;
}
