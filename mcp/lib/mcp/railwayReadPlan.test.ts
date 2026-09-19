/**
 * lib/mcp/railwayReadPlan.test.ts — PH-12 12.6 leaf 2b-1 (P2 cgpt): probe COMPUSE cu plannerul + caps REALE, plus guard de drift
 * între `SERVICE_CROSSCHECK` (railwayReadModel) și `.railway/railway.ts` (IaC baseline).
 *
 * Rulează pe WSL (are `bindRoleCaps` = @preflight/env-contracts + envSchema + buildEnvCheck + releaseGate, toate PURE, zero I/O de
 * rețea; și `.railway/railway.ts` pe disc). Dovedește afirmațiile importante care nu se pot proba doar la nivel de mapare:
 *   1) MCP cu `SUPABASE_SERVICE_ROLE_KEY` sealed (null) → mapare → `planFromRaw(..., "auth-canary", bindRoleCaps())` → plan BLOCAT
 *      prin validatorul canonic (env_missing), fără secret/placeholder în render.
 *   2) `identity_drift` pe un serviciu cerut de profil → rol OMIS → plan BLOCAT prin `state_unknown`.
 *   3) drift-guard: numele + comenzile din `SERVICE_CROSSCHECK` există în `.railway/railway.ts` (sursele nu pot diverge tăcut).
 */

import { readFileSync } from "node:fs";
import { mapRailwaySnapshotToRawState, SERVICE_CROSSCHECK } from "./railwayReadModel";
import { bindRoleCaps } from "./profileCaps";
import { planFromRaw, formatPlanLines, SERVICE_IDS, type ServiceId } from "./profilePlan";

let passed = 0;
const fails: string[] = [];
function assert(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }

const PROJECT = "proj-uuid-0001";
const ENV = "env-uuid-prod-0001";
const UUID: Record<ServiceId, string> = {
  redis: "svc-redis-uuid", mcp: "svc-mcp-uuid", "worker-evm": "svc-workerevm-uuid", "indexer-evm": "svc-indexerevm-uuid", "solana-worker": "svc-solana-uuid",
};
const MANIFEST = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID } };

const RUN = (id = "d1", status = "SUCCESS") => ({ id, status });
const STOPPED_DEP = { active: null as { id: string; status: string } | null, latest: { id: "old", status: "REMOVED" } };
type Over = { serviceId?: string; name?: string; startCommand?: string | null; active?: { id: string; status: string } | null; latest?: { id: string; status: string } | null; hasStagedChanges?: boolean; variables?: Record<string, string | null> };
function service(role: ServiceId, o: Over = {}) {
  return {
    serviceId: o.serviceId ?? UUID[role],
    name: o.name ?? SERVICE_CROSSCHECK[role].name,
    startCommand: o.startCommand === undefined ? SERVICE_CROSSCHECK[role].startCommand : o.startCommand,
    activeDeployment: o.active === undefined ? RUN() : o.active,
    latestDeployment: o.latest === undefined ? RUN() : o.latest,
    hasStagedChanges: o.hasStagedChanges ?? false,
    variables: o.variables ?? {},
  };
}
function snapshot(services: ReturnType<typeof service>[]) { return { projectId: PROJECT, environmentId: ENV, hasStagedChanges: false, services }; }

const caps = bindRoleCaps();

// ── 1. MCP sealed service-role → plan blocat (env_missing), fără leak ────────────────────────────────────────────
{
  const REDIS_SENTINEL = "redis://SENTINEL-observed-secret@localhost:6379";
  const mcpVars: Record<string, string | null> = {
    REDIS_URL: REDIS_SENTINEL,
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-observed",
    SUPABASE_SERVICE_ROLE_KEY: null, // SEALED
  };
  const snap = snapshot([
    service("redis"),
    service("mcp", { variables: mcpVars }),
    service("worker-evm", STOPPED_DEP),
    service("indexer-evm", STOPPED_DEP),
    service("solana-worker", STOPPED_DEP),
  ]);
  const mapped = mapRailwaySnapshotToRawState(snap, MANIFEST);
  assert(mapped.ok === true, "1.1: mapare ok");
  if (mapped.ok) {
    const pr = planFromRaw(mapped.rawState, "auth-canary", caps);
    assert(pr.ok === true, "1.2: planFromRaw ok (caps valide)");
    if (pr.ok) {
      assert(pr.plan.admissible === false, "1.3: plan BLOCAT");
      if (!pr.plan.admissible) {
        assert(pr.plan.blockers.some((b) => b.service === "mcp" && b.kind === "env_missing" && b.key === "SUPABASE_SERVICE_ROLE_KEY"), "1.4: blocker env_missing SUPABASE_SERVICE_ROLE_KEY (sealed→missing prin validatorul canonic)");
      }
      const render = formatPlanLines(pr.plan).join("\n");
      assert(render.indexOf("SENTINEL-observed-secret") === -1, "1.5: valoarea REDIS observată NU se scurge în render");
      assert(render.indexOf("anon-key-observed") === -1, "1.6: anon key observată NU se scurge în render");
      assert(render.indexOf("<sealed>") === -1, "1.7: niciun placeholder <sealed> în render");
    }
  }
}

