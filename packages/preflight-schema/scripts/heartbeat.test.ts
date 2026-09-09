/**
 * scripts/heartbeat.test.ts — PH-12 12.4 GUARD pentru CONTRACTUL PE SÂRMĂ al heartbeat-ului de serviciu.
 *
 * Trăiește AICI, în pachetul partajat, fiindcă atât publisherii worker (indexer-evm / solana) cât și reader-ul
 * (mcp/lib/health) depind de `serializeHeartbeat` / `parseHeartbeat` / praguri. Testul mcp `test:ph12-hb`
 * verifică CLASIFICATORUL (stări/scope/byte-compat); ACEST test verifică FORMATUL + pragurile de protocol,
 * independent de mcp — ca leaf 3 (publisher) să se sprijine pe cod deja acoperit, fără să dubleze `30/300`.
 */
import {
  serializeHeartbeat, parseHeartbeat, serviceHeartbeatKey, SERVICE_ROLES, HEARTBEAT_VERSION,
  HEARTBEAT_INTERVAL_SEC, HEARTBEAT_TTL_SEC,
  type ServiceRole,
} from "../src/index";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const T0 = 1_700_000_000_000;

function main(): void {
console.log("PH-12 12.4 — heartbeat WIRE CONTRACT (@preflight/schema)");

// ── roluri + versiune ─────────────────────────────────────────────────────────
check("1. SERVICE_ROLES = ['indexer-evm','solana-worker']", JSON.stringify(SERVICE_ROLES) === JSON.stringify(["indexer-evm", "solana-worker"]));
check("2. HEARTBEAT_VERSION === 1", HEARTBEAT_VERSION === 1);

// ── praguri de PROTOCOL (partajate cu publisherii; NU dublate în worker) ───────
check("3. ⭐ HEARTBEAT_INTERVAL_SEC === 30 (publisher scrie la 30s)", HEARTBEAT_INTERVAL_SEC === 30);
check("4. ⭐ HEARTBEAT_TTL_SEC === 300 (TTL cheie)", HEARTBEAT_TTL_SEC === 300);
check("5. interval < ttl (heartbeat ≪ expirare)", HEARTBEAT_INTERVAL_SEC < HEARTBEAT_TTL_SEC);

// ── round-trip serialize ↔ parse pe AMBELE roluri ─────────────────────────────
for (const role of SERVICE_ROLES) {
  const wire = serializeHeartbeat(role, T0);
  check(`6.${role}. serialize → {v:1,service,updated_at}`, wire === JSON.stringify({ v: 1, service: role, updated_at: T0 }));
  const rt = parseHeartbeat(wire, role);
  check(`7.${role}. round-trip parse intact`, !!rt && rt.v === 1 && rt.service === role && rt.updated_at === T0);
}

// ── serialize FAIL-LOUD pe now nesincer ───────────────────────────────────────
const badNow = (n: number) => { try { serializeHeartbeat("indexer-evm", n); return false; } catch { return true; } };
check("8. ⭐ serialize aruncă pe NaN", badNow(NaN));
check("9. ⭐ serialize aruncă pe Infinity", badNow(Infinity));
check("10. ⭐ serialize aruncă pe -Infinity", badNow(-Infinity));
check("11. ⭐ serialize aruncă pe 0", badNow(0));
check("12. ⭐ serialize aruncă pe negativ", badNow(-5));
check("13. serialize acceptă un epoch-ms valid", (() => { try { return typeof serializeHeartbeat("solana-worker", T0) === "string"; } catch { return false; } })());

// ── parse FAIL-CLOSED (reader NU aruncă niciodată) ────────────────────────────
check("14. parse: null → null", parseHeartbeat(null, "indexer-evm") === null);
check("15. ⭐ parse: JSON invalid → null (nu aruncă)", parseHeartbeat("{nope", "indexer-evm") === null);
check("16. ⭐ parse: v necunoscut (2) → null", parseHeartbeat(JSON.stringify({ v: 2, service: "indexer-evm", updated_at: T0 }), "indexer-evm") === null);
check("17. ⭐ parse: service nepotrivit → null (cross-role)", parseHeartbeat(serializeHeartbeat("solana-worker", T0), "indexer-evm") === null);
check("18. parse: updated_at ne-numeric → null", parseHeartbeat(JSON.stringify({ v: 1, service: "indexer-evm", updated_at: "x" }), "indexer-evm") === null);
check("19. parse: updated_at ≤ 0 → null", parseHeartbeat(JSON.stringify({ v: 1, service: "indexer-evm", updated_at: -1 }), "indexer-evm") === null);
check("20. parse: non-obiect (array) → null", parseHeartbeat("[]", "indexer-evm") === null);

const roles: ServiceRole[] = [...SERVICE_ROLES];
check("21. tip ServiceRole uzabil (compile + runtime)", roles.length === 2);

// ── cheia Redis PARTAJATĂ writer↔reader (leaf 2) ───────────────────────────────
check("22. ⭐ serviceHeartbeatKey('indexer-evm') === 'preflight:service_heartbeat:indexer-evm'",
  serviceHeartbeatKey("indexer-evm") === "preflight:service_heartbeat:indexer-evm");
check("23. ⭐ serviceHeartbeatKey('solana-worker') === 'preflight:service_heartbeat:solana-worker'",
  serviceHeartbeatKey("solana-worker") === "preflight:service_heartbeat:solana-worker");
check("24. ⭐⭐ chei DISTINCTE per rol (fără coliziune)", serviceHeartbeatKey("indexer-evm") !== serviceHeartbeatKey("solana-worker"));
check("25. prefix `preflight:` (plan de date partajat, NU `mcp:` intern)",
  SERVICE_ROLES.every(r => serviceHeartbeatKey(r).startsWith("preflight:service_heartbeat:")));
check("26. ⭐ toate rolurile → chei unice (set size === roluri)",
  new Set(SERVICE_ROLES.map(serviceHeartbeatKey)).size === SERVICE_ROLES.length);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
