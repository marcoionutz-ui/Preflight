/**
 * lib/oauth/resource.ts — PH-3 (RFC 8707 Resource Indicators + audience binding; spec MCP 2026-07-28).
 *
 * Preflight servește O SINGURĂ resursă protejată: serverul MCP la `${issuer}/api/mcp` (declarat în
 * `oauth-protected-resource` metadata). Acest leaf: (1) validează `resource` cerut de client (RFC 8707) și îl
 * leagă ca AUDIENCE în authorization code + access token; (2) la resource server, respinge tokenurile al căror
 * audience NU e resursa canonică (protecție confused-deputy / token passthrough — spec MCP „token audience binding").
 *
 * PUR (fără importuri, doar `URL` global) → testabil izolat în tsx, fără Redis/Supabase/Next.
 */

// Calea canonică a resursei MCP relativ la issuer (transportul e montat la /api/[transport] → /api/mcp).
export const MCP_RESOURCE_PATH = "/api/mcp";

/** Normalizează un URI pentru comparație: strip slash-uri finale (`.../api/mcp/` == `.../api/mcp`). */
function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * Normalizare RFC 3986 pentru comparație: DOAR schema și host-ul se lowercase-uiesc (case-insensitive), path-ul rămâne
 * case-sensitive, slash final ignorat. `HTTPS://Host/api/mcp` == `https://host/api/mcp`. CRITIC (cgpt): NU aruncăm
 * componente — `userinfo` (`user:pass@`) și `hash` (`#frag`) sunt PĂSTRATE în output, ca un URI care le conține să NU
 * devină egal cu canonicul (care nu le are) → mismatch → respins. Un normalizator care le-ar șterge ar face
 * `https://user@host/api/mcp` sau `.../api/mcp#frag` să treacă drept canonic (gaură de audience). `URL` neparsabil →
 * strip+trim brut (comparația eșuează oricum, fără a arunca).
 */
function normalizeForCompare(uri: string): string {
  try {
    const u = new URL(uri);
    const userinfo = (u.username || u.password) ? `${u.username}:${u.password}@` : "";
    return `${u.protocol.toLowerCase()}//${userinfo}${u.host.toLowerCase()}${stripTrailingSlash(u.pathname)}${u.search}${u.hash}`;
  } catch {
    return stripTrailingSlash(uri.trim());
  }
}

/** URI-ul canonic al resursei protejate = `${issuer}/api/mcp` (issuer normalizat, fără slash final). */
export function canonicalResourceUri(issuer: string): string {
  return stripTrailingSlash(issuer) + MCP_RESOURCE_PATH;
}

export type ResourceValidation =
  | { status: "ok";             resource: string }
  | { status: "invalid_target"; reason: string };

/**
 * RFC 8707 §2: `resource` TREBUIE să fie un URI absolut, FĂRĂ fragment. Preflight acceptă DOAR resursa lui canonică
 * (o singură resursă) → orice alt target = `invalid_target`.
 *   - `requested` gol/absent → `ok` cu `resource = canonic` (DEFAULT-BIND: fiecare token emis e legat de resursa
 *     asta, chiar dacă un client mai vechi nu trimite `resource` încă — onboarding-ul e PH-2). Așa avem audience-
 *     binding COMPLET fără a sparge clienți, iar validarea la resource server rămâne semnificativă.
 *   - `requested` prezent → trebuie să fie URI absolut, fără fragment, și să se potrivească pe canonic (normalizat).
 */
export function validateResourceIndicator(
  requested: string | null | undefined,
  issuer: string,
): ResourceValidation {
  const canonical = canonicalResourceUri(issuer);
  const raw = (requested ?? "").trim();
  if (raw === "") return { status: "ok", resource: canonical }; // absent → default-bind canonic

  let u: URL;
  try { u = new URL(raw); } catch { return { status: "invalid_target", reason: "resource must be an absolute URI" }; }
  if (!u.protocol || (u.protocol !== "https:" && u.protocol !== "http:")) {
    return { status: "invalid_target", reason: "resource must be an http(s) URI" };
  }
  if (u.hash) return { status: "invalid_target", reason: "resource must not contain a fragment (RFC 8707 §2)" };
  if (u.username || u.password) return { status: "invalid_target", reason: "resource must not contain userinfo" };
  // Comparație normalizată RFC 3986 (scheme+host case-insensitive) — acceptă `HTTPS://Host/api/mcp`.
  if (normalizeForCompare(raw) !== normalizeForCompare(canonical)) {
    return { status: "invalid_target", reason: "resource does not identify this MCP server" };
  }
  return { status: "ok", resource: canonical };
}

/**
 * Validarea audience-ului la RESOURCE SERVER: acceptă tokenul DOAR dacă audience-ul lui == resursa canonică a acestui
 * server. FAIL-CLOSED (cgpt/varu): un token FĂRĂ audience (`undefined`/gol) → RESPINS, NU acceptat — spec MCP cere ca
 * serverul să DOVEDEASCĂ audience-ul tokenului, iar un grandfather permanent ar fi o gaură permanentă de fail-open.
 * Toate căile de emitere de acum (client_credentials + authorization_code) setează audience, deci tokenurile noi trec
 * mereu; un token vechi fără audience (niciunul deployat) → 401 → clientul reautorizează (contract 24h TTL oricum).
 * Comparație normalizată RFC 3986 (scheme+host case-insensitive, slash final ignorat).
 */
export function tokenAudienceValid(audience: string | null | undefined, expected: string): boolean {
  if (audience === undefined || audience === null || audience === "") return false; // fail-closed: audience obligatoriu
  return normalizeForCompare(audience) === normalizeForCompare(expected);
}
