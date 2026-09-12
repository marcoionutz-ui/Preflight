/**
 * lib/mcp/releaseGate.test.ts — PH-12 12.5a (nucleu PUR de release-gate).
 * Pur, zero I/O: parse health, readiness (auth-canary), strict (Base canary), formă token/refresh, izolare de prod.
 */
import {
  parseHealthReport, assertReadiness, assertStrictHealthy,
  parseTokenResponse, assertTokenResponse, assertRefreshRotation,
  assertCanaryIsolation, PROD_MCP_HOSTS, PROD_SUPABASE_REFS,
} from "./releaseGate";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

// Fabrică de raport health valid; `over` suprascrie câmpuri de top-level, `checks` se îmbină.
function health(over: Partial<Record<string, unknown>> = {}, checksOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ok", httpStatus: 200, scope: "mcp-web + evm-worker",
    checks: {
      web:    { ok: true,  detail: "web process responding" },
      redis:  { ok: true,  detail: "redis reachable" },
      worker: { ok: true,  detail: "worker fresh" },
      ws:     { ok: true,  detail: "ws healthy" },
      ...checksOver,
    },
    ...over,
  };
}
const okTokenBody = (over: Record<string, unknown> = {}) =>
  ({ access_token: "at_1", token_type: "Bearer", expires_in: 3600, scope: "read:pair", refresh_token: "rt_1", ...over });

console.log("PH-12 12.5a — releaseGate (nucleu pur)");

// ── A. parseHealthReport ──────────────────────────────────────────────────────
{
  check("A1. obiect valid → parsat", parseHealthReport(health()) !== null);
  check("A2. string JSON valid → parsat", parseHealthReport(JSON.stringify(health())) !== null);
  check("A3. ⭐ JSON stricat → null", parseHealthReport("{not json") === null);
  check("A4. ⭐ status necunoscut → null", parseHealthReport(health({ status: "weird" })) === null);
  check("A5. ⭐ httpStatus ne-număr → null", parseHealthReport(health({ httpStatus: "200" })) === null);
  check("A6. ⭐ scope lipsă → null", parseHealthReport(health({ scope: undefined })) === null);
  check("A7. ⭐ checks lipsă → null", parseHealthReport(health({ checks: undefined })) === null);
  check("A8. ⭐ un check de bază lipsă (ws) → null", parseHealthReport(health({}, { ws: undefined })) === null);
  check("A9. ⭐ check fără `ok:boolean` → null", parseHealthReport(health({}, { redis: { detail: "x" } })) === null);
  check("A10. services absent → parsat, services null", (() => { const r = parseHealthReport(health()); return r !== null && r.services === null && r.checks.services === null; })());
  check("A11. ⭐ checks.services prezent dar malformat → null", parseHealthReport(health({}, { services: { detail: "x" } })) === null);
  check("A12. ⭐ services non-array → null", parseHealthReport(health({ services: "nope" })) === null);
  check("A13. ⭐ services element malformat → null", parseHealthReport(health({ services: [{ state: "ok" }] })) === null);
  check("A14. services array valid → mapat", (() => {
    const r = parseHealthReport(health({ services: [{ service: "indexer-evm", state: "ok", ageSec: 12 }] }, { services: { ok: true, detail: "svc ok" } }));
    return r !== null && r.services?.length === 1 && r.services[0].service === "indexer-evm" && r.services[0].ageSec === 12 && r.checks.services?.ok === true;
  })());
  check("A15. root array → null", parseHealthReport([]) === null);
  check("A16. null → null", parseHealthReport(null) === null);
  check("A17. câmp extra ignorat (forward-compat)", parseHealthReport(health({ ts: "2026", extra: 1 })) !== null);
}

