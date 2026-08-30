/**
 * lib/oauth/resumeBindPlan.test.ts — PH-2 pas 6 frunză 4b (state machine PUR /auth/resume).
 *
 * Pur (doar isTransactionExpired din authzTransaction; restul e `import type`) → tsx-testabil FĂRĂ Redis/next/supabase.
 * Acoperă: entry (login cookie-păstrat / retryable / proceed), read step cu EXPIRARE aplicată înainte de bind (corecția
 * 2), bind step (conflict→reread doar atac 1), rebind (același user câștigă CAS / account-switch / încă nelegat) și
 * politica de cookie (clear DOAR pe resume_ok/invalid; keep pe retryable/login).
 */
import {
  planResumeEntry, classifyReadStep, classifyBindStep, classifyRebind, resumeClearsCookie,
  type CheckedReadStep,
} from "./resumeBindPlan";
import type { AuthzTransaction } from "./authzTransaction";
import type { AuthzTxnReadResult, BindAuthzTxnResult } from "../db/authzTxnStoreIo";
import type { SessionState } from "./authorizeGetDecision";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

// Fixture minimal AuthzTransaction (clasificatorii ating doar txn_id / session_user_id / expires_at).
function mkTxn(o: { txn_id?: string; session_user_id?: string | null; expires_at?: number }): AuthzTransaction {
  return {
    txn_id: o.txn_id ?? "txn_abc",
    session_user_id: o.session_user_id ?? null,
    expires_at: o.expires_at ?? 10_000,
  } as unknown as AuthzTransaction;
}
const foundRead = (txn: AuthzTransaction, raw = "RAW"): AuthzTxnReadResult => ({ status: "found", txn, raw });
// CheckedReadStep = ieșirea `bind` a lui classifyReadStep (a trecut prin expirare) — singurul input al lui classifyRebind.
function checkedFrom(txn: AuthzTransaction, raw = "RC"): CheckedReadStep {
  const s = classifyReadStep(foundRead(txn, raw), (txn.expires_at as number) - 1); // ne-expirat
  if (s.kind !== "bind") throw new Error("fixture: așteptam bind");
  return s;
}

// Probă COMPILE-TIME (cgpt P1): un `AuthzTransaction` BRUT NU e acceptat de classifyRebind (cere CheckedReadStep, deci
// forțează trecerea prin expirare). Funcție MOARTĂ — validată de `tsc`, NICIODATĂ rulată de `tsx` (altfel `checked.txn`
// ar fi undefined la runtime). Dacă cineva relaxează semnătura, `@ts-expect-error` devine nefolosit → tsc pică.
function _compileProofP1(): void {
  // @ts-expect-error — mkTxn(...) e AuthzTransaction, nu CheckedReadStep (ieșirea `bind` a classifyReadStep)
  classifyRebind(mkTxn({ session_user_id: "u1" }), "u1");
}
void _compileProofP1; // referință fără APEL (nu executa corpul sub tsx)

