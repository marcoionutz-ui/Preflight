/**
 * lib/db/quotaKey.test.ts — PH-2 GUARD (cheia de quota lunară derivată din subiect, pur).
 */
import { monthlyQuotaKey, yearMonthUTC, type QuotaSubject } from "./quotaKey";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
function throws(fn: () => unknown): boolean { try { fn(); return false; } catch { return true; } }

function main(): void {
console.log("PH-2 — quotaKey (derivare cheie quota lunară, pur)");

// ── forma cheilor ─────────────────────────────────────────────────────────────
check("1. ⭐ account → mcp:quota:acct:<userId>:<ym>", monthlyQuotaKey({ kind: "account", userId: "u1" }, "2026-08") === "mcp:quota:acct:u1:2026-08");
check("2. ⭐⭐⭐ client → IDENTIC cu azi (mcp:quota:<clientId>:<ym>) — client_credentials neschimbat", monthlyQuotaKey({ kind: "client", clientId: "c1" }, "2026-08") === "mcp:quota:c1:2026-08");

// ── regresie de CUTOVER: cheia clientului byte-identică cu formula istorică din reserveQuota ──
{
  const clientId = "tp_marco_personal", ym = "2026-08";
  const legacy = `mcp:quota:${clientId}:${ym}`; // exact ce producea quotaKey(clientId) înainte de PH-2
  check("3. ⭐⭐⭐ cheia client = formula legacy (contoarele existente NU se resetează la deploy)", monthlyQuotaKey({ kind: "client", clientId }, ym) === legacy);
}

// ── izolare account/client cu ACELAȘI id ──────────────────────────────────────
check("4. ⭐⭐⭐ account vs client cu ACELAȘI string de id → chei DIFERITE (fără coliziune)",
  monthlyQuotaKey({ kind: "account", userId: "x" }, "2026-08") !== monthlyQuotaKey({ kind: "client", clientId: "x" }, "2026-08"));

// ── gardă anti-coliziune pe prefixul de cont ──────────────────────────────────
check("5. ⭐⭐ clientId care începe cu „acct:” → aruncă (ar coliza cu namespace-ul de cont)",
  throws(() => monthlyQuotaKey({ kind: "client", clientId: "acct:u1" }, "2026-08")));
check("6. clientId care conține „acct” dar NU la început → OK", monthlyQuotaKey({ kind: "client", clientId: "my_acct_x" }, "2026-08") === "mcp:quota:my_acct_x:2026-08");

// ── fail-closed pe id gol/whitespace ──────────────────────────────────────────
check("7. ⭐⭐ userId gol → aruncă (fără bucket partajat)", throws(() => monthlyQuotaKey({ kind: "account", userId: "" }, "2026-08")));
check("8. ⭐⭐ userId whitespace → aruncă", throws(() => monthlyQuotaKey({ kind: "account", userId: "   " }, "2026-08")));
check("9. ⭐⭐ clientId gol → aruncă", throws(() => monthlyQuotaKey({ kind: "client", clientId: "" }, "2026-08")));
check("10. ⭐ id cu spații în jur → trim (un singur bucket per id logic)", monthlyQuotaKey({ kind: "account", userId: "  u1  " }, "2026-08") === "mcp:quota:acct:u1:2026-08");

// ── fail-closed pe ym ─────────────────────────────────────────────────────────
check("11. ⭐⭐ ym gol → aruncă", throws(() => monthlyQuotaKey({ kind: "client", clientId: "c1" }, "")));
check("12. ⭐⭐ ym format greșit (2026-8, o cifră) → aruncă", throws(() => monthlyQuotaKey({ kind: "client", clientId: "c1" }, "2026-8")));
check("13. ⭐ ym cu junk (2026-08-01) → aruncă", throws(() => monthlyQuotaKey({ kind: "client", clientId: "c1" }, "2026-08-01")));
check("13a. ⭐⭐ ym lună 00 → aruncă (formă validă dar lună inexistentă)", throws(() => monthlyQuotaKey({ kind: "client", clientId: "c1" }, "2026-00")));
check("13b. ⭐⭐ ym lună 13 → aruncă", throws(() => monthlyQuotaKey({ kind: "client", clientId: "c1" }, "2026-13")));
check("13c. ⭐ ym lună 99 → aruncă", throws(() => monthlyQuotaKey({ kind: "client", clientId: "c1" }, "2026-99")));
check("13d. lună 12 e validă (margine superioară)", monthlyQuotaKey({ kind: "client", clientId: "c1" }, "2026-12") === "mcp:quota:c1:2026-12");
check("13e. lună 01 e validă (margine inferioară)", monthlyQuotaKey({ kind: "client", clientId: "c1" }, "2026-01") === "mcp:quota:c1:2026-01");

// ── yearMonthUTC ──────────────────────────────────────────────────────────────
check("14. ⭐ yearMonthUTC: lună zero-padded (ian → 01)", yearMonthUTC(new Date(Date.UTC(2026, 0, 15))) === "2026-01");
check("15. ⭐ yearMonthUTC: decembrie → 12", yearMonthUTC(new Date(Date.UTC(2026, 11, 31))) === "2026-12");
check("16. ⭐⭐ yearMonthUTC UTC, nu local: 2026-01-01T00:30Z rămâne 2026-01 (nu decembrie)", yearMonthUTC(new Date("2026-01-01T00:30:00Z")) === "2026-01");
check("17. ⭐⭐ yearMonthUTC Date invalid → aruncă (fără NaN-NaN bucket global)", throws(() => yearMonthUTC(new Date("nope"))));

// ── kind necunoscut (cast intenționat) → aruncă, NU cade tăcut pe client ──────
check("17a. ⭐⭐⭐ kind necunoscut (deși are clientId) → aruncă (fail-closed, nu cheie client tăcută)",
  throws(() => monthlyQuotaKey({ kind: "mystery", clientId: "c1" } as unknown as QuotaSubject, "2026-08")));
check("17b. ⭐⭐ kind lipsă cu totul → aruncă", throws(() => monthlyQuotaKey({ clientId: "c1" } as unknown as QuotaSubject, "2026-08")));

// ── compoziția reală (yearMonthUTC → monthlyQuotaKey) ─────────────────────────
{
  const now = new Date("2026-08-22T10:00:00Z");
  const sub: QuotaSubject = { kind: "account", userId: "u1" };
  check("18. ⭐ compoziție yearMonthUTC→monthlyQuotaKey", monthlyQuotaKey(sub, yearMonthUTC(now)) === "mcp:quota:acct:u1:2026-08");
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
