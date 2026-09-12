/**
 * lib/mcp/canaryGate1.test.ts — PH-12 12.5b-3 (orchestrator Gate 1, pași injectați, pur).
 * Capability-bound + origini curate + throw-safe (inclusiv setup) + tokenul rotit exercitat.
 */
import {
  runGate1, vetGate1Targets,
  type Gate1Steps, type Gate1Targets, type AuthCodeBundle, type AuthorizeOutcome,
  type ReadinessResult, type McpProbeResult,
} from "./canaryGate1";
import type { TokenResult } from "./canaryTokenClient";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

console.log("PH-12 12.5b-3 — canaryGate1 (capability-bound, origini curate, throw-safe, AT rotit exercitat)");

const LOCAL = { mcpBaseUrl: "http://127.0.0.1:8080", supabaseUrl: "http://127.0.0.1:54321" };
const BUNDLE: AuthCodeBundle = { code: "CODE", redirectUri: "http://127.0.0.1:5555/callback", codeVerifier: "VERIFIER" };
const okToken = (access: string, refresh: string): TokenResult =>
  ({ ok: true, accessToken: access, refreshToken: refresh, tokenType: "Bearer", expiresIn: 86400, scope: "read:pair" });

interface Spy {
  factoryCalls: number; targetsSeen?: Gate1Targets; order: string[];
  exchangeArg?: AuthCodeBundle; mcpArgs: string[]; refreshArg?: string;
}
interface Over {
  factoryThrow?: true;
  readiness?: ReadinessResult | "throw"; authorize?: AuthorizeOutcome | "throw";
  exchange?: TokenResult | "throw"; mcp?: McpProbeResult | "throw"; mcpRotated?: McpProbeResult | "throw"; refresh?: TokenResult | "throw";
}
function factory(over: Over, spy: Spy): (t: Gate1Targets) => Gate1Steps {
  return (targets) => {
    spy.factoryCalls++; spy.targetsSeen = targets;
    if (over.factoryThrow) throw new Error("SECRET-boom-in-setup");
    const step = <T>(name: string, v: T | "throw" | undefined, def: T): (() => Promise<T>) => async () => {
      spy.order.push(name);
      if (v === "throw") throw new Error(`SECRET-boom-in-${name}`);
      return v ?? def;
    };
    let mcpCall = 0;
    return {
      readiness: step("readiness", over.readiness, { ok: true }),
      authorize: step("authorize", over.authorize, { ok: true, bundle: BUNDLE }),
      exchange:  async (b) => { spy.order.push("exchange"); spy.exchangeArg = b; if (over.exchange === "throw") throw new Error("SECRET-boom-exchange"); return over.exchange ?? okToken("AT1", "RT1"); },
      mcpProbe:  async (t) => {
        spy.order.push("mcp"); spy.mcpArgs.push(t); mcpCall++;
        const which = mcpCall === 1 ? over.mcp : over.mcpRotated;
        if (which === "throw") throw new Error("SECRET-boom-mcp");
        return which ?? { ok: true };
      },
      refresh:   async (t) => { spy.order.push("refresh"); spy.refreshArg = t; if (over.refresh === "throw") throw new Error("SECRET-boom-refresh"); return over.refresh ?? okToken("AT2", "RT2"); },
    };
  };
}
const newSpy = (): Spy => ({ factoryCalls: 0, order: [], mcpArgs: [] });

