/**
 * lib/mcp/canaryRedisCleanup.test.ts — PH-12 12.5b-5a (cleanup Redis țintit + dovadă post-delete, hermetic).
 *
 * Fake al portului `CanaryRedisPort` pe un `Map` (+ injectare de unavailable/throw/reziduu). Cheile seed-uite sunt
 * construite cu un builder LOCAL hardcodat (`mcp:token:<sha256>` etc.) — INDEPENDENT de `oauthStorageKeys` — ca ștergerea
 * să dovedească faptul că cleanup-ul țintește EXACT formatul real de stocare. Dovada post-delete e ACUM în orchestrator
 * (lock cgpt): unavailable la GET-ul de dovadă ≠ absent; familiile verificate == familiile șterse; token valid fără
 * family_id → roșu.
 */

import { createHash } from "crypto";
import {
  makeKeyLedger,
  runCanaryRedisCleanup,
  type CanaryRedisPort,
  type RedisGetOutcome,
  type RedisDelOutcome,
  type CanaryKeyMaterial,
  type RedisCleanupReport,
} from "./canaryRedisCleanup";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

// ── builder LOCAL de chei (hardcodat, independent de sursa unică) ──
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const K = {
  access:  (t: string) => `mcp:token:${sha(t)}`,
  refresh: (t: string) => `mcp:refresh:${sha(t)}`,
  family:  (f: string) => `mcp:refresh_family:${f}`,
  code:    (c: string) => `mcp:code:${c}`,
};

// ── payload-uri ──
function userTokenJSON(familyId: string): string {
  return JSON.stringify({
    subject_kind: "user", user_id: "u1", grant_id: "g1", entitlement_version: 1,
    client_id: "canary-dcr-x", scopes: ["read:basic"], issued_at: 1_700_000_000,
    audience: "http://127.0.0.1:8080/api/mcp", family_id: familyId,
  });
}
function userRefreshJSON(familyId: string): string {
  return JSON.stringify({
    subject_kind: "user", client_id: "canary-dcr-x", user_id: "u1", grant_id: "g1",
    entitlement_version: 1, scopes: ["read:basic"], audience: "http://127.0.0.1:8080/api/mcp",
    issued_at: 1_700_000_000, family_id: familyId,
  });
}
// Token VALID dar client-shaped → parse valid, tokenFamilyId=undefined (M2M nu are familie).
function clientTokenJSON(): string {
  return JSON.stringify({
    subject_kind: "client", client_id: "c1", scopes: ["read:basic"], issued_at: 1_700_000_000,
    credential_version: "v1", audience: "http://127.0.0.1:8080/api/mcp",
  });
}
// Token user FĂRĂ family_id → NU trece guard-ul de formă → parse invalid (corupt).
function userTokenNoFamilyJSON(): string {
  return JSON.stringify({
    subject_kind: "user", user_id: "u1", grant_id: "g1", entitlement_version: 1,
    client_id: "canary-dcr-x", scopes: ["read:basic"], issued_at: 1_700_000_000,
    audience: "http://127.0.0.1:8080/api/mcp", // fără family_id
  });
}

// ── fake port ──
interface FakeOpts {
  getUnavailable?:   Set<string>; // GET → unavailable ÎNTOTDEAUNA (eșec la pre-resolve)
  proofUnavailable?: Set<string>; // GET → unavailable DOAR după ce cheia a fost ștearsă (eșec la dovadă)
  delUnavailable?:   Set<string>; // DEL → unavailable
  delNoop?:          Set<string>; // DEL → "deleted" DAR nu șterge (simulează reziduu)
  throwGet?:         Set<string>;
  throwDel?:         Set<string>;
}
function makeFakePort(store: Map<string, string>, opts: FakeOpts = {}) {
  const gotKeys: string[] = [];
  const delKeys: string[] = [];
  const port: CanaryRedisPort = {
    async get(key: string): Promise<RedisGetOutcome> {
      gotKeys.push(key);
      if (opts.throwGet?.has(key)) throw new Error("boom-get");
      if (opts.getUnavailable?.has(key)) return { status: "unavailable" };
      if (opts.proofUnavailable?.has(key) && !store.has(key)) return { status: "unavailable" };
      const v = store.get(key);
      return v === undefined ? { status: "not_found" } : { status: "found", value: v };
    },
    async del(key: string): Promise<RedisDelOutcome> {
      delKeys.push(key);
      if (opts.throwDel?.has(key)) throw new Error("boom-del");
      if (opts.delUnavailable?.has(key)) return { status: "unavailable" };
      if (opts.delNoop?.has(key)) return { status: "deleted" }; // raportează șters DAR păstrează cheia (reziduu)
      const had = store.delete(key);
      return had ? { status: "deleted" } : { status: "not_found" };
    },
  };
  return { port, gotKeys, delKeys };
}

