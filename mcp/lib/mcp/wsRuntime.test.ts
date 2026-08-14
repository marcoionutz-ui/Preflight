/**
 * lib/mcp/wsRuntime.test.ts — D1c (WS-liveness leaf, anti-stale + anti-false-fresh).
 *
 * Acoperă cele trei frunze pure din health-freshness care decid semnalele WS-liveness expuse prin MCP:
 *   - adjustWsAgeSec     — vârsta publicată (la updatedAt) → vârsta la `now`; P2: negativ/NaN/Inf → null.
 *   - resolveWsRuntime   — validare+normalizare a unui worker_runtime raw (chain-guard, updatedAt, viitor/expirat).
 *   - isWsStreamStale    — „transport viu + data stream mort"; P3: pong necunoscut (null) ≠ recent.
 * Fără Redis, fără timere — doar input→output. Exact GAP-ul din cgpt P2/P3 (fals-fresh pe date corupte/necunoscute).
 */

import { adjustWsAgeSec, resolveWsRuntime, isWsStreamStale } from "./health-freshness";

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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
