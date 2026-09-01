/**
 * lib/oauth/consentView.test.ts — PH-2 pas 6 frunză 5c-i (view-model consent, pur).
 *
 * INVARIANTĂ cheie testată: scope-urile afișate = `resolveGrantedScopes(...)` (afișare == acordare). Porți fail-closed
 * oglindite din `decideConsentGrant`: REGISTRATION (poartă partajată `checkRegistrationBinding`, `nowMs` injectat) +
 * cont lipsă/neutilizabil/al altui user + zero scope-uri → error. Un registration invalid/absent NU produce consent.
 */
import {
  buildConsentView, labelForScope, redirectDisplayHost,
} from "./consentView";
import { SERVER_SCOPE_CATALOG } from "./scopeCatalog";
import type { AuthzTransaction } from "./authzTransaction";
import type { AccountEntitlement } from "./entitlement";
import type { AuthorizeRegistration } from "./authorizeRequestValidate";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // 43 base64url canonic
const NOW = 1_500_000; // în fereastra txn (created 1_000_000 → expires 1_600_000)

function txnOf(over: Partial<AuthzTransaction> = {}): AuthzTransaction {
  return {
    txn_id:                "txn_abcdef0123456789",
    csrf_token:            "csrf_ABCDEFGHIJKLMNOP",
    grant_id:              "11111111-1111-4111-8111-111111111111",
    registration_id:       "reg_1",
    client_id:             "client_1",
    redirect_uri:          "https://app.example.com/callback",
    state:                 "st_1",
    resource:              "https://mcp.example.com/api/mcp",
    requested_scopes:      ["read:pair"],
    code_challenge:        CHALLENGE,
    code_challenge_method: "S256",
    session_user_id:       "user_1",
    created_at:            1_000_000,
    expires_at:            1_600_000,
    ...over,
  };
}

function acctOf(over: Partial<AccountEntitlement> = {}): AccountEntitlement {
  return {
    user_id:               "user_1",
    plan:                  "pro",
    scopes:                ["read:all"],
    rate_limit_per_minute: 60,
    rate_limit_per_day:    10_000,
    status:                "active",
    entitlement_version:   1,
    ...over,
  };
}

function regOf(over: Partial<AuthorizeRegistration> = {}): AuthorizeRegistration {
  return {
    registration_id:            "reg_1",
    client_id:                  "client_1",
    status:                     "active",
    grant_types:                ["authorization_code"],
    expires_at:                 null,
    redirect_uris:              ["https://app.example.com/callback"],
    client_name:                "Acme Trading Bot",
    client_type:                "confidential",
    token_endpoint_auth_method: "client_secret_post",
    ...over,
  };
}

/** Helper: buildConsentView cu defaults valide, suprascrise punctual. `nowMs` = NOW dacă nu-i dat. */
function build(over: {
  txn?: AuthzTransaction; registration?: AuthorizeRegistration | null; account?: AccountEntitlement | null;
  serverPolicy?: readonly string[]; nowMs?: number;
} = {}) {
  return buildConsentView({
    txn:          over.txn ?? txnOf(),
    registration: over.registration === undefined ? regOf() : over.registration,
    account:      over.account === undefined ? acctOf() : over.account,
    serverPolicy: over.serverPolicy ?? SERVER_SCOPE_CATALOG,
    nowMs:        over.nowMs ?? NOW,
  });
}

