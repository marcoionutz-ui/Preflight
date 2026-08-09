/**
 * scripts/enqueueBuffer.test.ts — test:u8-p4 (P1-4)
 *
 * Buffer-ul de re-enqueue (durabilitate fereastră WS→enqueue) e PUR: `enqueue`, `now` și cap-urile sunt
 * injectate. Testăm fără Redis și fără timere reale — ceas fals + enqueue fals controlabil.
 *
 * Invariantul central (bug-ul vechi `attempt(3)`): un candidat NU se pierde cât Redis e jos — rămâne
 * bufferat, reîncearcă cu backoff, și e recuperat imediat ce Redis revine. Pierdere DOAR la cap plin
 * (dropat + numărat, nu tăcut).
 */

import { EnqueueRetryBuffer, type EnqueueBufferDeps } from "../src/discovery/enqueueBuffer";
import type { DiscoveryCandidate } from "../src/discovery/discoveryQueue";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else      { failed++; console.error("  ✗ FAIL: " + name); }
}

function cand(slot: number, sig: string): DiscoveryCandidate {
  return { program: "pumpfun", slot, signature: sig };
}

// ── Harness: ceas fals + enqueue fals ────────────────────────────────────────────
interface Harness {
  buf:   EnqueueRetryBuffer;
  setNow:(ms: number) => void;
  calls: DiscoveryCandidate[];
  recovered: { c: DiscoveryCandidate; added: boolean }[];
  dropped:   { c: DiscoveryCandidate; buffered: number }[];
  setEnqueue:(fn: (c: DiscoveryCandidate) => Promise<boolean>) => void;
}
function makeHarness(capacity: number, base = 1_000, max = 8_000): Harness {
  let clock = 0;
  let enqueueImpl: (c: DiscoveryCandidate) => Promise<boolean> =
    async () => { throw new Error("redis down"); };
  const calls: DiscoveryCandidate[] = [];
  const recovered: { c: DiscoveryCandidate; added: boolean }[] = [];
  const dropped:   { c: DiscoveryCandidate; buffered: number }[] = [];

  const deps: EnqueueBufferDeps = {
    enqueue: (c) => { calls.push(c); return enqueueImpl(c); },
    now:     () => clock,
    capacity,
    baseBackoffMs: base,
    maxBackoffMs:  max,
    onRecovered: (c, added) => recovered.push({ c, added }),
    onDropped:   (c, buffered) => dropped.push({ c, buffered }),
  };
  return {
    buf: new EnqueueRetryBuffer(deps),
    setNow: (ms) => { clock = ms; },
    calls, recovered, dropped,
    setEnqueue: (fn) => { enqueueImpl = fn; },
  };
}

