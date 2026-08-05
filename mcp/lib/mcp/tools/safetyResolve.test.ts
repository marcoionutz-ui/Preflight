/**
 * tools/safetyResolve.test.ts — P1-1: rezolvarea pe pairKey (nu pe adresa brută).
 *
 * Hărțile sunt cheiate cu `pairKey(chain, addr)` REAL (ca worker-ul). Dovedește că `resolveSafetyContext`
 * găsește token/chain/symbol când perechea există (vechiul `[addr]` brut rata → UNKNOWN_RISK fals),
 * respectă prioritățile (arg > prefix > hărți), raportează ambiguitatea și normalizează eth→ethereum.
 */
import { resolveSafetyContext, deriveChainFromTokenAddress, type SafetyMaps } from "./safetyResolve";
import { pairKey } from "@preflight/schema";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const ADDR  = "0xAbCdEf0000000000000000000000000000000001";
const TOKEN = "0xToKeN0000000000000000000000000000000009";
const empty = (): SafetyMaps => ({ states: {}, watch: {}, hot: {}, armed: {}, memory: {} });

function main(): void {
  console.log("P1-1 — resolveSafetyContext (lookup pe pairKey, nu addr brut)");

  // 1. CORE FIX: pereche în states pe base, cheiată pairKey, FĂRĂ hint → rezolvă chain+token
  //    (vechiul `ctx.states[addr]` brut rata → chain/token null → UNKNOWN_RISK fals). symbol = fallback
  //    (states NU e sursă de symbol în tool — doar memory/hot/watch), deci addr.slice.
  const m1 = empty();
  m1.states[pairKey("base", ADDR)] = { tokenAddress: TOKEN, symbol: "FOO" };
  const r1 = resolveSafetyContext(ADDR, null, null, m1);
  check("1. * states[pairKey(base)] fără hint -> chain=base + token rezolvat (fix-ul P1-1)",
    r1.resolvedChain === "base" && r1.rawTokenAddress === TOKEN && r1.symbol === ADDR.slice(0, 10));

  // 2. memory[pairKey] pe arbitrum → token + symbol din memory
  const m2 = empty();
  m2.memory[pairKey("arbitrum", ADDR)] = { tokenAddress: TOKEN, symbol: "BAR" };
  const r2 = resolveSafetyContext(ADDR, null, null, m2);
  check("2. memory[pairKey(arbitrum)] -> chain=arbitrum + token + symbol",
    r2.resolvedChain === "arbitrum" && r2.rawTokenAddress === TOKEN && r2.symbol === "BAR");

  // 3. hint 'eth' + intrare sub cheia ethereum → găsit; chain normalizat ethereum (token din states, symbol din memory)
  const m3 = empty();
  m3.states[pairKey("ethereum", ADDR)] = { tokenAddress: TOKEN };
  m3.memory[pairKey("ethereum", ADDR)] = { symbol: "ETHT" };
  const r3 = resolveSafetyContext(ADDR, "eth", null, m3);
  check("3. * hint 'eth' -> pairKey(ethereum) găsit + chain normalizat 'ethereum' + token + symbol",
    r3.resolvedChain === "ethereum" && r3.rawTokenAddress === TOKEN && r3.symbol === "ETHT");

  // 4. token_address arg → folosit direct (fără lookup)
  const r4 = resolveSafetyContext(ADDR, "base", "0xArg", empty());
  check("4. token_address arg -> folosit direct", r4.rawTokenAddress === "0xArg" && r4.resolvedChain === "base");

  // 5. ambiguitate: aceeași adresă pe base ȘI bsc, fără hint → ambiguousChains, chain null
  const m5 = empty();
  m5.states[pairKey("base", ADDR)] = { tokenAddress: TOKEN, symbol: "A" };
  m5.states[pairKey("bsc", ADDR)]  = { tokenAddress: TOKEN, symbol: "B" };
  const r5 = resolveSafetyContext(ADDR, null, null, m5);
  check("5. * ambiguu (base+bsc) fără hint -> chain null + ambiguousChains 2",
    r5.resolvedChain === null && r5.ambiguousChains.length === 2 &&
    r5.ambiguousChains.includes("base") && r5.ambiguousChains.includes("bsc"));

  // 6. negăsit, fără hint/token → chain null, token null, symbol = prefix adresă
  const r6 = resolveSafetyContext(ADDR, null, null, empty());
  check("6. * negăsit fără hint/token -> chain null, token null, symbol=addr.slice(0,10)",
    r6.resolvedChain === null && r6.rawTokenAddress === null && r6.symbol === ADDR.slice(0, 10));

  // 7. hint dar pereche absentă din hărți -> chain din hint (tool cere apoi token_address)
  const r7 = resolveSafetyContext(ADDR, "base", null, empty());
  check("7. hint fără intrare în hărți -> chain=base (din hint), token null",
    r7.resolvedChain === "base" && r7.rawTokenAddress === null);

  // 8. chain din prefixul token address (fără hint, fără hărți)
  const r8 = resolveSafetyContext(ADDR, null, "arbitrum_0xToken", empty());
  check("8. chain din prefix token ('arbitrum_0x…') -> arbitrum",
    r8.resolvedChain === "arbitrum" && r8.rawTokenAddress === "arbitrum_0xToken");

  // 9. deriveChainFromTokenAddress
  check("9. deriveChainFromTokenAddress('base_0xabc') === 'base'", deriveChainFromTokenAddress("base_0xabc") === "base");
  check("9a. deriveChainFromTokenAddress('0xabc') === null", deriveChainFromTokenAddress("0xabc") === null);

  // 10. prioritate: hint bate prefixul token
  const r10 = resolveSafetyContext(ADDR, "bsc", "arbitrum_0xToken", empty());
  check("10. hint 'bsc' bate prefixul token 'arbitrum' -> bsc", r10.resolvedChain === "bsc");

  // 11. symbol din hot când memory lipsește
  const m11 = empty();
  m11.hot[pairKey("base", ADDR)] = { symbol: "HOTSYM" };
  const r11 = resolveSafetyContext(ADDR, null, null, m11);
  check("11. symbol din hot[pairKey] când memory lipsește", r11.symbol === "HOTSYM" && r11.resolvedChain === "base");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
