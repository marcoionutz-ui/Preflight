/**
 * lib/oauth/baseUrl.ts — U7 (host-header poisoning fix).
 *
 * PUR (fără importuri) → testabil izolat în tsx. Sursa CANONICĂ a originii publice a serverului OAuth.
 *
 * Problema: rutele de metadata (`.well-known/*`, `api/.well-known/*`) și `/auth/callback` construiau
 * `issuer`/`origin` din `x-forwarded-host` — un header CONTROLAT DE CLIENT. Un atacator putea trimite
 * `X-Forwarded-Host: evil.com` → metadata anunța `evil.com/api/oauth/token` → un client care descoperă
 * config-ul era trimis la endpoint-urile atacatorului (exfiltrare de cod/token). Fix: `PUBLIC_BASE_URL`
 * (env, setat de deploy) = sursa canonică; header-ele rămân fallback DOAR pentru dev/compat (fără garanție
 * de securitate acolo — în producție trebuie setat `PUBLIC_BASE_URL`).
 */

/** Normalizează un base URL configurat: trebuie http(s) absolut cu host, fără slash-uri trailing. Altfel → null. */
export function normalizeBaseUrl(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let u: URL;
  try { u = new URL(trimmed); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null; // nu javascript:/data:/ftp:/etc.
  if (u.hostname === "") return null;                                   // fără host = inutil ca origine
  return trimmed.replace(/\/+$/, "");                                   // fără slash trailing (`${base}/authorize`)
}

let warnedMissingBaseUrl = false;

/**
 * A1: în PRODUCȚIE, `PUBLIC_BASE_URL` lipsă/invalid → resolver-ul cade pe Host-ul CONTROLAT DE CLIENT (nesigur →
 * host-header poisoning). Decizia „trebuie avertizat?" e PURĂ (testabilă); efectul (console.warn, o dată per proces
 * ca să nu spam-uim pe fiecare hit de metadata) trăiește în `resolveBaseUrl`.
 */
export function shouldWarnMissingBaseUrl(
  env: { PUBLIC_BASE_URL?: string | undefined; NODE_ENV?: string | undefined },
): boolean {
  return (env.NODE_ENV ?? "") === "production" && normalizeBaseUrl(env.PUBLIC_BASE_URL) === null;
}

/**
 * Originea publică a serverului OAuth. `PUBLIC_BASE_URL` (env) = canonic → IGNORĂ header-ele → imun la
 * host-header poisoning. Dacă lipsește/invalid → fallback pe `x-forwarded-host`/`host` (DOAR dev/compat;
 * NU e trusted în producție → în producție emite un warning O DATĂ). Fără slash trailing în ambele cazuri.
 */
export function resolveBaseUrl(
  headers: { get(name: string): string | null },
  env: { PUBLIC_BASE_URL?: string | undefined; NODE_ENV?: string | undefined },
): string {
  const configured = normalizeBaseUrl(env.PUBLIC_BASE_URL);
  if (configured) return configured;

  if (shouldWarnMissingBaseUrl(env) && !warnedMissingBaseUrl) {
    warnedMissingBaseUrl = true;
    console.warn(
      "[OAUTH] PUBLIC_BASE_URL lipsă/invalid în producție — cad pe Host-ul controlat de client " +
      "(risc de host-header poisoning). Setează PUBLIC_BASE_URL pe deploy.",
    );
  }

  const host  = headers.get("x-forwarded-host") ?? headers.get("host") ?? "";
  const proto = headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}