async function main(): Promise<void> {
  console.log("PH-12 12.5b-5a — cleanup Redis țintit + dovadă post-delete (hermetic)");

  const AT1 = "a".repeat(64), AT2 = "b".repeat(64);
  const RT1 = "c".repeat(64), RT2 = "d".repeat(64);
  const CODE = "e".repeat(64);
  const FAM = "fam-single";

  // ── 1. HAPPY PATH: tot prezent, o familie, codul deja consumat (absent) ──
  {
    const store = new Map<string, string>([
      [K.access(AT1), userTokenJSON(FAM)],
      [K.access(AT2), userTokenJSON(FAM)],
      [K.refresh(RT1), userRefreshJSON(FAM)],
      [K.refresh(RT2), userRefreshJSON(FAM)],
      [K.family(FAM), sha(RT2)],
    ]);
    const { port, delKeys } = makeFakePort(store);
    const material: CanaryKeyMaterial = { accessTokens: [AT1, AT2], refreshTokens: [RT1, RT2], authCodes: [CODE] };
    const rep = await runCanaryRedisCleanup(port, material);

    check("1a. happy: raport ok", rep.ok === true);
    check("1b. happy: zero erori, zero reziduu, zero proof-unavailable", rep.errors.length === 0 && rep.stillPresent.length === 0 && rep.proofUnavailable.length === 0);
    check("1c. happy: o singură familie", rep.familyIdsSeen === 1 && rep.invariantBroken === false);
    check("1d. happy: toate cheile de credențial șterse din store", ![K.access(AT1), K.access(AT2), K.refresh(RT1), K.refresh(RT2), K.family(FAM)].some(k => store.has(k)));
    check("1e. happy: deleted numără doar cheile prezente (5)", rep.deleted === 5);
    check("1f. happy: a încercat DEL pe cheia de cod + familie (format oficial)", delKeys.includes(K.code(CODE)) && delKeys.includes(K.family(FAM)));
  }

  // ── 2. FAMILY din access ȘI refresh, aceeași valoare → o singură familie ──
  {
    const store = new Map<string, string>([
      [K.access(AT1), userTokenJSON(FAM)],
      [K.refresh(RT1), userRefreshJSON(FAM)],
      [K.family(FAM), sha(RT1)],
    ]);
    const { port } = makeFakePort(store);
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [AT1], refreshTokens: [RT1], authCodes: [] });
    check("2. family din access+refresh (aceeași) → 1 familie, ok, familie ștearsă", rep.ok && rep.familyIdsSeen === 1 && !store.has(K.family(FAM)));
  }

  // ── 3. REZILIENȚĂ: access token lipsă (not_found), family rezolvată din refresh ──
  {
    const store = new Map<string, string>([
      [K.refresh(RT1), userRefreshJSON(FAM)],
      [K.family(FAM), sha(RT1)],
    ]);
    const { port } = makeFakePort(store);
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [AT1], refreshTokens: [RT1], authCodes: [] });
    check("3. reziliență: family din refresh când access lipsește → familie ștearsă, ok", rep.ok && rep.familyIdsSeen === 1 && !store.has(K.family(FAM)));
  }

  // ── 4. COD prezent (run eșuat înainte de exchange) → șters ──
  {
    const store = new Map<string, string>([[K.code(CODE), "seed-payload"]]);
    const { port } = makeFakePort(store);
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [], refreshTokens: [], authCodes: [CODE] });
    check("4. cod rămas → șters, ok, deleted=1", rep.ok && rep.deleted === 1 && !store.has(K.code(CODE)));
  }

  // ── 5. PAYLOAD ACCESS CORUPT → corrupt_payload, roșu, cheile tot șterse ──
  {
    const store = new Map<string, string>([
      [K.access(AT1), "{not valid json"],
      [K.family(FAM), sha(RT1)],
    ]);
    const { port } = makeFakePort(store);
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [AT1], refreshTokens: [], authCodes: [] });
    check("5a. access corupt → ok=false + eroare corrupt_payload", rep.ok === false && rep.errors.some(e => e.target === "access" && e.code === "corrupt_payload"));
    check("5b. access corupt → cheia de access tot ștearsă (best-effort)", !store.has(K.access(AT1)));
  }

  // ── 6. PAYLOAD REFRESH CORUPT → corrupt_payload, roșu ──
  {
    const store = new Map<string, string>([[K.refresh(RT1), "42"]]);
    const { port } = makeFakePort(store);
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [], refreshTokens: [RT1], authCodes: [] });
    check("6. refresh corupt → ok=false + corrupt_payload", rep.ok === false && rep.errors.some(e => e.target === "refresh" && e.code === "corrupt_payload"));
  }

  // ── 7. GET UNAVAILABLE la pre-resolve → roșu ──
  {
    const store = new Map<string, string>([[K.access(AT1), userTokenJSON(FAM)]]);
    const { port } = makeFakePort(store, { getUnavailable: new Set([K.access(AT1)]) });
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [AT1], refreshTokens: [], authCodes: [] });
    check("7. GET unavailable → ok=false + eroare unavailable pe access", rep.ok === false && rep.errors.some(e => e.target === "access" && e.code === "unavailable"));
  }

  // ── 8. DEL UNAVAILABLE → roșu ──
  {
    const store = new Map<string, string>([[K.code(CODE), "x"]]);
    const { port } = makeFakePort(store, { delUnavailable: new Set([K.code(CODE)]) });
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [], refreshTokens: [], authCodes: [CODE] });
    check("8. DEL unavailable → ok=false + eroare unavailable pe code", rep.ok === false && rep.errors.some(e => e.target === "code" && e.code === "unavailable"));
  }

  // ── 8b. GET/DEL care ARUNCĂ → tratate ca unavailable (fail-closed) ──
  {
    const store = new Map<string, string>([[K.access(AT1), userTokenJSON(FAM)]]);
    const { port } = makeFakePort(store, { throwGet: new Set([K.access(AT1)]), throwDel: new Set([K.access(AT1)]) });
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [AT1], refreshTokens: [], authCodes: [] });
    check("8b. throw pe get+del → ok=false, nu aruncă", rep.ok === false);
  }

  // ── 9. INVARIANTĂ RUPTĂ: 2 familii → roșu, AMBELE șterse best-effort ──
  {
    const FA = "fam-A", FB = "fam-B";
    const store = new Map<string, string>([
      [K.access(AT1), userTokenJSON(FA)],
      [K.refresh(RT1), userRefreshJSON(FB)],
      [K.family(FA), sha(RT1)],
      [K.family(FB), sha(RT2)],
    ]);
    const { port } = makeFakePort(store);
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [AT1], refreshTokens: [RT1], authCodes: [] });
    check("9a. 2 familii → invariantBroken + ok=false", rep.invariantBroken === true && rep.ok === false && rep.familyIdsSeen === 2);
    check("9b. 2 familii → AMBELE șterse best-effort", !store.has(K.family(FA)) && !store.has(K.family(FB)));
  }

  // ── 10. MATERIAL GOL → ok, nimic șters ──
  {
    const { port } = makeFakePort(new Map());
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [], refreshTokens: [], authCodes: [] });
    check("10. material gol → ok, deleted=0", rep.ok && rep.deleted === 0 && rep.familyIdsSeen === 0);
  }

  // ── 11. LEDGER: dedup + ignoră gol ──
  {
    const led = makeKeyLedger();
    led.recordAccessToken(AT1); led.recordAccessToken(AT1); led.recordAccessToken("");
    led.recordRefreshToken(RT1); led.recordAuthCode(CODE); led.recordAuthCode(CODE);
    check("11. ledger dedup + ignoră gol", led.accessTokens.length === 1 && led.refreshTokens.length === 1 && led.authCodes.length === 1);
  }

  // ── 12. ANTI-LEAK: raportul NU conține niciun secret ──
  {
    const store = new Map<string, string>([
      [K.access(AT1), userTokenJSON(FAM)],
      [K.refresh(RT1), userRefreshJSON(FAM)],
      [K.family(FAM), sha(RT1)],
    ]);
    const { port } = makeFakePort(store);
    const rep: RedisCleanupReport = await runCanaryRedisCleanup(port, { accessTokens: [AT1], refreshTokens: [RT1], authCodes: [CODE] });
    const blob = JSON.stringify(rep);
    const leaks = [AT1, RT1, CODE, FAM, sha(AT1), sha(RT1)];
    check("12. anti-leak: niciun token/hash/cod/family_id în raport", !leaks.some(s => blob.includes(s)));
  }

  // ── 13. NICIO ALTĂ CHEIE atinsă (doar cele derivate din material) ──
  {
    const store = new Map<string, string>([
      [K.access(AT1), userTokenJSON(FAM)],
      [K.family(FAM), sha(RT1)],
      ["mcp:rl:acct:u1", "should-not-touch"],
      ["mcp:quota:acct:u1:2026-09", "should-not-touch"],
    ]);
    const { port, delKeys, gotKeys } = makeFakePort(store);
    await runCanaryRedisCleanup(port, { accessTokens: [AT1], refreshTokens: [], authCodes: [CODE] });
    const allowed = new Set([K.access(AT1), K.family(FAM), K.code(CODE)]);
    const touched = [...delKeys, ...gotKeys];
    check("13a. nu atinge chei de rate/quota", store.has("mcp:rl:acct:u1") && store.has("mcp:quota:acct:u1:2026-09"));
    check("13b. toate cheile atinse sunt derivate din material (fără scan/broad)", touched.every(k => allowed.has(k)));
  }

  // ── 14 (cgpt): DEL reușește DAR GET-ul de dovadă întoarce unavailable → roșu (proofUnavailable) ──
  {
    const store = new Map<string, string>([
      [K.access(AT1), userTokenJSON(FAM)],
      [K.family(FAM), sha(RT1)],
    ]);
    // DEL șterge normal; dar GET-ul de DUPĂ ștergere pe cheia de access întoarce unavailable
    const { port } = makeFakePort(store, { proofUnavailable: new Set([K.access(AT1)]) });
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [AT1], refreshTokens: [], authCodes: [] });
    check("14a. DEL ok dar dovadă unavailable → ok=false", rep.ok === false);
    check("14b. proofUnavailable conține 'access' (unavailable ≠ absent)", rep.proofUnavailable.includes("access"));
    check("14c. cheia chiar e ștearsă (DEL a reușit) — dar dovada nu poate confirma", !store.has(K.access(AT1)));
  }

  // ── 15 (cgpt): token VALID fără family_id (client-shaped) → roșu; user fără family_id → roșu ──
  {
    const store = new Map<string, string>([[K.access(AT1), clientTokenJSON()]]);
    const { port } = makeFakePort(store);
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [AT1], refreshTokens: [], authCodes: [] });
    check("15a. token client-shaped (fără familie) → ok=false + unexpected_payload", rep.ok === false && rep.errors.some(e => e.target === "access" && e.code === "unexpected_payload"));
    check("15b. token client-shaped → nicio familie revendicată", rep.familyIdsSeen === 0);

    const store2 = new Map<string, string>([[K.access(AT1), userTokenNoFamilyJSON()]]);
    const { port: p2 } = makeFakePort(store2);
    const rep2 = await runCanaryRedisCleanup(p2, { accessTokens: [AT1], refreshTokens: [], authCodes: [] });
    check("15c. user fără family_id (formă invalidă) → ok=false (corrupt_payload)", rep2.ok === false && rep2.errors.some(e => e.target === "access" && e.code === "corrupt_payload"));
  }

  // ── 16 (cgpt): payload corupt → familia NU e pretinsă verificată ──
  {
    const store = new Map<string, string>([
      [K.access(AT1), "not-json"],
      [K.family(FAM), sha(RT1)], // familie prezentă, DAR nerezolvabilă din payload-ul corupt
    ]);
    const { port, delKeys } = makeFakePort(store);
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [AT1], refreshTokens: [], authCodes: [] });
    check("16a. corupt → 0 familii rezolvate, ok=false", rep.familyIdsSeen === 0 && rep.ok === false);
    check("16b. corupt → familia NU e țintită (nu revendicăm ștergere/dovadă pe o familie nerezolvată)", !delKeys.includes(K.family(FAM)) && rep.stillPresent.length === 0 && rep.proofUnavailable.length === 0);
  }

  // ── 17 (cgpt): rulare de DOUĂ ori pe același ledger → a doua rămâne verde, șterge zero ──
  {
    const store = new Map<string, string>([
      [K.access(AT1), userTokenJSON(FAM)],
      [K.refresh(RT1), userRefreshJSON(FAM)],
      [K.family(FAM), sha(RT1)],
    ]);
    const material: CanaryKeyMaterial = { accessTokens: [AT1], refreshTokens: [RT1], authCodes: [CODE] };
    const { port } = makeFakePort(store);
    const first  = await runCanaryRedisCleanup(port, material);
    const second = await runCanaryRedisCleanup(port, material);
    check("17a. prima rulare → ok, șterge (deleted>0)", first.ok && first.deleted > 0);
    check("17b. a doua rulare → tot ok, șterge zero (idempotent)", second.ok && second.deleted === 0 && second.familyIdsSeen === 0);
  }

  // ── 18. REZIDUU: DEL raportează șters dar cheia rămâne → stillPresent → roșu ──
  {
    const store = new Map<string, string>([[K.code(CODE), "x"]]);
    const { port } = makeFakePort(store, { delNoop: new Set([K.code(CODE)]) });
    const rep = await runCanaryRedisCleanup(port, { accessTokens: [], refreshTokens: [], authCodes: [CODE] });
    check("18. reziduu (cheie prezentă post-delete) → ok=false + stillPresent 'code'", rep.ok === false && rep.stillPresent.includes("code"));
  }

  // ── 19 (cgpt DECISIV): failure→retry NU pierde familia. Run 1: family DEL unavailable (tokenurile se șterg, familia ──
  // rămâne) → roșu. Run 2 pe ACELAȘI ledger: familia e în resolvedFamilyIds → se șterge, deși tokenurile-s duse → verde.
  {
    const ledger = makeKeyLedger();
    ledger.recordAccessToken(AT1); ledger.recordRefreshToken(RT1); ledger.recordAuthCode(CODE);
    const store = new Map<string, string>([
      [K.access(AT1), userTokenJSON(FAM)],
      [K.refresh(RT1), userRefreshJSON(FAM)],
      [K.family(FAM), sha(RT1)],
    ]);
    // Run 1: DEL pe cheia de familie → unavailable (familia rămâne); AT/RT se șterg normal.
    const { port: p1 } = makeFakePort(store, { delUnavailable: new Set([K.family(FAM)]) });
    const r1 = await runCanaryRedisCleanup(p1, ledger, ledger.recordFamilyId);
    check("19a. run1: family DEL unavailable → ok=false", r1.ok === false);
    check("19b. run1: tokenurile șterse DAR familia rămâne (reziduu)", !store.has(K.access(AT1)) && !store.has(K.refresh(RT1)) && store.has(K.family(FAM)));
    check("19c. run1: familia e persistată în ledger (resolvedFamilyIds)", ledger.resolvedFamilyIds.includes(FAM));

    // Run 2: ACELAȘI ledger (tokenurile-s duse — nerezolvabile din payload), dar familia vine din seed. DEL merge acum.
    const { port: p2 } = makeFakePort(store);
    const r2 = await runCanaryRedisCleanup(p2, ledger, ledger.recordFamilyId);
    check("19d. run2: seed din resolvedFamilyIds → familia ștearsă chiar dacă tokenurile-s duse", !store.has(K.family(FAM)));
    check("19e. run2: verde (retry a recuperat familia orfană)", r2.ok === true && r2.familyIdsSeen === 1);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