void (async () => {
  console.log("[test:u8-p4] enqueueBuffer — durabilitate WS→enqueue (P1-4)\n");

  // ── A. push + dedupe ────────────────────────────────────────────────────────────
  console.log("A. push + dedupe");
  {
    const h = makeHarness(10);
    check("A1 buffer gol la start", h.buf.size === 0);
    check("A2 push c1 → true (bufferat)", h.buf.push(cand(1, "sigA")) === true);
    check("A3 size 1 după primul push", h.buf.size === 1);
    check("A4 push c1 DIN NOU → true dar idempotent (fără dublare)", h.buf.push(cand(1, "sigA")) === true && h.buf.size === 1);
    check("A5 push c2 distinct → size 2", h.buf.push(cand(2, "sigB")) === true && h.buf.size === 2);
    const s = h.buf.stats();
    check("A6 stats.buffered=2, recovered=0, dropped=0", s.buffered === 2 && s.recovered === 0 && s.dropped === 0);
  }

  // ── B. Redis jos → rămâne bufferat, backoff, NU renunță ───────────────────────────
  console.log("B. Redis jos → retry cu backoff, fără pierdere");
  {
    const h = makeHarness(10, 1_000, 8_000);
    h.setNow(0);
    h.buf.push(cand(1, "sigA"));
    h.buf.push(cand(2, "sigB"));

    // flush la t=0 cu Redis jos → ambele eșuează, rămân, attempts=1 → nextAt = 0 + 1000
    await h.buf.flushDue();
    check("B1 ambele încă bufferate după eșec (size 2)", h.buf.size === 2);
    check("B2 enqueue încercat de 2 ori", h.calls.length === 2);
    check("B3 recovered=0 (Redis jos)", h.buf.stats().recovered === 0);

    // flush la t=500 → NIMIC due (nextAt=1000) → zero enqueue-uri noi
    h.setNow(500);
    await h.buf.flushDue();
    check("B4 la t=500 nimic eligibil → fără enqueue nou", h.calls.length === 2);

    // flush la t=1000 → due, dar tot jos → attempts=2 → nextAt = 1000 + 2000 = 3000
    h.setNow(1_000);
    await h.buf.flushDue();
    check("B5 la t=1000 due → reîncercat (4 apeluri total)", h.calls.length === 4);
    check("B6 tot 2 bufferate (încă jos)", h.buf.size === 2);

    // t=2000 → nextAt=3000, nimic due
    h.setNow(2_000);
    await h.buf.flushDue();
    check("B7 la t=2000 nimic eligibil (backoff a crescut la 3000)", h.calls.length === 4);

    // t=3000 → Redis REVINE → ambele recuperate
    h.setNow(3_000);
    h.setEnqueue(async () => true); // added
    await h.buf.flushDue();
    check("B8 la revenirea Redis → buffer golit (size 0)", h.buf.size === 0);
    check("B9 recovered=2", h.buf.stats().recovered === 2);
    check("B10 onRecovered chemat de 2 ori cu added=true", h.recovered.length === 2 && h.recovered.every(r => r.added === true));
    check("B11 dropped=0 (nimic pierdut — invariantul P1-4)", h.buf.stats().dropped === 0);
  }

  // ── C. Cap plin → drop ONEST (nu tăcut) ───────────────────────────────────────────
  console.log("C. cap plin → drop numărat");
  {
    const h = makeHarness(2);
    h.setNow(0);
    check("C1 push a → ok", h.buf.push(cand(1, "a")) === true);
    check("C2 push b → ok (cap 2 atins)", h.buf.push(cand(2, "b")) === true);
    check("C3 push c → DROPAT (cap plin) → false", h.buf.push(cand(3, "c")) === false);
    check("C4 size rămâne 2 (FIFO reținut)", h.buf.size === 2);
    check("C5 dropped=1", h.buf.stats().dropped === 1);
    check("C6 onDropped chemat cu candidatul + buffered=2", h.dropped.length === 1 && h.dropped[0].c.signature === "c" && h.dropped[0].buffered === 2);
    // dedupe NU consumă cap: re-push al unuia existent nu dropează
    check("C7 re-push al unui membru existent → true (nu drop)", h.buf.push(cand(1, "a")) === true && h.buf.stats().dropped === 1);
  }

  // ── D. enqueue rezolvă false (deduped) = tot recuperat ────────────────────────────
  console.log("D. deduped (added=false) = recuperare validă");
  {
    const h = makeHarness(10);
    h.setNow(0);
    h.buf.push(cand(9, "dedup"));
    h.setEnqueue(async () => false); // deja cunoscut în Redis
    await h.buf.flushDue();
    check("D1 buffer golit chiar dacă added=false", h.buf.size === 0);
    check("D2 recovered=1", h.buf.stats().recovered === 1);
    check("D3 onRecovered cu added=false", h.recovered.length === 1 && h.recovered[0].added === false);
  }

  // ── E. flush parțial: unii reușesc, alții eșuează în același pas ───────────────────
  console.log("E. flush mixt — succes + eșec în același flush");
  {
    const h = makeHarness(10);
    h.setNow(0);
    h.buf.push(cand(1, "ok1"));
    h.buf.push(cand(2, "boom"));  // acesta va arunca
    h.buf.push(cand(3, "ok2"));
    h.setEnqueue(async (c) => { if (c.signature === "boom") throw new Error("still down"); return true; });
    await h.buf.flushDue();
    check("E1 cei 2 OK recuperați, boom rămâne (size 1)", h.buf.size === 1);
    check("E2 recovered=2", h.buf.stats().recovered === 2);
    // boom a primit backoff → nu-i due la t=0 imediat re-flush
    const callsBefore = h.calls.length;
    await h.buf.flushDue();
    check("E3 re-flush imediat: boom nu-i due (backoff) → fără enqueue nou", h.calls.length === callsBefore);
    // după backoff (base=1000) devine due și, cu Redis sus, se recuperează
    h.setNow(1_000);
    h.setEnqueue(async () => true);
    await h.buf.flushDue();
    check("E4 după backoff + Redis sus → boom recuperat (size 0)", h.buf.size === 0 && h.buf.stats().recovered === 3);
  }

  // ── F. backoff plafonat la max ────────────────────────────────────────────────────
  console.log("F. backoff plafonat");
  {
    const h = makeHarness(10, 1_000, 4_000); // max 4000
    h.setNow(0);
    h.buf.push(cand(1, "capped"));
    // eșuează repetat: attempts 1→1000, 2→2000, 3→4000, 4→ (8000 cap la 4000)
    // avansăm ceasul exact la fiecare nextAt ca să forțăm reîncercarea
    let t = 0;
    for (const expected of [1_000, 2_000, 4_000, 4_000]) {
      await h.buf.flushDue();          // eșuează la t curent → programează nextAt = t + expected
      t += expected;
      h.setNow(t);
    }
    // ultimul flush la t (după al 4-lea backoff plafonat) cu Redis sus → recuperat
    h.setEnqueue(async () => true);
    await h.buf.flushDue();
    check("F1 recuperat după backoff plafonat la max (fără explozie)", h.buf.size === 0 && h.buf.stats().recovered === 1);
  }

  // ── Sumar ─────────────────────────────────────────────────────────────────────────
  console.log("\n[test:u8-p4] passed=" + passed + " failed=" + failed);
  if (failed > 0) process.exit(1);
})();
