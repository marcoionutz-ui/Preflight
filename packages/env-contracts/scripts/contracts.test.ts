/**
 * scripts/contracts.test.ts — PH-12 12.6 leaf 2a: teste COMPORTAMENTALE pentru contractele de env ale celor trei roluri.
 *
 * Dovada e comportamentală (rulează validatoarele REALE), NU regex/source-guard. Două direcții per rol:
 *   (A) COVERAGE: cu toate chain-urile active simultan, FIECARE nume de câmp posibil (`*EnvFields`) ∈ `*_PROBLEM_KEYS`.
 *   (B) PROVENIENȚĂ: pe env-uri adversariale, FIECARE `problem.name` emis de validatorul real ∈ `*_PROBLEM_KEYS` —
 *       inclusiv numele din POST-CHECK-uri (grupurile Solana, `SOLANA_WS_URL`, selecția goală worker-evm).
 */

import {
  validateWorkerEvmEnv, workerEvmEnvFields, WORKER_EVM_PROBLEM_KEYS, CHAIN_WS_ENV, WORKER_EVM_UNEXPECTED_PREFIXES,
  validateIndexerEvmEnv, indexerEvmEnvFields, INDEXER_EVM_PROBLEM_KEYS, CHAIN_RPC_ENV, INDEXER_EVM_UNEXPECTED_PREFIXES,
  validateSolanaEnv, solanaEnvFields, SOLANA_PROBLEM_KEYS, REDIS_GROUP, RPC_GROUP, SOLANA_UNEXPECTED_PREFIXES,
  type EnvSnapshot,
} from "../src/index";

let passed = 0;
const fails: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) passed++;
  else fails.push(msg);
}

/** Toate numele emise în `problem.name` peste o listă de env-uri adversariale. */
function emittedProblemNames(validate: (e: EnvSnapshot) => ReturnType<typeof validateWorkerEvmEnv>, envs: EnvSnapshot[]): Set<string> {
  const names = new Set<string>();
  for (const env of envs) {
    const v = validate(env);
    if (!v.ok) for (const p of v.problems) names.add(p.name);
  }
  return names;
}

// ─────────────────────────────── worker-evm ───────────────────────────────
{
  const allChains: EnvSnapshot = { ENABLED_CHAINS: "base,arbitrum,bsc,ethereum", INDEXER_ENABLE_ETHEREUM: "1", PREFLIGHT_MODE: "LIVE" };
  const catalog = new Set(WORKER_EVM_PROBLEM_KEYS);

  // (A) coverage: fiecare câmp posibil (toate chain-urile WS-active) ∈ catalog.
  for (const f of workerEvmEnvFields(allChains)) {
    assert(catalog.has(f.name), `worker-evm coverage: câmpul ${f.name} lipsește din WORKER_EVM_PROBLEM_KEYS`);
  }

  // (B) proveniență: nume emise de validatorul real ⊆ catalog (inclusiv WS missing + selecție goală).
  const adversarial: EnvSnapshot[] = [
    {},                                                                                 // REDIS + WS default missing
    { ...allChains, REDIS_URL: "redis://localhost:6379" },                              // 4 WS missing
    { ENABLED_CHAINS: "", REDIS_URL: "redis://localhost:6379", PREFLIGHT_MODE: "DEV" }, // post-check selecție goală
    { ENABLED_CHAINS: "base", REDIS_URL: "redis://localhost:6379", PREFLIGHT_MODE: "LIVE", ALCHEMY_BASE_WS: "http://not-ws" }, // WS invalid
  ];
  for (const name of emittedProblemNames(validateWorkerEvmEnv, adversarial)) {
    assert(catalog.has(name), `worker-evm proveniență: problem.name ${name} ∉ WORKER_EVM_PROBLEM_KEYS`);
  }
  assert(emittedProblemNames(validateWorkerEvmEnv, adversarial).size > 0, "worker-evm: env-urile adversariale n-au produs nicio problemă");
}

// ─────────────────────────────── indexer-evm ───────────────────────────────
{
  const allChains: EnvSnapshot = { INDEXER_ENABLE_BSC: "1", INDEXER_ENABLE_ARBITRUM: "1", INDEXER_ENABLE_ETHEREUM: "1" };
  const catalog = new Set(INDEXER_EVM_PROBLEM_KEYS);

  for (const f of indexerEvmEnvFields(allChains)) {
    assert(catalog.has(f.name), `indexer-evm coverage: câmpul ${f.name} lipsește din INDEXER_EVM_PROBLEM_KEYS`);
  }

  const adversarial: EnvSnapshot[] = [
    {},                                                              // REDIS + ALCHEMY_BASE_RPC missing
    { ...allChains, REDIS_URL: "redis://localhost:6379" },           // 4 RPC missing
    { REDIS_URL: "redis://localhost:6379", ALCHEMY_BASE_RPC: "https://user:pass@rpc" }, // RPC cu credențiale → invalid
  ];
  for (const name of emittedProblemNames(validateIndexerEvmEnv, adversarial)) {
    assert(catalog.has(name), `indexer-evm proveniență: problem.name ${name} ∉ INDEXER_EVM_PROBLEM_KEYS`);
  }
  assert(emittedProblemNames(validateIndexerEvmEnv, adversarial).size > 0, "indexer-evm: env-urile adversariale n-au produs nicio problemă");
}