async function main(): Promise<void> {
  // ── vetGate1Targets: derivare + izolare + origini curate ──
  {
    const v = vetGate1Targets(LOCAL);
    check("1. ⭐⭐⭐ vet local → ok + endpoint-uri derivate", v.ok === true && v.ok && v.targets.tokenUrl === "http://127.0.0.1:8080/api/oauth/token" && v.targets.mcpUrl === "http://127.0.0.1:8080/api/mcp" && v.targets.healthUrl === "http://127.0.0.1:8080/api/health");
    check("2. ⭐⭐⭐ authorizeUrl = ${origin}/authorize (GET resource-owner, NU /api/oauth/authorize legacy)", v.ok && v.targets.authorizeUrl === "http://127.0.0.1:8080/authorize");
    check("3. ⭐⭐ resource (audience) == mcpUrl", v.ok && v.targets.resource === v.targets.mcpUrl);
  }
  {
    const v = vetGate1Targets({ mcpBaseUrl: "http://127.0.0.1:8080/", supabaseUrl: "http://127.0.0.1:54321" });
    check("4. ⭐⭐ `/` bar (origine) acceptat → endpoint-uri corecte din origin", v.ok === true && v.ok && v.targets.mcpUrl === "http://127.0.0.1:8080/api/mcp" && v.targets.authorizeUrl === "http://127.0.0.1:8080/authorize");
  }
  {
    const v = vetGate1Targets({ mcpBaseUrl: "https://preflight.jackspools.lol", supabaseUrl: "http://127.0.0.1:54321" });
    check("5. ⭐⭐⭐ vet prod → ok:false (fără targets)", v.ok === false);
  }
  // P2: origini murdare → refuz (înainte producea URL-uri greșite prin concatenare)
  {
    const v = vetGate1Targets({ mcpBaseUrl: "http://127.0.0.1:8080/foo", supabaseUrl: "http://127.0.0.1:54321" });
    check("6. ⭐⭐⭐ base cu PATH (/foo) → refuz", v.ok === false && !v.ok && /path/.test(v.reason));
  }
  {
    const v = vetGate1Targets({ mcpBaseUrl: "http://127.0.0.1:8080?x=1", supabaseUrl: "http://127.0.0.1:54321" });
    check("7. ⭐⭐⭐ base cu QUERY (?x=1) → refuz", v.ok === false && !v.ok && /query/.test(v.reason));
  }
  {
    const v = vetGate1Targets({ mcpBaseUrl: "http://127.0.0.1:8080#frag", supabaseUrl: "http://127.0.0.1:54321" });
    check("8. ⭐⭐⭐ base cu FRAGMENT (#frag) → refuz", v.ok === false && !v.ok && /fragment/.test(v.reason));
  }
  {
    const v = vetGate1Targets({ mcpBaseUrl: "http://127.0.0.1:8080", supabaseUrl: "http://127.0.0.1:54321/x" });
    check("9. ⭐⭐ supabaseUrl cu path → refuz", v.ok === false && !v.ok && /supabaseUrl/.test(v.reason));
  }
  {
    // trailing-dot prod ocolea allowlist-ul (host `!==`); acum vetGate1Targets îl refuză prin izolare.
    const v = vetGate1Targets({ mcpBaseUrl: "https://preflight.jackspools.lol.", supabaseUrl: "http://127.0.0.1:54321" });
    check("9b. ⭐⭐⭐ mcpBaseUrl prod cu punct final → vet refuză (fără targets)", v.ok === false);
  }

  // ── happy + capability-bound + al doilea mcp exercitat ──
  {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory({}, spy));
    check("10. ⭐⭐⭐ happy → ok, toate stage-urile (inclusiv setup + mcp_rotated)", r.ok === true && r.ok && r.stages.join(",") === "isolation,setup,readiness,authorize,exchange,mcp,refresh,rotation,mcp_rotated");
    check("11. ⭐⭐ ordine: mcpProbe chemat de DOUĂ ori (AT inițial + AT rotit)", spy.order.join(",") === "readiness,authorize,exchange,mcp,refresh,mcp");
    check("12. ⭐⭐⭐ CAPABILITY-BOUND: fabrica a primit țintele DERIVATE din cfg vetat", spy.targetsSeen?.tokenUrl === "http://127.0.0.1:8080/api/oauth/token" && spy.targetsSeen?.authorizeUrl === "http://127.0.0.1:8080/authorize" && spy.targetsSeen?.resource === "http://127.0.0.1:8080/api/mcp");
    check("13. ⭐⭐⭐ threading: bundle→exchange, AT inițial→mcp#1, refresh→refresh, AT rotit→mcp#2", spy.exchangeArg?.code === "CODE" && spy.mcpArgs[0] === "AT1" && spy.refreshArg === "RT1" && spy.mcpArgs[1] === "AT2");
  }

  // ── izolare = poartă zero: fabrica NU e invocată ──
  {
    const spy = newSpy();
    const r = await runGate1({ mcpBaseUrl: "https://preflight.jackspools.lol", supabaseUrl: "http://127.0.0.1:54321" }, factory({}, spy));
    check("14. ⭐⭐⭐ mcpBaseUrl prod → stage isolation, fabrica NU e invocată", r.ok === false && !r.ok && r.stage === "isolation" && spy.factoryCalls === 0 && spy.order.length === 0);
  }
  {
    const spy = newSpy();
    const r = await runGate1(null, factory({}, spy));
    check("15. ⭐⭐ cfg null → stage isolation, fabrica neinvocată", r.ok === false && !r.ok && r.stage === "isolation" && spy.factoryCalls === 0);
  }
  {
    const spy = newSpy();
    const r = await runGate1({ mcpBaseUrl: "http://127.0.0.1:8080/foo", supabaseUrl: "http://127.0.0.1:54321" }, factory({}, spy));
    check("16. ⭐⭐ origine murdară → stage isolation, fabrica neinvocată", r.ok === false && !r.ok && r.stage === "isolation" && spy.factoryCalls === 0);
  }
  {
    const spy = newSpy();
    const r = await runGate1({ mcpBaseUrl: "https://preflight.jackspools.lol.", supabaseUrl: "http://127.0.0.1:54321" }, factory({}, spy));
    check("16b. ⭐⭐⭐ prod trailing-dot → stage isolation, fabrica neinvocată", r.ok === false && !r.ok && r.stage === "isolation" && spy.factoryCalls === 0);
  }

  // ── SETUP throw: makeSteps aruncă → stage setup generic, fără leak, niciun pas ──
  {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory({ factoryThrow: true }, spy));
    check("17. ⭐⭐⭐ makeSteps THROW → stage setup generic, fără SECRET, niciun pas rulat", r.ok === false && !r.ok && r.stage === "setup" && !r.reason.includes("SECRET") && spy.order.length === 0);
  }

  // ── short-circuit pe fiecare stage (coduri închise → mesaje statice) ──
  {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory({ readiness: { ok: false, code: "not_ready" } }, spy));
    check("18. ⭐⭐⭐ readiness code → stage readiness static, authorize NU rulează", r.ok === false && !r.ok && r.stage === "readiness" && r.reason === "readiness: health raportează not-ready (web/Redis jos)" && !spy.order.includes("authorize"));
  }
  {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory({ authorize: { ok: false, code: "state_mismatch" } }, spy));
    check("19. ⭐⭐⭐ authorize code → stage authorize, exchange NU rulează", r.ok === false && !r.ok && r.stage === "authorize" && /state mismatch/.test(r.reason) && !spy.order.includes("exchange"));
  }
  {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory({ exchange: { ok: false, stage: "http", status: 400, reason: "HTTP 400 invalid_grant SECRET" } }, spy));
    check("20. ⭐⭐⭐ exchange fail → stage exchange din stage+status; mcp NU rulează", r.ok === false && !r.ok && r.stage === "exchange" && r.reason === "exchange: /token a răspuns HTTP 400" && !spy.order.includes("mcp"));
    check("20b. ⭐⭐⭐ ANTI-LEAK: reason-ul leaf-ului (SECRET) NU e propagat", r.ok === false && !r.ok && !r.reason.includes("SECRET") && !r.reason.includes("invalid_grant"));
  }
  {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory({ mcp: { ok: false, code: "unauthorized" } }, spy));
    check("21. ⭐⭐⭐ mcp#1 code → stage mcp, refresh NU rulează", r.ok === false && !r.ok && r.stage === "mcp" && /AT inițial/.test(r.reason) && /401/.test(r.reason) && !spy.order.includes("refresh"));
  }
  {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory({ refresh: { ok: false, stage: "http", status: null, reason: "transport error" } }, spy));
    check("22. ⭐⭐ refresh fail transport (http+status null) → stage refresh, mesaj static de transport", r.ok === false && !r.ok && r.stage === "refresh" && r.reason === "refresh: eroare de transport (rețea)");
  }

  // ── REZILIENȚĂ LA THROW pe fiecare pas ──
  for (const [label, over, stage, blocked] of [
    ["readiness", { readiness: "throw" }, "readiness", "authorize"],
    ["authorize", { authorize: "throw" }, "authorize", "exchange"],
    ["exchange",  { exchange: "throw" },  "exchange",  "mcp"],
    ["mcp",       { mcp: "throw" },       "mcp",       "refresh"],
    ["refresh",   { refresh: "throw" },   "refresh",   ""],
  ] as const) {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory(over as Over, spy));
    const ok = r.ok === false && !r.ok && r.stage === stage && !r.reason.includes("SECRET") && (blocked === "" || !spy.order.includes(blocked));
    check(`23.${label} ⭐⭐⭐ ${label} THROW → stage ${stage}, fără SECRET, short-circuit`, ok);
  }

  // ── tokenul ROTIT exercitat: mcp#2 respinge AT2 → Gate 1 ROȘU (deși AT1 mergea și refresh a reușit) ──
  {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory({ mcp: { ok: true }, mcpRotated: { ok: false, code: "unauthorized" } }, spy));
    check("24. ⭐⭐⭐ AT1 ok + refresh ok + AT2 RESPINS pe /api/mcp → stage mcp_rotated (Gate roșu)", r.ok === false && !r.ok && r.stage === "mcp_rotated" && /AT rotit/.test(r.reason));
    check("25. ⭐⭐⭐ al doilea mcpProbe a primit EXACT AT2", spy.mcpArgs.length === 2 && spy.mcpArgs[1] === "AT2");
  }
  {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory({ mcpRotated: "throw" }, spy));
    check("26. ⭐⭐ mcp#2 THROW → stage mcp_rotated generic, fără SECRET", r.ok === false && !r.ok && r.stage === "mcp_rotated" && !r.reason.includes("SECRET"));
  }

  // ── rotație ──
  {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory({ exchange: okToken("SAME_AT", "RT1"), refresh: okToken("SAME_AT", "RT2") }, spy));
    check("27. ⭐⭐⭐ access_token neschimbat → stage rotation, mcp#2 NU rulează", r.ok === false && !r.ok && r.stage === "rotation" && /access_token neschimbat/.test(r.reason) && spy.mcpArgs.length === 1);
  }
  {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory({ exchange: okToken("AT1", "SAME_RT"), refresh: okToken("AT2", "SAME_RT") }, spy));
    check("28. ⭐⭐⭐ refresh_token neschimbat → stage rotation", r.ok === false && !r.ok && r.stage === "rotation" && /refresh_token neschimbat/.test(r.reason));
  }
  {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory({ exchange: okToken("SECRETA", "SECRETR"), refresh: okToken("SECRETA", "RTnew") }, spy));
    check("29. ⭐⭐⭐ ANTI-LEAK: reason de rotație fără valoarea token-ului", r.ok === false && !r.ok && r.stage === "rotation" && !r.reason.includes("SECRET"));
  }
  {
    const spy = newSpy();
    const r = await runGate1(LOCAL, factory({ exchange: okToken("SECRETA", "SECRETR"), refresh: okToken("ATn", "RTn") }, spy));
    check("30. ⭐⭐ happy cu token-uri 'secrete' → note fără valori", r.ok === true && r.ok && !r.note.includes("SECRET"));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("test crashed:", e); process.exit(1); });
