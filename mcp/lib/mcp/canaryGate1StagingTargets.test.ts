/**
 * lib/mcp/canaryGate1StagingTargets.test.ts — lotul OAuth staging, partea C: vetting-ul + țintele probei (pur).
 */
import {
  vetStagingProbe, readStagingProbeConfig, vetProcessEnvBinding, classifySupabaseKey, redisHostOf, decodeJwtClaims,
  STAGING_VET_MSG, DEFAULT_PROBE_EMAIL_DOMAIN, type StagingProbeConfig,
} from "./canaryGate1StagingTargets";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

console.log("lot OAuth staging C — canaryGate1StagingTargets (izolare, origini, chei, Redis pin, CIMD)");

const REF = "abcdefghijklmnopqrst";
const jwt = (claims: Record<string, unknown>): string =>
  `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;
const ANON = jwt({ role: "anon", ref: REF });
const SERVICE = jwt({ role: "service_role", ref: REF });

const GOOD: StagingProbeConfig = {
  mcpBaseUrl:         "https://preflight-staging.up.railway.app",
  supabaseUrl:        `https://${REF}.supabase.co`,
  supabaseAnonKey:    ANON,
  supabaseServiceKey: SERVICE,
  expectSupabaseRef:  REF,
  redisUrl:           "redis://default:pw@staging-redis.proxy.rlwy.net:12345",
  expectRedisHost:    "staging-redis.proxy.rlwy.net",
  cimdClientId:       "https://claude.ai/oauth/claude-mcp-client-metadata",
};
const codeOf = (over: Partial<StagingProbeConfig>): string => {
  const v = vetStagingProbe({ ...GOOD, ...over });
  return v.ok ? "ok" : v.code;
};

// ── happy path + derivare ──
{
  const v = vetStagingProbe(GOOD);
  check("1. ⭐⭐⭐ config staging valid → ok", v.ok === true);
  if (v.ok) {
    const t = v.targets;
    check("2. ⭐⭐⭐ ținte derivate din origine (mcp/token/authorize/PRM/AS RFC 8414)",
      t.mcpUrl === "https://preflight-staging.up.railway.app/api/mcp" && t.resource === t.mcpUrl
      && t.tokenUrl === "https://preflight-staging.up.railway.app/api/oauth/token"
      && t.authorizeUrl === "https://preflight-staging.up.railway.app/authorize"
      && t.prmUrl === "https://preflight-staging.up.railway.app/.well-known/oauth-protected-resource"
      && t.asMetadataUrl === "https://preflight-staging.up.railway.app/.well-known/oauth-authorization-server");
    check("3. ⭐⭐ redirect implicit = callback claude.ai; domeniu email implicit",
      t.claudeRedirectUri === "https://claude.ai/api/mcp/auth_callback" && t.emailDomain === DEFAULT_PROBE_EMAIL_DOMAIN);
    check("4. ⭐⭐ restUrl + ref Supabase", t.restUrl === `https://${REF}.supabase.co/rest/v1` && t.supabaseRef === REF);
    check("5. ⭐⭐⭐ secretele NU sunt în ținte (doar în `secrets`)", !JSON.stringify(t).includes(ANON) && !JSON.stringify(t).includes(SERVICE) && v.secrets.serviceKey === SERVICE);
  }
}

// ── producție refuzată (aceeași sursă ca releaseGate) ──
check("6. ⭐⭐⭐ MCP de producție (preflight.jackspools.lol) → isolation_refused", codeOf({ mcpBaseUrl: "https://preflight.jackspools.lol" }) === "isolation_refused");
check("7. ⭐⭐⭐ MCP de producție (preflight.up.railway.app) → isolation_refused", codeOf({ mcpBaseUrl: "https://preflight.up.railway.app" }) === "isolation_refused");
check("8. ⭐⭐⭐ MCP prod cu punct final → refuz", codeOf({ mcpBaseUrl: "https://preflight.jackspools.lol." }) !== "ok");
check("9. ⭐⭐⭐ Supabase de producție → isolation_refused",
  codeOf({ supabaseUrl: "https://ipeyogzfgqypfkujraxm.supabase.co", expectSupabaseRef: "ipeyogzfgqypfkujraxm" }) === "isolation_refused");

// ── origini / schemă ──
check("10. ⭐⭐ MCP cu path → mcp_origin_unclean", codeOf({ mcpBaseUrl: "https://preflight-staging.up.railway.app/api" }) === "mcp_origin_unclean");
check("11. ⭐⭐⭐ MCP http loopback → mcp_not_https (proba e pentru staging public)", codeOf({ mcpBaseUrl: "http://127.0.0.1:3000" }) === "mcp_not_https");
check("12. ⭐⭐ MCP https loopback → mcp_loopback", codeOf({ mcpBaseUrl: "https://localhost:3000" }) === "mcp_loopback");
check("13. ⭐⭐ Supabase non-supabase.co → supabase_host_unexpected", codeOf({ supabaseUrl: "https://db.example.com" }) === "supabase_host_unexpected");
check("14. ⭐⭐⭐ ref Supabase ≠ pinul operatorului → supabase_ref_mismatch", codeOf({ expectSupabaseRef: "zzzzzzzzzzzzzzzzzzzz" }) === "supabase_ref_mismatch");

