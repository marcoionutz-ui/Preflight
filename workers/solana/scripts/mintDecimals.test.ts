import { parseMintDecimals, parseCachedDecimals } from "../src/infra/parseMintDecimals";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else       { failed++; console.log("  ❌ " + name); }
}

// getParsedAccountInfo().value.data pt un mint SPL: { program, parsed:{ type:"mint", info:{ decimals } }, space }
const splMint = (decimals: number) => ({
  program: "spl-token",
  parsed:  { type: "mint", info: { decimals, freezeAuthority: null, isInitialized: true, mintAuthority: null, supply: "0" } },
  space:   82,
});
const token2022Mint = (decimals: number) => ({
  program: "spl-token-2022",
  parsed:  { type: "mint", info: { decimals } },
});
const tokenAccount = {
  program: "spl-token",
  parsed:  { type: "account", info: { mint: "X", owner: "Y", tokenAmount: { decimals: 6 } } },
};

console.log("A3 parseMintDecimals tests");

check("1. SPL mint decimals=6 → 6", parseMintDecimals(splMint(6)) === 6);
check("2. SPL mint decimals=9 (WSOL-like) → 9", parseMintDecimals(splMint(9)) === 9);
check("3. Token-2022 mint decimals=6 (pump.fun) → 6", parseMintDecimals(token2022Mint(6)) === 6);
check("4. mint decimals=0 (NFT) → 0", parseMintDecimals(splMint(0)) === 0);
check("5. token ACCOUNT (nu mint) → null", parseMintDecimals(tokenAccount) === null);
check("6. Buffer/unparsed (fără .parsed) → null", parseMintDecimals({ program: "spl-token", space: 82 }) === null);
check("7. data = null → null", parseMintDecimals(null) === null);
check("8. data = Buffer (string) → null", parseMintDecimals("rawbase64==") === null);
check("9. decimals lipsă → null", parseMintDecimals({ parsed: { type: "mint", info: {} } }) === null);
check("10. decimals string '6' → null", parseMintDecimals({ parsed: { type: "mint", info: { decimals: "6" } } }) === null);
check("11. decimals out of range (99) → null", parseMintDecimals({ parsed: { type: "mint", info: { decimals: 99 } } }) === null);
check("12. decimals negativ (-1) → null", parseMintDecimals({ parsed: { type: "mint", info: { decimals: -1 } } }) === null);
check("13. decimals float (6.5) → null", parseMintDecimals({ parsed: { type: "mint", info: { decimals: 6.5 } } }) === null);

// ── parseCachedDecimals (validare strictă a cache-ului Redis) ────────────────
check("14. cache '6' → 6",      parseCachedDecimals("6") === 6);
check("15. cache '0' → 0",      parseCachedDecimals("0") === 0);
check("16. cache '18' → 18",    parseCachedDecimals("18") === 18);
check("17. cache '19' → null (range)",   parseCachedDecimals("19") === null);
check("18. cache '-1' → null",           parseCachedDecimals("-1") === null);
check("19. cache '6junk' → null",        parseCachedDecimals("6junk") === null);
check("20. cache '6.5' → null",          parseCachedDecimals("6.5") === null);
check("21. cache '' → null",             parseCachedDecimals("") === null);
check("22. cache ' 6' → null (spațiu)",  parseCachedDecimals(" 6") === null);
check("23. cache '06' → null (leading zero)", parseCachedDecimals("06") === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
