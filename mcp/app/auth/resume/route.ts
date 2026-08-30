/**
 * app/auth/resume/route.ts — PH-2 pas 6 frunză 4c (handler I/O al fluxului login→consent, resource-owner).
 *
 * Callback-ul de login (`app/auth/callback/route.ts`) schimbă codul Supabase EXACT o dată, apoi face 303 AICI. `/auth/
 * resume` NU atinge codul Supabase (nu importă / nu apelează `exchangeCodeForSession`) → un refresh de pagină pe outage
 * e retry SIGUR (codul nu se poate „arde" de două ori). Leagă tranzacția de consent (din cookie-ul de resume) de
 * sesiunea DEJA stabilită și dirijează userul la consent.
 *
 * Ordinea (deciziile lui Marco):
 *   - gate flag ÎNAINTE de orice cookie (flag OFF → 404, dormant ca `/start`).
 *   - fără cookie → `/dashboard` IMEDIAT, FĂRĂ `getSessionState()` (corecția 1: un login normal fără OAuth pending nu
 *     depinde de încă o citire Supabase).
 *   - cookie prezent → `getSessionState()` → `planResumeEntry`: anonymous → `/login` (cookie PĂSTRAT, e puntea login↔
 *     txn); unavailable → 503 (cookie PĂSTRAT); authenticated → ladder read/bind.
 *   - ladder cu retry-o-dată pe conflict CAS; timp PROASPĂT (`Date.now()`) la FIECARE citire → expirarea aplicată
 *     ÎNAINTE de fiecare bind (`classifyReadStep`). Re-read-ul NU reutilizează timpul cererii: între atacuri trece timp
 *     real (un round-trip Redis), iar un txn care expiră în fereastra aia NU trebuie legat (cgpt P1). Cookie ȘTERS DOAR
 *     pe terminale consumate (`resumeClearsCookie`: resume_ok / invalid); PĂSTRAT pe retryable (503) / login.
 */

import { NextResponse, type NextRequest } from "next/server";
import { isResourceOwnerAuthorizeEnabled } from "@/lib/oauth/authorizeResourceOwnerFlag";
import { resolveBaseUrl } from "@/lib/oauth/baseUrl";
import { getSessionState, readResumeCookie, clearResumeCookie } from "@/lib/oauth/sessionResumeIo";
import { readAuthzTxn, bindAuthzTxnUser } from "@/lib/db/authzTxnStoreIo";
import {
  planResumeEntry, classifyReadStep, classifyBindStep, classifyRebind, resumeClearsCookie,
} from "@/lib/oauth/resumeBindPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── helpers de răspuns (toate no-store) ────────────────────────────────────────
function noStore(res: NextResponse): NextResponse { res.headers.set("Cache-Control", "no-store"); return res; }

function notFound(): NextResponse {
  return noStore(new NextResponse("Not Found", { status: 404 }));
}
/** 503 retryable — outage la sesiune/txn store. Cookie-ul NU se atinge → refresh-ul re-atinge `/auth/resume` în siguranță. */
function unavailable(): NextResponse {
  return noStore(new NextResponse("Service temporarily unavailable. Please try again.", { status: 503 }));
}
/** Card de eroare generic (400) — tranzacție dead/corrupt/expirat sau account-switch. Cookie-ul e ȘTERS de apelant. */
function errorCard(): NextResponse {
  const html = "<!DOCTYPE html><html><head><title>Authorization Failed</title></head>"
    + "<body style=\"background:#0a0a0a;color:#fff;font-family:-apple-system,sans-serif;text-align:center;padding:60px\">"
    + "<h1 style=\"color:#ff4444;font-size:20px\">Authorization Failed</h1>"
    + "<p style=\"color:#888\">This authorization request has expired or is invalid. Please restart the connection.</p></body></html>";
  return noStore(new NextResponse(html, { status: 400, headers: { "Content-Type": "text/html" } }));
}
/** Eroare internă generică (500) — boundary de excepții: orice throw neașteptat NU scurge stack la client. */
function internalError(): NextResponse {
  return noStore(new NextResponse("Internal Server Error", { status: 500 }));
}
function redirectTo(url: string): NextResponse {
  return noStore(NextResponse.redirect(url, 302));
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // DORMANT: flag OFF → inaccesibil (callback-ul nici nu face handoff când flag OFF).
  if (!isResourceOwnerAuthorizeEnabled(process.env)) return notFound();
  try {
    return await handleResume(req);
  } catch (err) {
    console.error("[AUTH RESUME] unhandled:", err);
    return internalError();
  }
}