// ── chei ──
check("15. ⭐⭐ anon == service → keys_identical", codeOf({ supabaseServiceKey: ANON }) === "keys_identical");
check("16. ⭐⭐⭐ cheile inversate → anon_key_wrong_role", codeOf({ supabaseAnonKey: SERVICE, supabaseServiceKey: ANON }) === "anon_key_wrong_role");
check("17. ⭐⭐⭐ cheie JWT a ALTUI proiect → key_ref_mismatch", codeOf({ supabaseServiceKey: jwt({ role: "service_role", ref: "otherprojectrefxxxxx" }) }) === "key_ref_mismatch");
check("18. ⭐⭐ chei noi sb_publishable_/sb_secret_ → ok", codeOf({ supabaseAnonKey: "sb_publishable_x", supabaseServiceKey: "sb_secret_y" }) === "ok");
check("19. ⭐⭐ cheie service fără prefixul rolului → service_key_wrong_role", codeOf({ supabaseServiceKey: "sb_publishable_y" }) === "service_key_wrong_role");
check("20. ⭐ classifySupabaseKey/decodeJwtClaims pe non-JWT", decodeJwtClaims("abc") === null && classifySupabaseKey("garbage", "anon", REF) === "wrong_role");

// ── Redis ──
check("21. ⭐⭐⭐ REDIS_URL host ≠ pin → redis_host_mismatch", codeOf({ expectRedisHost: "other.proxy.rlwy.net" }) === "redis_host_mismatch");
check("22. ⭐⭐ REDIS_URL schemă http → redis_url_invalid", codeOf({ redisUrl: "http://staging-redis.proxy.rlwy.net:1" }) === "redis_url_invalid");
check("23. ⭐ redisHostOf: rediss ok, path ciudat refuzat", redisHostOf("rediss://u:p@H.example:6380/0") === "h.example" && redisHostOf("redis://h/x/y") === null);
check("24. ⭐⭐ pin Redis case-insensitive", codeOf({ expectRedisHost: "STAGING-REDIS.proxy.rlwy.net" }) === "ok");

// ── CIMD + redirect + email ──
check("25. ⭐⭐⭐ client_id CIMD pe alt host → cimd_client_id_invalid", codeOf({ cimdClientId: "https://evil.example/doc" }) === "cimd_client_id_invalid");
check("26. ⭐⭐ client_id CIMD cu query → cimd_client_id_invalid", codeOf({ cimdClientId: "https://claude.ai/doc?x=1" }) === "cimd_client_id_invalid");
check("27. ⭐⭐⭐ redirect ≠ CLAUDE_CALLBACKS → redirect_uri_not_claude", codeOf({ claudeRedirectUri: "https://claude.ai/api/mcp/auth_callback/x" }) === "redirect_uri_not_claude");
check("28. ⭐ redirect claude.com acceptat", codeOf({ claudeRedirectUri: "https://claude.com/api/mcp/auth_callback" }) === "ok");
check("29. ⭐ domeniu email invalid → email_domain_invalid", codeOf({ emailDomain: "Bad Domain" }) === "email_domain_invalid");

// ── config lipsă + env reader ──
check("30. ⭐⭐⭐ config null / câmp gol / whitespace → config_missing",
  !vetStagingProbe(null).ok && codeOf({ cimdClientId: "" }) === "config_missing" && codeOf({ redisUrl: " redis://x " }) === "config_missing");
{
  const env = { GATE1_MCP_BASE_URL: "a", NEXT_PUBLIC_SUPABASE_URL: "b", REDIS_URL: "c", GATE1_CIMD_CLIENT_ID: "d" };
  const c = readStagingProbeConfig(env);
  check("31. ⭐ readStagingProbeConfig mapează numele de env", c.mcpBaseUrl === "a" && c.supabaseUrl === "b" && c.redisUrl === "c" && c.cimdClientId === "d" && c.supabaseServiceKey === undefined);
}
check("32. ⭐⭐ mesajele de vetting nu conțin valori (statice)", Object.values(STAGING_VET_MSG).every((m) => !m.includes(REF) && !m.includes("pw@")));

// ── legătura cu env-ul procesului ──
{
  const v = vetStagingProbe(GOOD);
  if (v.ok) {
    const env = { NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co/`, SUPABASE_SERVICE_ROLE_KEY: SERVICE, REDIS_URL: GOOD.redisUrl };
    check("33. ⭐⭐⭐ env-ul procesului = cel vetat → ok", vetProcessEnvBinding(env, v.targets, v.secrets).ok);
    const bad1 = vetProcessEnvBinding({ ...env, NEXT_PUBLIC_SUPABASE_URL: "https://ipeyogzfgqypfkujraxm.supabase.co" }, v.targets, v.secrets);
    check("34. ⭐⭐⭐ process.env Supabase ≠ vetat → env_supabase_url_mismatch", !bad1.ok && bad1.code === "env_supabase_url_mismatch");
    const bad2 = vetProcessEnvBinding({ ...env, REDIS_URL: "redis://prod:6379" }, v.targets, v.secrets);
    check("35. ⭐⭐⭐ process.env REDIS_URL ≠ vetat → env_redis_url_mismatch", !bad2.ok && bad2.code === "env_redis_url_mismatch");
    const bad3 = vetProcessEnvBinding({ ...env, SUPABASE_SERVICE_ROLE_KEY: ANON }, v.targets, v.secrets);
    check("36. ⭐⭐ process.env service key ≠ vetată → env_service_key_mismatch", !bad3.ok && bad3.code === "env_service_key_mismatch");
  } else {
    check("33-36. precondiție", false);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
