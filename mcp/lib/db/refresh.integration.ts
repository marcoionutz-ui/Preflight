/**
 * PH-4 integration proof — funcțiile REALE de producție pe un Redis REAL (nu source-guards). NU face parte din
 * `npm test` (infra-free); rulează separat: `npm run test:ph4-integration` cu un Redis LOCAL dedicat.
 *
 * SIGURANȚĂ (cgpt #2r, P0): NU face `flushdb`. Refuză să pornească dacă REDIS_URL nu e loopback dedicat + opt-in
 * explicit (`PH4_INTEGRATION_ALLOW=1`) — ca să nu poată șterge un staging/producție configurat din greșeală.
 * Cheile create sunt random (family_id/token) și se șterg la final (best-effort).
 *
 * Acoperă cgpt #4: A->B rotire, TTL-uri reale produse de Lua (access/refresh/family), reuse-A-revocă-familia,
 * B-respins, ACCESS token moare la revocare (#1), familie ABSENTĂ -> inactive -> 401 (fail-closed #2r),
 * concurență (EVAL atomic), retry `familyState unavailable -> 503` în resolveAuth.
 */
import { createHash } from "node:crypto";
import Redis from "ioredis";
import { mintRefreshToken, familyKey, newFamilyId, peekRefreshToken, rotateRefreshToken, getFamilyState } from "./oauth-refresh";
import { validateToken, REFRESH_TTL_SEC, TOKEN_TTL_SEC } from "./oauth-tokens";
import { resolveAuth, type AuthDeps } from "../mcp/authPolicy";
import type { RefreshPayload } from "./oauthAtomic";
import type { ClientLookup } from "./clientLookup";

