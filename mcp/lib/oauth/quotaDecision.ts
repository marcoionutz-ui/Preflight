/**
 * lib/oauth/quotaDecision.ts — PH-2a (MODEL PUR pentru decizia multi-dimensională de quota). Zero I/O → tsx.
 *
 * ⚠️ NU e „quota atomică implementată”. E DOAR clasificatorul de decizie. Atomicitatea reală (verifică-toate →
 * consumă-toate-sau-niciuna, retry_after din PTTL, concurență) trăiește în Lua + wiring (slice SEPARAT):
 *   - cablarea în `checkRateLimit`/`reserveQuota`/`resolveAuth` (azi taxează per client, nu per cont);
 *   - Lua pentru cele 4 ferestre + dovadă pe Redis REAL (concurență, denied⇒zero incrementări);
 *   - mutarea cheii de quota LUNARĂ pe `user_id` pentru tokenurile user (`usage.ts`).
 *
 * Design (Marco #4): tokenurile auth-code (subject_kind=user) se contorizează pe ACCOUNT (`user_id`) primar, cu
 * `client_id` = dimensiune SECUNDARĂ anti-abuz. Ambele (× minut/zi) trebuie verificate ATOMIC: permis DOAR dacă
 * TOATE au loc; la refuz NU se consumă NICIUNA. client_credentials = o singură dimensiune (client), ca azi.
 *
 * Fail-closed peste tot: count/limit corupte (NaN/negativ/fracționar, limit ≠ -1) SAU set de ferestre GOL
 * => request BLOCAT (nu consumat, nu „nelimitat”). `limit === -1` = nelimitat explicit. Loc dacă `count < limit`.
 */

/** O fereastră de quota: o (scope × window) cu contorul curent (înainte de request), limita și TTL-ul ferestrei. */
export interface QuotaWindow {
  scope:   string; // ex. "account" | "client"
  window:  string; // ex. "minute" | "day"
  count:   number; // consumat ÎNAINTE de acest request (>= 0)
  limit:   number; // -1 = nelimitat; altfel întreg >= 0
  ttlSec?: number; // secunde până se resetează fereastra (pentru retry_after); opțional (>= 0)
}

export interface QuotaRemaining { scope: string; window: string; remaining: number; } // -1 = nelimitat

export interface QuotaDecision {
  allowed:   boolean;
  /** prima fereastră care blochează (ordinea de intrare = prioritatea apelantului); null dacă allowed. */
  blockedBy: { scope: string; window: string; reason: "exhausted" | "corrupt" | "no-windows" } | null;
  /** locuri rămase per fereastră (înainte de a consuma acest request); -1 = nelimitat, 0 = plin. */
  remaining: QuotaRemaining[];
  /** max TTL al ferestrelor EPUIZATE care au un ttlSec valid; null dacă nu-i blocat prin epuizare / TTL necunoscut. */
  retryAfterSec: number | null;
}

const UNLIMITED = -1;
function isNonNegInt(n: unknown): n is number { return typeof n === "number" && Number.isInteger(n) && n >= 0; }
function isValidLimit(n: unknown): n is number { return n === UNLIMITED || isNonNegInt(n); }
function validTtl(n: unknown): n is number { return typeof n === "number" && Number.isFinite(n) && n >= 0; }

function remainingOf(w: QuotaWindow): number {
  if (w.limit === UNLIMITED) return UNLIMITED;
  return Math.max(0, w.limit - w.count);
}

/**
 * Decizie ATOMICĂ pe mai multe ferestre. Permis DOAR dacă TOATE au loc (count < limit) și niciuna nu-i coruptă,
 * ȘI setul NU e gol (gol = stare coruptă, fail-closed — NU acces nelimitat).
 *
 * PRECEDENȚĂ (cgpt): CORUPȚIA DOMINĂ, indiferent de ordine. Dacă ORICE fereastră e coruptă → `reason:"corrupt"`
 * + `retryAfterSec:null` (o stare coruptă NU se maschează ca rate-limit normal cu retry). Doar dacă NICIUNA nu-i
 * coruptă, o fereastră epuizată dă `reason:"exhausted"` cu `retryAfterSec` = max ttlSec al TUTUROR ferestrelor
 * epuizate (necunoscut/TTL lipsă → null, conservator). `blockedBy` = PRIMA fereastră (în ordine) din categoria care câștigă.
 */
