/**
 * lib/mcp/canaryFixture.test.ts — PH-12 12.5b-5 (fixtură provisioning idempotent, cu PORT FAKE, pur/hermetic).
 *
 * Acoperă lock-urile Marco: happy path (+ordine cleanup inversă), retry identic (adoptat, manifest gol), coliziune
 * (diferă → fail-closed, fără overwrite), eșec după fiecare pas (manifest parțial + cleanup exact), cleanup nu șterge
 * preexistente (adoptate), builder gated pe izolare, derivare id-uri unice + redirectUri EXACT, provision nu aruncă
 * niciodată, cleanup best-effort, wrapper cu finally.
 */
import {
  provisionGate1Fixture, cleanupGate1Fixture, runWithGate1Fixture, buildFixtureStoreAfterIsolation,
  fixtureEmail, fixtureClientId, entitlementMatches, registrationMatches, DEFAULT_FIXTURE_SCOPES,
  type FixtureStore, type FixtureSpec, type UserCreateOutcome, type UserReadOutcome, type CreateOutcome,
  type EntitlementReadOutcome, type RegistrationReadOutcome, type DeleteOutcome,
  type EntitlementRow, type RegistrationRow, type EntitlementSnapshot, type RegistrationSnapshot,
} from "./canaryFixture";
import { SERVER_SCOPE_CATALOG } from "../oauth/scopeCatalog";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

console.log("PH-12 12.5b-5 — canaryFixture (provisioning idempotent + cleanup, port injectat)");

const RUN_ID   = "run0001abcd";
const REDIRECT = "http://127.0.0.1:8080/callback";
const USER_ID  = "user-uuid-xyz";

function spec(over: Partial<FixtureSpec> = {}): FixtureSpec {
  return { redirectUri: REDIRECT, runId: RUN_ID, ...over };
}

// snapshot-uri care COINCID EXACT cu rândurile intenționate (default-uri)
const MATCHING_ENT: EntitlementSnapshot = {
  plan: "canary", scopes: [...DEFAULT_FIXTURE_SCOPES], rate_limit_per_minute: 60, rate_limit_per_day: 5000, status: "active",
};
const MATCHING_REG: RegistrationSnapshot = {
  client_type: "public", token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"], redirect_uris: [REDIRECT],
  client_name: "Preflight Canary DCR", status: "active",
};

interface Behaviors {
  createUser?: () => Promise<UserCreateOutcome>;
  readUserByEmail?: () => Promise<UserReadOutcome>;
  deleteUser?: () => Promise<DeleteOutcome>;
  createEntitlement?: () => Promise<CreateOutcome>;
  readEntitlement?: () => Promise<EntitlementReadOutcome>;
  deleteEntitlement?: () => Promise<DeleteOutcome>;
  createRegistration?: () => Promise<CreateOutcome>;
  readRegistrationByClientId?: () => Promise<RegistrationReadOutcome>;
  deleteRegistration?: () => Promise<DeleteOutcome>;
}
interface Fake extends FixtureStore { calls: { method: string; arg: unknown }[]; }

function makeFake(b: Behaviors = {}): Fake {
  const calls: { method: string; arg: unknown }[] = [];
  const rec = (m: string, a: unknown) => { calls.push({ method: m, arg: a }); };
  return {
    calls,
    async createUser(arg)                 { rec("createUser", arg);                 return b.createUser ? b.createUser() : { status: "created", userId: USER_ID }; },
    async readUserByEmail(arg)            { rec("readUserByEmail", arg);            return b.readUserByEmail ? b.readUserByEmail() : { status: "not_found" }; },
    async deleteUser(arg)                 { rec("deleteUser", arg);                 return b.deleteUser ? b.deleteUser() : { status: "deleted" }; },
    async createEntitlement(arg)          { rec("createEntitlement", arg);          return b.createEntitlement ? b.createEntitlement() : { status: "created" }; },
    async readEntitlement(arg)            { rec("readEntitlement", arg);            return b.readEntitlement ? b.readEntitlement() : { status: "not_found" }; },
    async deleteEntitlement(arg)          { rec("deleteEntitlement", arg);          return b.deleteEntitlement ? b.deleteEntitlement() : { status: "deleted" }; },
    async createRegistration(arg)         { rec("createRegistration", arg);         return b.createRegistration ? b.createRegistration() : { status: "created" }; },
    async readRegistrationByClientId(arg) { rec("readRegistrationByClientId", arg); return b.readRegistrationByClientId ? b.readRegistrationByClientId() : { status: "not_found" }; },
    async deleteRegistration(arg)         { rec("deleteRegistration", arg);         return b.deleteRegistration ? b.deleteRegistration() : { status: "deleted" }; },
  };
}
const methods = (f: Fake): string[] => f.calls.map(c => c.method);