function main(): void {
console.log("PH-2 pas 6 frunză 5c-i — consentView (view-model consent, pur)");

// ── happy path + afișare == acordare ────────────────────────────────────────────
{
  const r = build();
  check("1. ⭐⭐⭐ cont read:all + cere [read:pair] + registration validă → consent", r.kind === "consent");
  if (r.kind === "consent") {
    check("2. ⭐⭐⭐ scope-uri EFECTIVE = [read:pair] (afișare == resolveGrantedScopes)",
      r.view.scopes.length === 1 && r.view.scopes[0].scope === "read:pair");
    check("3. ⭐⭐ scope etichetat (read:pair → 'Pair data')", r.view.scopes[0].label === "Pair data");
    check("4. ⭐⭐ clientName din registration.client_name", r.view.clientName === "Acme Trading Bot");
    check("5. ⭐⭐ clientId din txn", r.view.clientId === "client_1");
    check("6. ⭐⭐⭐ redirectHost = host din redirect_uri", r.view.redirectHost === "app.example.com");
    check("7. ⭐⭐⭐ txnId + csrfToken duse în view (pt. hidden fields)",
      r.view.txnId === "txn_abcdef0123456789" && r.view.csrfToken === "csrf_ABCDEFGHIJKLMNOP");
  }
}

// ── read:all acoperă mai multe granulare (semantica wildcard pe entitlement) ──────
check("8. ⭐⭐⭐ cont read:all + cere [read:pair, read:market] → AMBELE", (() => {
  const r = build({ txn: txnOf({ requested_scopes: ["read:pair", "read:market"] }), account: acctOf({ scopes: ["read:all"] }) });
  return r.kind === "consent" && r.view.scopes.map(s => s.scope).join(",") === "read:pair,read:market";
})());

// ── requested gol → baza = scope-urile contului ∩ policy ─────────────────────────
check("9. ⭐⭐ requested gol → baza = scopes cont (∩ policy)", (() => {
  const r = build({ txn: txnOf({ requested_scopes: [] }), account: acctOf({ scopes: ["read:pair", "read:market"] }) });
  return r.kind === "consent" && r.view.scopes.map(s => s.scope).sort().join(",") === "read:market,read:pair";
})());

// ── REGISTRATION: poartă obligatorie (fix cgpt — testul vechi 10 fixa comportamentul GREȘIT) ──
check("10. ⭐⭐⭐ registration null → error (NU consent; POST ar respinge)", build({ registration: null }).kind === "error");
check("10a. ⭐⭐⭐ registration_id ≠ cel din txn → error (altă registration a aceluiași client)",
  build({ registration: regOf({ registration_id: "reg_OTHER" }) }).kind === "error");
check("10b. ⭐⭐⭐ client_id registration ≠ txn → error (NU afișa client_name înșelător al altui client)",
  build({ registration: regOf({ client_id: "client_OTHER" }) }).kind === "error");
check("10c. ⭐⭐⭐ status suspended → error", build({ registration: regOf({ status: "suspended" }) }).kind === "error");
check("10d. ⭐⭐⭐ status revoked → error", build({ registration: regOf({ status: "revoked" }) }).kind === "error");
check("10e. ⭐⭐⭐ fără authorization_code în grant_types → error",
  build({ registration: regOf({ grant_types: ["refresh_token"] }) }).kind === "error");
check("10f. ⭐⭐⭐ expirată (expires_at < nowMs) → error",
  build({ registration: regOf({ expires_at: NOW - 1 }) }).kind === "error");
check("10g. ⭐⭐⭐ expires_at EXACT === nowMs → error (strict în viitor, nu ≥)",
  build({ registration: regOf({ expires_at: NOW }) }).kind === "error");
check("10h. ⭐⭐⭐ expires_at în viitor (> nowMs) → consent",
  build({ registration: regOf({ expires_at: NOW + 1 }) }).kind === "consent");
check("10i. ⭐⭐ expires_at null (nu expiră) → consent",
  build({ registration: regOf({ expires_at: null }) }).kind === "consent");

// ── clientName fallback (DOAR pe registration VALIDĂ cu nume lipsă/gol) ───────────
check("11. ⭐⭐⭐ registration validă cu client_name gol → fallback pe client_id", (() => {
  const r = build({ registration: regOf({ client_name: "" }) });
  return r.kind === "consent" && r.view.clientName === "client_1";
})());
check("12. ⭐⭐ registration validă cu client_name whitespace → fallback pe client_id (trim)", (() => {
  const r = build({ registration: regOf({ client_name: "   " }) });
  return r.kind === "consent" && r.view.clientName === "client_1";
})());
check("12b. ⭐ registration validă cu client_name null → fallback pe client_id", (() => {
  const r = build({ registration: regOf({ client_name: null }) });
  return r.kind === "consent" && r.view.clientName === "client_1";
})());
check("12c. ⭐ client_name cu spații → trimmed", (() => {
  const r = build({ registration: regOf({ client_name: "  Bot X  " }) });
  return r.kind === "consent" && r.view.clientName === "Bot X";
})());

// ── porți CONT (oglindesc decideConsentGrant) ────────────────────────────────────
check("13. ⭐⭐⭐ cont null → error (POST ar da 'contul nu are entitlement')", build({ account: null }).kind === "error");
check("14. ⭐⭐⭐ cont suspended → error (isAccountUsable false)", build({ account: acctOf({ status: "suspended" }) }).kind === "error");
check("14b. ⭐⭐ cont revoked → error", build({ account: acctOf({ status: "revoked" }) }).kind === "error");
check("15. ⭐⭐⭐ cont fără scopes → error", build({ account: acctOf({ scopes: [] }) }).kind === "error");
check("16. ⭐⭐⭐ cont pentru alt user decât txn → error (mismatch)",
  build({ txn: txnOf({ session_user_id: "user_2" }), account: acctOf({ user_id: "user_1" }) }).kind === "error");

// ── scope-uri efective goale → error (afișare == acordare) ───────────────────────
check("17. ⭐⭐⭐ scope cerut necoperit de cont → intersecție goală → error", (() => {
  return build({ txn: txnOf({ requested_scopes: ["read:positions"] }), account: acctOf({ scopes: ["read:pair"] }) }).kind === "error";
})());
check("18. ⭐⭐⭐ scope în afara catalogului (read:ghost) → exclus → error (read:all NU acoperă în policy)", (() => {
  return build({ txn: txnOf({ requested_scopes: ["read:ghost"] }), account: acctOf({ scopes: ["read:all"] }) }).kind === "error";
})());
check("19. ⭐⭐ redirect_uri neparsabil → error (nu afișăm gunoi)",
  build({ txn: txnOf({ redirect_uri: "not a url" }) }).kind === "error");

// ── redirectDisplayHost (unit direct) ────────────────────────────────────────────
check("20. ⭐⭐ https → host", redirectDisplayHost("https://app.example.com/cb") === "app.example.com");
check("21. ⭐⭐⭐ loopback cu port → host:port", redirectDisplayHost("http://127.0.0.1:8080/cb") === "127.0.0.1:8080");
check("22. ⭐⭐ localhost cu port → host:port", redirectDisplayHost("http://localhost:3000/cb") === "localhost:3000");
check("23. ⭐⭐⭐ custom scheme nativ (fără host) → schema", redirectDisplayHost("com.example.app:/callback") === "com.example.app");
check("24. ⭐⭐ neparsabil → null", redirectDisplayHost("nonsense") === null);
check("25. ⭐ gol → null", redirectDisplayHost("") === null);

// ── labelForScope ────────────────────────────────────────────────────────────────
check("26. ⭐⭐ toate cele 8 scope-uri din catalog au etichetă ne-goală",
  SERVER_SCOPE_CATALOG.every((s) => typeof labelForScope(s) === "string" && labelForScope(s).length > 0));
check("27. ⭐⭐⭐ scope necunoscut → scope-ul însuși (nu ascundem ce se acordă)", labelForScope("read:mystery") === "read:mystery");
check("28. ⭐ etichete concrete", labelForScope("read:safety") === "Safety checks" && labelForScope("read:all") === "Full read access");

// ── view scope order stabil ──────────────────────────────────────────────────────
check("29. ⭐⭐ ordinea scope-urilor = ordinea din resolveGrantedScopes (stabilă)", (() => {
  const r = build({ txn: txnOf({ requested_scopes: ["read:market", "read:pair", "read:safety"] }), account: acctOf({ scopes: ["read:all"] }) });
  return r.kind === "consent" && r.view.scopes.map(s => s.scope).join(",") === "read:market,read:pair,read:safety";
})());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
