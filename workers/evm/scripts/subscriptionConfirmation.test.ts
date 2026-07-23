/**
 * scripts/subscriptionConfirmation.test.ts — D3.
 *
 * Testează state-machine-ul PUR din `ws/scopedSubs.ts` (funcțiile REALE de producție, importate — fără
 * WebSocket, fără mock de rețea). Acoperă exact contractul D3: snapshot-ul devine „activ" DOAR după
 * confirmarea serverului, subscripția veche NU se anulează înainte de confirmare, eșecul se re-încearcă,
 * răspunsurile depășite (stale) nu pot reactiva un snapshot vechi, iar o cerere fără ACK (server tăcut)
 * sau un `ws.send` eșuat NU îngheață retry-ul.
 *
 * Fără dependențe externe (fără Redis/WS) → rulează mereu, determinist. `now` e injectat (reducer pur).
 */

import {
  createScopedSubStore, scopedSubKey,
  planScopedSubscribe, applyScopedSubResponse, planScopedUnsubscribe, clearScopedSubsForChain,
  abandonScopedSubRequest, hasHardExpiredScopedRequest, activeSnapshot, activeSubId,
  SCOPED_SUB_ACK_TIMEOUT_MS, SCOPED_SUB_HARD_TIMEOUT_MS,
  type ScopedSubStore,
} from "../src/ws/scopedSubs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

// contor de reqId ca în producție (nextScopedSubReqId): unic, crescător.
let req = 20_000;
const nextReq = () => ++req;

// ceas injectat; majoritatea testelor rulează la un moment fix (cereri mereu proaspete).
const T0 = 1_000_000;

const KEY = scopedSubKey("base", "v3");

// helper: subscribe + confirmare-succes într-un pas (pentru a ajunge la o stare „activă" curată)
function subscribeAndConfirm(store: ScopedSubStore, desired: string, subId: string, now = T0): void {
  const plan = planScopedSubscribe(store, KEY, desired, nextReq(), now);
  if (plan.reqId != null) applyScopedSubResponse(store, plan.reqId, { ok: true, subId });
}