async function main(): Promise<void> {
  // ── 1. HAPPY PATH: toate create → created; manifest complet; handle corect ──
  {
    const f = makeFake();
    const r = await provisionGate1Fixture(f, spec());
    check("1. ⭐⭐⭐ happy path → ok", r.ok === true);
    if (r.ok) {
      check("2. ⭐⭐⭐ manifest = [user, entitlement, registration] în ordine de creare",
        JSON.stringify(r.manifest) === JSON.stringify([
          { kind: "user", key: USER_ID },
          { kind: "entitlement", key: USER_ID },
          { kind: "registration", key: fixtureClientId(RUN_ID) },
        ]));
      check("3. ⭐⭐ handle: userId/email/clientId/redirectUri/scopes",
        r.handle.userId === USER_ID
        && r.handle.email === fixtureEmail(RUN_ID)
        && r.handle.clientId === fixtureClientId(RUN_ID)
        && r.handle.redirectUri === REDIRECT
        && JSON.stringify(r.handle.scopes) === JSON.stringify([...DEFAULT_FIXTURE_SCOPES]));
    }
    // entitlement row a primit user_id-ul userului creat
    const entCall = f.calls.find(c => c.method === "createEntitlement")!;
    check("4. ⭐⭐ entitlement.user_id == userId creat", (entCall.arg as EntitlementRow).user_id === USER_ID);
    // registration row = DCR public bine format
    const regCall = f.calls.find(c => c.method === "createRegistration")!;
    const reg = regCall.arg as RegistrationRow;
    check("5. ⭐⭐⭐ registration = DCR public {none, [ac,rt], status active}",
      reg.client_type === "public" && reg.token_endpoint_auth_method === "none"
      && JSON.stringify(reg.grant_types) === JSON.stringify(["authorization_code", "refresh_token"])
      && reg.status === "active" && reg.client_id === fixtureClientId(RUN_ID));
  }

  // ── cleanup happy path: ordine INVERSĂ, doar pe chei specifice ──
  {
    const f = makeFake();
    const r = await provisionGate1Fixture(f, spec());
    if (!r.ok) throw new Error("setup");
    f.calls.length = 0;
    const rep = await cleanupGate1Fixture(f, r.manifest);
    check("6. ⭐⭐⭐ cleanup ok, 3 șterse", rep.ok === true && rep.deleted === 3 && rep.errors.length === 0);
    check("7. ⭐⭐⭐ cleanup în ORDINE INVERSĂ: registration → entitlement → user",
      JSON.stringify(methods(f)) === JSON.stringify(["deleteRegistration", "deleteEntitlement", "deleteUser"]));
    check("8. ⭐⭐ delete pe CHEIE specifică (nu broad)",
      f.calls[0].arg === fixtureClientId(RUN_ID) && f.calls[1].arg === USER_ID && f.calls[2].arg === USER_ID);
  }

  // ── 2. RETRY IDENTIC: toate conflict + read coincid EXACT → adoptat; manifest GOL ──
  {
    const f = makeFake({
      createUser: async () => ({ status: "conflict" }),
      readUserByEmail: async () => ({ status: "found", userId: "existing-user", emailConfirmed: true }),
      createEntitlement: async () => ({ status: "conflict" }),
      readEntitlement: async () => ({ status: "found", snapshot: MATCHING_ENT }),
      createRegistration: async () => ({ status: "conflict" }),
      readRegistrationByClientId: async () => ({ status: "found", snapshot: MATCHING_REG }),
    });
    const r = await provisionGate1Fixture(f, spec());
    check("9. ⭐⭐⭐ retry identic → ok (adoptat)", r.ok === true);
    check("10. ⭐⭐⭐ manifest GOL (nimic creat de noi → nimic de șters)", r.ok && r.manifest.length === 0);
    check("11. ⭐⭐ handle.userId = userul EXISTENT adoptat", r.ok && r.handle.userId === "existing-user");
    // cleanup pe manifest gol → nu șterge nimic
    f.calls.length = 0;
    const rep = await cleanupGate1Fixture(f, r.ok ? r.manifest : []);
    check("12. ⭐⭐⭐ cleanup pe adoptate: ZERO delete (nu ștergem preexistente)",
      rep.deleted === 0 && f.calls.length === 0);
  }

  // ── 3. COLIZIUNE (differs) la registration → fail-closed, fără overwrite ──
  {
    const f = makeFake({
      createRegistration: async () => ({ status: "conflict" }),
      readRegistrationByClientId: async () => ({ status: "found", snapshot: { ...MATCHING_REG, redirect_uris: ["http://evil.example/cb"] } }),
    });
    const r = await provisionGate1Fixture(f, spec());
    check("13. ⭐⭐⭐ registration existent DIFERĂ → fail-closed", r.ok === false && !r.ok && r.stage === "registration");
    check("14. ⭐⭐⭐ NU suprascrie: createRegistration o dată, ZERO deleteRegistration în provisioning",
      f.calls.filter(c => c.method === "createRegistration").length === 1
      && f.calls.filter(c => c.method === "deleteRegistration").length === 0);
    check("15. ⭐⭐ manifest = [user, entitlement] (create înainte de coliziune)",
      !r.ok && JSON.stringify(r.manifest) === JSON.stringify([{ kind: "user", key: USER_ID }, { kind: "entitlement", key: USER_ID }]));
  }
  // coliziune user (email există dar NECONFIRMAT) → differs
  {
    const f = makeFake({
      createUser: async () => ({ status: "conflict" }),
      readUserByEmail: async () => ({ status: "found", userId: "u2", emailConfirmed: false }),
    });
    const r = await provisionGate1Fixture(f, spec());
    check("16. ⭐⭐⭐ user existent NECONFIRMAT → fail-closed la stage user, manifest gol",
      r.ok === false && !r.ok && r.stage === "user" && r.manifest.length === 0);
  }
  // coliziune entitlement (differs pe scopes)
  {
    const f = makeFake({
      createEntitlement: async () => ({ status: "conflict" }),
      readEntitlement: async () => ({ status: "found", snapshot: { ...MATCHING_ENT, scopes: ["mcp:read"] } }),
    });
    const r = await provisionGate1Fixture(f, spec());
    check("17. ⭐⭐ entitlement existent diferă → fail-closed stage entitlement, manifest=[user]",
      r.ok === false && !r.ok && r.stage === "entitlement"
      && JSON.stringify(r.manifest) === JSON.stringify([{ kind: "user", key: USER_ID }]));
  }

  // ── 4. EȘEC după fiecare pas (unavailable) → manifest parțial + cleanup exact ──
  {
    const f = makeFake({ createUser: async () => ({ status: "unavailable" }) });
    const r = await provisionGate1Fixture(f, spec());
    check("18. ⭐⭐⭐ eșec la user → stage user, manifest gol", r.ok === false && !r.ok && r.stage === "user" && r.manifest.length === 0);
  }
  {
    const f = makeFake({ createEntitlement: async () => ({ status: "unavailable" }) });
    const r = await provisionGate1Fixture(f, spec());
    check("19. ⭐⭐⭐ eșec la entitlement → stage entitlement, manifest=[user]",
      r.ok === false && !r.ok && r.stage === "entitlement"
      && JSON.stringify(r.manifest) === JSON.stringify([{ kind: "user", key: USER_ID }]));
    const rep = await cleanupGate1Fixture(f, r.ok ? [] : r.manifest);
    check("20. ⭐⭐ cleanup după eșec entitlement șterge DOAR userul", rep.deleted === 1 && methods(f).includes("deleteUser") && !methods(f).includes("deleteEntitlement"));
  }
  {
    const f = makeFake({ createRegistration: async () => ({ status: "unavailable" }) });
    const r = await provisionGate1Fixture(f, spec());
    check("21. ⭐⭐⭐ eșec la registration → stage registration, manifest=[user, entitlement]",
      r.ok === false && !r.ok && r.stage === "registration"
      && JSON.stringify(r.manifest) === JSON.stringify([{ kind: "user", key: USER_ID }, { kind: "entitlement", key: USER_ID }]));
  }

  // ── 5. CLEANUP nu șterge PREEXISTENTE: adopt user+entitlement, create registration ──
  {
    const f = makeFake({
      createUser: async () => ({ status: "conflict" }),
      readUserByEmail: async () => ({ status: "found", userId: "pre-user", emailConfirmed: true }),
      createEntitlement: async () => ({ status: "conflict" }),
      readEntitlement: async () => ({ status: "found", snapshot: MATCHING_ENT }),
      // registration: created (nou)
    });
    const r = await provisionGate1Fixture(f, spec());
    check("22. ⭐⭐⭐ adopt user+entitlement, create registration → manifest = [registration] DOAR",
      r.ok === true && r.ok && JSON.stringify(r.manifest) === JSON.stringify([{ kind: "registration", key: fixtureClientId(RUN_ID) }]));
    f.calls.length = 0;
    const rep = await cleanupGate1Fixture(f, r.ok ? r.manifest : []);
    check("23. ⭐⭐⭐ cleanup șterge DOAR registration, NU userul/entitlementul preexistente",
      rep.deleted === 1 && JSON.stringify(methods(f)) === JSON.stringify(["deleteRegistration"])
      && !methods(f).includes("deleteUser") && !methods(f).includes("deleteEntitlement"));
  }

  // ── 6. builder gated pe IZOLARE ──
  {
    let built = 0; let seenUrl = "";
    const prod = buildFixtureStoreAfterIsolation(
      { mcpBaseUrl: "https://preflight.jackspools.lol", supabaseUrl: "http://127.0.0.1:54321" },
      () => { built++; return {} as FixtureStore; },
    );
    check("24. ⭐⭐⭐ cfg cu host MCP de PROD → ok:false, build NEinvocat", prod.ok === false && built === 0);

    const prodSb = buildFixtureStoreAfterIsolation(
      { mcpBaseUrl: "http://127.0.0.1:8080", supabaseUrl: "https://ipeyogzfgqypfkujraxm.supabase.co" },
      () => { built++; return {} as FixtureStore; },
    );
    check("25. ⭐⭐⭐ cfg cu Supabase de PROD → ok:false, build NEinvocat", prodSb.ok === false && built === 0);

    const clean = buildFixtureStoreAfterIsolation(
      { mcpBaseUrl: "http://127.0.0.1:8080", supabaseUrl: "http://127.0.0.1:54321" },
      (url) => { built++; seenUrl = url; return { sentinel: true } as unknown as FixtureStore; },
    );
    check("26. ⭐⭐⭐ cfg curat → ok, build invocat O DATĂ cu supabaseUrl vetat", clean.ok === true && built === 1 && seenUrl === "http://127.0.0.1:54321");

    // P2 (fix cgpt): build() care aruncă (createClient/env) → poarta NU propagă, întoarce ok:false generic
    let threw = false; let res2: { ok: boolean } = { ok: true };
    try {
      res2 = buildFixtureStoreAfterIsolation(
        { mcpBaseUrl: "http://127.0.0.1:8080", supabaseUrl: "http://127.0.0.1:54321" },
        () => { throw new Error("createClient boom SECRETKEY"); },
      );
    } catch { threw = true; }
    check("26b. ⭐⭐⭐ build() aruncă → ok:false fail-closed, poarta NU propagă excepția", threw === false && res2.ok === false);
  }

  // ── 6b. scopurile fixturii sunt LEGATE de catalogul REAL al serverului (P1 fix cgpt) ──
  {
    check("26c. ⭐⭐⭐ DEFAULT_FIXTURE_SCOPES ⊆ SERVER_SCOPE_CATALOG (nu scope-uri inventate)",
      DEFAULT_FIXTURE_SCOPES.length > 0 && DEFAULT_FIXTURE_SCOPES.every(s => SERVER_SCOPE_CATALOG.includes(s)));
    // scope în afara catalogului → fluxul real l-ar clamp-a la gol → fixtura refuză fail-closed
    const f = makeFake();
    const r = await provisionGate1Fixture(f, spec({ scopes: ["read:basic", "mcp:bogus_not_in_catalog"] }));
    check("26d. ⭐⭐⭐ scope în afara catalogului → fail stage spec, ZERO I/O", r.ok === false && !r.ok && r.stage === "spec" && f.calls.length === 0);
    // un scope catalog valid, ne-default → acceptat
    const f2 = makeFake();
    const r2 = await provisionGate1Fixture(f2, spec({ scopes: ["read:basic"] }));
    check("26e. ⭐⭐ scope catalog valid (read:basic) → ok, entitlement primește EXACT acel scope",
      r2.ok === true && JSON.stringify((f2.calls.find(c => c.method === "createEntitlement")!.arg as EntitlementRow).scopes) === JSON.stringify(["read:basic"]));

    // P1 (fix cgpt): ABSENT (undefined) → default; EXPLICIT GOL ([]) → fail-closed (NU escaladează la toate scope-urile)
    const fUndef = makeFake();
    const rUndef = await provisionGate1Fixture(fUndef, spec({ scopes: undefined }));
    check("26f. ⭐⭐⭐ scopes: undefined → folosește DEFAULT (catalogul complet)",
      rUndef.ok === true && JSON.stringify((fUndef.calls.find(c => c.method === "createEntitlement")!.arg as EntitlementRow).scopes) === JSON.stringify([...DEFAULT_FIXTURE_SCOPES]));

    const fEmpty = makeFake();
    const rEmpty = await provisionGate1Fixture(fEmpty, spec({ scopes: [] }));
    check("26g. ⭐⭐⭐ scopes: [] → fail stage spec, ZERO I/O (nu escaladează la toate)",
      rEmpty.ok === false && !rEmpty.ok && rEmpty.stage === "spec" && fEmpty.calls.length === 0);
  }

  // ── 7. derivare id-uri UNICE per run + redirectUri EXACT preservat ──
  {
    check("27. ⭐⭐ email/clientId diferă între runId-uri diferite",
      fixtureEmail("runAAAAAAAA") !== fixtureEmail("runBBBBBBBB")
      && fixtureClientId("runAAAAAAAA") !== fixtureClientId("runBBBBBBBB"));
    check("28. ⭐ email lowercased + derivat din runId", fixtureEmail("Run12345678") === "canary-run12345678@canary.local");

    const REDIR_Q = "http://127.0.0.1:53219/cb?state=keepme&foo=bar";
    const f = makeFake();
    const r = await provisionGate1Fixture(f, spec({ redirectUri: REDIR_Q }));
    const reg = (f.calls.find(c => c.method === "createRegistration")!.arg as RegistrationRow);
    check("29. ⭐⭐⭐ redirectUri înregistrat BYTE-EXACT (query/path păstrate, fără normalizare)",
      r.ok === true && reg.redirect_uris.length === 1 && reg.redirect_uris[0] === REDIR_Q && (r.ok && r.handle.redirectUri === REDIR_Q));
  }

  // ── 8. provision NU aruncă niciodată (port care aruncă → unavailable fail-closed) ──
  {
    const f = makeFake({ createUser: async () => { throw new Error("ECONNREFUSED SECRETLEAK"); } });
    let threw = false; let stage = "";
    try {
      const r = await provisionGate1Fixture(f, spec());
      if (!r.ok) stage = r.stage;
      check("30. ⭐⭐⭐ port care aruncă → provision întoarce fail-closed (nu propagă)", r.ok === false && stage === "user");
    } catch { threw = true; }
    check("31. ⭐⭐⭐ provision NU a aruncat", threw === false);
  }

  // ── 9. cleanup BEST-EFFORT: o ștergere pică, restul tot se încearcă ──
  {
    const f = makeFake({ deleteRegistration: async () => ({ status: "unavailable" }) });
    const r = await provisionGate1Fixture(f, spec());
    if (!r.ok) throw new Error("setup");
    f.calls.length = 0;
    const rep = await cleanupGate1Fixture(f, r.manifest);
    check("32. ⭐⭐⭐ o ștergere eșuată NU oprește restul (user+entitlement tot șterse)",
      rep.ok === false && rep.deleted === 2 && rep.errors.length === 1 && rep.errors[0].kind === "registration"
      && methods(f).includes("deleteEntitlement") && methods(f).includes("deleteUser"));
  }
  // cleanup: delete care ARUNCĂ → raportat ca "threw", restul continuă
  {
    const f = makeFake({ deleteRegistration: async () => { throw new Error("boom"); } });
    const r = await provisionGate1Fixture(f, spec());
    if (!r.ok) throw new Error("setup");
    f.calls.length = 0;
    const rep = await cleanupGate1Fixture(f, r.manifest);
    check("33. ⭐⭐ delete care aruncă → 'threw' + restul continuă (nu propagă)",
      rep.ok === false && rep.deleted === 2 && rep.errors[0].code === "threw" && methods(f).includes("deleteUser"));
  }
  // cleanup: "not_found" e benign (deja dispărut)
  {
    const f = makeFake({ deleteUser: async () => ({ status: "not_found" }) });
    const r = await provisionGate1Fixture(f, spec());
    if (!r.ok) throw new Error("setup");
    const rep = await cleanupGate1Fixture(f, r.manifest);
    check("34. ⭐⭐ not_found la delete = benign (deja dispărut) → ok, numărat ca șters", rep.ok === true && rep.deleted === 3);
  }

  // ── 10. runWithGate1Fixture: cleanup în FINALLY ──
  {
    const f = makeFake();
    let handleUser = "";
    const res = await runWithGate1Fixture(f, spec(), async (h) => { handleUser = h.userId; return "BODY_OK"; });
    check("35. ⭐⭐⭐ wrapper succes: body primește handle, result întors, cleanup rulat",
      res.ok === true && res.ok && res.result === "BODY_OK" && handleUser === USER_ID && res.cleanup.deleted === 3);
    check("36. ⭐⭐ după success, resursele au fost curățate (delete pt. toate 3)",
      methods(f).filter(m => m.startsWith("delete")).length === 3);
  }
  {
    // body aruncă → cleanup TOT rulează, apoi excepția se re-propagă
    const f = makeFake();
    let threw = false;
    try { await runWithGate1Fixture(f, spec(), async () => { throw new Error("body blew up"); }); }
    catch { threw = true; }
    check("37. ⭐⭐⭐ wrapper: body aruncă → excepția se re-propagă", threw === true);
    check("38. ⭐⭐⭐ ... DAR cleanup a rulat în finally (toate 3 șterse)",
      methods(f).filter(m => m.startsWith("delete")).length === 3);
  }
  {
    // provisioning parțial (eșec la registration) → wrapper face cleanup pe manifest parțial
    const f = makeFake({ createRegistration: async () => ({ status: "unavailable" }) });
    const res = await runWithGate1Fixture(f, spec(), async () => "unreachable");
    check("39. ⭐⭐⭐ wrapper: provisioning parțial → phase provision + cleanup pe manifest parțial",
      res.ok === false && !res.ok && res.phase === "provision" && res.stage === "registration"
      && res.cleanup.deleted === 2 && methods(f).includes("deleteUser") && methods(f).includes("deleteEntitlement"));
  }
  {
    // P2 (fix cgpt): body OK dar cleanup LASĂ reziduu → NU e ok:true (fail-closed pe leak), result rămâne expus
    const f = makeFake({ deleteRegistration: async () => ({ status: "unavailable" }) });
    const res = await runWithGate1Fixture(f, spec(), async () => "BODY_OK");
    check("39b. ⭐⭐⭐ wrapper: body ok dar cleanup a lăsat resurse → ok:false phase cleanup (nu succes tăcut)",
      res.ok === false && !res.ok && res.phase === "cleanup" && res.cleanup.ok === false);
    check("39c. ⭐⭐ ... dar result-ul corpului rămâne expus (corpul a reușit)",
      !res.ok && res.phase === "cleanup" && res.result === "BODY_OK");
  }

  // ── 11. validare spec (fail-closed, stage "spec", ZERO I/O) ──
  {
    for (const [name, s] of [
      ["runId prea scurt",        spec({ runId: "short" })],
      ["runId cu caractere rele", spec({ runId: "bad id!!" })],
      ["redirectUri non-loopback", spec({ redirectUri: "https://example.com/cb" })],
      ["redirectUri cu fragment",  spec({ redirectUri: "http://127.0.0.1:8080/cb#frag" })],
      ["redirectUri cu credențiale", spec({ redirectUri: "http://u:p@127.0.0.1:8080/cb" })],
      ["redirectUri neparsabil",   spec({ redirectUri: "not a url" })],
      ["scopes gol/whitespace",    spec({ scopes: ["mcp:read", "  "] })],
    ] as [string, FixtureSpec][]) {
      const f = makeFake();
      const r = await provisionGate1Fixture(f, s);
      check(`40. ⭐⭐ spec invalid (${name}) → fail stage spec, ZERO I/O`, r.ok === false && !r.ok && r.stage === "spec" && f.calls.length === 0);
    }
  }

  // ── 12. matchers puri (unit) ──
  {
    const ent: EntitlementRow = { user_id: "u", plan: "canary", scopes: ["a", "b"], rate_limit_per_minute: 60, rate_limit_per_day: 5000, status: "active" };
    check("41. ⭐ entitlementMatches: identic → true", entitlementMatches(ent, { plan: "canary", scopes: ["a", "b"], rate_limit_per_minute: 60, rate_limit_per_day: 5000, status: "active" }) === true);
    check("42. ⭐ entitlementMatches: scopes altă ORDINE → false (exact)", entitlementMatches(ent, { plan: "canary", scopes: ["b", "a"], rate_limit_per_minute: 60, rate_limit_per_day: 5000, status: "active" }) === false);
    const reg: RegistrationRow = { client_id: "c", client_type: "public", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], redirect_uris: [REDIRECT], client_name: "N", status: "active" };
    check("43. ⭐ registrationMatches: identic → true", registrationMatches(reg, { client_type: "public", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], redirect_uris: [REDIRECT], client_name: "N", status: "active" }) === true);
    check("44. ⭐⭐ registrationMatches: client_name null vs string → false (fail-closed)", registrationMatches(reg, { client_type: "public", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], redirect_uris: [REDIRECT], client_name: null, status: "active" }) === false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("test crashed:", e); process.exit(1); });
