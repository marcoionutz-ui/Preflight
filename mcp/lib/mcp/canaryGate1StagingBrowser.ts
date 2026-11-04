/**
 * lib/mcp/canaryGate1StagingBrowser.ts — lotul OAuth staging, partea C: adaptorul Playwright al probei (subțire).
 *
 * Playwright NU e dependență comisă (doctrina 12.3a: se instalează ad-hoc), deci aici NU îl importăm: tipăm un SUBSET
 * structural al API-ului (`Pw*Like`) și primim obiectul `browser` real de la runnerul `.mjs`. Logica e astfel verificată
 * de `tsc`, iar runnerul rămâne doar cablaj.
 *
 * Gărzi (fiecare context = un cont de test, cookie-uri proprii):
 *   - GARDA DE CONTEXT: orice cerere spre o origine ≠ {MCP de staging, Supabase de staging} e ANULATĂ (`route.abort`)
 *     înainte să plece. Cele spre claude.ai / claude.com / loopback sunt reținute (doar în memorie) ca „capturi”.
 *     Supabase-ul vetat e permis: formularul /signup face `signInWithOtp` (POST /auth/v1/otp) din browser, iar loginul
 *     navighează la `/auth/v1/verify`, care redirecționează înapoi la /auth/callback?code=… (PKCE, verifier-ul acestui
 *     context).
 *   - SIGNUP: formularul REAL din app/signup/auth-form.tsx (`#email`, `button[type=submit]`, „Check your email”).
 *   - APPROVE (E4): POST-ul de consimțământ e interceptat pe pagină; `route.fetch({maxRedirects: 0})` îl trimite la
 *     staging FĂRĂ să urmeze redirect-ul, `Location` e capturat, iar browserul primește o pagină sintetică — deci
 *     redirect-ul spre `claude.ai` (care poartă codul) nu e urmat niciodată, indiferent cum tratează Playwright hop-urile.
 *   - E3n: navigare MANUALĂ cu `context.request` (cookie-urile contextului, `maxRedirects: 0`), urmând doar
 *     `/authorize` → `/api/oauth/authorize/start`; orice alt redirect e raportat și NU e urmat.
 * Nimic din ce trece prin adaptor (URL-uri, coduri, cookie-uri) nu e logat.
 */

import type { ApproveResult, BrowserSession } from "./canaryGate1Staging";
import type { StagingTargets } from "./canaryGate1StagingTargets";
import { nextHop } from "./canaryGate1StagingChecks";

// ── subsetul structural Playwright folosit ──
export interface PwRequestLike { url(): string; method(): string }
export interface PwApiResponseLike { status(): number; headers(): Record<string, string>; text(): Promise<string> }
export interface PwRouteLike {
  request(): PwRequestLike;
  abort(errorCode?: string): Promise<void>;
  fallback(): Promise<void>;
  fetch(options?: { maxRedirects?: number; timeout?: number }): Promise<PwApiResponseLike>;
  fulfill(options: { status?: number; contentType?: string; body?: string; response?: PwApiResponseLike }): Promise<void>;
}
export type PwUrlMatcher = (url: URL) => boolean;
export type PwRouteHandler = (route: PwRouteLike) => Promise<void>;
export interface PwLocatorLike {
  count(): Promise<number>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  inputValue(options?: { timeout?: number }): Promise<string>;
  first(): PwLocatorLike;
  click(options?: { timeout?: number }): Promise<void>;
  waitFor(options?: { state?: "attached" | "visible"; timeout?: number }): Promise<void>;
  getAttribute(name: string): Promise<string | null>;
}
export interface PwPageLike {
  goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number }): Promise<unknown>;
  url(): string;
  waitForLoadState(state?: "load" | "domcontentloaded" | "networkidle", options?: { timeout?: number }): Promise<void>;
  locator(selector: string): PwLocatorLike;
  route(url: PwUrlMatcher, handler: PwRouteHandler): Promise<void>;
  unroute(url: PwUrlMatcher, handler?: PwRouteHandler): Promise<void>;
}
export interface PwApiRequestLike {
  get(url: string, options?: { maxRedirects?: number; timeout?: number }): Promise<PwApiResponseLike>;
}
export interface PwContextLike {
  newPage(): Promise<PwPageLike>;
  route(url: PwUrlMatcher, handler: PwRouteHandler): Promise<void>;
  cookies(): Promise<Array<{ name: string }>>;
  request: PwApiRequestLike;
  close(): Promise<void>;
}
export interface PwBrowserLike { newContext(): Promise<PwContextLike> }

const NAV_TIMEOUT_MS    = 30_000;
const IDLE_TIMEOUT_MS   = 10_000;
const ACTION_TIMEOUT_MS = 15_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const CAPTURED_HTML = "<!DOCTYPE html><html><body>gate1-staging: redirect captured (not followed)</body></html>";

/** claude.ai / claude.com (+ subdomenii) / loopback: ținte ale căror cereri sunt reținute ca „capturi”. */
export function isCaptureHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "claude.ai" || h === "claude.com" || h.endsWith(".claude.ai") || h.endsWith(".claude.com") || LOOPBACK.has(h);
}

function pathname(u: string): string | null {
  try { return new URL(u).pathname; } catch { return null; }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(onTimeout); });
  });
}