// ── B. assertReadiness (auth-canary: acceptă degraded, cere web+Redis) ─────────
{
  const ok       = parseHealthReport(health())!;
  const degraded = parseHealthReport(health({ status: "degraded", httpStatus: 200 }, { worker: { ok: false, detail: "worker stale" }, ws: { ok: false, detail: "ws unknown" } }))!;
  const down     = parseHealthReport(health({ status: "down", httpStatus: 503 }, { redis: { ok: false, detail: "redis unreachable" }, worker: { ok: false, detail: "?" }, ws: { ok: false, detail: "?" } }))!;
  check("B1. ⭐⭐ ok → ready", assertReadiness(ok).ok === true);
  check("B2. ⭐⭐⭐ degraded (workeri opriți) DAR web+Redis ok → ready (acceptat)", assertReadiness(degraded).ok === true);
  check("B3. ⭐⭐⭐ down (Redis inaccesibil) → NOT ready", assertReadiness(down).ok === false);
  const redisDown = parseHealthReport(health({ status: "degraded", httpStatus: 200 }, { redis: { ok: false, detail: "x" } }))!;
  check("B4. ⭐⭐ status degraded dar Redis check false → NOT ready", assertReadiness(redisDown).ok === false);
  const webDown = parseHealthReport(health({ status: "degraded", httpStatus: 200 }, { web: { ok: false, detail: "x" } }))!;
  check("B5. ⭐ web check false → NOT ready", assertReadiness(webDown).ok === false);
  const strict503 = parseHealthReport(health({ status: "degraded", httpStatus: 503 }))!;
  check("B6. ⭐ httpStatus 503 (a lovit ?strict=1 din greșeală) → NOT ready (readiness e pe /api/health simplu)", assertReadiness(strict503).ok === false);
}

// ── C. assertStrictHealthy (Base canary: tot verde + roluri servicii în scope) ─
{
  const ok = parseHealthReport(health())!;
  check("C1. ⭐⭐ status ok + 200 + toate check-urile → strict healthy", assertStrictHealthy(ok).ok === true);
  const degraded = parseHealthReport(health({ status: "degraded", httpStatus: 503 }, { worker: { ok: false, detail: "stale" } }))!;
  check("C2. ⭐⭐⭐ degraded/503 → NOT strict (Base canary cere worker fresh)", assertStrictHealthy(degraded).ok === false);
  const okBut503 = parseHealthReport(health({ status: "ok", httpStatus: 503 }))!;
  check("C3. ⭐ status ok dar httpStatus 503 (incoerent) → NOT strict", assertStrictHealthy(okBut503).ok === false);
  const wsBad = parseHealthReport(health({}, { ws: { ok: false, detail: "stale" } }))!;
  // (status rămâne 'ok' în fixture, dar check-ul ws e false → strict trebuie să pice pe check)
  check("C4. ⭐⭐ un check de bază false (ws) → NOT strict", assertStrictHealthy(wsBad).ok === false);
  // servicii așteptate:
  const withSvc = parseHealthReport(health({ scope: "mcp-web + evm-worker + indexer-evm", services: [{ service: "indexer-evm", state: "ok", ageSec: 5 }] }, { services: { ok: true, detail: "svc ok" } }))!;
  check("C5. ⭐⭐⭐ rol așteptat 'indexer-evm' în scope + checks.services.ok → strict healthy", assertStrictHealthy(withSvc, { expectedServiceRoles: ["indexer-evm"] }).ok === true);
  check("C6. ⭐⭐⭐ rol așteptat dar scope NU-l conține → NOT strict", assertStrictHealthy(ok, { expectedServiceRoles: ["indexer-evm"] }).ok === false);
  const svcNotOk = parseHealthReport(health({ scope: "mcp-web + evm-worker + indexer-evm", services: [{ service: "indexer-evm", state: "stale", ageSec: 200 }] }, { services: { ok: false, detail: "svc stale" } }))!;
  // status ok în fixture dar checks.services.ok=false → cu rol așteptat pică
  check("C7. ⭐⭐ rol așteptat dar checks.services.ok false → NOT strict", assertStrictHealthy(svcNotOk, { expectedServiceRoles: ["indexer-evm"] }).ok === false);
  check("C8. ⭐ fără roluri așteptate → nu cere secțiunea services", assertStrictHealthy(ok, {}).ok === true);
}