// ── 2. identity_drift pe worker-evm (cerut de base-canary) → rol OMIS → plan blocat prin state_unknown ───────────
{
  const validMcp: Record<string, string | null> = {
    REDIS_URL: "redis://localhost:6379",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "svc-role",
  };
  const snap = snapshot([
    service("redis"),
    service("mcp", { variables: validMcp }),
    service("worker-evm", { startCommand: "npm run start --workspace=@preflight/indexer-evm" }), // DRIFT
    service("indexer-evm", STOPPED_DEP),
    service("solana-worker", STOPPED_DEP),
  ]);
  const mapped = mapRailwaySnapshotToRawState(snap, MANIFEST);
  assert(mapped.ok === true, "2.1: mapare ok");
  if (mapped.ok) {
    assert(mapped.rawState["worker-evm"] === undefined, "2.2: worker-evm OMIS (identity_drift)");
    const pr = planFromRaw(mapped.rawState, "base-canary", caps);
    assert(pr.ok === true, "2.3: planFromRaw ok");
    if (pr.ok && !pr.plan.admissible) {
      assert(pr.plan.blockers.some((b) => b.service === "worker-evm" && b.kind === "state_unknown"), "2.4: worker-evm → state_unknown");
    } else assert(false, "2.4b: aștept plan blocat");
  }
}

// ── 3. drift-guard: SERVICE_CROSSCHECK ↔ .railway/railway.ts, ASOCIAT (nume + comandă în ACELAȘI bloc) ───────────
{
  let iac = "";
  try { iac = readFileSync(new URL("../../../.railway/railway.ts", import.meta.url), "utf8"); } catch { iac = ""; }
  assert(iac.length > 0, "3.0: .railway/railway.ts citit");
  // extrage valoarea REALĂ a PROPRIETĂȚII exacte `<key>: "…"` și o DEZ-ESCAPE-uiește (JSON.parse), NU normalizează lossy.
  // Comparația de mai jos e EXACTĂ pe valoarea reală — consistentă cu modelul: `normalizeCommand` doar relaxează spații, deci
  // egalitate EXACTĂ ⊂ egalitatea modelului → guard-ul nu poate da fals-pass (nu mai șterge backslash-uri, nu mai colapsează `\n`).
  // ANCORĂ STRUCTURALĂ: o cheie într-un obiect literal e MEREU precedată de `{` sau `,` (± whitespace) → `[{,]\s*<key>` ocolește
  // complet clasele de caractere (prefix identificator ASCII `restart`/`$start` SAU Unicode `östart` nu e precedat de `{`/`,`). Sufix blocat de `\s*:`.
  const extractStr = (blk: string, key: string): string | null => {
    const m = blk.match(new RegExp("[{,]\\s*" + key + '\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"'));
    if (m === null) return null;
    try { return JSON.parse('"' + m[1] + '"') as string; } catch { return null; } // dez-escape literal JS → valoarea reală
  };
  // NEGATIV: orice prefix „lipit" de cheie — identificator ASCII (`restart`,`x…`,`$…`,`_…`) SAU Unicode (`ö…`, `真…`) — NU trebuie pescuit.
  assert(extractStr('{ restart: "WRONG", start: "CANON" }', "start") === "CANON", "3.decoy: `restart` nu e pescuit ca `start`");
  assert(extractStr('{ xstartCommand: "WRONG", startCommand: "CANON" }', "startCommand") === "CANON", "3.decoy2: `xstartCommand` nu e pescuit ca `startCommand`");
  assert(extractStr('{ $start: "WRONG", start: "CANON" }', "start") === "CANON", "3.decoy3: `$start` nu e pescuit ca `start`");
  assert(extractStr('{ _start: "WRONG", start: "CANON" }', "start") === "CANON", "3.decoy4: `_start` nu e pescuit ca `start`");
  assert(extractStr('{ östart: "WRONG", start: "CANON" }', "start") === "CANON", "3.decoy5: identificator Unicode `östart` nu e pescuit ca `start`");
  assert(extractStr('{ 真start: "WRONG", start: "CANON" }', "start") === "CANON", "3.decoy6: identificator Unicode `真start` nu e pescuit ca `start`");

  // Non-redis: `service("<name>", { … start: "<cmd>" … });` → valoarea `start` din blocul acelui nume TREBUIE să fie EXACT canonicul.
  for (const role of SERVICE_IDS) {
    if (role === "redis") continue;
    const cc = SERVICE_CROSSCHECK[role];
    const start = iac.indexOf(`service("${cc.name}"`);
    assert(start !== -1, `3.blk[${role}]: bloc service("${cc.name}") prezent`);
    if (start !== -1) {
      const end = iac.indexOf("});", start);
      const block = iac.slice(start, end === -1 ? undefined : end);
      const val = extractStr(block, "start");
      assert(val !== null && val === cc.startCommand, `3.cmd[${role}]: valoarea start din blocul „${cc.name}" e EXACT canonicul (fără sufix)`);
    }
  }

  // Redis: nume în `const <var> = redis("Preflight - Redis", …)`; comanda în `<var>.deploy = { startCommand: "…" }` → asociere prin variabilă, valoare EXACTĂ.
  {
    const cc = SERVICE_CROSSCHECK["redis"];
    const m = iac.match(/const\s+(\w+)\s*=\s*redis\(\s*"Preflight - Redis"/);
    assert(m !== null, "3.redis.name: redis(\"Preflight - Redis\") prezent");
    if (m) {
      const dm = iac.match(new RegExp(m[1] + "\\.deploy\\s*=\\s*(\\{[\\s\\S]*?\\});")); // capturăm ȘI acoladele → ancora [{,] prinde prima proprietate
      assert(dm !== null, "3.redis.deploy: <var>.deploy prezent (asociat prin variabilă)");
      if (dm) {
        const val = extractStr(dm[1], "startCommand");
        assert(val !== null && val === cc.startCommand, "3.redis.cmd: startCommand din <var>.deploy e EXACT canonicul");
      }
    }
  }
}

if (fails.length > 0) {
  console.error(`railwayReadPlan.test: ${fails.length} EȘUAT / ${passed} ok`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`railwayReadPlan.test: ${passed}/${passed} ok`);
