/**
 * scripts/integrity.test.ts — E32b (teste de integritate, invariantele schema-level din audit).
 *
 * Cele 6 „teste care contează" din audit (E32) sunt invarianți cross-cutting. Aici sunt cei 3
 * la nivel de SCHEMĂ (functii pure în @preflight/schema), care înainte NU aveau NICIO acoperire
 * (schema avea doar `typecheck`):
 *   1. Aceeași adresă pe 2 chain-uri rămâne IZOLATĂ  → `pairKey` (P0-1 / Faza B).
 *   2. Worker Base nu șterge snapshot-ul Arbitrum      → `REDIS_KEYS.*` chain-scoped (Faza B4).
 *   6. `eth`/`ethereum` folosesc ACELAȘI risk cache     → `normalizeChainId` + `REDIS_KEYS.risk` (A1).
 *
 * (3=registry repair/C1, 4=enrichment restart/C2, 5=cursor Solana/C6 sunt teste worker+Redis-Lua,
 * acoperite de suitele Faza C care rulează în CI prin service `redis:7` post-E32a.)
 *
 * PUR (doar funcții din @preflight/schema; `import type` din risk-layer stripat de tsx) → rulează în tsx.
 */
import {
  pairKey, splitPairKey, normalizeChainId, normalizePairAddress,
  REDIS_KEYS, PREFLIGHT_EVM_CHAINS,
} from "../src/index";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