// ── D. parseTokenResponse + assertTokenResponse ───────────────────────────────
{
  check("D1. răspuns valid → parsat", parseTokenResponse(okTokenBody()) !== null);
  check("D2. string JSON valid → parsat", parseTokenResponse(JSON.stringify(okTokenBody())) !== null);
  check("D3. ⭐ JSON stricat → null", parseTokenResponse("{bad") === null);
  check("D4. ⭐ access_token gol → null", parseTokenResponse(okTokenBody({ access_token: "" })) === null);
  check("D5. ⭐ expires_in ne-număr → null", parseTokenResponse(okTokenBody({ expires_in: "3600" })) === null);
  check("D6. ⭐⭐ token valid → assert ok (cu refresh așteptat)", assertTokenResponse(okTokenBody()).ok === true);
  check("D7. ⭐⭐⭐ token_type non-Bearer → fail", assertTokenResponse(okTokenBody({ token_type: "mac" })).ok === false);
  check("D7b. ⭐⭐⭐ ANTI-LEAK: reason NU ecouă valoarea token_type (necontrolată, poate purta secret)",
    assertTokenResponse(okTokenBody({ token_type: "SECRETCODE" })).reason.indexOf("SECRETCODE") === -1);
  check("D8. ⭐ Bearer case-insensitive → ok", assertTokenResponse(okTokenBody({ token_type: "bearer" })).ok === true);
  check("D9. ⭐⭐ expires_in ≤ 0 → fail", assertTokenResponse(okTokenBody({ expires_in: 0 })).ok === false);
  check("D10. ⭐⭐ scope lipsă → fail", assertTokenResponse(okTokenBody({ scope: undefined })).ok === false);
  check("D11. ⭐⭐⭐ refresh lipsă + expectRefresh → fail (fluxul user trebuie să emită refresh)", assertTokenResponse(okTokenBody({ refresh_token: undefined }), { expectRefresh: true }).ok === false);
  check("D12. ⭐⭐ refresh lipsă + expectRefresh=false (client_credentials) → ok", assertTokenResponse(okTokenBody({ refresh_token: undefined }), { expectRefresh: false }).ok === true);
  check("D13. ⭐ malformat → fail-closed", assertTokenResponse("nope").ok === false);
}

// ── E. assertRefreshRotation ──────────────────────────────────────────────────
{
  const first  = okTokenBody({ access_token: "at_1", refresh_token: "rt_1" });
  const second = okTokenBody({ access_token: "at_2", refresh_token: "rt_2" });
  check("E1. ⭐⭐⭐ access + refresh ambele rotite → ok", assertRefreshRotation(first, second).ok === true);
  check("E2. ⭐⭐⭐ access NEschimbat → fail", assertRefreshRotation(first, okTokenBody({ access_token: "at_1", refresh_token: "rt_2" })).ok === false);
  check("E3. ⭐⭐⭐ refresh NEschimbat (reuse) → fail", assertRefreshRotation(first, okTokenBody({ access_token: "at_2", refresh_token: "rt_1" })).ok === false);
  check("E4. ⭐⭐ al doilea fără refresh → fail", assertRefreshRotation(first, okTokenBody({ access_token: "at_2", refresh_token: undefined })).ok === false);
  check("E5. ⭐ primul fără refresh → fail", assertRefreshRotation(okTokenBody({ refresh_token: undefined }), second).ok === false);
  check("E6. ⭐ primul malformat → fail", assertRefreshRotation("bad", second).ok === false);
  check("E7. ⭐ al doilea malformat → fail", assertRefreshRotation(first, "bad").ok === false);
}

// ── F. assertCanaryIsolation (plasa anti-prod, rulează ÎNAINTEA gate-urilor) ───
{
  const staging = { mcpBaseUrl: "https://preflight-staging.up.railway.app", supabaseUrl: "https://stagingref123.supabase.co" };
  check("F1. ⭐⭐⭐ config staging curat → izolat (ok)", assertCanaryIsolation(staging).ok === true);
  check("F2. ⭐⭐⭐ mcpBaseUrl = domeniu MCP prod (jackspools) → REFUZ", assertCanaryIsolation({ ...staging, mcpBaseUrl: "https://preflight.jackspools.lol" }).ok === false);
  check("F3. ⭐⭐⭐ mcpBaseUrl = domeniu prod railway → REFUZ", assertCanaryIsolation({ ...staging, mcpBaseUrl: "https://preflight.up.railway.app" }).ok === false);
  check("F4. ⭐⭐⭐ supabaseUrl = Supabase prod (ref ipeyo…) → REFUZ", assertCanaryIsolation({ ...staging, supabaseUrl: "https://ipeyogzfgqypfkujraxm.supabase.co" }).ok === false);
  check("F5. ⭐⭐ mcpBaseUrl lipsă → REFUZ (ambiguu)", assertCanaryIsolation({ supabaseUrl: staging.supabaseUrl }).ok === false);
  check("F6. ⭐⭐ supabaseUrl gol → REFUZ (ambiguu)", assertCanaryIsolation({ mcpBaseUrl: staging.mcpBaseUrl, supabaseUrl: "  " }).ok === false);
  check("F7. ⭐⭐ mcpBaseUrl neparsabil → REFUZ (fail-closed)", assertCanaryIsolation({ ...staging, mcpBaseUrl: "not a url" }).ok === false);
  check("F8. ⭐⭐ supabaseUrl neparsabil → REFUZ", assertCanaryIsolation({ ...staging, supabaseUrl: "::::" }).ok === false);
  check("F9. ⭐⭐ config null → REFUZ", assertCanaryIsolation(null).ok === false);
  check("F10. ⭐⭐ config undefined → REFUZ", assertCanaryIsolation(undefined).ok === false);
  check("F11. ⭐ host prod case-insensitive (UPPERCASE) → REFUZ", assertCanaryIsolation({ ...staging, mcpBaseUrl: "https://PREFLIGHT.JACKSPOOLS.LOL" }).ok === false);
  check("F12. ⭐⭐⭐ localhost (Gate 1 complet local) → izolat ok", assertCanaryIsolation({ mcpBaseUrl: "http://localhost:3000", supabaseUrl: "http://localhost:54321" }).ok === true);
  check("F13. ⭐ constantele de prod sunt ne-goale (plasa are pe ce refuza)", PROD_MCP_HOSTS.length >= 2 && PROD_SUPABASE_REFS.length >= 1);
}

