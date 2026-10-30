import assert from "node:assert/strict";
import { validateWorkerEvmEnv, WORKER_EVM_PROBLEM_KEYS, ETH_PRICE_RPC_GROUP } from "@preflight/env-contracts";
import type { EnvSnapshot } from "@preflight/config-env";
let passed = 0;
const good = { NODE_ENV: "production", REDIS_URL: "redis://localhost:6379", ENABLED_CHAINS: "base", PREFLIGHT_MODE: "LIVE", ALCHEMY_BASE_WS: "wss://base.example" };
const names = (e: EnvSnapshot) => { const v = validateWorkerEvmEnv(e); return v.ok ? [] : v.problems.map(p => p.name); };
function check(name: string, f: () => void) { f(); passed++; console.log("  OK " + name); }
check("E1 missing and whitespace ETH group fail", () => { for (const raw of [undefined, "", "  "]) assert(names({ ...good, ALCHEMY_BASE_RPC: raw }).includes(ETH_PRICE_RPC_GROUP)); });
check("E2 every ETH source is independently sufficient", () => { for (const key of ["ALCHEMY_BASE_RPC", "ALCHEMY_ARB_RPC", "ALCHEMY_ETH_RPC"]) assert.equal(validateWorkerEvmEnv({ ...good, [key]: "https://rpc.example" }).ok, true); });
check("E3 all malformed sources fail without leaking values", () => { const v = validateWorkerEvmEnv({ ...good, ALCHEMY_BASE_RPC: "https://secret:password@rpc.example", ALCHEMY_ARB_RPC: "bad" }); assert.equal(v.ok, false); assert(!JSON.stringify(v).includes("password")); assert(names({ ...good, ALCHEMY_BASE_RPC: "bad" }).includes(ETH_PRICE_RPC_GROUP)); });
check("E4 valid fallback plus malformed optional source warns", () => { const v = validateWorkerEvmEnv({ ...good, ALCHEMY_BASE_RPC: "bad", ALCHEMY_ARB_RPC: "https://rpc.example" }); assert.equal(v.ok, true); assert(v.warnings.some(w => w.name === "ALCHEMY_BASE_RPC")); });
check("E5 DEV warns without relaxing Redis/empty selection", () => { const e = { ...good, PREFLIGHT_MODE: "DEV" }; const v = validateWorkerEvmEnv(e); assert.equal(v.ok, true); assert(v.warnings.some(w => w.name === ETH_PRICE_RPC_GROUP)); assert.equal(validateWorkerEvmEnv({ ...e, REDIS_URL: undefined }).ok, false); assert.equal(validateWorkerEvmEnv({ ...e, ENABLED_CHAINS: "" }).ok, false); });
check("E6 BSC-only is independent from ETH", () => { const e = { ...good, ENABLED_CHAINS: "bsc", ALCHEMY_BNB_WS: "wss://bsc.example" }; assert.deepEqual(names(e), ["ALCHEMY_BNB_RPC"]); assert.equal(validateWorkerEvmEnv({ ...e, ALCHEMY_BNB_RPC: "https://bsc.example" }).ok, true); });
check("E7 mixed chains require both groups", () => { const e = { ...good, ENABLED_CHAINS: "base,bsc", ALCHEMY_BNB_WS: "wss://bsc.example", ALCHEMY_BASE_RPC: "https://base.example" }; assert(names(e).includes("ALCHEMY_BNB_RPC")); });
check("E8 Ethereum shadow gate remains", () => { assert.equal(validateWorkerEvmEnv({ ...good, ENABLED_CHAINS: "ethereum", ALCHEMY_ETH_RPC: "https://eth.example" }).ok, false); assert.equal(validateWorkerEvmEnv({ ...good, ENABLED_CHAINS: "ethereum", INDEXER_ENABLE_ETHEREUM: "1", ALCHEMY_ETH_WS: "wss://eth.example", ALCHEMY_ETH_RPC: "https://eth.example" }).ok, true); });
check("E9 provenance includes actual fields and canonical group", () => { for (const key of ["ALCHEMY_BASE_RPC", "ALCHEMY_ARB_RPC", "ALCHEMY_ETH_RPC", "ALCHEMY_BNB_RPC", ETH_PRICE_RPC_GROUP]) assert(WORKER_EVM_PROBLEM_KEYS.includes(key)); });
check("E10 non-DEV modes cannot bypass requirement", () => { for (const mode of [undefined, "BURST", "PAID_LIVE", "typo", " DEV "]) assert(names({ ...good, PREFLIGHT_MODE: mode }).includes(ETH_PRICE_RPC_GROUP)); });
console.log(passed + " passed, 0 failed (P1 env)");
