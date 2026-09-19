/**
 * lib/mcp/profileCaps.test.ts — PH-12 12.6 leaf 2a: teste COMPORTAMENTALE pentru `bindRoleCaps`.
 *
 * Adaptor: normalizatorul (șterge `role`/`warnings`/`detail`), MCP-combine (runtime + build, inclusiv când AMBELE pică),
 * staging POZITIV (allowlist/loopback, origine curată), frozen. + Integrare cu planner-ul (leaf 1): `envKeys` e o
 * allowlist REALĂ — un nume necanonic emis de un validator → `validation_unavailable`; numele canonice trec.
 */

import { bindRoleCaps } from "./profileCaps";
import { buildObservation, type Caps, type RawState, type ServiceEnvValidator } from "./profilePlan";
import { MCP_ENV_FIELDS, MCP_UNEXPECTED_PREFIXES } from "../config/envSchema";
import { BUILD_ENV_FIELD_NAMES } from "../config/buildEnvCheck";

let passed = 0;
const fails: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) passed++;
  else fails.push(msg);
}

const caps = bindRoleCaps();

// ─────────────────────────────── A. normalizator: DOAR {name,kind}, fără detail/role/warnings ───────────────────────────────
{
  const v = caps.validateService["worker-evm"]!({}); // REDIS_URL missing (+ WS default)
  assert(v.ok === false, "A1: worker-evm gol ar trebui ok:false");
  assert(JSON.stringify(Object.keys(v).sort()) === JSON.stringify(["ok", "problems"]), "A2: rezultatul are DOAR {ok,problems} (fără role/warnings)");
  for (const p of v.problems) {
    assert(JSON.stringify(Object.keys(p).sort()) === JSON.stringify(["kind", "name"]), `A3: problema are DOAR {name,kind} (fără detail): ${JSON.stringify(p)}`);
  }
  assert(v.problems.some((p) => p.name === "REDIS_URL" && p.kind === "missing"), "A4: REDIS_URL missing prezent");
}

// ─────────────────────────────── B. invariantul ok ⇔ problems gol ───────────────────────────────
{
  const good = caps.validateService["worker-evm"]!({ REDIS_URL: "redis://localhost:6379", ENABLED_CHAINS: "base", PREFLIGHT_MODE: "LIVE", ALCHEMY_BASE_WS: "wss://base.example" });
  assert(good.ok === true && good.problems.length === 0, "B1: env valid → ok:true + zero probleme");
}

// ─────────────────────────────── C. MCP combine (runtime + build), inclusiv când AMBELE pică ───────────────────────────────
{
  const v = caps.validateService["mcp"]!({}); // lipsesc runtime (SUPABASE_SERVICE_ROLE_KEY, REDIS_URL) ȘI build (NEXT_PUBLIC_*)
  assert(v.ok === false, "C1: MCP gol → ok:false");
  const names = new Set(v.problems.map((p) => p.name));
  assert(names.has("SUPABASE_SERVICE_ROLE_KEY") || names.has("REDIS_URL"), "C2: problemă din validatorul RUNTIME prezentă");
  assert(names.has("NEXT_PUBLIC_SUPABASE_URL") || names.has("NEXT_PUBLIC_SUPABASE_ANON_KEY"), "C3: problemă din validatorul BUILD prezentă (combine)");
}

// ─────────────────────────────── D. envKeys = allowlist de proveniență ───────────────────────────────
{
  const mcpKeys = new Set(caps.envKeys["mcp"] ?? []);
  assert(mcpKeys.has("SUPABASE_SERVICE_ROLE_KEY"), "D1: envKeys[mcp] include runtime SUPABASE_SERVICE_ROLE_KEY");
  assert(mcpKeys.has("NEXT_PUBLIC_SUPABASE_URL") && mcpKeys.has("NEXT_PUBLIC_SUPABASE_ANON_KEY"), "D2: envKeys[mcp] include build NEXT_PUBLIC_*");
  assert((caps.envKeys["worker-evm"] ?? []).includes("REDIS_URL"), "D3: envKeys[worker-evm] include REDIS_URL");
}