/** Deschide un context izolat (un cont de test) cu garda de origine instalată ÎNAINTE de prima pagină. */
export async function openBrowserSession(browser: PwBrowserLike, t: StagingTargets): Promise<BrowserSession> {
  const ctx = await browser.newContext();
  const captures: string[] = [];
  const allowed = new Set([t.origin, t.supabaseUrl]);
  await ctx.route((u) => !allowed.has(u.origin), async (route) => {
    let host = "";
    try { host = new URL(route.request().url()).hostname; } catch { host = ""; }
    if (isCaptureHost(host)) captures.push(route.request().url());
    await route.abort("blockedbyclient").catch(() => {});
  });
  const page = await ctx.newPage();

  const settle = async (): Promise<void> => { await page.waitForLoadState("networkidle", { timeout: IDLE_TIMEOUT_MS }).catch(() => {}); };

  return {
    async open(url) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await settle();
        return { finalUrl: page.url() };
      } catch {
        return { finalUrl: null };
      }
    },

    async submitSignup(email) {
      try {
        await page.goto(`${t.origin}/signup`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await settle(); // hidratarea ÎNAINTE de input: altfel React resetează valoarea / click-ul face submit nativ
        const input = page.locator("#email").first();
        await input.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
        for (let attempt = 0; attempt < 2; attempt++) {
          await input.fill(email, { timeout: ACTION_TIMEOUT_MS });
          if ((await input.inputValue({ timeout: ACTION_TIMEOUT_MS })) === email) break;
          await settle();
        }
        if ((await input.inputValue({ timeout: ACTION_TIMEOUT_MS })) !== email) return "failed";
        await page.locator("button[type=submit]").first().click({ timeout: ACTION_TIMEOUT_MS });
      } catch {
        return "failed";
      }
      try {
        await page.locator("text=Check your email").first().waitFor({ state: "visible", timeout: NAV_TIMEOUT_MS });
        return "sent";
      } catch {
        return "form_error"; // eroarea Supabase din formular (rate limit, hook care răspunde cu eroare…) sau submit nativ
      }
    },

    async cookieNames() {
      try { return (await ctx.cookies()).map((c) => c.name); } catch { return []; }
    },

    async hasApproveButton() {
      try { return (await page.locator("button[value=approve]").count()) > 0; } catch { return false; }
    },

    async approveConsent(): Promise<ApproveResult> {
      const isConsent: PwUrlMatcher = (u) => u.origin === t.origin && u.pathname === t.consentPath;
      let resolveResult: (r: ApproveResult) => void = () => {};
      const result = new Promise<ApproveResult>((res) => { resolveResult = res; });
      const handler: PwRouteHandler = async (route) => {
        if (route.request().method() !== "POST") { await route.fallback().catch(() => {}); return; }
        try {
          const resp = await route.fetch({ maxRedirects: 0, timeout: ACTION_TIMEOUT_MS });
          const status = resp.status();
          const loc = resp.headers()["location"];
          if (status >= 300 && status < 400 && typeof loc === "string" && loc !== "") {
            const abs = new URL(loc, route.request().url()).href;
            await route.fulfill({ status: 200, contentType: "text/html", body: CAPTURED_HTML });
            resolveResult({ kind: "captured", location: abs });
          } else {
            await route.fulfill({ response: resp });
            resolveResult({ kind: "not_redirected", status });
          }
        } catch {
          await route.abort("failed").catch(() => {});
          resolveResult({ kind: "failed" });
        }
      };
      await page.route(isConsent, handler);
      try {
        await settle(); // hidratarea înainte de click
        await page.locator("button[value=approve]").first().click({ timeout: ACTION_TIMEOUT_MS });
        return await withTimeout(result, NAV_TIMEOUT_MS, { kind: "failed" });
      } catch {
        return { kind: "failed" };
      } finally {
        await page.unroute(isConsent, handler).catch(() => {});
      }
    },

    async probeAuthorizeNoFollow(url) {
      try {
        let cur = url;
        for (let hop = 0; hop < 4; hop++) {
          const resp = await ctx.request.get(cur, { maxRedirects: 0, timeout: ACTION_TIMEOUT_MS });
          const res = { status: resp.status(), headers: resp.headers(), body: await resp.text() };
          const h = nextHop(res, cur, t.origin);
          if (h.kind === "offsite") return { startStatus: null, redirectLocation: h.url, approveVisible: false };
          if (h.kind === "same_origin") {
            // Singurul hop permis: pagina `/authorize` (flux inițial) → `/api/oauth/authorize/start`.
            if (pathname(cur) === "/authorize" && pathname(h.url) === t.startPath) { cur = h.url; continue; }
            return { startStatus: null, redirectLocation: h.url, approveVisible: false };
          }
          return {
            startStatus:      pathname(cur) === t.startPath ? res.status : null,
            redirectLocation: null,
            approveVisible:   /value="approve"/.test(res.body),
          };
        }
        return { startStatus: null, redirectLocation: null, approveVisible: false };
      } catch {
        return { startStatus: null, redirectLocation: null, approveVisible: false };
      }
    },

    async clickRevoke() {
      try {
        await page.goto(t.dashboardUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await settle();
      } catch { return "missing"; }
      const btn = page.locator('[data-testid="revoke-claude-access"]');
      const out = page.locator('[data-testid="revoke-result"]');
      try { if ((await btn.count()) === 0) return "missing"; } catch { return "missing"; }
      // Două încercări: un click înainte de hidratare nu face nimic (buton type=button); acțiunea e idempotentă.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await btn.first().click({ timeout: ACTION_TIMEOUT_MS });
          await out.first().waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
          return (await out.first().getAttribute("data-status")) === "ok" ? "ok" : "error";
        } catch { /* reîncearcă o dată */ }
      }
      return "error";
    },

    offsiteCaptures() { return captures.slice(); },

    async close() { await ctx.close(); },
  };
}
