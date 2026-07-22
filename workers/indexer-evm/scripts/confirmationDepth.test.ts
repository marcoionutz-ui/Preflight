/**
 * scripts/confirmationDepth.test.ts — C5 (confirmation depth / reorg safety)
 *
 * Verifică: default-uri per-chain, override env (per-chain + global + invalid),
 * clamp safeHead >= 0, și integrarea cu getBatchRanges/computeCursorState
 * (batch-urile nu depășesc niciodată head-ul confirmat; cursor peste safe head → 0 batches).
 *
 * Rulează: npm run test:c5   (tsx scripts/confirmationDepth.test.ts)
 */
import {
  DEFAULT_CONFIRMATION_DEPTH,
  confirmationDepth,
  safeHead,
  computeCursorState,
  getBatchRanges,
  BATCH_SIZE,
} from "../src/infra/cursor";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else       { failed++; console.log("  ❌ " + name); }
}

// helper: curăță toate override-urile de env între cazuri
function clearEnv() {
  delete process.env.INDEXER_CONFIRMATION_DEPTH;
  for (const c of ["BASE", "ARBITRUM", "BSC", "ETHEREUM"]) {
    delete process.env[`INDEXER_CONFIRMATION_DEPTH_${c}`];
  }
}

function run() {
  console.log("C5 — confirmation depth / reorg safety\n");

  // 1. default-uri per-chain
  clearEnv();
  check("1a. default base = 5",     confirmationDepth("base") === 5);
  check("1b. default arbitrum = 5", confirmationDepth("arbitrum") === 5);
  check("1c. default bsc = 15",     confirmationDepth("bsc") === 15);
  check("1d. default ethereum = 6", confirmationDepth("ethereum") === 6);
  check("1e. map exportat coincide", DEFAULT_CONFIRMATION_DEPTH.bsc === 15 && DEFAULT_CONFIRMATION_DEPTH.base === 5);

  // 2. safeHead math + clamp
  clearEnv();
  check("2a. safeHead(base,1000) = 995", safeHead("base", 1000) === 995);
  check("2b. safeHead(bsc,1000) = 985",  safeHead("bsc", 1000) === 985);
  check("2c. clamp >= 0 (base, head 3)", safeHead("base", 3) === 0);
  check("2d. clamp >= 0 (bsc, head 0)",  safeHead("bsc", 0) === 0);

  // 3. override per-chain
  clearEnv();
  process.env.INDEXER_CONFIRMATION_DEPTH_BASE = "12";
  check("3a. per-chain override base = 12", confirmationDepth("base") === 12);
  check("3b. override afectează safeHead", safeHead("base", 1000) === 988);
  check("3c. alt chain neafectat (bsc=15)", confirmationDepth("bsc") === 15);

  // 4. override global
  clearEnv();
  process.env.INDEXER_CONFIRMATION_DEPTH = "3";
  check("4a. global override arbitrum = 3", confirmationDepth("arbitrum") === 3);
  check("4b. global override ethereum = 3", confirmationDepth("ethereum") === 3);

  // 5. per-chain bate global
  clearEnv();
  process.env.INDEXER_CONFIRMATION_DEPTH = "3";
  process.env.INDEXER_CONFIRMATION_DEPTH_BSC = "20";
  check("5a. per-chain (20) bate global (3) pt bsc", confirmationDepth("bsc") === 20);
  check("5b. global (3) rămâne pt base", confirmationDepth("base") === 3);

  // 6. override invalid → default (fără throw)
  clearEnv();
  process.env.INDEXER_CONFIRMATION_DEPTH_BASE = "abc";
  check("6a. override non-numeric → default 5", confirmationDepth("base") === 5);
  process.env.INDEXER_CONFIRMATION_DEPTH_BASE = "-2";
  check("6b. override negativ → default 5", confirmationDepth("base") === 5);
  process.env.INDEXER_CONFIRMATION_DEPTH_BASE = "";
  check("6c. override gol → default 5", confirmationDepth("base") === 5);
  process.env.INDEXER_CONFIRMATION_DEPTH_BASE = "7.9";
  check("6d. override fracționar → floor 7", confirmationDepth("base") === 7);

  // 7. depth 0 = dezactivat (indexează până la head)
  clearEnv();
  process.env.INDEXER_CONFIRMATION_DEPTH_BASE = "0";
  check("7a. depth 0 → confirmationDepth 0", confirmationDepth("base") === 0);
  check("7b. depth 0 → safeHead == head", safeHead("base", 1000) === 1000);

  // 8. integrare: batch-urile nu depășesc head-ul confirmat
  clearEnv();
  const rawHead = 1000;
  const sh = safeHead("base", rawHead);           // 995
  const st = computeCursorState(990, sh, "base"); // behind 5, OK
  const ranges = getBatchRanges(st, sh);
  const maxTo = Math.max(...ranges.map(r => r.toBlock));
  check("8a. safe head = 995", sh === 995);
  check("8b. există batches (behind 5)", ranges.length >= 1);
  check("8c. niciun toBlock > safe head", maxTo === 995 && maxTo < rawHead);

  // 9. cursor FIX la safe head → 0 batches
  clearEnv();
  const stAt = computeCursorState(995, safeHead("base", 1000), "base");
  check("9a. cursor == safe head → behind 0", stAt.blocksBehind === 0);
  check("9b. cursor == safe head → 0 batches", getBatchRanges(stAt, safeHead("base", 1000)).length === 0);

  // 10. cursor PESTE safe head (blocuri neconfirmate deja în cursor) → 0 batches, fără range negativ
  clearEnv();
  const stAhead = computeCursorState(998, safeHead("base", 1000), "base"); // 998 > 995
  check("10a. cursor peste safe head → behind 0 (nu negativ)", stAhead.blocksBehind === 0);
  check("10b. cursor peste safe head → 0 batches", getBatchRanges(stAhead, safeHead("base", 1000)).length === 0);

  // 11. batch mare respectă BATCH_SIZE ȘI safe head simultan
  clearEnv();
  const shBig = safeHead("bsc", 5000);            // 4985
  const stBig = computeCursorState(1000, shBig, "bsc");
  const rBig  = getBatchRanges(stBig, shBig);
  const okSize = rBig.every(r => r.toBlock - r.fromBlock + 1 <= BATCH_SIZE);
  const okHead = rBig.every(r => r.toBlock <= shBig);
  check("11a. toate batch-urile <= BATCH_SIZE", okSize);
  check("11b. toate batch-urile <= safe head", okHead);

  clearEnv();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
