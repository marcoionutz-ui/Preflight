/**
 * lib/demo/demoGuard.test.ts — PH-11 GUARD (deciderele pure de protecție demo).
 * Pur, fără Redis: identitate canonică (Solana case-sensitive, EVM dedup, eth/ethereum), IP Railway (x-real-ip +
 * isIP, XFF spoof), cache freshness+age, rate/budget/concurrency classify + source-guard pe pagini.
 */
import { readFileSync } from "node:fs";
import {
  canonicalizeDemoPair, canonicalChain, demoPairSlug, isServableDemoPair,
  extractClientIp, resolveCacheFreshness, cacheAgeSec,
  classifyWindowLimit, classifyBuildBudget, classifyConcurrency, nonBuildFallback,
  DEMO_CACHE_TTL_SEC, DEMO_STALE_SERVE_MAX_SEC,
  DEMO_REQ_LIMIT_PER_WINDOW, DEMO_BUILD_LIMIT_PER_WINDOW,
} from "./demoGuard";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
const hdr = (m: Record<string, string>) => (n: string): string | undefined => m[n];
const EVM = "0x" + "a".repeat(40);
const EVM_UP = "0x" + "A".repeat(40);
const V4 = "0x" + "b".repeat(64);
const SOL = "So11111111111111111111111111111111111111112"; // 43, base58

