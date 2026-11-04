/**
 * lib/config/adminScriptTarget.ts — lotul OAuth staging (review cgpt, P1): ținta EXPLICITĂ a scripturilor admin care
 * scriu cu service-role (`provisionCimdClient --apply`, `createBetaInvite`, `adminClientAccess`).
 *
 * Frunză PURĂ (zero importuri, zero I/O) → testabilă în tsx.
 *
 * Problema: un script care încarcă implicit `.env.local` din directorul curent poate scrie în proiectul Supabase greșit
 * (în WSL, `.env.local` indică producția). Regula:
 *   - scripturile NU mai încarcă `.env.local`; `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` vin explicit din
 *     shell;
 *   - operatorul declară EXPLICIT ref-ul țintă în `EXPECT_SUPABASE_REF`; URL-ul trebuie să fie exact
 *     `https://<ref>.supabase.co` cu acel ref (origine curată: fără userinfo, port, cale, query, fragment);
 *   - dacă cheia e un JWT Supabase (cheile legacy), `ref`-ul și `role`-ul din payload trebuie să fie ref-ul așteptat și
 *     `service_role`; o cheie nouă `sb_secret_…` nu poartă ref, deci nu se poate verifica — se raportează `key_ref:
 *     "unverifiable"`, iar decizia rămâne pe URL + ref-ul declarat;
 *   - `mode: "staging_only"` refuză în plus orice ref de producție (`PROD_SUPABASE_REFS`, injectat de apelant ca
 *     frunza să rămână fără importuri); `mode: "explicit_any"` permite producția, dar tot doar cu ref-ul declarat
 *     explicit (pentru `adminClientAccess`, care va autoriza M2M și în producție, la poarta ei).
 * Totul se decide ÎNAINTE de importul clientului administrativ. Motivele sunt coduri statice (fără valori, fără cheie).
 */

export type AdminTargetMode = "staging_only" | "explicit_any";

export type AdminTargetRefusal =
  | "url_missing" | "key_missing" | "expect_ref_missing" | "expect_ref_malformed"
  | "url_invalid" | "url_not_clean_origin" | "url_not_supabase_cloud" | "url_ref_mismatch"
  | "key_ref_mismatch" | "key_role_not_service" | "production_refused";

export type AdminTargetVerdict =
  | { ok: true; ref: string; host: string; production: boolean; key_ref: "verified" | "unverifiable" }
  | { ok: false; reason: AdminTargetRefusal };

const REF_RE = /^[a-z0-9]{20}$/;

function b64urlJson(part: string): unknown {
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    return JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8"));
  } catch { return null; }
}

/** Payload-ul unui JWT (3 segmente base64url) sau `null` dacă cheia nu e un JWT. Nu verifică semnătura. */
function jwtPayload(key: string): Record<string, unknown> | null {
  const parts = key.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null;
  const p = b64urlJson(parts[1]);
  return typeof p === "object" && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
}

export function vetAdminScriptTarget(p: {
  supabaseUrl: string | undefined;
  serviceKey:  string | undefined;
  expectRef:   string | undefined;
  mode:        AdminTargetMode;
  prodRefs:    readonly string[];
}): AdminTargetVerdict {
  const url = typeof p.supabaseUrl === "string" ? p.supabaseUrl.trim() : "";
  const key = typeof p.serviceKey === "string" ? p.serviceKey.trim() : "";
  const expect = typeof p.expectRef === "string" ? p.expectRef.trim() : "";
  if (url === "") return { ok: false, reason: "url_missing" };
  if (key === "") return { ok: false, reason: "key_missing" };
  if (expect === "") return { ok: false, reason: "expect_ref_missing" };
  if (!REF_RE.test(expect)) return { ok: false, reason: "expect_ref_malformed" };

  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reason: "url_invalid" }; }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== ""
      || u.pathname !== "/" || u.search !== "" || u.hash !== "" || url.replace(/\/$/, "") !== u.origin) {
    return { ok: false, reason: "url_not_clean_origin" };
  }
  const m = /^([a-z0-9]{20})\.supabase\.co$/.exec(u.hostname);
  if (m === null) return { ok: false, reason: "url_not_supabase_cloud" };
  const ref = m[1];
  if (ref !== expect) return { ok: false, reason: "url_ref_mismatch" };

  let keyRef: "verified" | "unverifiable" = "unverifiable";
  const payload = jwtPayload(key);
  if (payload !== null) {
    if (payload.ref !== ref) return { ok: false, reason: "key_ref_mismatch" };
    if (payload.role !== "service_role") return { ok: false, reason: "key_role_not_service" };
    keyRef = "verified";
  }

  const production = p.prodRefs.includes(ref);
  if (production && p.mode === "staging_only") return { ok: false, reason: "production_refused" };
  return { ok: true, ref, host: u.hostname, production, key_ref: keyRef };
}
