/**
 * lib/mcp/canaryRedisRetry.test.ts — PH-12 12.5b-4b (retry bounded al cleanup-ului Redis, hermetic).
 *
 * Testează `runCleanupWithBoundedRetry` cu `runOnce` scriptat (rapoarte deterministe) + un caz end-to-end pe modulul
 * REAL (`runCanaryRedisCleanup` + fake port): tranzitoriu→verde, structural→roșu fără retry, structural nemascabil de un
 * verde ulterior, tranzitoriu persistent→roșu bounded, clamp maxAttempts.
 */

import { createHash } from "crypto";
import { runCleanupWithBoundedRetry, isStructuralCleanupFailure } from "./canaryRedisRetry";
import type { RedisCleanupReport } from "./canaryRedisCleanup";
import { makeKeyLedger, runCanaryRedisCleanup, type CanaryRedisPort } from "./canaryRedisCleanup";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

// ── factory de rapoarte ──
const base = (): RedisCleanupReport => ({ ok: false, deleted: 0, familyIdsSeen: 1, invariantBroken: false, errors: [], stillPresent: [], proofUnavailable: [] });
const okRep         = (): RedisCleanupReport => ({ ...base(), ok: true, deleted: 1 });
const transientErr  = (): RedisCleanupReport => ({ ...base(), errors: [{ target: "family", code: "unavailable" }] });
const transientProof= (): RedisCleanupReport => ({ ...base(), proofUnavailable: ["access"] });
const transientResid= (): RedisCleanupReport => ({ ...base(), stillPresent: ["code"] });
const structuralErr = (): RedisCleanupReport => ({ ...base(), familyIdsSeen: 0, errors: [{ target: "access", code: "unexpected_payload" }] });
const corruptErr    = (): RedisCleanupReport => ({ ...base(), errors: [{ target: "refresh", code: "corrupt_payload" }] });
const invariantErr  = (): RedisCleanupReport => ({ ...base(), invariantBroken: true, familyIdsSeen: 2, deleted: 2 });

function scripted(seq: RedisCleanupReport[]): () => Promise<RedisCleanupReport> {
  let i = 0;
  return async () => seq[Math.min(i++, seq.length - 1)];
}