function main(): void {
console.log("PH-11 — demo guard (pur: identitate canonică + IP + cache + rate/budget/concurrency)");

// ── Item 1: identitate canonică ───────────────────────────────────────────────
check("1. canonicalChain: eth → ethereum", canonicalChain("eth") === "ethereum");
check("2. canonicalChain: ETHEREUM → ethereum (case)", canonicalChain("ETHEREUM") === "ethereum");
check("3. ⭐ canonicalChain necunoscut → null", canonicalChain("dogechain") === null);
check("4. ⭐⭐ eth/addr și ethereum/addr → ACEEAȘI cheie (dedup)",
  demoPairSlug("eth", EVM) === demoPairSlug("ethereum", EVM) && demoPairSlug("eth", EVM) !== null);
check("5. ⭐⭐ EVM casing DEDUPLICAT (0xAAA… == 0xaaa…)",
  demoPairSlug("base", EVM_UP) === demoPairSlug("base", EVM) && demoPairSlug("base", EVM) === `pair:base:${EVM}`);
check("6. ⭐ EVM V4 pool id (0x+64hex) acceptat", canonicalizeDemoPair("base", V4)?.address === V4);
check("7. ⭐ EVM adresă lungime greșită (0x+41) → null", canonicalizeDemoPair("base", "0x" + "a".repeat(41)) === null);
check("8. ⭐ EVM non-hex → null", canonicalizeDemoPair("base", "0x" + "z".repeat(40)) === null);
check("9. ⭐⭐ Solana CASE-SENSITIVE: două casing-uri diferite → chei DIFERITE (fără coliziune)",
  demoPairSlug("solana", SOL) !== demoPairSlug("solana", SOL.toLowerCase()) &&
  demoPairSlug("solana", SOL) === `pair:solana:${SOL}`);
check("10. ⭐ Solana păstrează casing-ul original în slug", canonicalizeDemoPair("solana", SOL)?.address === SOL);
check("11. ⭐ Solana non-base58 (conține 0/O/I/l) → null",
  canonicalizeDemoPair("solana", "0OIl" + "1".repeat(39)) === null);
check("12. ⭐ Solana prea scurt (<32) → null", canonicalizeDemoPair("solana", "abc") === null);
check("13. ⭐ pre-validare și slug NU pot diverge (ambele din canonicalizeDemoPair)",
  isServableDemoPair("base", EVM) === (demoPairSlug("base", EVM) !== null) &&
  isServableDemoPair("base", "bad") === (demoPairSlug("base", "bad") !== null));
check("14. demoPairSlug invalid → null", demoPairSlug("base", "bad") === null);
check("15. null/undefined → not servable (fără throw)",
  isServableDemoPair(null, EVM) === false && isServableDemoPair("base", undefined) === false);

// ── Item 2: IP Railway (x-real-ip + isIP; XFF doar cu trustXff) ───────────────
check("16. ⭐⭐ x-real-ip valid are PRECEDENȚĂ (Railway)",
  extractClientIp(hdr({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" })) === "203.0.113.7");
check("17. ⭐⭐ XFF SPOOFED ignorat fără trustXff → 'unknown' (nu bucket nou per request)",
  extractClientIp(hdr({ "x-forwarded-for": "1.2.3.4" })) === "unknown");
check("18. ⭐ x-real-ip INVALID (nu-i IP) → 'unknown' (isIP fail-closed)",
  extractClientIp(hdr({ "x-real-ip": "not-an-ip" })) === "unknown");
check("19. ⭐ x-real-ip IPv6 valid acceptat",
  extractClientIp(hdr({ "x-real-ip": "2001:db8::1" })) === "2001:db8::1");
check("20. ⭐ XFF folosit DOAR cu trustXff (trusted proxy explicit), primul hop validat",
  extractClientIp(hdr({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" }), { trustXff: true }) === "198.51.100.9");
check("21. ⭐ trustXff dar primul hop XFF invalid → 'unknown'",
  extractClientIp(hdr({ "x-forwarded-for": "garbage, 10.0.0.1" }), { trustXff: true }) === "unknown");
check("22. niciun antet → 'unknown'", extractClientIp(hdr({})) === "unknown");
check("23. ⭐ x-real-ip valid bate XFF chiar cu trustXff",
  extractClientIp(hdr({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" }), { trustXff: true }) === "203.0.113.7");

// ── cache freshness + age (item 6) ───────────────────────────────────────────
const now = 1_000_000_000_000;
check("24. miss (null)", resolveCacheFreshness(null, now) === "miss");
check("25. fresh (age 0)", resolveCacheFreshness(now, now) === "fresh");
check("26. stale (peste ttl, sub staleMax)", resolveCacheFreshness(now - (DEMO_CACHE_TTL_SEC + 10) * 1000, now) === "stale");
check("27. miss (peste staleMax)", resolveCacheFreshness(now - (DEMO_STALE_SERVE_MAX_SEC + 1) * 1000, now) === "miss");
check("28. viitor → miss", resolveCacheFreshness(now + 5000, now) === "miss");
check("29. ⭐ cacheAgeSec: 90s", cacheAgeSec(now - 90_000, now) === 90);
check("30. ⭐ cacheAgeSec viitor/NaN → null", cacheAgeSec(now + 1000, now) === null && cacheAgeSec(NaN, now) === null);

// ── Item 5: request-rate (generos) vs build-rate (strict) ─────────────────────
check("31. request-rate: sub limita generoasă → allow", classifyWindowLimit(100, DEMO_REQ_LIMIT_PER_WINDOW) === "allow");
check("32. ⭐ request-rate: peste limita generoasă → limited", classifyWindowLimit(DEMO_REQ_LIMIT_PER_WINDOW + 1, DEMO_REQ_LIMIT_PER_WINDOW) === "limited");
check("33. ⭐ build-rate STRICT < request-rate (30 < 120)", DEMO_BUILD_LIMIT_PER_WINDOW < DEMO_REQ_LIMIT_PER_WINDOW);
check("34. ⭐ count peste build-limit dar sub req-limit → build limited (spam de build separat)",
  classifyWindowLimit(DEMO_BUILD_LIMIT_PER_WINDOW + 1, DEMO_BUILD_LIMIT_PER_WINDOW) === "limited" &&
  classifyWindowLimit(DEMO_BUILD_LIMIT_PER_WINDOW + 1, DEMO_REQ_LIMIT_PER_WINDOW) === "allow");
check("35. ⭐ count 0/NaN → FAIL-CLOSED limited", classifyWindowLimit(0, 30) === "limited" && classifyWindowLimit(NaN, 30) === "limited");

// ── budget + concurrency classifiers ─────────────────────────────────────────
check("36. budget ≥0 → allow; -1 → limited", classifyBuildBudget(0) === "allow" && classifyBuildBudget(-1) === "limited");
check("37. budget NaN → limited (fail-closed)", classifyBuildBudget(NaN) === "limited");
check("38. ⭐ concurrency slot ≥0 → allow; -1 (plin) → limited",
  classifyConcurrency(0) === "allow" && classifyConcurrency(3) === "allow" && classifyConcurrency(-1) === "limited");
check("39. concurrency NaN → limited (fail-closed)", classifyConcurrency(NaN) === "limited");
check("40. nonBuildFallback: stale → serve_stale; miss → busy",
  nonBuildFallback("stale") === "serve_stale" && nonBuildFallback("miss") === "busy");

// ── source-guard: pagini cablate corect ──────────────────────────────────────
const overview = readFileSync("app/demo/page.tsx", "utf8");
const pairPage = readFileSync("app/demo/pair/[chain]/[address]/page.tsx", "utf8");
check("41. ⭐ overview: resolveClientIp + enforceRequestRate + admitBuildRequest + withBuildLease (heartbeat+fenced publish+release)",
  /resolveClientIp\(/.test(overview) && /enforceRequestRate\(/.test(overview) &&
  /admitBuildRequest\(/.test(overview) && /withBuildLease\(/.test(overview));
check("42. ⭐⭐ overview: enforceRequestRate ÎNAINTE de admitBuildRequest (request-rate întâi)",
  overview.indexOf("enforceRequestRate(") < overview.indexOf("admitBuildRequest("));
check("43. ⭐⭐ pair page (item 4): enforceRequestRate ÎNAINTE de canonicalizeDemoPair (URL invalid tot request-limited)",
  /enforceRequestRate\(/.test(pairPage) && /canonicalizeDemoPair\(/.test(pairPage) &&
  pairPage.indexOf("enforceRequestRate(") < pairPage.indexOf("canonicalizeDemoPair("));
check("44. ⭐ pair page: demoPairSlug + withBuildLease + resolveClientIp (nu extractClientIp direct)",
  /demoPairSlug\(/.test(pairPage) && /withBuildLease\(/.test(pairPage) &&
  /resolveClientIp\(/.test(pairPage) && !/[^e]extractClientIp\(/.test(pairPage));
check("45. ⭐⭐ ambele: build DOAR pe action==='build' (nu pe serve_stale → respectă bugetul/concurența)",
  /admission\.action === "build"/.test(overview) && /admission\.action === "build"/.test(pairPage));
check("46. ⭐⭐ item 6: ambele randează CacheBanner (onestitate stale/cached snapshot)",
  /CacheBanner/.test(overview) && /CacheBanner/.test(pairPage) &&
  /servedFrom=/.test(overview) && /servedFrom=/.test(pairPage));
check("47. ⭐⭐ FAIL-CLOSED: ambele tratează request-rate ≠ allow ca busy (Redis-down/unavailable NU trece)",
  /rate !== "allow"/.test(overview) && /rate !== "allow"/.test(pairPage));
check("48. ⭐⭐ ambele construiesc DOAR dacă withBuildLease a rulat build-ul (res.built) — ownership pierdut ⇒ nu afișează",
  /res\.built/.test(overview) && /res\.built/.test(pairPage));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
