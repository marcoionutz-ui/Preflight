/**
 * PH-4 integration — Redis UNREACHABLE-BEFORE-EXECUTION (cgpt #4). NU face parte din `npm test`.
 * Rulează separat: `npm run test:ph4-integration-down` (Redis LOCAL dedicat în PH4_LIVE_REDIS_URL).
 *
 * CLAIM PRECIS (cgpt #3r): acest fișier dovedește DOAR cazul „comanda nu ajunge niciodată la Redis" (endpoint
 * inaccesibil) — modulul întoarce `unavailable` (503), NU `invalid` (401), și nu mutează nimic (grantul seedat pe
 * un Redis live rămâne neatins). NU acoperă cazul ambiguu „EVAL a fost executat, dar răspunsul s-a pierdut" — acela
 * e dovedit same-instance în `refresh.integration.ts` (secțiunea 8 FLAP: retry-ul cu tokenul vechi e reuse_detected,
 * familia e revocată, niciun credential valid nu rămâne). Aici NU pretindem că acoperim mid-flight.
 */
import Redis from "ioredis";
import { mintRefreshToken, familyKey, newFamilyId, rotateRefreshToken, getFamilyState, peekRefreshToken } from "./oauth-refresh";
import { validateToken, REFRESH_TTL_SEC } from "./oauth-tokens";
import type { RefreshPayload } from "./oauthAtomic";

// getRedis() citește REDIS_URL LAZY (la primul apel, în main) — modulele nu deschid conexiuni la import, deci putem
// seta env-ul aici (după importuri) fără efect. Port ÎNCHIS: modulul nu ajunge la niciun server -> `unavailable`.
const LIVE = process.env.PH4_LIVE_REDIS_URL ?? "";
const LOOPBACK = /^redis:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(LIVE);
if (!LOOPBACK || process.env.PH4_INTEGRATION_ALLOW !== "1") {
  console.error("REFUZ: seteaza PH4_LIVE_REDIS_URL spre un Redis LOCAL dedicat (loopback) + PH4_INTEGRATION_ALLOW=1.");
  process.exit(3);
}
process.env.REDIS_URL = "redis://127.0.0.1:6390"; // port INCHIS — comanda modulului nu ajunge niciodata la un server

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
function mkPayload(familyId: string, issued_at: number): RefreshPayload {
  return { client_id: "c1", scopes: ["read:basic"], audience: "https://x/api/mcp", credential_version: "v1", family_id: familyId, issued_at };
}

async function main() {
  console.log("PH-4 INTEGRATION (unreachable-before-exec) — modul @ redis://127.0.0.1:6390 (INCHIS); live seed @ " + LIVE);
  const live = new Redis(LIVE);

  // Seed pe LIVE un grant existent (client manual) — NU trebuie atins de modulul care nu poate contacta Redis.
  const fam = newFamilyId();
  const R = mintRefreshToken(mkPayload(fam, 1));
  await live.set(R.key, R.value, "EX", REFRESH_TTL_SEC);
  await live.set(familyKey(fam), R.hash, "EX", REFRESH_TTL_SEC);

  // Modulul (endpoint inaccesibil) — comanda nu ajunge la Redis -> `unavailable`, NU `invalid`.
  const rot = await rotateRefreshToken(R.token, mkPayload(fam, 2), mkPayload(fam, 2));
  check("1. ⭐⭐ rotate cu Redis inaccesibil -> unavailable (fail-closed, nu minte 401)", rot.status === "unavailable");
  check("2. ⭐ getFamilyState inaccesibil -> unavailable (resolveAuth -> retry -> 503)", (await getFamilyState(fam)) === "unavailable");
  check("3. peekRefreshToken inaccesibil -> unavailable", (await peekRefreshToken(R.token)).status === "unavailable");
  check("4. validateToken inaccesibil -> unavailable (nu invalid)", (await validateToken("whatever")).status === "unavailable");

  // NON-MUTARE (doar pt. cazul unreachable-before-exec): grantul seedat pe live e NESCHIMBAT (comanda n-a ajuns la el).
  check("5. ⭐⭐ family seedata NESCHIMBATA (comanda n-a ajuns la Redis; == hash initial, nu REVOKED)", (await live.get(familyKey(fam))) === R.hash);
  check("6. ⭐ refresh seedat inca prezent (neconsumat)", (await live.get(R.key)) === R.value);

  await live.del(R.key, familyKey(fam)); // cleanup
  console.log("\n" + passed + " passed, " + failed + " failed");
  live.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("THREW:", e); process.exit(2); });