async function main(): Promise<void> {
  console.log("PH-12 12.5b-4b — retry bounded cleanup Redis (hermetic)");

  // ── clasificator ──
  check("0a. structural: unexpected_payload", isStructuralCleanupFailure(structuralErr()) === true);
  check("0b. structural: corrupt_payload", isStructuralCleanupFailure(corruptErr()) === true);
  check("0c. structural: invariantBroken", isStructuralCleanupFailure(invariantErr()) === true);
  check("0d. NON-structural: unavailable/proof/reziduu", !isStructuralCleanupFailure(transientErr()) && !isStructuralCleanupFailure(transientProof()) && !isStructuralCleanupFailure(transientResid()));

  // ── 1. verde din prima → 1 încercare ──
  {
    const r = await runCleanupWithBoundedRetry(scripted([okRep()]), { maxAttempts: 3 });
    check("1. verde din prima → ok, attempts=1", r.ok && r.attempts === 1 && !r.sawStructural);
  }

  // ── 2. tranzitoriu apoi verde → recuperat în 2 (fiecare tip de tranzitoriu) ──
  for (const [label, t] of [["unavailable", transientErr], ["proofUnavailable", transientProof], ["stillPresent", transientResid]] as const) {
    let retries = 0;
    const r = await runCleanupWithBoundedRetry(scripted([t(), okRep()]), { maxAttempts: 3, onRetry: () => { retries++; } });
    check(`2.${label}: tranzitoriu→verde în 2, onRetry o dată`, r.ok && r.attempts === 2 && retries === 1);
  }

  // ── 3. structural din prima → roșu, FĂRĂ retry (attempts=1) ──
  {
    let retries = 0;
    const r = await runCleanupWithBoundedRetry(scripted([structuralErr(), okRep()]), { maxAttempts: 3, onRetry: () => { retries++; } });
    check("3. structural din prima → roșu, attempts=1, zero retry", r.ok === false && r.sawStructural && r.attempts === 1 && retries === 0);
  }

  // ── 4. tranzitoriu apoi structural → roșu, sticky (nu mascat de un verde scriptat după) ──
  {
    const r = await runCleanupWithBoundedRetry(scripted([transientErr(), structuralErr(), okRep()]), { maxAttempts: 3 });
    check("4. tranzitoriu→structural→(verde ignorat) → roșu, attempts=2", r.ok === false && r.sawStructural && r.attempts === 2);
  }

  // ── 5. tranzitoriu persistent → roșu, bounded exact la maxAttempts ──
  {
    let retries = 0;
    const r = await runCleanupWithBoundedRetry(scripted([transientErr()]), { maxAttempts: 3, onRetry: () => { retries++; } });
    check("5. persistent → roșu, attempts=3, retry între încercări=2", r.ok === false && !r.sawStructural && r.attempts === 3 && retries === 2);
  }

  // ── 6. invariantBroken e structural → roșu, fără retry ──
  {
    const r = await runCleanupWithBoundedRetry(scripted([invariantErr(), okRep()]), { maxAttempts: 3 });
    check("6. invariantBroken → roșu, attempts=1", r.ok === false && r.sawStructural && r.attempts === 1);
  }

  // ── 7. clamp maxAttempts (0/negativ → cel puțin 1) ──
  {
    const r = await runCleanupWithBoundedRetry(scripted([transientErr()]), { maxAttempts: 0 });
    check("7. maxAttempts=0 clamp la 1 → attempts=1", r.attempts === 1);
    const rNeg = await runCleanupWithBoundedRetry(scripted([transientErr()]), { maxAttempts: -5 });
    check("7b. maxAttempts negativ → attempts=1", rNeg.attempts === 1);
  }

  // ── 7c (cgpt P2): maxAttempts NON-FINIT nu rupe bounded — NaN/Infinity → default 3, NU buclă infinită / zero rulări ──
  {
    const rNaN = await runCleanupWithBoundedRetry(scripted([transientErr()]), { maxAttempts: NaN });
    check("7c. NaN → default 3 (rulează, nu sare bucla): attempts=3, roșu", rNaN.attempts === 3 && rNaN.ok === false && rNaN.report !== undefined);
    const rInf = await runCleanupWithBoundedRetry(scripted([transientErr()]), { maxAttempts: Infinity });
    check("7d. Infinity → default 3 (bounded, NU infinit): attempts=3", rInf.attempts === 3 && rInf.ok === false);
    // sanity: un NaN care s-ar termina verde din prima tot funcționează (nu blochează)
    const rNaNok = await runCleanupWithBoundedRetry(scripted([okRep()]), { maxAttempts: NaN });
    check("7e. NaN cu verde din prima → ok, attempts=1", rNaNok.ok === true && rNaNok.attempts === 1);
  }

  // ── 8. END-TO-END pe modulul REAL: family DEL unavailable prima dată, apoi merge → verde în 2 (retry-safe ledger) ──
  {
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const kAccess = (t: string) => `mcp:token:${sha(t)}`;
    const kRefresh = (t: string) => `mcp:refresh:${sha(t)}`;
    const kFamily = (f: string) => `mcp:refresh_family:${f}`;
    const userTok = (f: string) => JSON.stringify({ subject_kind: "user", user_id: "u1", grant_id: "g1", entitlement_version: 1, client_id: "c", scopes: ["read:basic"], issued_at: 1, audience: "http://127.0.0.1:8080/api/mcp", family_id: f });
    const store = new Map<string, string>([[kAccess("A"), userTok("F")], [kRefresh("C"), userTok("F")], [kFamily("F"), sha("C")]]);
    let famDel = 0;
    const port: CanaryRedisPort = {
      async get(k) { const v = store.get(k); return v === undefined ? { status: "not_found" } : { status: "found", value: v }; },
      async del(k) { if (k.startsWith("mcp:refresh_family:")) { famDel++; if (famDel <= 1) return { status: "unavailable" }; } const had = store.delete(k); return had ? { status: "deleted" } : { status: "not_found" }; },
    };
    const led = makeKeyLedger();
    led.recordAccessToken("A"); led.recordRefreshToken("C");
    const r = await runCleanupWithBoundedRetry(() => runCanaryRedisCleanup(port, led, led.recordFamilyId), { maxAttempts: 3 });
    check("8. real: family DEL tranzitoriu → verde în 2, familia ștearsă via resolvedFamilyIds", r.ok === true && r.attempts === 2 && !store.has(kFamily("F")));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