async function handleResume(req: NextRequest): Promise<NextResponse> {
  const origin = resolveBaseUrl(req.headers, process.env); // origine CANONICĂ (dashboard/login/authorize)

  // Corecția 1: citește cookie-ul PRIMUL. Fără cookie (absent SAU format invalid) → `/dashboard` direct, FĂRĂ să mai
  // citim sesiunea (un login normal, fără OAuth pending, nu depinde de încă un round-trip Supabase).
  const txnId = await readResumeCookie();
  if (txnId === null) return redirectTo(`${origin}/dashboard`);

  const session = await getSessionState();
  const entry = planResumeEntry(session);
  if (entry.kind === "login")     return redirectTo(`${origin}/login`); // cookie PĂSTRAT (puntea login↔txn)
  if (entry.kind === "retryable") return unavailable();                 // 503, cookie PĂSTRAT
  // entry.kind === "proceed"

  const outcome = await runLadder(txnId, entry.userId); // resume_ok | invalid | retryable (timp proaspăt intern)
  // Cookie ȘTERS DOAR pe terminale consumate; PĂSTRAT pe retryable (refresh sigur).
  if (resumeClearsCookie(outcome.kind)) await clearResumeCookie();

  switch (outcome.kind) {
    case "resume_ok": {
      const u = new URL(`${origin}/authorize`);
      u.searchParams.set("txn_id", outcome.txnId);
      return redirectTo(u.toString());
    }
    case "invalid":
      console.error("[AUTH RESUME] invalid:", outcome.reason);
      return errorCard();
    case "retryable":
      console.error("[AUTH RESUME] retryable:", outcome.reason);
      return unavailable();
    default: {
      const _exhaustive: never = outcome;
      console.error("[AUTH RESUME] outcome necunoscut", _exhaustive);
      return internalError();
    }
  }
}

/** Rezultat TERMINAL al ladder-ului (subset din clasificatori: doar cele care ajung înapoi la rută). */
type LadderOutcome =
  | { kind: "resume_ok"; txnId: string }
  | { kind: "invalid"; reason: string }
  | { kind: "retryable"; reason: string };

/**
 * Ladder read→bind cu RETRY o singură dată pe conflict CAS. Timp PROASPĂT (`Date.now()`) la FIECARE citire → expirarea
 * aplicată ÎNAINTE de fiecare bind (`classifyReadStep`); re-read-ul NU reutilizează timpul atacului 1 (între ele trece
 * timp real → un txn expirat în fereastră NU se leagă, cgpt P1). Atac 1: read → (found+ne-expirat) bind → conflict?
 * re-read. Atac 2: re-read → inspectează legarea (`classifyRebind`: același user câștigat / alt user / încă nelegat) →
 * eventual un ULTIM bind; al doilea conflict → retryable (fără al treilea retry). Nu atinge NICIODATĂ codul Supabase.
 */
async function runLadder(txnId: string, userId: string): Promise<LadderOutcome> {
  // ── atac 1 ──
  const read1 = await readAuthzTxn(txnId);
  const step1 = classifyReadStep(read1, Date.now()); // timp PROASPĂT
  if (step1.kind !== "bind") return step1; // retryable | invalid
  const bind1 = await bindAuthzTxnUser({ txn: step1.txn, raw: step1.raw }, userId);
  const b1 = classifyBindStep(bind1, true); // conflict → reread
  if (b1.kind !== "reread") return b1;      // resume_ok | invalid | retryable

  // ── atac 2 (re-read + retry O DATĂ) ──
  const read2 = await readAuthzTxn(txnId);
  const step2 = classifyReadStep(read2, Date.now()); // timp PROASPĂT din nou (re-read poate depăși expirarea)
  if (step2.kind !== "bind") return step2;
  const reb = classifyRebind(step2, userId); // resume_ok (același user) | invalid (alt user) | bind (încă nelegat)
  if (reb.kind !== "bind") return reb;
  const bind2 = await bindAuthzTxnUser({ txn: reb.txn, raw: reb.raw }, userId);
  return classifyBindStep(bind2, false); // al doilea conflict → retryable (fără al treilea retry)
}
