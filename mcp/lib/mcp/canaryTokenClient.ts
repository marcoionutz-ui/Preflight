/**
 * lib/mcp/canaryTokenClient.ts — PH-12 12.5b-1 (driver Gate 1: client HTTP pentru /api/oauth/token).
 *
 * Pasul 5+7 al fluxului: schimbă authorization_code pe access+refresh, apoi rotește refresh-ul. Transportul e INJECTAT
 * (`PostForm`) → leaf-ul e testabil complet fără rețea; adaptorul real peste `fetch` intră în orchestrator (12.5b-3).
 * Parsarea + validarea răspunsului refolosesc EXACT primitivele din 12.5a (`parseTokenResponse`/`assertTokenResponse`)
 * → un singur contract de răspuns /token.
 *
 * Anti-leak (regula ta, întărit cgpt): corpul cererii conține SECRETE (code, code_verifier, refresh_token). Textele
 * NECONTROLATE nu ajung NICIODATĂ în `reason`: (1) eroarea de transport → mesaj GENERIC (nu `Error.message`, care poate
 * conține body-ul cererii); (2) body-ul HTTP de eroare → se acceptă DOAR un `error` OAuth din allowlist (cod scurt,
 * ne-secret); `error_description` (text reflectat de server, poate conține secretul) NU se afișează niciodată. Motivele
 * de assert descriu doar FORMA (token_type/expires_in — ne-secrete). `redactSecret` = fingerprint sigur. Zero logging.
 *
 * User-flow-ONLY (întărit cgpt): AMBELE operații (auth-code, refresh) sunt flux user → succesul garantează TIPIZAT
 * `refreshToken: string` (nu `string | null`). Nu există `expectRefresh` expus apelantului (n-ar putea slăbi rotația).
 * `client_credentials` (fără refresh) rămâne DELIBERAT în afara acestui client — e un smoke separat, cu tip propriu.
 *
 * `resource` (audience) e trimis pe FIECARE cerere (RFC 8707): la /token trebuie să coincidă cu resursa legată în cod.
 */

import { createHash } from "crypto";
import { parseTokenResponse, assertTokenResponse } from "./releaseGate";

/** Răspuns HTTP minimal (subset compatibil cu `Response`): status + text(). */
export interface HttpResponse {
  status: number;
  text(): Promise<string>;
}
/** Transport injectat: POST application/x-www-form-urlencoded. Adaptorul real peste `fetch` e în orchestrator. */
export type PostForm = (url: string, body: string, headers: Record<string, string>) => Promise<HttpResponse>;

export interface TokenClientConfig {
  tokenEndpoint: string;   // ex. http://127.0.0.1:<port>/api/oauth/token
  clientId:      string;   // clientul public DCR canary
  resource:      string;   // audience canonică ${issuer}/api/mcp — trimisă pe fiecare cerere (RFC 8707)
}

// Succes user-flow: `refreshToken` e MEREU `string` (ambele operații cer refresh). Un client_credentials (fără refresh)
// ar folosi un tip SEPARAT — nu-l amestecăm aici, ca apelantul să nu poată trata o rotație fără refresh drept reușită.
export type TokenResult =
  | { ok: true;  accessToken: string; refreshToken: string; tokenType: string; expiresIn: number; scope: string }
  | { ok: false; stage: "http" | "assert"; status: number | null; reason: string };

/** Fingerprint sigur pt. loguri: `len=NN sha256=xxxxxxxx` — NU dezvăluie secretul. */
export function redactSecret(s: string): string {
  if (typeof s !== "string" || s === "") return "len=0";
  return `len=${s.length} sha256=${createHash("sha256").update(s).digest("hex").slice(0, 8)}`;
}

/** Encodează un corp form-urlencoded din perechi (valorile sunt escape-uite de URLSearchParams). */
export function buildForm(params: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) p.set(k, v);
  return p.toString();
}

