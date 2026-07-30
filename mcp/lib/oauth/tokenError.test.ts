/**
 * lib/oauth/tokenError.test.ts — E5 (token endpoint nu scurge detalii interne în error_description).
 *
 * Catch-ul din `token/route.ts` deleagă la `sanitizeTokenError(err, console.error)`. Testăm că, indiferent de
 * eroare: body-ul clientului e generic (nu conține mesajul intern), status 500, cod `server_error`, iar eroarea
 * REALĂ ajunge totuși în logger. Leaf pur → rulează standalone în tsx (fără ruta Next import-grea).
 */
import { sanitizeTokenError, GENERIC_SERVER_ERROR_DESCRIPTION } from "./tokenError";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const SENTINEL = "redis://user:s3cr3t@internal-host:6379/0 ECONNREFUSED at query X";

function main(): void {
console.log("E5 — sanitizeTokenError (mesaj generic la client, eroarea reală doar în log)");

// Logger fals care captează ce s-a logat.
const logged: Array<{ msg: string; err: unknown }> = [];
const fakeLog = (msg: string, err: unknown) => { logged.push({ msg, err }); };

// 1+2+3+4+5: eroare Error cu mesaj-sentinel.
const realErr = new Error(SENTINEL);
const out = sanitizeTokenError(realErr, fakeLog);
const bodyStr = JSON.stringify({ error: out.error, error_description: out.error_description });

check("1. ⭐ mesajul-sentinel NU apare în body (nici error nici error_description)", !bodyStr.includes(SENTINEL) && !bodyStr.includes("s3cr3t") && !bodyStr.includes("internal-host"));
check("2. status === 500", out.status === 500);
check("3. error === 'server_error'", out.error === "server_error");
check("4. error_description === mesajul generic", out.error_description === GENERIC_SERVER_ERROR_DESCRIPTION);
check("5. ⭐ eroarea ORIGINALĂ e logată (obiectul Error exact)", logged.length === 1 && logged[0].err === realErr);
check("5b. logul conține mesajul-sentinel (server-side, e OK acolo)", (logged[0].err as Error).message === SENTINEL);

// 6: eroare non-Error (string, obiect) — nu trebuie reflectată nici ea.
logged.length = 0;
const strErr = "leak-me: DB_PASSWORD=hunter2";
const outStr = sanitizeTokenError(strErr, fakeLog);
const bodyStr2 = JSON.stringify(outStr);
check("6. ⭐ err non-Error (string) → body tot generic, nu-l reflectă", !bodyStr2.includes("hunter2") && !bodyStr2.includes("leak-me") && outStr.error_description === GENERIC_SERVER_ERROR_DESCRIPTION);
check("6b. err non-Error tot logat (obiectul brut)", logged.length === 1 && logged[0].err === strErr);

const outObj = sanitizeTokenError({ secret: "abc", host: "10.0.0.5" }, fakeLog);
check("6c. ⭐ err obiect cu câmpuri sensibile → body generic, fără reflectare", !JSON.stringify(outObj).includes("10.0.0.5") && !JSON.stringify(outObj).includes("abc"));

// Stabilitatea mesajului generic (nu depinde de input).
check("7. mesajul generic e stabil (același pt. inputuri diferite)",
  sanitizeTokenError(new Error("a"), fakeLog).error_description === sanitizeTokenError(new Error("b"), fakeLog).error_description);
check("8. mesajul generic e propoziția fixă așteptată", GENERIC_SERVER_ERROR_DESCRIPTION === "The authorization server encountered an unexpected error.");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
