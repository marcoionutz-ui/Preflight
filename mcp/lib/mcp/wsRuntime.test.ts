/**
 * lib/mcp/wsRuntime.test.ts — D1c (WS-liveness leaf, anti-stale + anti-false-fresh).
 *
 * Acoperă cele trei frunze pure din health-freshness care decid semnalele WS-liveness expuse prin MCP:
 *   - adjustWsAgeSec     — vârsta publicată (la updatedAt) → vârsta la `now`; P2: negativ/NaN/Inf → null.
 *   - resolveWsRuntime   — validare+normalizare a unui worker_runtime raw (chain-guard, updatedAt, viitor/expirat).
 *   - isWsStreamStale    — „transport viu + data stream mort"; P3: pong necunoscut (null) ≠ recent.
 * Fără Redis, fără timere — doar input→output. Exact GAP-ul din cgpt P2/P3 (fals-fresh pe date corupte/necunoscute).
 */

import { adjustWsAgeSec, resolveWsRuntime, isWsStreamStale, resolveWsSub, classifyWsSubs } from "./health-freshness";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

// normalizeChainId de test: lower + eth→ethereum (suficient pt. chain-guard-ul din resolveWsRuntime).
const normalizeChain = (s: string): string => {
  const v = s.trim().toLowerCase();
  return v === "eth" ? "ethereum" : v;
};

const OPTS = { maxAgeMs: 120_000, futureSkewMs: 30_000, normalizeChain };
const NOW = 1_000_000_000_000; // timestamp fix (fără Date.now — determinist)