function main(): void {
  console.log("E32b — integritate schema (invarianții 1, 2, 6 din audit)");

  // ── Invariant 1: aceeași adresă pe 2 chain-uri rămâne IZOLATĂ (pairKey, P0-1) ──
  const ADDR = "0xAbCdEf0000000000000000000000000000000001";
  check("1a. * aceeași adresă EVM pe base vs arbitrum → chei DIFERITE (fără coliziune P0-1)",
    pairKey("base", ADDR) !== pairKey("arbitrum", ADDR));
  check("1b. pairKey include chain-ul normalizat (prefix)",
    pairKey("base", ADDR) === `base:${ADDR.toLowerCase()}`);
  check("1c. EVM case-insensitive (hex lowercased) → aceeași cheie",
    pairKey("base", ADDR.toUpperCase()) === pairKey("base", ADDR.toLowerCase()));
  check("1d. * Solana case-PĂSTRAT (base58 e case-sensitive, lowercasing corupe adresa)",
    pairKey("solana", "AeGBpQ9xK3mZ") === "solana:AeGBpQ9xK3mZ");
  check("1e. aceeași adresă string pe solana vs base → chei diferite (chain-prefix)",
    pairKey("solana", "AeGBpQ9xK3mZ") !== pairKey("base", "AeGBpQ9xK3mZ"));
  check("1f. trim pe adresă (whitespace nu produce identitate diferită)",
    pairKey("base", `  ${ADDR}  `) === pairKey("base", ADDR));
  // splitPairKey = inversul lui pairKey (round-trip corect → PairMap iterează cheia decodată).
  const ref = splitPairKey(pairKey("arbitrum", ADDR));
  check("1g. splitPairKey round-trip → chain corect", ref.chain === "arbitrum");
  check("1h. splitPairKey round-trip → adresă corectă (lowercased EVM)", ref.address === ADDR.toLowerCase());
  check("1i. splitPairKey pe cheie legacy fără ':' → chain gol + adresa întreagă",
    splitPairKey("0xabc").chain === "" && splitPairKey("0xabc").address === "0xabc");
  // eth/ethereum se colapsează ÎN pairKey (aceeași identitate, nu 2 perechi).
  check("1j. * pairKey('eth') === pairKey('ethereum') (normalizare în identitate)",
    pairKey("eth", ADDR) === pairKey("ethereum", ADDR));

  // ── Invariant 2: worker Base nu șterge snapshot-ul Arbitrum (chei chain-scoped, B4) ──
  check("2a. * workerSnapshot base vs arbitrum → chei DIFERITE (scriere Base ≠ clobber Arbitrum)",
    REDIS_KEYS.workerSnapshot("base") !== REDIS_KEYS.workerSnapshot("arbitrum"));
  check("2b. workerSnapshot conține chain-ul normalizat",
    REDIS_KEYS.workerSnapshot("base") === "preflight:worker_snapshot:base:latest");
  // TOATE cheile chain-scoped trebuie să fie disjuncte pe chain-uri (niciun worker per-chain nu
  // scrie peste alt chain). Verificăm fiecare builder chain-scoped pe toate perechile de chain-uri.
  const chainScoped: Array<[string, (c: string) => string]> = [
    ["pairStates", REDIS_KEYS.pairStates],
    ["activeWatch", REDIS_KEYS.activeWatch],
    ["hotCandidates", REDIS_KEYS.hotCandidates],
    ["armedEntries", REDIS_KEYS.armedEntries],
    ["workerSnapshot", REDIS_KEYS.workerSnapshot],
    ["recentDrops", REDIS_KEYS.recentDrops],
    ["pipelineEvents", REDIS_KEYS.pipelineEvents],
    ["workerRuntime", REDIS_KEYS.workerRuntime],
    ["momentumEvents", REDIS_KEYS.momentumEvents],
    ["signalPipeline", REDIS_KEYS.signalPipeline],
    ["qualifiedSignals", REDIS_KEYS.qualifiedSignals],
    ["pipelineCoverage", REDIS_KEYS.pipelineCoverage],
    ["scannerStats", REDIS_KEYS.scannerStats],
    ["agentWatchSeen", REDIS_KEYS.agentWatchSeen],
    ["agentWatchRotation", REDIS_KEYS.agentWatchRotation],
    ["agentWatchInRotation", REDIS_KEYS.agentWatchInRotation],
    ["agentWatchMeta", REDIS_KEYS.agentWatchMeta],
    ["agentWatchClientQueue(fixed client)", (c: string) => REDIS_KEYS.agentWatchClientQueue(c, "clientX")],
    ["lifecycle", REDIS_KEYS.lifecycle],
    ["trendingMovers", REDIS_KEYS.trendingMovers],
  ];
  const evm = [...PREFLIGHT_EVM_CHAINS];
  let allDisjoint = true, allContainChain = true;
  for (const [, build] of chainScoped) {
    const keys = evm.map(c => build(c));
    if (new Set(keys).size !== keys.length) allDisjoint = false;           // fără coliziuni între chain-uri
    if (!evm.every((c, i) => keys[i].includes(`:${c}`))) allContainChain = false; // fiecare cheie ancorată pe chain
  }
  check(`2c. * toate cele ${chainScoped.length} chei chain-scoped → DISJUNCTE pe ${evm.length} chain-uri`, allDisjoint);
  check("2d. fiecare cheie chain-scoped conține chain-ul (namespace per-chain)", allContainChain);
  check("2e. chei per-pair (pairContext/trendingSnapshot) sunt chain-scoped prin pairKey",
    REDIS_KEYS.pairContext("base", ADDR) !== REDIS_KEYS.pairContext("arbitrum", ADDR) &&
    REDIS_KEYS.trendingSnapshot("base", ADDR) !== REDIS_KEYS.trendingSnapshot("arbitrum", ADDR));

  // ── Invariant 6: eth/ethereum folosesc ACELAȘI risk cache (normalizeChainId, A1) ──
  check("6a. * normalizeChainId('eth') === 'ethereum'", normalizeChainId("eth") === "ethereum");
  check("6b. normalizeChainId case-insensitive + trim", normalizeChainId("  ETH ") === "ethereum");
  check("6c. * REDIS_KEYS.risk('eth', t) === REDIS_KEYS.risk('ethereum', t) (același cache — A1)",
    REDIS_KEYS.risk("eth", "0xToken") === REDIS_KEYS.risk("ethereum", "0xToken"));
  check("6d. risk key = token lowercased (case-insensitive pe token)",
    REDIS_KEYS.risk("ethereum", "0xTOKEN") === REDIS_KEYS.risk("ethereum", "0xtoken"));
  check("6e. risk key conține chain normalizat + token",
    REDIS_KEYS.risk("eth", "0xToken") === "preflight:risk:ethereum:0xtoken");
  check("6f. alt chain NU se colapsează (base ≠ ethereum)",
    normalizeChainId("base") === "base" && REDIS_KEYS.risk("base", "0xToken") !== REDIS_KEYS.risk("ethereum", "0xToken"));
  check("6g. normalizePairAddress: EVM lowercase, Solana păstrat",
    normalizePairAddress("ethereum", "0xABC") === "0xabc" && normalizePairAddress("solana", "AbC") === "AbC");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