// Coduri de eroare permise la token endpoint (RFC 6749 §5.2 + RFC 8707). DOAR acestea ajung în `reason` — orice altceva
// (inclusiv un `error` inventat de un server ostil) → doar statusul. `error_description` NU se afișează niciodată.
const OAUTH_TOKEN_ERRORS = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
  "unsupported_grant_type", "invalid_scope", "invalid_target", "temporarily_unavailable",
  "server_error", "access_denied",
]);

/** Reason fără leak dintr-un body HTTP de eroare: DOAR un `error` OAuth allowlisted (cod scurt); niciodată description. */
function httpErrorReason(status: number, body: string): string {
  try {
    const j: unknown = JSON.parse(body);
    if (j && typeof j === "object") {
      const e = (j as { error?: unknown }).error;
      if (typeof e === "string" && OAUTH_TOKEN_ERRORS.has(e)) return `HTTP ${status} ${e}`;
    }
  } catch { /* body ne-JSON → doar statusul (nu ecouăm body-ul, poate fi HTML/gunoi/secret reflectat) */ }
  return `HTTP ${status}`;
}

/** Nucleu comun: POST form la /token, parsează + validează cu assertTokenResponse (contract 12.5a, expectRefresh MEREU). */
async function postToken(
  post: PostForm,
  cfg:  TokenClientConfig,
  form: Record<string, string>,
): Promise<TokenResult> {
  let res: HttpResponse;
  try {
    res = await post(cfg.tokenEndpoint, buildForm(form), {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept":       "application/json",
    });
  } catch {
    // GENERIC: NU includem `Error.message` — poate conține body-ul cererii (secrete) sau text reflectat.
    return { ok: false, stage: "http", status: null, reason: "transport error" };
  }

  const body = await res.text().catch(() => "");
  if (res.status !== 200) {
    return { ok: false, stage: "http", status: res.status, reason: httpErrorReason(res.status, body) };
  }

  // expectRefresh MEREU true (user-flow): assert garantează refresh non-null. Nu-l expunem apelantului.
  const verdict = assertTokenResponse(body, { expectRefresh: true });
  if (!verdict.ok) {
    return { ok: false, stage: "assert", status: 200, reason: verdict.reason };
  }
  const t = parseTokenResponse(body)!; // garantat non-null de assert
  // Belt-and-suspenders pt. TIP: assert(expectRefresh:true) deja garantează, dar îngustăm explicit la `string`.
  if (t.refresh_token === null || t.scope === null) {
    return { ok: false, stage: "assert", status: 200, reason: "refresh_token/scope lipsă după validare (fail-closed)" };
  }
  return { ok: true, accessToken: t.access_token, refreshToken: t.refresh_token, tokenType: t.token_type, expiresIn: t.expires_in, scope: t.scope };
}

/**
 * Pasul 5: schimbă authorization_code pe access + refresh (flux user PKCE). `redirectUri` TREBUIE să fie EXACT string-ul
 * folosit la /authorize (serverul compară exact). `expectRefresh:true` — fluxul user emite mereu refresh.
 */
export function exchangeAuthCode(
  post: PostForm,
  cfg:  TokenClientConfig,
  args: { code: string; redirectUri: string; codeVerifier: string },
): Promise<TokenResult> {
  return postToken(post, cfg, {
    grant_type:    "authorization_code",
    code:          args.code,
    redirect_uri:  args.redirectUri,
    client_id:     cfg.clientId,
    code_verifier: args.codeVerifier,
    resource:      cfg.resource,
  });
}

/**
 * Pasul 7: rotește refresh-ul (grant refresh_token). Rotația trebuie SĂ emită un refresh nou (user-flow) → NU există
 * `expectRefresh` de slăbit; succesul are `refreshToken: string`. Orchestratorul verifică apoi diferența access/refresh
 * cu `assertRefreshRotation` (12.5a).
 */
export function refreshToken(
  post: PostForm,
  cfg:  TokenClientConfig,
  args: { refreshToken: string },
): Promise<TokenResult> {
  return postToken(post, cfg, {
    grant_type:    "refresh_token",
    refresh_token: args.refreshToken,
    client_id:     cfg.clientId,
    resource:      cfg.resource,
  });
}
