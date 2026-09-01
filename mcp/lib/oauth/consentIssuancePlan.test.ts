/**
 * lib/oauth/consentIssuancePlan.test.ts — PH-2 pas 6 frunză 5a-planner (mașina de stări PURĂ a POST-ului /consent).
 * Zero I/O; acoperă fiecare ramură a fiecărei etape + contractul P1 (unavailable = stare incertă, 503, nu presupune txn).
 */
import {
  planConsentAction, planPayloadBuild, planAfterInsert, planAfterConsume, planAfterDenyConsume, planActionClaim,
  type ConsentRedirect,
} from "./consentIssuancePlan";
import type { ConsentGrantOutcome } from "./authorizeConsent";
import type { OAuthGrant } from "./grant";
import type { InsertGrantResult } from "../db/grantInsert";
import type { ConsumeIssueOutcome } from "../db/oauth-codes";
import type { AuthCodePayload } from "../db/oauthAtomic";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const GRANT = { grant_id: "g1" } as unknown as OAuthGrant; // planner-ul îl trece mai departe, nu-l inspectează
const PAYLOAD = { client_id: "c1" } as unknown as AuthCodePayload; // idem: dus mai departe, nu inspectat
const R: ConsentRedirect = { redirectUri: "https://app.test/cb", state: "st-123", iss: "https://as.test" };
const R_NOSTATE: ConsentRedirect = { redirectUri: "https://app.test/cb", iss: "https://as.test" };