// SIGURANȚĂ: loopback dedicat + opt-in explicit, altfel refuz (nu ating un Redis oarecare).
const URL = process.env.REDIS_URL ?? "";
const LOOPBACK = /^redis:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(URL);
if (!LOOPBACK || process.env.PH4_INTEGRATION_ALLOW !== "1") {
  console.error("REFUZ: seteaza REDIS_URL spre un Redis LOCAL dedicat (loopback) + PH4_INTEGRATION_ALLOW=1. Nu rulez pe un Redis oarecare.");
  process.exit(3);
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const seed = new Redis(URL);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const created: string[] = [];
const CV = "v1";
const hex = (t: string) => createHash("sha256").update(t).digest("hex");
const tokenKey   = (t: string) => `mcp:token:${hex(t)}`;
const refreshKey = (t: string) => `mcp:refresh:${hex(t)}`;

function activeDeps(): AuthDeps {
  return {
    validateToken,
    getClient: async () => ({
      status: "found",
      client: { client_id: "c1", secret_rotated_at: CV, plan: "pro", rate_limit_per_minute: 100, rate_limit_per_day: 10000, scopes: ["read:basic"] },
    } as unknown as ClientLookup),
    checkRate: async () => ({ status: "ok", remaining_min: 99, remaining_day: 9999 }),
    touch: () => {},
    sleep,
    familyState: getFamilyState,
  };
}
function mkPayload(familyId: string, issued_at: number): RefreshPayload {
  return { client_id: "c1", scopes: ["read:basic"], audience: "https://x/api/mcp", credential_version: CV, family_id: familyId, issued_at };
}
async function seedFamily(): Promise<{ familyId: string; A: ReturnType<typeof mintRefreshToken> }> {
  const familyId = newFamilyId();
  const A = mintRefreshToken(mkPayload(familyId, 1));
  await seed.set(A.key, A.value, "EX", REFRESH_TTL_SEC);
  await seed.set(familyKey(familyId), A.hash, "EX", REFRESH_TTL_SEC);
  created.push(A.key, familyKey(familyId));
  return { familyId, A };
}
const HEX64 = /^[0-9a-f]{64}$/;
const near = (ttl: number, target: number) => ttl > target - 120 && ttl <= target;

async function main() {
  console.log("PH-4 INTEGRATION — real Redis @ " + URL + " (no flushdb; random keys)");

  // ── 1. Rotire A -> B + TTL-uri reale produse de Lua ─────────────────────────
  const { familyId, A } = await seedFamily();
  const r1 = await rotateRefreshToken(A.token, mkPayload(familyId, 2), mkPayload(familyId, 2));
  check("1. rotate A -> rotated (access + refresh noi)", r1.status === "rotated");
  const accessA = r1.status === "rotated" ? r1.accessToken : "";
  const B       = r1.status === "rotated" ? r1.refreshToken : "";
  created.push(tokenKey(accessA), refreshKey(B));
  const famAfter1 = await seed.get(familyKey(familyId));
  check("2. family.current mutat pe noul refresh (hex64, != vechiul hash A)", !!famAfter1 && HEX64.test(famAfter1) && famAfter1 !== A.hash);
  check("3. refresh B exista (peekRefreshToken -> found)", (await peekRefreshToken(B)).status === "found");
  const [ttlAcc, ttlRef, ttlFam] = [await seed.ttl(tokenKey(accessA)), await seed.ttl(refreshKey(B)), await seed.ttl(familyKey(familyId))];
  check("4. ⭐ TTL access ~ TOKEN_TTL_SEC (24h, produs de Lua)",   near(ttlAcc, TOKEN_TTL_SEC));
  check("5. ⭐ TTL refresh ~ REFRESH_TTL_SEC (30 zile, produs de Lua)", near(ttlRef, REFRESH_TTL_SEC));
  check("6. ⭐ TTL family ~ REFRESH_TTL_SEC (sliding, produs de Lua)",  near(ttlFam, REFRESH_TTL_SEC));

  // ── 2. ACCESS poartă family_id (#1) + onorat cât familia e activă ────────────
  const vA = await validateToken(accessA);
  check("7. ⭐ access valid + payload.family_id === familyId (access poarta familia)", vA.status === "valid" && vA.payload.family_id === familyId);
  check("8. ⭐ resolveAuth(access) cu familie ACTIVA -> ok", (await resolveAuth("Bearer " + accessA, activeDeps())).ok === true);

  // ── 3. Reuse A -> revocă familia; B -> respins ──────────────────────────────
  const rReuse = await rotateRefreshToken(A.token, mkPayload(familyId, 3), mkPayload(familyId, 3));
  check("9. ⭐⭐ reuse A (superseded) -> reuse_detected", rReuse.status === "reuse_detected");
  check("10. ⭐ family = REVOKED dupa reuse", (await seed.get(familyKey(familyId))) === "REVOKED");
  check("11. ⭐⭐ B (refresh valid anterior) -> revoked (familia moarta il taie)", (await rotateRefreshToken(B, mkPayload(familyId, 4), mkPayload(familyId, 4))).status === "revoked");

  // ── 4. cgpt #1 CORE: access-ul deja emis MOARE la revocare ──────────────────
  const auth2 = await resolveAuth("Bearer " + accessA, activeDeps());
  check("12. ⭐⭐⭐ resolveAuth(ACELASI access) dupa REVOKED -> 401 INVALID_TOKEN (revocare ajunge la access token)",
    auth2.ok === false && auth2.status === 401 && auth2.errorCode === "INVALID_TOKEN");
  check("13. ⭐ getFamilyState(revocata) -> revoked", (await getFamilyState(familyId)) === "revoked");

  // ── 5. Concurență: exact unul rotește, celălalt reuse ───────────────────────
  const c = await seedFamily();
  const [c1, c2] = await Promise.all([
    rotateRefreshToken(c.A.token, mkPayload(c.familyId, 5), mkPayload(c.familyId, 5)),
    rotateRefreshToken(c.A.token, mkPayload(c.familyId, 6), mkPayload(c.familyId, 6)),
  ]);
  check("14. ⭐⭐ 2x rotate(A) concurent -> exact unul rotated, unul reuse_detected (EVAL atomic)",
    [c1.status, c2.status].sort().join(",") === "reuse_detected,rotated");

  // ── 6. FAIL-CLOSED (cgpt #2r): familie ABSENTĂ (expirată) -> inactive -> 401 ─
  const eId = newFamilyId();
  const E = mintRefreshToken(mkPayload(eId, 7));
  await seed.set(E.key, E.value, "EX", 1);
  await seed.set(familyKey(eId), E.hash, "EX", 1);
  created.push(E.key);
  await sleep(1300);
  check("15. ⭐⭐ familie EXPIRATA/absenta -> getFamilyState = inactive (fail-closed, NU active)", (await getFamilyState(eId)) === "inactive");
  const gId = newFamilyId();
  await seed.set(familyKey(gId), "garbage-not-a-hash", "EX", 60); created.push(familyKey(gId));
  check("16. ⭐ family malformata (gunoi, nici hash nici sentinela) -> inactive", (await getFamilyState(gId)) === "inactive");

  // ── 7. resolveAuth: familyState inactive -> 401; unavailable -> retry -> 503 ─
  const authInactive = await resolveAuth("Bearer " + accessA, { ...activeDeps(), familyState: async () => "inactive" as const });
  check("17. ⭐⭐ resolveAuth: familyState inactive -> 401 INVALID_TOKEN (missing family respinsa)", authInactive.status === 401 && authInactive.errorCode === "INVALID_TOKEN");
  let calls = 0;
  const authUnavail = await resolveAuth("Bearer " + accessA, { ...activeDeps(), familyState: async () => { calls++; return "unavailable" as const; } });
  check("18. ⭐⭐ resolveAuth: familyState unavailable x2 -> retry -> 503 AUTH_UNAVAILABLE (2 apeluri, nu 401 fals)",
    authUnavail.status === 503 && authUnavail.errorCode === "AUTH_UNAVAILABLE" && calls === 2);

  // ── 8. FLAP same-instance (cgpt #3r): EVAL EXECUTAT dar RASPUNSUL PIERDUT ────
  // Cazul ambiguu pe ACEEASI instanta: Redis a rulat rotatia (mutatie persistata, EVAL e atomic) dar clientul a
  // primit eroare in loc de raspuns. Il modelam prin STAREA server-side reala: rotate reuseste (familia avanseaza la
  // B); clientul NU primeste B (raspuns pierdut) si RETRIMITE cu tokenul VECHI A. Proprietatea de siguranta dovedita:
  // retry-ul cu A NU produce un al doilea token valid -> reuse_detected + familia REVOCATA; iar B (nereceptionat) e si
  // el mort. Deci "EVAL rulat, raspuns pierdut" nu lasa niciodata doua credentiale valide; cel mult reautentificare.
  const f = await seedFamily();
  const rF = await rotateRefreshToken(f.A.token, mkPayload(f.familyId, 20), mkPayload(f.familyId, 20)); // EVAL executat
  const fB = rF.status === "rotated" ? rF.refreshToken : "";
  check("19. FLAP: rotate (EVAL executat server-side) -> rotated (mutatie persistata, atomica)", rF.status === "rotated");
  const rRetry = await rotateRefreshToken(f.A.token, mkPayload(f.familyId, 21), mkPayload(f.familyId, 21)); // raspuns pierdut -> retry cu A vechi
  check("20. ⭐⭐ FLAP: retry cu tokenul vechi dupa raspuns pierdut -> reuse_detected (NU al doilea token valid)", rRetry.status === "reuse_detected");
  check("21. ⭐⭐ FLAP: familia REVOCATA + noul token (nereceptionat) e si el mort -> zero credential valid ramas",
    (await seed.get(familyKey(f.familyId))) === "REVOKED" &&
    (await rotateRefreshToken(fB, mkPayload(f.familyId, 22), mkPayload(f.familyId, 22))).status === "revoked");

  if (created.length) await seed.del(...created); // cleanup best-effort (chei random, oricum expira prin TTL)
  console.log("\n" + passed + " passed, " + failed + " failed");
  seed.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("THREW:", e); process.exit(2); });