function main(): void {
  console.log("D1c — wsRuntime (adjustWsAgeSec / resolveWsRuntime / isWsStreamStale)");

  // ── adjustWsAgeSec ──────────────────────────────────────────────────────────
  console.log(" adjustWsAgeSec:");
  check("a1. 10 publicat + 5 runtime → 15", adjustWsAgeSec(10, 5) === 15);
  check("a2. 0 publicat + 5 runtime → 5", adjustWsAgeSec(0, 5) === 5);
  check("a3. P2: negativ (-500) -> null (nu acum)", adjustWsAgeSec(-500, 5) === null);
  check("a4. null publicat → null", adjustWsAgeSec(null, 5) === null);
  check("a5. undefined publicat → null", adjustWsAgeSec(undefined, 5) === null);
  check("a6. NaN → null", adjustWsAgeSec(NaN, 5) === null);
  check("a7. Infinity → null", adjustWsAgeSec(Infinity, 5) === null);
  check("a8. string → null", adjustWsAgeSec("30" as unknown, 5) === null);
  check("a9. runtimeAgeSec negativ clampat la 0 (12 + (-3) → 12)", adjustWsAgeSec(12, -3) === 12);
  check("a10. rotunjire (10.6 + 4.4 → 11 + 4 = 15)", adjustWsAgeSec(10.6, 4.4) === 15);

  // ── resolveWsRuntime ────────────────────────────────────────────────────────
  console.log(" resolveWsRuntime:");
  {
    const r = resolveWsRuntime(
      { chain: "ethereum", updatedAt: NOW - 10_000, wsConnected: true, lastPongAgeSec: 4, lastWsMessageAgeSec: 400 },
      "ethereum", NOW, OPTS);
    check("r1. valid → entry", r !== null);
    check("r2. → updatedAt păstrat", r?.updatedAt === NOW - 10_000);
    check("r3. → wsConnected true", r?.wsConnected === true);
    check("r4. → pong ajustat (4 + 10s runtime = 14)", r?.lastPongAgeSec === 14);
    check("r5. → message ajustat (400 + 10 = 410)", r?.lastWsMessageAgeSec === 410);
  }
  check("r6. ⭐ chain mismatch (payload bsc pe cheia ethereum) → null",
    resolveWsRuntime({ chain: "bsc", updatedAt: NOW, wsConnected: true }, "ethereum", NOW, OPTS) === null);
  check("r7. alias eth→ethereum acceptat pe cheia ethereum",
    resolveWsRuntime({ chain: "eth", updatedAt: NOW, wsConnected: true }, "ethereum", NOW, OPTS) !== null);
  check("r8. updatedAt lipsă/NaN → null",
    resolveWsRuntime({ chain: "ethereum", updatedAt: "x", wsConnected: true }, "ethereum", NOW, OPTS) === null);
  check("r9. expirat (>120s) → null",
    resolveWsRuntime({ chain: "ethereum", updatedAt: NOW - 130_000, wsConnected: true }, "ethereum", NOW, OPTS) === null);
  check("r10. viitor (>30s) → null",
    resolveWsRuntime({ chain: "ethereum", updatedAt: NOW + 40_000, wsConnected: true }, "ethereum", NOW, OPTS) === null);
  check("r11. viitor mic (<30s) acceptat",
    resolveWsRuntime({ chain: "ethereum", updatedAt: NOW + 5_000, wsConnected: true }, "ethereum", NOW, OPTS) !== null);
  {
    // P2 la nivel de entry: pong negativ → intrarea SUPRAVIEȚUIEȘTE dar pong-ul devine null (necunoscut).
    const r = resolveWsRuntime(
      { chain: "ethereum", updatedAt: NOW - 5_000, wsConnected: true, lastPongAgeSec: -500, lastWsMessageAgeSec: 40 },
      "ethereum", NOW, OPTS);
    check("r12. ⭐ P2: pong negativ → entry OK, pong=null", r !== null && r.lastPongAgeSec === null);
    check("r13.   message tot ajustat (40 + 5 = 45)", r?.lastWsMessageAgeSec === 45);
  }
  check("r14. wsConnected non-true → false (nu adevărat coerc.)",
    resolveWsRuntime({ chain: "ethereum", updatedAt: NOW, wsConnected: "yes" as unknown }, "ethereum", NOW, OPTS)?.wsConnected === false);

  // ── isWsStreamStale ─────────────────────────────────────────────────────────
  console.log(" isWsStreamStale:");
  const PF = 90, ST = 300;
  check("s1. ⭐ connected + pong 10 (viu) + msg 400 (mort) → true",
    isWsStreamStale({ wsConnected: true, lastPongAgeSec: 10, lastWsMessageAgeSec: 400 }, PF, ST) === true);
  check("s2. ⭐ P3: connected + pong NULL + msg 400 → false (pong necunoscut ≠ viu)",
    isWsStreamStale({ wsConnected: true, lastPongAgeSec: null, lastWsMessageAgeSec: 400 }, PF, ST) === false);
  check("s3. pong 200 (>fresh) + msg 400 → false (transport nedovedit viu)",
    isWsStreamStale({ wsConnected: true, lastPongAgeSec: 200, lastWsMessageAgeSec: 400 }, PF, ST) === false);
  check("s4. msg 100 (<stale) → false (data stream nu-i mort)",
    isWsStreamStale({ wsConnected: true, lastPongAgeSec: 10, lastWsMessageAgeSec: 100 }, PF, ST) === false);
  check("s5. msg NULL → false (nu putem afirma stale)",
    isWsStreamStale({ wsConnected: true, lastPongAgeSec: 10, lastWsMessageAgeSec: null }, PF, ST) === false);
  check("s6. not connected → false",
    isWsStreamStale({ wsConnected: false, lastPongAgeSec: 10, lastWsMessageAgeSec: 400 }, PF, ST) === false);
  check("s7. undefined (chain fără runtime) → false",
    isWsStreamStale(undefined, PF, ST) === false);
  check("s8. graniță: pong exact 90 (===fresh, nu <) → false",
    isWsStreamStale({ wsConnected: true, lastPongAgeSec: 90, lastWsMessageAgeSec: 400 }, PF, ST) === false);
  check("s9. graniță: msg exact 300 (===stale, nu >) → false",
    isWsStreamStale({ wsConnected: true, lastPongAgeSec: 10, lastWsMessageAgeSec: 300 }, PF, ST) === false);

  // ── Part B: resolveWsSub ─────────────────────────────────────────────────────
  console.log(" resolveWsSub:");
  {
    const e = resolveWsSub({ confirmed: true, poolCount: 3, lastMessageAgeSec: 40, confirmedAgeSec: 120 }, 10);
    check("b1. valid → entry", e !== null);
    check("b2. → confirmed true", e?.confirmed === true);
    check("b3. → poolCount 3", e?.poolCount === 3);
    check("b4. → lastMessageAgeSec ajustat (40 + 10 = 50)", e?.lastMessageAgeSec === 50);
    check("b4b. → confirmedAgeSec ajustat (120 + 10 = 130)", e?.confirmedAgeSec === 130);
  }
  check("b5. undefined → null (kind nepublicat)", resolveWsSub(undefined, 10) === null);
  check("b6. null → null", resolveWsSub(null, 10) === null);
  check("b7. confirmed non-true (coerc.) → false",
    resolveWsSub({ confirmed: "yes" as unknown, poolCount: 1, lastMessageAgeSec: 0 }, 0)?.confirmed === false);
  check("b8. poolCount negativ → 0 (defensiv)",
    resolveWsSub({ confirmed: true, poolCount: -5, lastMessageAgeSec: 0 }, 0)?.poolCount === 0);
  check("b9. poolCount NaN → 0",
    resolveWsSub({ confirmed: true, poolCount: NaN, lastMessageAgeSec: 0 }, 0)?.poolCount === 0);
  check("b10. poolCount fracționar → floor (2.9 → 2)",
    resolveWsSub({ confirmed: true, poolCount: 2.9, lastMessageAgeSec: 0 }, 0)?.poolCount === 2);
  check("b11. P2: lastMessageAgeSec negativ -> null (nu fals acum)",
    resolveWsSub({ confirmed: true, poolCount: 1, lastMessageAgeSec: -30 }, 5)?.lastMessageAgeSec === null);
  check("b12. lastMessageAgeSec absent → null",
    resolveWsSub({ confirmed: true, poolCount: 1 }, 5)?.lastMessageAgeSec === null);
  check("b12b. confirmedAgeSec absent → null",
    resolveWsSub({ confirmed: true, poolCount: 1, lastMessageAgeSec: 5 }, 5)?.confirmedAgeSec === null);

  // resolveWsRuntime propagă subs (Part B) când workerul publică wsSubs
  {
    const r = resolveWsRuntime(
      { chain: "ethereum", updatedAt: NOW - 10_000, wsConnected: true, lastPongAgeSec: 4,
        wsSubs: { v2: { confirmed: true, poolCount: 5, lastMessageAgeSec: 400, confirmedAgeSec: 900 }, v4: { confirmed: false, poolCount: 0, lastMessageAgeSec: null, confirmedAgeSec: null } } },
      "ethereum", NOW, OPTS);
    check("b13. subs prezent → v2 entry (age 400 + 10 = 410)", r?.subs?.v2?.lastMessageAgeSec === 410);
    check("b14. subs v2 confirmed + poolCount 5", r?.subs?.v2?.confirmed === true && r?.subs?.v2?.poolCount === 5);
    check("b15. subs v3 absent din payload → null", r?.subs?.v3 === null);
    check("b16. subs v4 present (confirmed false)", r?.subs?.v4?.confirmed === false);
  }
  check("b17. worker vechi (fără wsSubs) → subs null",
    resolveWsRuntime({ chain: "ethereum", updatedAt: NOW, wsConnected: true }, "ethereum", NOW, OPTS)?.subs === null);

  // ── Part B: classifyWsSubs (CROSS-KIND — cele 4 scenarii cgpt) ────────────────
  console.log(" classifyWsSubs:");
  const sub = (lastMessageAgeSec: number | null, confirmedAgeSec: number | null = 900, poolCount = 3, confirmed = true) =>
    ({ confirmed, poolCount, lastMessageAgeSec, confirmedAgeSec });
  const CL = { staleSec: 300 };

  // scenariu 1: V2 400 (stale), V3 10, V4 20 (recente) → V2 SUSPECTED_STALE (frații livrează → path viu)
  {
    const c = classifyWsSubs({ v2: sub(400), v3: sub(10), v4: sub(20) }, CL);
    check("c1. ⭐ V2 stale + V3/V4 recente → V2 SUSPECTED_STALE", c.perKind.v2 === "SUSPECTED_STALE");
    check("c2. V3 recent → ACTIVE", c.perKind.v3 === "ACTIVE");
    check("c3. V4 recent → ACTIVE", c.perKind.v4 === "ACTIVE");
    check("c4. suspectedStaleKinds = [v2]", c.suspectedStaleKinds.length === 1 && c.suspectedStaleKinds[0] === "v2");
    check("c5. rollup chain = SUSPECTED_STALE", c.chain === "SUSPECTED_STALE");
  }
  // scenariu 2: toate 400 (stale) → niciun frate livrează recent → toate QUIET_OR_UNKNOWN (NU stale)
  {
    const c = classifyWsSubs({ v2: sub(400), v3: sub(400), v4: sub(400) }, CL);
    check("c6. ⭐ toate stale, niciun frate recent → v2 QUIET_OR_UNKNOWN", c.perKind.v2 === "QUIET_OR_UNKNOWN");
    check("c7. → v3 QUIET_OR_UNKNOWN", c.perKind.v3 === "QUIET_OR_UNKNOWN");
    check("c8. → v4 QUIET_OR_UNKNOWN", c.perKind.v4 === "QUIET_OR_UNKNOWN");
    check("c9. ⭐ suspectedStaleKinds gol (nu declarăm 3 stale)", c.suspectedStaleKinds.length === 0);
    check("c10. rollup chain = QUIET_OR_UNKNOWN", c.chain === "QUIET_OR_UNKNOWN");
  }
  // scenariu 3: niciun kind confirmat/cu pool-uri → NO_ACTIVE_SUBSCRIPTIONS
  {
    const c = classifyWsSubs({ v2: sub(10, 900, 0), v3: sub(10, 900, 3, false), v4: null }, CL);
    check("c11. ⭐ niciun kind activ → chain NO_ACTIVE_SUBSCRIPTIONS", c.chain === "NO_ACTIVE_SUBSCRIPTIONS");
    check("c12. → perKind toate null (v2 poolCount 0, v3 neconfirmat, v4 absent)",
      c.perKind.v2 === null && c.perKind.v3 === null && c.perKind.v4 === null);
    check("c13. subs null (worker vechi) → NO_ACTIVE_SUBSCRIPTIONS", classifyWsSubs(null, CL).chain === "NO_ACTIVE_SUBSCRIPTIONS");
  }
  // scenariu 4: un singur kind confirmat + recent → ACTIVE
  {
    const c = classifyWsSubs({ v2: sub(10), v3: null, v4: null }, CL);
    check("c14. ⭐ un kind recent → v2 ACTIVE", c.perKind.v2 === "ACTIVE");
    check("c15. rollup chain = ACTIVE", c.chain === "ACTIVE");
    check("c16. v3/v4 inactive → null", c.perKind.v3 === null && c.perKind.v4 === null);
  }
  // never-delivered (lastMessageAgeSec null) + confirmedAgeSec → gating corect
  {
    // V3 livrează recent (frate viu); V2 n-a livrat NICIODATĂ dar confirmat de mult (900>300) → SUSPECTED_STALE
    const c = classifyWsSubs({ v2: sub(null, 900), v3: sub(10), v4: null }, CL);
    check("c17. ⭐ never-delivered + confirmat de mult + frate viu → SUSPECTED_STALE", c.perKind.v2 === "SUSPECTED_STALE");
  }
  {
    // V2 n-a livrat + confirmat RECENT (50<300) → prea nou ca să suspectăm → QUIET_OR_UNKNOWN (chiar cu frate viu)
    const c = classifyWsSubs({ v2: sub(null, 50), v3: sub(10), v4: null }, CL);
    check("c18. ⭐ never-delivered + confirmat recent → QUIET_OR_UNKNOWN (prea nou)", c.perKind.v2 === "QUIET_OR_UNKNOWN");
  }
  {
    // V2 stale + confirmedAgeSec null (necunoscut) DAR a livrat cândva (msg vechi) + frate viu → SUSPECTED_STALE
    // (candidatura vine din mesajul vechi, nu din confirmedAge)
    const c = classifyWsSubs({ v2: sub(400, null), v3: sub(10), v4: null }, CL);
    check("c19. stale prin mesaj vechi (confirmedAge null irelevant) + frate viu → SUSPECTED_STALE", c.perKind.v2 === "SUSPECTED_STALE");
  }
  {
    // never-delivered + confirmedAge null (necunoscut) + frate viu → nu putem afirma candidatura → QUIET_OR_UNKNOWN
    const c = classifyWsSubs({ v2: sub(null, null), v3: sub(10), v4: null }, CL);
    check("c20. never-delivered + confirmedAge necunoscut → QUIET_OR_UNKNOWN (onest)", c.perKind.v2 === "QUIET_OR_UNKNOWN");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