function main(): void {
console.log("PH-2 pas 6 frunză 5a-planner — consentIssuancePlan (pur, în etape)");

// ── Etapa 0: planActionClaim (arbitrare cross-action) ────────────────────────────────────────────────
check("0a. ⭐⭐⭐ claim won → proceed", planActionClaim({ status: "won" }).kind === "proceed");
check("0b. ⭐⭐⭐ claim idempotent (retry propriu) → proceed", planActionClaim({ status: "idempotent" }).kind === "proceed");
{
  const s = planActionClaim({ status: "lost", winner: "deny" });
  check("0c. ⭐⭐⭐ claim lost → terminal local_error (NU efecte, NU redirect — perdantul nu conduce clientul)",
    s.kind === "terminal" && s.outcome.kind === "local_error" && s.outcome.reason.includes("deny"));
}
check("0d. ⭐⭐⭐ claim unavailable → terminal 503", (() => {
  const s = planActionClaim({ status: "unavailable" });
  return s.kind === "terminal" && s.outcome.kind === "unavailable";
})());

// ── Etapa 1: planConsentAction ────────────────────────────────────────────────────────────────────────
{
  const grant = { kind: "grant", grant: GRANT, claims: {} } as unknown as ConsentGrantOutcome;
  const s = planConsentAction(grant);
  check("1. ⭐⭐⭐ grant → issue", s.kind === "issue");
  check("1b. ⭐⭐⭐ issue poartă EXACT grantul deciziei (aceeași referință)", s.kind === "issue" && s.grant === GRANT);
}
check("2. ⭐⭐⭐ denied → deny (fără issue)", planConsentAction({ kind: "denied" }).kind === "deny");
{
  const s = planConsentAction({ kind: "reject", reason: "csrf greșit" });
  check("3. ⭐⭐⭐ reject → terminal local_error (NU consume, NU redirect)", s.kind === "terminal" && s.outcome.kind === "local_error");
  check("3b. ⭐⭐ reject → error='access_denied' + reason propagat", s.kind === "terminal" && s.outcome.kind === "local_error" && s.outcome.error === "access_denied" && s.outcome.reason === "csrf greșit");
}
{
  const s = planConsentAction({ kind: "error", reason: "registration revocată" });
  check("4. ⭐⭐⭐ error → terminal local_error (invariantă post-consent)", s.kind === "terminal" && s.outcome.kind === "local_error");
  check("4b. ⭐⭐ error → error='server_error' + reason propagat", s.kind === "terminal" && s.outcome.kind === "local_error" && s.outcome.error === "server_error" && s.outcome.reason === "registration revocată");
}
check("5. ⭐⭐⭐ reject/error NU produc niciodată issue/deny (fără emitere pe cerere invalidă)", (() => {
  const a = planConsentAction({ kind: "reject", reason: "x" });
  const b = planConsentAction({ kind: "error",  reason: "y" });
  return a.kind === "terminal" && b.kind === "terminal";
})());

// ── Etapa 2a: planPayloadBuild ──────────────────────────────────────────────────────────────────────
{
  const s = planPayloadBuild({ ok: true, payload: PAYLOAD });
  check("6. ⭐⭐⭐ build ok → insert", s.kind === "insert");
  check("6b. ⭐⭐⭐ insert DUCE payload-ul validat mai departe (aceeași referință)", s.kind === "insert" && s.payload === PAYLOAD);
}
{
  const s = planPayloadBuild({ ok: false, error: "grant_id txn ≠ grant (mix-up)" });
  check("7. ⭐⭐⭐ build eșuat → terminal local_error (nimic scris, txn intactă)", s.kind === "terminal" && s.outcome.kind === "local_error");
  check("7b. ⭐⭐ build eșuat → error='server_error' + reason=build.error", s.kind === "terminal" && s.outcome.kind === "local_error" && s.outcome.error === "server_error" && s.outcome.reason === "grant_id txn ≠ grant (mix-up)");
}

// ── Etapa 2b: planAfterInsert ───────────────────────────────────────────────────────────────────────
check("8. ⭐⭐⭐ insert inserted → consume", planAfterInsert({ status: "inserted" }).kind === "consume");
check("9. ⭐⭐⭐ insert already_present (idempotent) → consume", planAfterInsert({ status: "already_present" }).kind === "consume");
{
  const s = planAfterInsert({ status: "revoked", reason: "persistat ≠ utilizabil" });
  check("10. ⭐⭐⭐ insert revoked → local_error access_denied (persistat ≠ utilizabil, NU emite)", s.kind === "terminal" && s.outcome.kind === "local_error" && s.outcome.error === "access_denied");
}
{
  const s = planAfterInsert({ status: "conflict", reason: "colizie grant_id" });
  check("11. ⭐⭐⭐ insert conflict → local_error server_error (fail-closed)", s.kind === "terminal" && s.outcome.kind === "local_error" && s.outcome.error === "server_error");
}
{
  const s = planAfterInsert({ status: "unavailable", reason: "DB jos" });
  check("12. ⭐⭐⭐ insert unavailable → 503 (consume vine DUPĂ → txn NEatinsă, retry curat)", s.kind === "terminal" && s.outcome.kind === "unavailable");
  check("12b. ⭐⭐ insert unavailable → reason propagat", s.kind === "terminal" && s.outcome.kind === "unavailable" && s.outcome.reason === "DB jos");
}

// ── Etapa 2c: planAfterConsume (ATOMIC) ─────────────────────────────────────────────────────────────
{
  const o: ConsumeIssueOutcome = { status: "issued", code: "CODE_abc" };
  const t = planAfterConsume(o, R);
  check("13. ⭐⭐⭐ consume issued → redirect_code", t.kind === "redirect_code");
  check("13b. ⭐⭐⭐ redirect_code poartă code + redirectUri + state + iss (RFC 9207)",
    t.kind === "redirect_code" && t.code === "CODE_abc" && t.redirectUri === "https://app.test/cb" && t.state === "st-123" && t.iss === "https://as.test");
  const t2 = planAfterConsume(o, R_NOSTATE);
  check("13c. ⭐⭐ redirect_code fără state când txn n-avea state (state undefined)", t2.kind === "redirect_code" && t2.state === undefined && t2.iss === "https://as.test");
}
{
  const t = planAfterConsume({ status: "gone" }, R);
  check("14. ⭐⭐⭐ consume gone → local_error invalid_grant (nimic de emis, repornește)", t.kind === "local_error" && t.error === "invalid_grant");
  check("14b. ⭐⭐⭐ consume gone → FĂRĂ redirect (nu trimite cod inexistent)", t.kind === "local_error");
}
{
  const t = planAfterConsume({ status: "unavailable" }, R);
  check("15. ⭐⭐⭐ consume unavailable → 503 (P1: stare INCERTĂ, NU local_error, NU redirect)", t.kind === "unavailable");
  check("15b. ⭐⭐⭐ consume unavailable ≠ gone (nu maschează AT-MOST-ONCE ca eroare terminală)", planAfterConsume({ status: "unavailable" }, R).kind !== "local_error");
}

// ── Etapa 3: planAfterDenyConsume ───────────────────────────────────────────────────────────────────
{
  const t = planAfterDenyConsume("consumed", R);
  check("16. ⭐⭐⭐ deny consumed → redirect_denied (?error=access_denied)", t.kind === "redirect_denied");
  check("16b. ⭐⭐⭐ redirect_denied poartă redirectUri + state + iss, FĂRĂ code",
    t.kind === "redirect_denied" && t.redirectUri === "https://app.test/cb" && t.state === "st-123" && t.iss === "https://as.test" && !("code" in t));
}
check("17. ⭐⭐⭐ deny gone → local_error invalid_grant (concurent a consumat; fail-closed, NU access_denied contradictoriu)", (() => {
  const t = planAfterDenyConsume("gone", R);
  return t.kind === "local_error" && t.error === "invalid_grant";
})());
check("18. ⭐⭐⭐ deny unavailable → 503 retryable", planAfterDenyConsume("unavailable", R).kind === "unavailable");

// ── izolare: cele patru terminale sunt distincte (503 ≠ pagină locală ≠ redirect) ────────────────────
check("19. ⭐⭐ cele 4 kind-uri terminale sunt distincte", (() => {
  const kinds = new Set([
    (planAfterConsume({ status: "issued", code: "c" }, R)).kind,   // redirect_code
    (planAfterDenyConsume("consumed", R)).kind,                    // redirect_denied
    (planAfterConsume({ status: "gone" }, R)).kind,                // local_error
    (planAfterConsume({ status: "unavailable" }, R)).kind,         // unavailable
  ]);
  return kinds.size === 4;
})());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
