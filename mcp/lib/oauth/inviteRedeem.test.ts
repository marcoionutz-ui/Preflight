/**
 * lib/oauth/inviteRedeem.test.ts — lotul OAuth staging, §4 (invitații beta: frunza pură).
 */
import {
  INVITE_TOKEN_LENGTH,
  INVITE_COOKIE,
  INVITE_COOKIE_PATH,
  INVITE_COOKIE_MAX_AGE_SEC,
  BETA_ACCESS_DAYS,
  REDEEM_STATUSES,
  buildInviteLink,
  hashInviteToken,
  inviteCookieClearAttrs,
  inviteCookieSetAttrs,
  isValidInviteTtlDays,
  isWellFormedInviteToken,
  isWellFormedTokenHash,
  normalizeInviteBaseUrl,
  normalizeInviteEmail,
  parseRedeemStatus,
  planCallbackInviteRedemption,
  planInviteRedeem,
} from "./inviteRedeem";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const TOKEN = "A".repeat(20) + "b_-" + "9".repeat(20); // 43 caractere base64url
const USER  = { id: "11111111-1111-4111-8111-111111111111", email: "  Ana@Example.COM ", email_confirmed_at: "2026-11-03T12:00:00Z" };

function main(): void {
console.log("OAuth staging §4 — inviteRedeem (pur)");

// ── token ──────────────────────────────────────────────────────────────────────
check("1. ⭐⭐⭐ token 43 caractere base64url → bine-format", TOKEN.length === INVITE_TOKEN_LENGTH && isWellFormedInviteToken(TOKEN));
check("2. ⭐⭐⭐ lungime greșită (42 / 44) → respins", !isWellFormedInviteToken(TOKEN.slice(1)) && !isWellFormedInviteToken(TOKEN + "x"));
check("3. ⭐⭐⭐ charset greșit (+ / = spațiu) → respins",
  !isWellFormedInviteToken(TOKEN.slice(0, 42) + "+") && !isWellFormedInviteToken(TOKEN.slice(0, 42) + "=") && !isWellFormedInviteToken(TOKEN.slice(0, 42) + " "));
check("4. ⭐⭐ non-string / gol → respins", !isWellFormedInviteToken(undefined) && !isWellFormedInviteToken(null) && !isWellFormedInviteToken("") && !isWellFormedInviteToken(42));
check("5. ⭐⭐ forma reală: base64url(32 octeți) are 43 caractere", isWellFormedInviteToken(Buffer.alloc(32, 0xfb).toString("base64url")));

// ── hash ───────────────────────────────────────────────────────────────────────
const h = hashInviteToken(TOKEN);
check("6. ⭐⭐⭐ hash = sha256 hex lowercase 64 (forma cerută de beta_invites_token_hash_chk)", isWellFormedTokenHash(h));
check("7. ⭐⭐ hash determinist + diferă pe token diferit", hashInviteToken(TOKEN) === h && hashInviteToken(TOKEN.slice(0, 42) + "Z") !== h);
check("8. ⭐⭐ vector cunoscut: sha256(\"abc\")", hashInviteToken("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
check("9. ⭐ isWellFormedTokenHash respinge uppercase / 63 / non-hex",
  !isWellFormedTokenHash(h.toUpperCase()) && !isWellFormedTokenHash(h.slice(1)) && !isWellFormedTokenHash("g".repeat(64)));

// ── email ──────────────────────────────────────────────────────────────────────
check("10. ⭐⭐⭐ trim + lowercase", normalizeInviteEmail("  Ana@Example.COM ") === "ana@example.com");
check("11. ⭐⭐⭐ idempotent", normalizeInviteEmail(normalizeInviteEmail("X@Y.ro") ?? "") === "x@y.ro");
check("12. ⭐⭐⭐ gol / doar spații → null", normalizeInviteEmail("") === null && normalizeInviteEmail("   ") === null);
check("13. ⭐⭐⭐ fără @ → null", normalizeInviteEmail("ana.example.com") === null);
check("14. ⭐⭐ @ la margini / dublu → null",
  normalizeInviteEmail("@example.com") === null && normalizeInviteEmail("ana@") === null && normalizeInviteEmail("a@b@c") === null);
check("15. ⭐⭐ whitespace / control intern → null", normalizeInviteEmail("an a@x.ro") === null && normalizeInviteEmail("ana@x\u0000.ro") === null && normalizeInviteEmail("ana@\tx.ro") === null);
check("16. ⭐ non-string → null; > 320 → null", normalizeInviteEmail(undefined) === null && normalizeInviteEmail(5) === null && normalizeInviteEmail("a@" + "b".repeat(320)) === null);

// ── TTL / acces ────────────────────────────────────────────────────────────────
check("17. ⭐⭐ ttl valid 1..30 întreg", isValidInviteTtlDays(1) && isValidInviteTtlDays(7) && isValidInviteTtlDays(30));
check("18. ⭐⭐ ttl invalid (0, 31, 1.5, NaN, \"7\")", !isValidInviteTtlDays(0) && !isValidInviteTtlDays(31) && !isValidInviteTtlDays(1.5) && !isValidInviteTtlDays(Number.NaN) && !isValidInviteTtlDays("7"));
check("19. ⭐⭐⭐ accesul acordat = 14 zile (decizia O2)", BETA_ACCESS_DAYS === 14);

// ── status RPC + plan ──────────────────────────────────────────────────────────
check("20. ⭐⭐⭐ set închis = exact cele 6 statusuri SQL",
  JSON.stringify([...REDEEM_STATUSES]) === JSON.stringify(["redeemed", "not_found", "already_redeemed", "expired", "email_mismatch", "already_entitled"]));
check("21. ⭐⭐⭐ parseRedeemStatus: necunoscut / non-string / majuscule → null",
  parseRedeemStatus("granted") === null && parseRedeemStatus(null) === null && parseRedeemStatus(1) === null && parseRedeemStatus("REDEEMED") === null);
check("22. ⭐⭐ parseRedeemStatus: fiecare status cunoscut trece", REDEEM_STATUSES.every((s) => parseRedeemStatus(s) === s));
check("23. ⭐⭐⭐ redeemed → granted (singurul care dă acces)", planInviteRedeem("redeemed").kind === "granted");
check("24. ⭐⭐⭐ toate celelalte → no_access cu motivul exact", (["not_found", "already_redeemed", "expired", "email_mismatch", "already_entitled", "unavailable"] as const)
  .every((s) => { const o = planInviteRedeem(s); return o.kind === "no_access" && o.reason === s; }));

// ── decizia din callback ───────────────────────────────────────────────────────
const p = planCallbackInviteRedemption({ cookieValue: TOKEN, user: USER });
check("25. ⭐⭐⭐ cookie bun + email confirmat → redeem cu hash, user id și email normalizat",
  p.kind === "redeem" && p.tokenHash === h && p.userId === USER.id && p.emailNormalized === "ana@example.com");
check("26. ⭐⭐⭐ redeem NU poartă tokenul în clar", p.kind === "redeem" && !JSON.stringify(p).includes(TOKEN));
const skip = (cookieValue: string | null | undefined, user: Parameters<typeof planCallbackInviteRedemption>[0]["user"]) => {
  const r = planCallbackInviteRedemption({ cookieValue, user }); return r.kind === "skip" ? r.reason : "redeem";
};
check("27. ⭐⭐ fără cookie (null / undefined / gol) → skip no_cookie", skip(null, USER) === "no_cookie" && skip(undefined, USER) === "no_cookie" && skip("", USER) === "no_cookie");
check("28. ⭐⭐⭐ cookie malformat → skip malformed_cookie (fără hash, fără DB)", skip("x".repeat(10), USER) === "malformed_cookie");
check("29. ⭐⭐⭐ email NECONFIRMAT (lipsă / null / gol) → skip email_unconfirmed",
  skip(TOKEN, { ...USER, email_confirmed_at: undefined }) === "email_unconfirmed" && skip(TOKEN, { ...USER, email_confirmed_at: null }) === "email_unconfirmed"
  && skip(TOKEN, { ...USER, email_confirmed_at: " " }) === "email_unconfirmed");
check("30. ⭐⭐ user lipsă / id gol / id cu spații → skip no_user",
  skip(TOKEN, null) === "no_user" && skip(TOKEN, { ...USER, id: "" }) === "no_user" && skip(TOKEN, { ...USER, id: " u1" }) === "no_user");
check("31. ⭐⭐ email lipsă / invalid → skip no_email", skip(TOKEN, { ...USER, email: undefined }) === "no_email" && skip(TOKEN, { ...USER, email: "nope" }) === "no_email");

// ── cookie ─────────────────────────────────────────────────────────────────────
const set = inviteCookieSetAttrs(true), clr = inviteCookieClearAttrs(true);
check("32. ⭐⭐⭐ cookie: pf_invite, HttpOnly, Lax, Path=/auth/callback, 30 min", INVITE_COOKIE === "pf_invite"
  && set.httpOnly === true && set.sameSite === "lax" && set.path === "/auth/callback" && set.maxAge === 1800 && INVITE_COOKIE_MAX_AGE_SEC === 1800);
check("33. ⭐⭐⭐ ștergerea folosește ACELAȘI path + Max-Age 0", clr.path === INVITE_COOKIE_PATH && clr.maxAge === 0 && clr.httpOnly === true);
check("34. ⭐⭐ secure transmis (prod true / dev false)", inviteCookieSetAttrs(true).secure === true && inviteCookieSetAttrs(false).secure === false);

// ── link ───────────────────────────────────────────────────────────────────────
check("35. ⭐⭐⭐ base-url https → origine", normalizeInviteBaseUrl("https://preflight-staging.up.railway.app") === "https://preflight-staging.up.railway.app"
  && normalizeInviteBaseUrl("https://preflight-staging.up.railway.app/") === "https://preflight-staging.up.railway.app");
check("36. ⭐⭐⭐ base-url http non-loopback / path / query / userinfo → null",
  normalizeInviteBaseUrl("http://example.com") === null && normalizeInviteBaseUrl("https://x.com/app") === null
  && normalizeInviteBaseUrl("https://x.com/?a=1") === null && normalizeInviteBaseUrl("https://u:p@x.com") === null && normalizeInviteBaseUrl("nope") === null);
check("37. ⭐ base-url http loopback (dev) → ok", normalizeInviteBaseUrl("http://localhost:3000") === "http://localhost:3000");
check("38. ⭐⭐⭐ link = <origine>/signup/invite?token=<token>", buildInviteLink("https://s.example", TOKEN) === `https://s.example/signup/invite?token=${TOKEN}`);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