// ─────────────────────────────── solana ───────────────────────────────
{
  const catalog = new Set(SOLANA_PROBLEM_KEYS);

  for (const f of solanaEnvFields()) {
    assert(catalog.has(f.name), `solana coverage: câmpul ${f.name} lipsește din SOLANA_PROBLEM_KEYS`);
  }

  // (B) proveniență generală: grup Redis + RPC absente + WS efectiv invalid.
  const adversarial: EnvSnapshot[] = [
    {},                                                                                  // grup Redis + RPC missing
    { REDIS_URL: "redis://localhost:6379", SOLANA_RPC_URL: "https://rpc.example", SOLANA_WS_URL: "http://not-ws" }, // WS efectiv invalid
  ];
  const names = emittedProblemNames(validateSolanaEnv, adversarial);
  for (const name of names) {
    assert(catalog.has(name), `solana proveniență: problem.name ${name} ∉ SOLANA_PROBLEM_KEYS`);
  }
  assert(names.has("SOLANA_WS_URL"), "solana: post-check WS (SOLANA_WS_URL) neacoperit");

  // (B2 — P2 cgpt) FIECARE membru al grupurilor Redis/RPC devine pe rând membrul EFECTIV invalid → problem.name = acel
  // membru exact. Setăm DOAR membrul i (cei cu precedență mai mare absenți) ca `??` să-l aleagă pe el drept efectiv.
  for (let i = 0; i < REDIS_GROUP.length; i++) {
    const v = validateSolanaEnv({ [REDIS_GROUP[i]]: "not-a-url", SOLANA_RPC_URL: "https://rpc.example" });
    const got = v.ok ? new Set<string>() : new Set(v.problems.map((p) => p.name));
    assert(got.has(REDIS_GROUP[i]), `solana: membrul Redis efectiv ${REDIS_GROUP[i]} nu a produs problem.name pe el`);
    for (const n of got) assert(catalog.has(n), `solana: problem.name ${n} ∉ catalog (Redis eff ${REDIS_GROUP[i]})`);
  }
  for (let i = 0; i < RPC_GROUP.length; i++) {
    const v = validateSolanaEnv({ REDIS_URL: "redis://localhost:6379", [RPC_GROUP[i]]: "not-a-url" });
    const got = v.ok ? new Set<string>() : new Set(v.problems.map((p) => p.name));
    assert(got.has(RPC_GROUP[i]), `solana: membrul RPC efectiv ${RPC_GROUP[i]} nu a produs problem.name pe el`);
    for (const n of got) assert(catalog.has(n), `solana: problem.name ${n} ∉ catalog (RPC eff ${RPC_GROUP[i]})`);
  }
}

// ─────────────────────────────── cataloage: frozen + ne-goale + UNICE (P2 cgpt) ───────────────────────────────
for (const [label, cat] of [["worker-evm", WORKER_EVM_PROBLEM_KEYS], ["indexer-evm", INDEXER_EVM_PROBLEM_KEYS], ["solana", SOLANA_PROBLEM_KEYS]] as const) {
  assert(Object.isFrozen(cat), `${label}: catalogul de proveniență nu e înghețat`);
  assert(cat.length > 0, `${label}: catalog gol`);
  assert(cat.length === new Set(cat).size, `${label}: catalog cu nume DUPLICATE (${cat.length} intrări vs ${new Set(cat).size} unice)`);
}

// ─────────────────────────────── trust-root-uri ÎNGHEȚATE la runtime (P1 cgpt) ───────────────────────────────
for (const [label, obj] of [
  ["CHAIN_WS_ENV", CHAIN_WS_ENV], ["CHAIN_RPC_ENV", CHAIN_RPC_ENV],
  ["REDIS_GROUP", REDIS_GROUP], ["RPC_GROUP", RPC_GROUP],
  ["WORKER_EVM_UNEXPECTED_PREFIXES", WORKER_EVM_UNEXPECTED_PREFIXES],
  ["INDEXER_EVM_UNEXPECTED_PREFIXES", INDEXER_EVM_UNEXPECTED_PREFIXES],
  ["SOLANA_UNEXPECTED_PREFIXES", SOLANA_UNEXPECTED_PREFIXES],
] as const) {
  assert(Object.isFrozen(obj), `${label}: trust-root ne-înghețat la runtime`);
}

if (fails.length > 0) {
  console.error(`env-contracts contracts.test: ${fails.length} EȘUAT / ${passed} ok`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`env-contracts contracts.test: ${passed}/${passed} ok`);