function main(): void {
console.log("PH-2 pas 6 frunză 4b — resumeBindPlan (entry + ladder read/bind, pur)");

// ── entry: cookie deja prezent (fără cookie → dashboard în rută, nu aici) ────────
const auth: SessionState = { kind: "authenticated", userId: "u1" };
check("1. ⭐⭐⭐ authenticated → proceed{userId} (intră în ladder)", (() => {
  const e = planResumeEntry(auth); return e.kind === "proceed" && e.userId === "u1";
})());
check("2. ⭐⭐⭐ anonymous → login (cookie PĂSTRAT: puntea login↔txn)", planResumeEntry({ kind: "anonymous" }).kind === "login");
check("3. ⭐⭐⭐ session unavailable → retryable (503, cookie PĂSTRAT — NU login)", planResumeEntry({ kind: "unavailable" }).kind === "retryable");

// ── read step: EXPIRARE aplicată ÎNAINTE de bind (corecția 2) ────────────────────
check("4. ⭐⭐⭐ read unavailable → retryable (fără bind)", classifyReadStep({ status: "unavailable" }, 0).kind === "retryable");
check("5. ⭐⭐⭐ read absent → invalid", classifyReadStep({ status: "absent" }, 0).kind === "invalid");
check("6. ⭐⭐⭐ read corrupt → invalid", classifyReadStep({ status: "corrupt" }, 0).kind === "invalid");
check("7. ⭐⭐⭐ found + ne-expirat (now < expires_at) → bind{txn,raw}", (() => {
  const s = classifyReadStep(foundRead(mkTxn({ expires_at: 10_000 }), "R1"), 5_000);
  return s.kind === "bind" && s.raw === "R1";
})());
check("8. ⭐⭐⭐ found + EXPIRAT (now ≥ expires_at) → invalid, NU bind (blob mort nu se leagă chiar dacă cheia trăiește)",
  classifyReadStep(foundRead(mkTxn({ expires_at: 10_000 })), 10_000).kind === "invalid");
check("9. ⭐⭐ found + expires_at NaN → invalid (isTransactionExpired fail-closed)",
  classifyReadStep(foundRead(mkTxn({ expires_at: NaN })), 5_000).kind === "invalid");
check("10. ⭐⭐ found + nowMs NaN → invalid (fail-closed pe timp corupt)",
  classifyReadStep(foundRead(mkTxn({ expires_at: 10_000 })), NaN).kind === "invalid");
check("11. ⭐ found exact la expires_at → invalid (≥, aliniat cu isTransactionExpired)",
  classifyReadStep(foundRead(mkTxn({ expires_at: 7_000 })), 7_000).kind === "invalid");

// ── bind step: conflict → reread DOAR pe atacul 1; txnId din bind.txn.txn_id (P2) ─
const mkUpdated = (txnId: string): BindAuthzTxnResult => ({ status: "updated", txn: mkTxn({ txn_id: txnId }), raw: "NR" });
const B = (status: BindAuthzTxnResult["status"]): BindAuthzTxnResult => {
  if (status === "reject") return { status: "reject", reason: "x" };
  return { status } as BindAuthzTxnResult;
};
check("12. ⭐⭐⭐ bind updated → resume_ok{txnId}", (() => {
  const s = classifyBindStep(mkUpdated("txn_z"), true); return s.kind === "resume_ok" && s.txnId === "txn_z";
})());
check("12b. ⭐⭐⭐ P2: resume_ok.txnId = bind.txn.txn_id ('stored-id'), NU un id extern al apelantului", (() => {
  const s = classifyBindStep(mkUpdated("stored-id"), true); return s.kind === "resume_ok" && s.txnId === "stored-id";
})());
check("13. ⭐⭐⭐ bind reject (account-switch) → invalid", classifyBindStep(B("reject"), true).kind === "invalid");
check("14. ⭐⭐ bind absent → invalid", classifyBindStep(B("absent"), true).kind === "invalid");
check("15. ⭐⭐ bind expired → invalid", classifyBindStep(B("expired"), true).kind === "invalid");
check("16. ⭐⭐⭐ bind unavailable → retryable (503, cookie păstrat)", classifyBindStep(B("unavailable"), true).kind === "retryable");
check("17. ⭐⭐⭐ bind conflict + allowRetry (atac 1) → reread", classifyBindStep(B("conflict"), true).kind === "reread");
check("18. ⭐⭐⭐ bind conflict + !allowRetry (atac 2) → retryable (fără al treilea retry — NU reread)",
  classifyBindStep(B("conflict"), false).kind === "retryable");
check("19. ⭐⭐ atac 2 updated tot → resume_ok (allowRetry irelevant pe succes)", classifyBindStep(mkUpdated("x"), false).kind === "resume_ok");

// ── rebind: ia DOAR CheckedReadStep (ieșirea `bind` a classifyReadStep) — P1 ─────
check("20. ⭐⭐⭐ re-read legat de ACELAȘI user (tab concurent a câștigat CAS) → resume_ok FĂRĂ alt bind", (() => {
  const s = classifyRebind(checkedFrom(mkTxn({ txn_id: "txn_q", session_user_id: "u1" })), "u1");
  return s.kind === "resume_ok" && s.txnId === "txn_q";
})());
check("21. ⭐⭐⭐ re-read legat de ALT user → invalid (account-switch, terminal)",
  classifyRebind(checkedFrom(mkTxn({ session_user_id: "u2" })), "u1").kind === "invalid");
check("22. ⭐⭐⭐ re-read încă NELEGAT (null) → bind{txn,raw} (un ULTIM bindAuthzTxnUser)", (() => {
  const s = classifyRebind(checkedFrom(mkTxn({ session_user_id: null }), "R2"), "u1");
  return s.kind === "bind" && s.raw === "R2";
})());
check("22b. ⭐⭐⭐ P1: classifyRebind consumă ieșirea `bind` a classifyReadStep (deci trecută prin expirare), nu txn brut", (() => {
  const checked = checkedFrom(mkTxn({ txn_id: "txn_e", session_user_id: "u1", expires_at: 10_000 }));
  return checked.kind === "bind" && classifyRebind(checked, "u1").kind === "resume_ok";
})());

// ── politica de cookie (regula lui Marco) ───────────────────────────────────────
check("23. ⭐⭐⭐ resume_ok → CLEAR cookie", resumeClearsCookie("resume_ok") === true);
check("24. ⭐⭐⭐ invalid (dead/corrupt/expired/account-switch) → CLEAR cookie", resumeClearsCookie("invalid") === true);
check("25. ⭐⭐⭐ retryable (unavailable / al 2-lea conflict) → PĂSTREAZĂ cookie", resumeClearsCookie("retryable") === false);
check("26. ⭐⭐⭐ login (anonymous) → PĂSTREAZĂ cookie (puntea login↔txn)", resumeClearsCookie("login") === false);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