// ─────────────────────────────── E. integrare planner: nume necanonic → validation_unavailable ───────────────────────────────
{
  const raw: RawState = { "worker-evm": { running: true, env: { REDIS_URL: "redis://localhost:6379", ALCHEMY_BASE_WS: "wss://base.example" } } };

  // E1: caps reale + env valid → observație OK (numele canonice trec proveniența).
  const okRes = buildObservation(raw, "base-canary", caps);
  assert(okRes.ok === true, "E1: caps reale + worker-evm valid → buildObservation ok");

  // E2: caps reale + env care emite un nume CANONIC (REDIS_URL missing) → tot OK (nu unavailable), env.ok=false.
  const rawMissing: RawState = { "worker-evm": { running: true, env: { ALCHEMY_BASE_WS: "wss://base.example" } } };
  const missRes = buildObservation(rawMissing, "base-canary", caps);
  assert(missRes.ok === true, "E2: nume canonic (REDIS_URL) trece proveniența (nu unavailable)");

  // E3: validator MANIPULAT care emite un nume NEcanonic → respins de envKeys → validation_unavailable.
  const fake: ServiceEnvValidator = () => ({ ok: false, problems: [{ name: "TOTALLY_FAKE_KEY", kind: "invalid" }] });
  const tampered: Caps = {
    validateService: { ...caps.validateService, "worker-evm": fake },
    envKeys: caps.envKeys,
    isStagingSupabase: caps.isStagingSupabase,
  };
  const fakeRes = buildObservation(raw, "base-canary", tampered);
  assert(fakeRes.ok === false && fakeRes.reason === "validation_unavailable", "E3: nume necanonic → validation_unavailable (envKeys e allowlist reală)");
}

// ─────────────────────────────── F. staging POZITIV (allowlist/loopback, origine curată) ───────────────────────────────
{
  const staging = caps.isStagingSupabase;
  assert(staging({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }) === true, "F1: loopback 127.0.0.1 → staging");
  assert(staging({ NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" }) === true, "F2: loopback localhost → staging");
  assert(staging({ NEXT_PUBLIC_SUPABASE_URL: "https://ipeyogzfgqypfkujraxm.supabase.co" }) === false, "F3: ref de PROD → NU staging");
  assert(staging({ NEXT_PUBLIC_SUPABASE_URL: "https://randomproject.supabase.co" }) === false, "F4: ref necunoscut → NU staging (allowlist gol)");
  assert(staging({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/rest/v1" }) === false, "F5: origine murdară (path) → NU staging");
  assert(staging({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/?x=1" }) === false, "F6: origine murdară (query) → NU staging");
  assert(staging({ NEXT_PUBLIC_SUPABASE_URL: "http://user:pass@127.0.0.1:54321" }) === false, "F7: userinfo → NU staging");
  assert(staging({} as Record<string, string>) === false, "F8: URL absent → NU staging");
}

// ─────────────────────────────── G. frozen ───────────────────────────────
{
  assert(Object.isFrozen(caps), "G1: caps înghețat");
  assert(Object.isFrozen(caps.envKeys), "G2: caps.envKeys înghețat");
  assert(Object.isFrozen(caps.validateService), "G3: caps.validateService înghețat");
  assert(Object.isFrozen(caps.envKeys["worker-evm"]), "G4: envKeys[worker-evm] înghețat");
}

// ─────────────────────────────── H. trust-root-uri MCP înghețate la runtime (P1 cgpt) ───────────────────────────────
{
  assert(Object.isFrozen(MCP_ENV_FIELDS), "H1: MCP_ENV_FIELDS înghețat la runtime");
  for (const f of MCP_ENV_FIELDS) assert(Object.isFrozen(f), `H2: FieldSpec ${f.name} înghețat`);
  assert(Object.isFrozen(MCP_UNEXPECTED_PREFIXES), "H3: MCP_UNEXPECTED_PREFIXES înghețat");
  assert(Object.isFrozen(BUILD_ENV_FIELD_NAMES), "H4: BUILD_ENV_FIELD_NAMES înghețat");
}

if (fails.length > 0) {
  console.error(`profileCaps.test: ${fails.length} EȘUAT / ${passed} ok`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`profileCaps.test: ${passed}/${passed} ok`);