export function decideQuota(windows: readonly QuotaWindow[]): QuotaDecision {
  // (#3 cgpt) set gol = fail-closed, NU „nelimitat”.
  if (windows.length === 0) {
    return { allowed: false, blockedBy: { scope: "(none)", window: "(none)", reason: "no-windows" }, remaining: [], retryAfterSec: null };
  }

  const remaining: QuotaRemaining[] = [];
  let firstCorrupt:   QuotaDecision["blockedBy"] = null;
  let firstExhausted: QuotaDecision["blockedBy"] = null;
  const exhaustedTtls: number[] = [];
  let anyExhaustedTtlUnknown = false;

  for (const w of windows) {
    if (!isNonNegInt(w.count) || !isValidLimit(w.limit)) {
      if (!firstCorrupt) firstCorrupt = { scope: w.scope, window: w.window, reason: "corrupt" };
      remaining.push({ scope: w.scope, window: w.window, remaining: 0 });
      continue;
    }
    remaining.push({ scope: w.scope, window: w.window, remaining: remainingOf(w) });
    const hasRoom = w.limit === UNLIMITED || w.count < w.limit;
    if (!hasRoom) {
      if (!firstExhausted) firstExhausted = { scope: w.scope, window: w.window, reason: "exhausted" };
      if (validTtl(w.ttlSec)) exhaustedTtls.push(w.ttlSec);
      else anyExhaustedTtlUnknown = true;
    }
  }

  // CORUPȚIA DOMINĂ: dacă există vreo fereastră coruptă, e eroare — nu retry (null), indiferent de epuizări.
  if (firstCorrupt) return { allowed: false, blockedBy: firstCorrupt, remaining, retryAfterSec: null };

  if (firstExhausted) {
    const retryAfterSec = exhaustedTtls.length > 0 && !anyExhaustedTtlUnknown ? Math.max(...exhaustedTtls) : null;
    return { allowed: false, blockedBy: firstExhausted, remaining, retryAfterSec };
  }

  return { allowed: true, blockedBy: null, remaining, retryAfterSec: null };
}

/**
 * Construiește ferestrele pentru un token auth-code: ACCOUNT primar + CLIENT secundar.
 * (#4 cgpt) Politica per-client e EXPLICITĂ: fie treci un `ScopeQuota` de client, fie `{ accountOnly: true }`.
 * Omiterea accidentală nu mai e posibilă (arg obligatoriu) → nu se poate strecura un bypass tăcut al subcap-ului.
 * Ordine = day înaintea minute, account înaintea client → `blockedBy` raportează fereastra cea mai „grea”.
 */
export interface ScopeQuota { perMinute: number; perDay: number; count: { minute: number; day: number }; ttl?: { minute?: number; day?: number }; }
export type AuthCodeClientPolicy = ScopeQuota | { accountOnly: true };

function windowsFor(scope: string, q: ScopeQuota): QuotaWindow[] {
  return [
    { scope, window: "day",    count: q.count.day,    limit: q.perDay,    ttlSec: q.ttl?.day },
    { scope, window: "minute", count: q.count.minute, limit: q.perMinute, ttlSec: q.ttl?.minute },
  ];
}

export function authCodeQuotaWindows(account: ScopeQuota, clientPolicy: AuthCodeClientPolicy): QuotaWindow[] {
  const w = windowsFor("account", account);
  if (!("accountOnly" in clientPolicy)) w.push(...windowsFor("client", clientPolicy));
  return w;
}

/** client_credentials: o singură dimensiune (client), ca azi. */
export function clientCredsQuotaWindows(client: ScopeQuota): QuotaWindow[] {
  return windowsFor("client", client);
}