// ── G. întăriri cerute de cgpt ────────────────────────────────────────────────
// G-strict: scope-fool + serviciu stale (verificare pe services[] autoritar, nu substring pe scope)
{
  const scopeFool = parseHealthReport(health({ scope: "mcp-web + evm-worker + not-indexer-evm", services: [] }, { services: { ok: true, detail: "svc" } }))!;
  check("G1. ⭐⭐⭐ scope 'not-indexer-evm' + services gol → NOT strict (nu ne păcălește substring-ul)", assertStrictHealthy(scopeFool, { expectedServiceRoles: ["indexer-evm"] }).ok === false);
  const staleSvc = parseHealthReport(health({ scope: "mcp-web + evm-worker + indexer-evm", services: [{ service: "indexer-evm", state: "stale", ageSec: 200 }] }, { services: { ok: true, detail: "svc (aggregate minte)" } }))!;
  check("G2. ⭐⭐⭐ serviciu PREZENT dar 'stale' (chiar cu checks.services.ok=true) → NOT strict (services[] e autoritar)", assertStrictHealthy(staleSvc, { expectedServiceRoles: ["indexer-evm"] }).ok === false);
}
// G-token: whitespace-only pe access/refresh/scope → fail
{
  check("G3. ⭐⭐ access_token whitespace → parse null + assert fail", parseTokenResponse(okTokenBody({ access_token: "   " })) === null && assertTokenResponse(okTokenBody({ access_token: "   " })).ok === false);
  check("G4. ⭐⭐ refresh_token whitespace + expectRefresh → fail", assertTokenResponse(okTokenBody({ refresh_token: "  " }), { expectRefresh: true }).ok === false);
  check("G5. ⭐⭐ scope whitespace → fail", assertTokenResponse(okTokenBody({ scope: "   " })).ok === false);
  check("G6. ⭐⭐ expires_in fracționar → fail (întreg pozitiv)", assertTokenResponse(okTokenBody({ expires_in: 3600.5 })).ok === false);
  check("G7. ⭐ expires_in negativ → fail", assertTokenResponse(okTokenBody({ expires_in: -1 })).ok === false);
}
// G-rotation: plic invalid la refresh nu trece drept „rotit"
{
  const first = okTokenBody({ access_token: "at_1", refresh_token: "rt_1" });
  check("G8. ⭐⭐⭐ refresh cu token_type 'mac' → fail (plic invalid, nu doar string diferit)", assertRefreshRotation(first, okTokenBody({ access_token: "at_2", refresh_token: "rt_2", token_type: "mac" })).ok === false);
  check("G9. ⭐⭐⭐ refresh cu expires_in 0 → fail", assertRefreshRotation(first, okTokenBody({ access_token: "at_2", refresh_token: "rt_2", expires_in: 0 })).ok === false);
  check("G10. ⭐⭐⭐ primul cu scope whitespace → fail (ambele plicuri trebuie valide)", assertRefreshRotation(okTokenBody({ access_token: "at_1", refresh_token: "rt_1", scope: "   " }), okTokenBody({ access_token: "at_2", refresh_token: "rt_2" })).ok === false);
}
// G-isolation: port explicit pe host prod, file:, ftp:, credentials
{
  const staging = { mcpBaseUrl: "https://preflight-staging.up.railway.app", supabaseUrl: "https://stagingref123.supabase.co" };
  check("G11. ⭐⭐⭐ host MCP prod cu port explicit (:443) → REFUZ (compar pe hostname, nu host)", assertCanaryIsolation({ ...staging, mcpBaseUrl: "https://preflight.jackspools.lol:443" }).ok === false);
  check("G12. ⭐⭐⭐ Supabase prod cu port explicit → REFUZ", assertCanaryIsolation({ ...staging, supabaseUrl: "https://ipeyogzfgqypfkujraxm.supabase.co:5432" }).ok === false);
  check("G13. ⭐⭐⭐ mcpBaseUrl file: → REFUZ (schemă)", assertCanaryIsolation({ ...staging, mcpBaseUrl: "file:///etc/passwd" }).ok === false);
  check("G14. ⭐⭐⭐ supabaseUrl ftp: → REFUZ (schemă)", assertCanaryIsolation({ ...staging, supabaseUrl: "ftp://host/x" }).ok === false);
  check("G15. ⭐⭐⭐ mcpBaseUrl cu credențiale (user:pass@) → REFUZ", assertCanaryIsolation({ ...staging, mcpBaseUrl: "https://user:pass@preflight-staging.up.railway.app" }).ok === false);
  check("G16. ⭐⭐ supabaseUrl cu userinfo → REFUZ", assertCanaryIsolation({ ...staging, supabaseUrl: "https://tok@stagingref123.supabase.co" }).ok === false);
}

