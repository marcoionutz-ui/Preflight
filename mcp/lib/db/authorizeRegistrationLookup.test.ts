/**
 * lib/db/authorizeRegistrationLookup.test.ts — PH-2 step 10.3b-iv frunză 5 (clasificator lookup /authorize, pur).
 *
 * (a) mapper + clasificator fail-closed pe forma `AuthorizeRegistration` (garanția de formă cerută de nit-ul cgpt);
 * (b) source-guard: `getAuthorizeRegistration` din `ph2Reads.ts` cere EXPLICIT cele 4 coloane extinse (o coloană omisă
 *     din select → mapper-ul o tratează corupt, deci selectul TREBUIE să le enumere).
 */
import { readFileSync } from "node:fs";
import { classifyAuthorizeRegistrationLookup, mapAuthorizeRegistrationRow } from "./authorizeRegistrationLookup";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const ROW = {
  registration_id: "reg1", client_id: "c1", status: "active",
  grant_types: ["authorization_code", "refresh_token"], expires_at: null,
  redirect_uris: ["https://claude.ai/cb", "com.example.app:/cb"],
  client_name: "Claude", client_type: "public", token_endpoint_auth_method: "none",
};

function main(): void {
console.log("PH-2 step 10.3b-iv frunză 5 — authorizeRegistrationLookup (clasificator + mapper, pur)");

// ── discriminare ──────────────────────────────────────────────────────────────────
check("1. ⭐⭐ eroare → unavailable (NU not_found)", classifyAuthorizeRegistrationLookup(null, { message: "down" }).status === "unavailable");
check("2. ⭐⭐ data null → not_found", classifyAuthorizeRegistrationLookup(null, null).status === "not_found");
check("3. ⭐⭐⭐ data undefined → unavailable (NU not_found)", classifyAuthorizeRegistrationLookup(undefined, null).status === "unavailable");

// ── rând valid complet ──────────────────────────────────────────────────────────
{
  const r = classifyAuthorizeRegistrationLookup(ROW, null);
  check("4. ⭐⭐⭐ rând valid → found", r.status === "found");
  if (r.status === "found") {
    const reg = r.registration;
    check("5. ⭐⭐⭐ redirect_uris păstrate exact", JSON.stringify(reg.redirect_uris) === JSON.stringify(ROW.redirect_uris));
    check("6. ⭐⭐ grant_types + status + client_id", JSON.stringify(reg.grant_types) === JSON.stringify(ROW.grant_types) && reg.status === "active" && reg.client_id === "c1");
    check("7. ⭐⭐ metadate UI păstrate", reg.client_name === "Claude" && reg.client_type === "public" && reg.token_endpoint_auth_method === "none");
    check("8. ⭐ expires_at null → null", reg.expires_at === null);
  }
}

// ── expires_at ────────────────────────────────────────────────────────────────────
check("9. ⭐⭐⭐ expires_at ISO → ms", (() => { const r = classifyAuthorizeRegistrationLookup({ ...ROW, expires_at: "2026-08-22T10:00:00.000Z" }, null); return r.status === "found" && r.registration.expires_at === Date.parse("2026-08-22T10:00:00.000Z"); })());
check("10. ⭐⭐⭐ expires_at ISO invalid → unavailable (corupt)", classifyAuthorizeRegistrationLookup({ ...ROW, expires_at: "nope" }, null).status === "unavailable");
check("11. ⭐⭐⭐ expires_at LIPSĂ → unavailable (NU „nu expiră\")", (() => { const { expires_at, ...noExp } = ROW; void expires_at; return classifyAuthorizeRegistrationLookup(noExp, null).status === "unavailable"; })());

// ── redirect_uris fail-closed ─────────────────────────────────────────────────────
check("12. ⭐⭐⭐ redirect_uris LIPSĂ → unavailable (fără allowlist înregistrat)", (() => { const { redirect_uris, ...noR } = ROW; void redirect_uris; return classifyAuthorizeRegistrationLookup(noR, null).status === "unavailable"; })());
check("13. ⭐⭐⭐ redirect_uris ne-array (string) → unavailable", classifyAuthorizeRegistrationLookup({ ...ROW, redirect_uris: "https://claude.ai/cb" }, null).status === "unavailable");
check("14. ⭐⭐ redirect_uris [] (gol) → found (validatorul tratează golul)", (() => { const r = classifyAuthorizeRegistrationLookup({ ...ROW, redirect_uris: [] }, null); return r.status === "found" && r.registration.redirect_uris.length === 0; })());
check("15. ⭐⭐ redirect_uris cu element ne-string → unavailable", classifyAuthorizeRegistrationLookup({ ...ROW, redirect_uris: ["ok", 42] }, null).status === "unavailable");

// ── câmpuri de securitate + metadate lenient ──────────────────────────────────────
check("16. ⭐⭐ grant_types ne-array → unavailable", classifyAuthorizeRegistrationLookup({ ...ROW, grant_types: "authorization_code" }, null).status === "unavailable");
check("17. ⭐ registration_id gol → unavailable", classifyAuthorizeRegistrationLookup({ ...ROW, registration_id: "" }, null).status === "unavailable");
check("18. ⭐⭐ status păstrat string (gate active e în validator)", (() => { const r = classifyAuthorizeRegistrationLookup({ ...ROW, status: "revoked" }, null); return r.status === "found" && r.registration.status === "revoked"; })());
check("19. ⭐⭐ client_name null → null (metadata, NU pică rândul)", (() => { const r = classifyAuthorizeRegistrationLookup({ ...ROW, client_name: null }, null); return r.status === "found" && r.registration.client_name === null; })());
check("20. ⭐⭐ client_name non-string (number) → coerce null, rândul rămâne found", (() => { const r = classifyAuthorizeRegistrationLookup({ ...ROW, client_name: 42 }, null); return r.status === "found" && r.registration.client_name === null; })());
check("21. mapAuthorizeRegistrationRow non-obiect → null", mapAuthorizeRegistrationRow(null) === null && mapAuthorizeRegistrationRow(42) === null);

// ── (b) source-guard: stringul din .select(...) al lui getAuthorizeRegistration enumeră coloanele extinse ──
// cgpt: NU `src.includes(col)` pe tot fișierul (ar prinde numele din comentarii / altă funcție → fals pozitiv).
// Izolăm CORPUL funcției (de la declarația ei până la următorul `export`), extragem stringul EXACT din `.select(...)`,
// și verificăm coloanele ca token-uri EXACTE acolo. Scoaterea unei coloane din select → test roșu.
let src: string | null = null;
try { src = readFileSync("lib/db/ph2Reads.ts", "utf8"); } catch { src = null; }
if (src === null) {
  check("22. (skip — ph2Reads.ts absent în sandbox; source-guard rulează în WSL)", true);
} else {
  const start = src.indexOf("export async function getAuthorizeRegistration");
  const rest  = start === -1 ? "" : src.slice(start + 1);
  const nextExport = rest.indexOf("\nexport ");
  const body  = start === -1 ? "" : (nextExport === -1 ? rest : rest.slice(0, nextExport));
  const sel   = body.match(/\.select\(\s*"([^"]*)"\s*\)/);
  const cols  = sel ? sel[1].split(",").map(s => s.trim()) : [];
  const needed = ["registration_id", "client_id", "status", "grant_types", "expires_at", "redirect_uris", "client_name", "client_type", "token_endpoint_auth_method"];
  const missing = needed.filter(c => !cols.includes(c));
  check("22. ⭐⭐⭐ .select(...) din getAuthorizeRegistration CONȚINE toate coloanele necesare (izolat pe corpul funcției, nu comentarii; extra permise)",
    start !== -1 && sel !== null && missing.length === 0);
  if (start === -1) console.log("     getAuthorizeRegistration negăsit");
  else if (!sel) console.log("     .select(\"...\") negăsit în corpul funcției");
  else if (missing.length > 0) console.log("     lipsă din select: " + missing.join(", "));
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