function main(): void {
  console.log("D3 — scopedSubs (confirmare explicită a subscripțiilor)");

  // ── D3.1: primul subscribe NU pretinde optimist că există; devine activ DOAR la confirmare ──
  {
    const s = createScopedSubStore();
    const plan = planScopedSubscribe(s, KEY, "a,b", nextReq(), T0);
    check("D3.1a. primul subscribe → sent", plan.outcome === "sent" && plan.reqId != null);
    check("D3.1b. active încă NULL înainte de confirmare (nu optimist)", activeSnapshot(s, KEY) === null);
    const r = applyScopedSubResponse(s, plan.reqId!, { ok: true, subId: "sub-1" });
    check("D3.1c. după confirmare → promoted", r.outcome === "promoted");
    check("D3.1d. active = snapshot confirmat", activeSnapshot(s, KEY) === "a,b");
    check("D3.1e. active subId = cel confirmat", activeSubId(s, KEY) === "sub-1");
    check("D3.1f. primul subscribe nu anulează nimic", r.unsub.length === 0);
  }

  // ── D3.2: steady-state — același snapshot confirmat, nimic în zbor → noop, nu re-trimite ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    const plan = planScopedSubscribe(s, KEY, "a,b", nextReq(), T0);
    check("D3.2a. snapshot neschimbat → noop-active", plan.outcome === "noop-active");
    check("D3.2b. nu trimite (reqId null)", plan.reqId === null);
    check("D3.2c. active neschimbat", activeSubId(s, KEY) === "sub-1");
  }

  // ── D3.3: dedup în zbor — exact cererea deja trimisă (cea mai recentă, proaspătă) → noop-in-flight ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    const p1 = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0); // creștere, în zbor
    check("D3.3a. creștere → sent", p1.outcome === "sent");
    const p2 = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0); // același desired, încă neconfirmat
    check("D3.3b. re-cerere identică în zbor → noop-in-flight", p2.outcome === "noop-in-flight");
    check("D3.3c. nu generează al doilea request", p2.reqId === null);
  }

  // ── D3.4 + D3.5: BUG-ul central — eșecul NU lasă snapshot optimist; active vechi rămâne; retry ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    const p = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0); // cerem creșterea
    check("D3.4a. active tot pe snapshot-ul VECHI cât timp e pending", activeSnapshot(s, KEY) === "a,b");
    const r = applyScopedSubResponse(s, p.reqId!, { ok: false }); // serverul respinge
    check("D3.4b. eroare pe cea mai recentă → failed-latest", r.outcome === "failed-latest");
    check("D3.5a. active NEschimbat după eșec (flow vechi continuă)", activeSnapshot(s, KEY) === "a,b");
    check("D3.5b. subId vechi păstrat (nu s-a anulat)", activeSubId(s, KEY) === "sub-1");
    check("D3.5c. eșecul nu anulează nimic", r.unsub.length === 0);
    // dovada anti-regresie: scanul următor RE-ÎNCEARCĂ (nu face short-circuit pe snapshot optimist)
    const retry = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0);
    check("D3.4c. scanul următor RE-TRIMITE (retry, nu noop)", retry.outcome === "sent" && retry.reqId != null);
  }

  // ── D3.6: înlocuire reușită — unsub la subscripția veche DOAR DUPĂ confirmarea celei noi ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    const p = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0);
    check("D3.6a. cât timp e pending, vechiul sub NU e anulat", activeSubId(s, KEY) === "sub-1");
    const r = applyScopedSubResponse(s, p.reqId!, { ok: true, subId: "sub-2" });
    check("D3.6b. succes → promoted", r.outcome === "promoted");
    check("D3.6c. active = subId nou", activeSubId(s, KEY) === "sub-2");
    check("D3.6d. active snapshot = cel nou", activeSnapshot(s, KEY) === "a,b,c");
    check("D3.6e. subId VECHI anulat abia acum", r.unsub.length === 1 && r.unsub[0] === "sub-1");
  }

  // ── D3.7: răspuns STALE — o cerere depășită nu poate reactiva un snapshot vechi; orfanul se anulează ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    const p1 = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0);  // req#1 → „a,b,c"
    const p2 = planScopedSubscribe(s, KEY, "a,b,c,d", nextReq(), T0); // req#2 → „a,b,c,d" (mai nou)
    check("D3.7a. a doua cerere (mai nouă) → sent", p2.outcome === "sent");
    // req#1 (depășit) se confirmă PRIMUL, cu succes
    const r1 = applyScopedSubResponse(s, p1.reqId!, { ok: true, subId: "sub-2" });
    check("D3.7b. răspuns depășit + succes → stale-success", r1.outcome === "stale-success");
    check("D3.7c. subId orfan (sub-2) anulat imediat", r1.unsub.length === 1 && r1.unsub[0] === "sub-2");
    check("D3.7d. active NU sare pe snapshot-ul depasit (ramane a,b)", activeSnapshot(s, KEY) === "a,b");
    // req#2 (cel mai recent) se confirmă → promovează la „a,b,c,d"
    const r2 = applyScopedSubResponse(s, p2.reqId!, { ok: true, subId: "sub-3" });
    check("D3.7e. cea mai recentă → promoted la snapshot-ul corect", r2.outcome === "promoted" && activeSnapshot(s, KEY) === "a,b,c,d");
    check("D3.7f. active subId = sub-3", activeSubId(s, KEY) === "sub-3");
    check("D3.7g. la promovare, vechiul sub-1 e anulat", r2.unsub.length === 1 && r2.unsub[0] === "sub-1");
  }

  // ── D3.7bis: stale-FAILED — cererea depășită eșuează → nu atinge active, latestReq rămâne pe cea nouă ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    const p1 = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0);
    const p2 = planScopedSubscribe(s, KEY, "a,b,c,d", nextReq(), T0);
    const r1 = applyScopedSubResponse(s, p1.reqId!, { ok: false }); // depășit + eroare
    check("D3.7bis-a. depășit + eroare → stale-failed", r1.outcome === "stale-failed");
    check("D3.7bis-b. active neatins", activeSnapshot(s, KEY) === "a,b");
    const r2 = applyScopedSubResponse(s, p2.reqId!, { ok: true, subId: "sub-2" });
    check("D3.7bis-c. cea nouă tot se promovează (latestReq intact)", r2.outcome === "promoted" && activeSnapshot(s, KEY) === "a,b,c,d");
  }

  // ── D3.8: empty watch — teardown; o cerere rămasă în zbor nu reînvie subscripția ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    const u = planScopedUnsubscribe(s, KEY);
    check("D3.8a. teardown anulează subId-ul activ", u.unsub.length === 1 && u.unsub[0] === "sub-1");
    check("D3.8b. active gol după teardown", activeSnapshot(s, KEY) === null);
    // idempotent: al doilea unsubscribe nu mai anulează nimic
    const u2 = planScopedUnsubscribe(s, KEY);
    check("D3.8c. teardown repetat → nimic de anulat", u2.unsub.length === 0);
    // un pending rămas în zbor care se confirmă DUPĂ teardown → orfan, nu reînvie
    const s2 = createScopedSubStore();
    subscribeAndConfirm(s2, "a,b", "sub-1");
    const p = planScopedSubscribe(s2, KEY, "a,b,c", nextReq(), T0); // în zbor
    planScopedUnsubscribe(s2, KEY);                                 // watch golit între timp
    const r = applyScopedSubResponse(s2, p.reqId!, { ok: true, subId: "sub-2" });
    check("D3.8d. pending confirmat după teardown → stale-success (orfan)", r.outcome === "stale-success");
    check("D3.8e. subId orfan anulat", r.unsub.length === 1 && r.unsub[0] === "sub-2");
    check("D3.8f. active rămâne gol (nu reînvie)", activeSnapshot(s2, KEY) === null);
  }

  // ── D3.9: reconnect — clear total pe chain; răspunsul întârziat al unei cereri pre-close → unknown ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    const p = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0); // în zbor când pică conexiunea
    clearScopedSubsForChain(s, "base");
    check("D3.9a. active șters după reconnect", activeSnapshot(s, KEY) === null);
    const r = applyScopedSubResponse(s, p.reqId!, { ok: true, subId: "sub-late" });
    check("D3.9b. răspuns pre-close → unknown (ignorat)", r.outcome === "unknown");
    check("D3.9c. nu anulăm subId-ul (moare cu socketul vechi)", r.unsub.length === 0);
    check("D3.9d. active tot gol", activeSnapshot(s, KEY) === null);
    // izolare per-chain: clear pe „base" nu atinge „arb"
    const s2 = createScopedSubStore();
    subscribeAndConfirm(s2, "a,b", "sub-base");
    const KEY_ARB = scopedSubKey("arb", "v3");
    const pa = planScopedSubscribe(s2, KEY_ARB, "x,y", nextReq(), T0);
    applyScopedSubResponse(s2, pa.reqId!, { ok: true, subId: "sub-arb" });
    clearScopedSubsForChain(s2, "base");
    check("D3.9e. clear pe base NU atinge arb", activeSubId(s2, KEY_ARB) === "sub-arb");
    check("D3.9f. base e curățat", activeSnapshot(s2, KEY) === null);
  }

  // ── D3.10: replacements secvențiale — fiecare promovare anulează exact subId-ul precedent ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a", "sub-1");
    const p2 = planScopedSubscribe(s, KEY, "a,b", nextReq(), T0);
    const r2 = applyScopedSubResponse(s, p2.reqId!, { ok: true, subId: "sub-2" });
    check("D3.10a. promovare 1→2 anulează sub-1", r2.unsub.length === 1 && r2.unsub[0] === "sub-1");
    const p3 = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0);
    const r3 = applyScopedSubResponse(s, p3.reqId!, { ok: true, subId: "sub-3" });
    check("D3.10b. promovare 2→3 anulează sub-2", r3.unsub.length === 1 && r3.unsub[0] === "sub-2");
    check("D3.10c. active final = sub-3 / a,b,c", activeSubId(s, KEY) === "sub-3" && activeSnapshot(s, KEY) === "a,b,c");
  }

  // ── D3.11: răspuns duplicat / reqId necunoscut → unknown, fără efecte ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    const r = applyScopedSubResponse(s, 999_999, { ok: true, subId: "ghost" });
    check("D3.11a. reqId necunoscut → unknown", r.outcome === "unknown");
    check("D3.11b. fără unsub", r.unsub.length === 0);
    check("D3.11c. active neatins", activeSubId(s, KEY) === "sub-1");
  }

  // ── D3.12: pending PROASPĂT, același snapshot → noop-in-flight (nu spamăm cât timp e în fereastră) ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0);                              // trimis la T0
    const fresh = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0 + SCOPED_SUB_ACK_TIMEOUT_MS - 1);
    check("D3.12. în fereastra ACK, același snapshot → noop-in-flight", fresh.outcome === "noop-in-flight" && fresh.reqId === null);
  }

  // ── D3.13: pending EXPIRAT (server tăcut), același snapshot → cerere NOUĂ (retry, nu îngheață) ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    const p1 = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0);                    // trimis la T0, fără ACK
    const late = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0 + SCOPED_SUB_ACK_TIMEOUT_MS + 1);
    check("D3.13a. după timeout, același snapshot → retrimite", late.outcome === "sent" && late.reqId != null && late.reqId !== p1.reqId);
    check("D3.13b. cererea expirată RĂMÂNE în pending (pt. cleanup orfan)", s.pending.has(p1.reqId!));
    check("D3.13c. active tot pe cel vechi (nimic confirmat încă)", activeSnapshot(s, KEY) === "a,b");
  }

  // ── D3.14: răspunsul cererii EXPIRATE vine totuși cu succes → stale-success + unsubscribe orfan ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    const p1 = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0);                    // expiră fără ACK
    const p2 = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0 + SCOPED_SUB_ACK_TIMEOUT_MS + 1); // retry
    const r1 = applyScopedSubResponse(s, p1.reqId!, { ok: true, subId: "sub-orphan" }); // răspunsul întârziat
    check("D3.14a. răspuns întârziat al cererii expirate → stale-success", r1.outcome === "stale-success");
    check("D3.14b. subId orfan anulat (nu rămâne viu pe server)", r1.unsub.length === 1 && r1.unsub[0] === "sub-orphan");
    check("D3.14c. active neatins de răspunsul stale", activeSnapshot(s, KEY) === "a,b");
    // retry-ul (p2) se confirmă normal
    const r2 = applyScopedSubResponse(s, p2.reqId!, { ok: true, subId: "sub-2" });
    check("D3.14d. retry-ul se promovează corect", r2.outcome === "promoted" && activeSubId(s, KEY) === "sub-2");
  }

  // ── D3.15: abandon după `ws.send` eșuat pe cea mai recentă → scanul următor retrimite ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    const p = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0);
    abandonScopedSubRequest(s, p.reqId!); // send a eșuat → renunțăm la cerere
    check("D3.15a. cererea abandonată e ștearsă din pending", !s.pending.has(p.reqId!));
    const retry = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0);
    check("D3.15b. scanul următor RE-TRIMITE (latestReq curățat)", retry.outcome === "sent" && retry.reqId != null);
    check("D3.15c. active neatins (send-ul eșuat nu a schimbat nimic)", activeSubId(s, KEY) === "sub-1");
  }

  // ── D3.16: abandon al unei cereri DEPĂȘITE → nu șterge latestReq-ul cererii NOI ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    const p1 = planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0);   // req#1
    const p2 = planScopedSubscribe(s, KEY, "a,b,c,d", nextReq(), T0); // req#2 devine latest
    abandonScopedSubRequest(s, p1.reqId!); // callback de eroare întârziat pe req#1 (deja depășit)
    check("D3.16a. req#1 (depășit) șters din pending", !s.pending.has(p1.reqId!));
    check("D3.16b. latestReq rămâne pe req#2 (cererea nouă intactă)", s.latestReq.get(KEY) === p2.reqId);
    check("D3.16c. req#2 tot în pending", s.pending.has(p2.reqId!));
    const r2 = applyScopedSubResponse(s, p2.reqId!, { ok: true, subId: "sub-2" });
    check("D3.16d. req#2 se promovează normal", r2.outcome === "promoted" && activeSubId(s, KEY) === "sub-2");
  }

  // ── D3.17: pending sub hard timeout → true (ACK blocat definitiv, trebuie reset WS) ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0); // trimis la T0, fără ACK
    check("D3.17. pending > hard-timeout → true", hasHardExpiredScopedRequest(s, KEY, T0 + SCOPED_SUB_HARD_TIMEOUT_MS) === true);
  }

  // ── D3.18: pending proaspăt → false (nu resetăm cât timp e sub hard-timeout) ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    planScopedSubscribe(s, KEY, "a,b,c", nextReq(), T0);
    check("D3.18a. pending sub hard-timeout → false", hasHardExpiredScopedRequest(s, KEY, T0 + SCOPED_SUB_HARD_TIMEOUT_MS - 1) === false);
    check("D3.18b. fără pending → false", hasHardExpiredScopedRequest(createScopedSubStore(), KEY, T0 + 10 * SCOPED_SUB_HARD_TIMEOUT_MS) === false);
  }

  // ── D3.19: alt chain/kind nu afectează cheia verificată ──
  {
    const s = createScopedSubStore();
    // pending vechi pe (arb, v3) și pe (base, v4); verificăm (base, v3) → nu trebuie afectat
    planScopedSubscribe(s, scopedSubKey("arb", "v3"), "x,y", nextReq(), T0);
    planScopedSubscribe(s, scopedSubKey("base", "v4"), "p,q", nextReq(), T0);
    check("D3.19a. hard-expired pe alt chain/kind → cheia curentă false", hasHardExpiredScopedRequest(s, KEY, T0 + SCOPED_SUB_HARD_TIMEOUT_MS + 1) === false);
    check("D3.19b. cheia lor proprie → true", hasHardExpiredScopedRequest(s, scopedSubKey("arb", "v3"), T0 + SCOPED_SUB_HARD_TIMEOUT_MS + 1) === true);
  }

  // ── D3.20: reconnect (clear) golește toate pending-urile acumulate (bounded după reset WS) ──
  {
    const s = createScopedSubStore();
    subscribeAndConfirm(s, "a,b", "sub-1");
    // simulează server mut: 4 soft-timeout-uri → 4 pending-uri acumulate pe aceeași cheie
    let t = T0;
    for (let i = 0; i < 4; i++) { planScopedSubscribe(s, KEY, "a,b,c", nextReq(), t); t += SCOPED_SUB_ACK_TIMEOUT_MS + 1; }
    check("D3.20a. pending-uri acumulate (server mut)", s.pending.size >= 4);
    check("D3.20b. hard-expired detectat pe primul", hasHardExpiredScopedRequest(s, KEY, T0 + SCOPED_SUB_HARD_TIMEOUT_MS + 1) === true);
    clearScopedSubsForChain(s, "base"); // = ce face handler-ul `close` după ws.terminate()
    check("D3.20c. reconnect golește TOATE pending-urile", s.pending.size === 0);
    check("D3.20d. active + latestReq golite", activeSnapshot(s, KEY) === null && s.latestReq.size === 0);
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