// ── H. întăriri runda 2 (scope token + http non-loopback) ─────────────────────
{
  const svcOkScopeFool = parseHealthReport(health({ scope: "mcp-web + evm-worker + not-indexer-evm", services: [{ service: "indexer-evm", state: "ok", ageSec: 5 }] }, { services: { ok: true, detail: "svc ok" } }))!;
  check("H1. ⭐⭐⭐ services[indexer-evm:ok] DAR scope 'not-indexer-evm' → NOT strict (scope verificat ca token)", assertStrictHealthy(svcOkScopeFool, { expectedServiceRoles: ["indexer-evm"] }).ok === false);
  const svcOkScopeExact = parseHealthReport(health({ scope: "mcp-web + evm-worker + indexer-evm", services: [{ service: "indexer-evm", state: "ok", ageSec: 5 }] }, { services: { ok: true, detail: "svc ok" } }))!;
  check("H2. ⭐⭐⭐ services[indexer-evm:ok] + scope exact '... + indexer-evm' → strict healthy", assertStrictHealthy(svcOkScopeExact, { expectedServiceRoles: ["indexer-evm"] }).ok === true);

  const staging = { mcpBaseUrl: "https://preflight-staging.up.railway.app", supabaseUrl: "https://stagingref123.supabase.co" };
  check("H3. ⭐⭐⭐ http://staging.example pe MCP (host extern, clar) → REFUZ", assertCanaryIsolation({ ...staging, mcpBaseUrl: "http://staging.example" }).ok === false);
  check("H4. ⭐⭐⭐ http://staging.example pe Supabase → REFUZ", assertCanaryIsolation({ ...staging, supabaseUrl: "http://staging.example" }).ok === false);
  check("H5. ⭐⭐⭐ ambele localhost pe HTTP (Gate 1 local) → izolat ok", assertCanaryIsolation({ mcpBaseUrl: "http://localhost:3000", supabaseUrl: "http://127.0.0.1:54321" }).ok === true);
  // trailing-dot FQDN: rezolvă la același domeniu prod dar `!==` allowlist → nu trebuie să ocolească plasa.
  check("H6. ⭐⭐⭐ mcpBaseUrl prod cu punct final (jackspools.lol.) → REFUZ (fail-closed necanonic)", assertCanaryIsolation({ ...staging, mcpBaseUrl: "https://preflight.jackspools.lol." }).ok === false);
  check("H7. ⭐⭐⭐ Supabase prod cu punct final (…supabase.co.) → REFUZ", assertCanaryIsolation({ ...staging, supabaseUrl: "https://ipeyogzfgqypfkujraxm.supabase.co." }).ok === false);
  check("H8. ⭐⭐ orice hostname cu punct final (chiar staging) → REFUZ (necanonic, nu-l normalizăm tăcut)", assertCanaryIsolation({ ...staging, mcpBaseUrl: "https://preflight-staging.up.railway.app." }).ok === false);
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
