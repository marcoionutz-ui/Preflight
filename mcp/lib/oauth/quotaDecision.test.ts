/**
 * lib/oauth/quotaDecision.test.ts — PH-2a GUARD (model decizie quota multi-dimensională, pur).
 */
import { decideQuota, authCodeQuotaWindows, clientCredsQuotaWindows,
         type QuotaWindow, type ScopeQuota } from "./quotaDecision";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
const rem = (d: ReturnType<typeof decideQuota>, scope: string, window: string): number =>
  d.remaining.find(r => r.scope === scope && r.window === window)?.remaining ?? NaN;

function main(): void {
console.log("PH-2a — quotaDecision (model decizie, pur)");

// ── o singură fereastră ───────────────────────────────────────────────────────
check("1. sub limită → allowed", decideQuota([{ scope: "client", window: "minute", count: 3, limit: 10 }]).allowed === true);
check("2. ⭐ exact la limită (count===limit) → BLOCAT", decideQuota([{ scope: "client", window: "minute", count: 10, limit: 10 }]).allowed === false);
check("3. count = limit-1 → allowed (mai încape exact unul)", decideQuota([{ scope: "client", window: "minute", count: 9, limit: 10 }]).allowed === true);
check("4. ⭐ nelimitat (-1) → allowed oricât de mare count", decideQuota([{ scope: "client", window: "day", count: 999999, limit: -1 }]).allowed === true);

// ── ATOMIC: toate trebuie să aibă loc ─────────────────────────────────────────
{
  const w: QuotaWindow[] = [
    { scope: "account", window: "day", count: 5, limit: 100 }, { scope: "account", window: "minute", count: 2, limit: 10 },
    { scope: "client",  window: "day", count: 5, limit: 50 },  { scope: "client",  window: "minute", count: 2, limit: 5 },
  ];
  check("5. ⭐ toate au loc → allowed", decideQuota(w).allowed === true);
}
{
  const w: QuotaWindow[] = [
    { scope: "account", window: "day", count: 5, limit: 100 }, { scope: "account", window: "minute", count: 2, limit: 10 },
    { scope: "client",  window: "day", count: 5, limit: 50 },  { scope: "client",  window: "minute", count: 5, limit: 5 },
  ];
  const d = decideQuota(w);
  check("6. ⭐⭐⭐ account are loc dar client-minute plin → BLOCAT (all-or-nothing)", d.allowed === false && d.blockedBy?.scope === "client" && d.blockedBy?.window === "minute");
}
{
  const d = decideQuota([{ scope: "account", window: "day", count: 100, limit: 100 }, { scope: "account", window: "minute", count: 0, limit: 10 }]);
  check("7. ⭐⭐ account-day plin → BLOCAT + blockedBy account/day (exhausted)", d.allowed === false && d.blockedBy?.scope === "account" && d.blockedBy?.window === "day" && d.blockedBy?.reason === "exhausted");
}
check("8. ⭐ mai multe pline → blockedBy = prima (account/day)", decideQuota([{ scope: "account", window: "day", count: 100, limit: 100 }, { scope: "client", window: "minute", count: 5, limit: 5 }]).blockedBy?.window === "day");

// ── fail-closed pe input corupt ───────────────────────────────────────────────
check("9. ⭐⭐⭐ count NaN → BLOCAT (corrupt)", (() => { const d = decideQuota([{ scope: "account", window: "minute", count: NaN, limit: 10 }]); return d.allowed === false && d.blockedBy?.reason === "corrupt"; })());
check("10. ⭐⭐ count negativ → BLOCAT", decideQuota([{ scope: "account", window: "minute", count: -1, limit: 10 }]).allowed === false);
check("11. ⭐⭐ limit fracționar → BLOCAT", decideQuota([{ scope: "account", window: "minute", count: 0, limit: 10.5 }]).allowed === false);
check("12. ⭐⭐ limit -2 (santinelă necunoscută) → BLOCAT", decideQuota([{ scope: "account", window: "minute", count: 0, limit: -2 }]).allowed === false);
check("13. ⭐ count fracționar → BLOCAT", decideQuota([{ scope: "account", window: "minute", count: 1.5, limit: 10 }]).allowed === false);
check("14. ⭐ o fereastră coruptă blochează TOT setul", (() => {
  const d = decideQuota([{ scope: "account", window: "day", count: 0, limit: 100 }, { scope: "client", window: "minute", count: NaN, limit: 5 }]);
  return d.allowed === false && d.blockedBy?.scope === "client" && d.blockedBy?.reason === "corrupt";
})());
// ── CORUPȚIA DOMINĂ epuizarea, indiferent de ordine (cgpt) ────────────────────
check("14a. ⭐⭐⭐ epuizat ÎNAINTE, corupt DUPĂ → blockedBy corrupt + retryAfterSec null (nu maschează corupția)", (() => {
  const d = decideQuota([
    { scope: "account", window: "day",    count: 100, limit: 100, ttlSec: 3600 },
    { scope: "client",  window: "minute", count: NaN, limit: 10 },
  ]);
  return d.allowed === false && d.blockedBy?.reason === "corrupt" && d.blockedBy?.scope === "client" && d.retryAfterSec === null;
})());
check("14b. ⭐⭐⭐ corupt ÎNAINTE, epuizat DUPĂ → tot corrupt + retryAfterSec null", (() => {
  const d = decideQuota([
    { scope: "client",  window: "minute", count: NaN, limit: 10 },
    { scope: "account", window: "day",    count: 100, limit: 100, ttlSec: 3600 },
  ]);
  return d.allowed === false && d.blockedBy?.reason === "corrupt" && d.retryAfterSec === null;
})());

// ── remaining ─────────────────────────────────────────────────────────────────
{
  const d = decideQuota([{ scope: "account", window: "minute", count: 3, limit: 10 }, { scope: "client", window: "day", count: 0, limit: -1 }]);
  check("15. remaining account/minute = 7", rem(d, "account", "minute") === 7);
  check("16. ⭐ remaining nelimitat = -1", rem(d, "client", "day") === -1);
  check("17. remaining plin = 0", rem(decideQuota([{ scope: "client", window: "minute", count: 5, limit: 5 }]), "client", "minute") === 0);
}

// ── (#3 cgpt) set GOL → fail-closed, NU allowed ───────────────────────────────
{
  const d = decideQuota([]);
  check("18. ⭐⭐⭐ windows gol → BLOCAT (no-windows, fail-closed — NU acces nelimitat)", d.allowed === false && d.blockedBy?.reason === "no-windows" && d.retryAfterSec === null);
}

// ── (#6 cgpt) retry_after = max TTL al ferestrelor EPUIZATE ───────────────────
{
  const d = decideQuota([
    { scope: "account", window: "day",    count: 100, limit: 100, ttlSec: 3600 },
    { scope: "account", window: "minute", count: 10,  limit: 10,  ttlSec: 42 },
  ]);
  check("19. ⭐⭐⭐ ambele epuizate → retryAfterSec = MAX ttl (3600, nu 42)", d.allowed === false && d.retryAfterSec === 3600);
}
{
  // doar minute epuizat (day are loc) → retry = ttl-ul ferestrei epuizate (minute)
  const d = decideQuota([
    { scope: "account", window: "day",    count: 5,  limit: 100, ttlSec: 3600 },
    { scope: "account", window: "minute", count: 10, limit: 10,  ttlSec: 42 },
  ]);
  check("20. ⭐⭐ doar minute epuizat → retryAfterSec = 42 (nu al ferestrei cu loc)", d.retryAfterSec === 42);
}
check("21. ⭐ allowed → retryAfterSec null", decideQuota([{ scope: "client", window: "minute", count: 0, limit: 10, ttlSec: 30 }]).retryAfterSec === null);
check("22. ⭐⭐ epuizat dar fără ttl → retryAfterSec null (necunoscut, nu 0)", decideQuota([{ scope: "client", window: "minute", count: 5, limit: 5 }]).retryAfterSec === null);
check("23. ⭐⭐ un TTL lipsă printre epuizate → retryAfterSec null (conservator)", decideQuota([
  { scope: "account", window: "day", count: 100, limit: 100, ttlSec: 3600 },
  { scope: "client",  window: "day", count: 50,  limit: 50 },
]).retryAfterSec === null);
check("24. ⭐ blocat prin corrupt → retryAfterSec null (nu-i retry, e eroare)", decideQuota([{ scope: "account", window: "minute", count: NaN, limit: 10, ttlSec: 30 }]).retryAfterSec === null);

// ── builder auth-code (#4 cgpt: client EXPLICIT) ──────────────────────────────
{
  const account: ScopeQuota = { perMinute: 10, perDay: 100, count: { minute: 2, day: 5 } };
  const client:  ScopeQuota = { perMinute: 5,  perDay: 50,  count: { minute: 2, day: 5 } };
  const w = authCodeQuotaWindows(account, client);
  check("25. ⭐ builder auth-code: 4 ferestre, day-înainte-minute + account-înainte-client", w.length === 4 && w[0].scope === "account" && w[0].window === "day" && w[3].scope === "client" && w[3].window === "minute");
  check("26. ⭐⭐ account-only EXPLICIT ({accountOnly:true}) → doar 2 ferestre (fără bypass tăcut)", authCodeQuotaWindows(account, { accountOnly: true }).length === 2);
  check("27. ⭐⭐ client plin pe minut → blochează (client/minute)", (() => {
    const d = decideQuota(authCodeQuotaWindows(account, { perMinute: 5, perDay: 50, count: { minute: 5, day: 5 } }));
    return d.allowed === false && d.blockedBy?.scope === "client" && d.blockedBy?.window === "minute";
  })());
  check("28. ⭐ ttl propagat din ScopeQuota în ferestre", authCodeQuotaWindows({ ...account, ttl: { day: 3600, minute: 60 } }, { accountOnly: true })[0].ttlSec === 3600);
}
// ── builder client_credentials ────────────────────────────────────────────────
{
  const w = clientCredsQuotaWindows({ perMinute: 20, perDay: 1000, count: { minute: 0, day: 0 } });
  check("29. ⭐ client_credentials: 2 ferestre (doar client)", w.length === 2 && w.every(x => x.scope === "client"));
  check("30. ⭐ client_credentials nelimitat (-1/-1) → allowed", decideQuota(clientCredsQuotaWindows({ perMinute: -1, perDay: -1, count: { minute: 9e9, day: 9e9 } })).allowed === true);
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
