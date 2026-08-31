/**
 * lib/oauth/boundedBody.test.ts — PH-2 pas 6 frunză 5b-ii-a (citire mărginită a body-ului).
 */
import { readBoundedText, contentLengthExceeds } from "./boundedBody";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const enc = new TextEncoder();
/** Stream din chunk-uri (bytes), pt. a controla granularitatea (multi-chunk). */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } });
}
function bytes(s: string): Uint8Array { return enc.encode(s); }

async function main(): Promise<void> {
console.log("PH-2 pas 6 frunză 5b-ii-a — boundedBody");

// ── readBoundedText ───────────────────────────────────────────────────────────────────────────────
{
  const r = await readBoundedText(streamOf(bytes("txn_id=abc&action=approve")), 1024);
  check("1. ⭐⭐⭐ body mic → ok + text exact", r.ok === true && r.text === "txn_id=abc&action=approve");
}
{
  const body = "x".repeat(100);
  const r = await readBoundedText(streamOf(bytes(body)), 100);
  check("2. ⭐⭐⭐ body EXACT la limită (100=100) → ok (plafon inclusiv)", r.ok === true && r.ok && r.text.length === 100);
}
{
  const r = await readBoundedText(streamOf(bytes("x".repeat(101))), 100);
  check("3. ⭐⭐⭐ body peste limită (101>100) → too_large", r.ok === false && r.reason === "too_large");
}
{
  // multi-chunk care depășește abia la al doilea chunk → abort la depășire
  const r = await readBoundedText(streamOf(bytes("x".repeat(60)), bytes("y".repeat(60))), 100);
  check("4. ⭐⭐⭐ multi-chunk care depășește la al doilea → too_large (abort, nu acumulează tot)", r.ok === false && r.reason === "too_large");
}
{
  // multi-chunk care se ÎNCADREAZĂ → concatenat corect, în ordine
  const r = await readBoundedText(streamOf(bytes("ab"), bytes("cd"), bytes("ef")), 100);
  check("5. ⭐⭐ multi-chunk sub limită → concatenat în ordine", r.ok === true && r.ok && r.text === "abcdef");
}
{
  const r = await readBoundedText(null, 100);
  check("6. ⭐⭐⭐ body null → ok cu text gol (parse-ul respinge golul)", r.ok === true && r.ok && r.text === "");
}
{
  // UTF-8 multibyte: 'é' = 2 bytes; decode corect, iar limita e pe BYTES nu chars
  const r = await readBoundedText(streamOf(bytes("héllo")), 1024);
  check("7. ⭐⭐⭐ UTF-8 multibyte decodat corect (é)", r.ok === true && r.ok && r.text === "héllo");
}
{
  // 'é'×60 = 120 bytes > 100 → too_large (limita pe bytes, nu pe 60 chars)
  const r = await readBoundedText(streamOf(bytes("é".repeat(60))), 100);
  check("8. ⭐⭐⭐ limită pe BYTES nu chars: 60×'é'=120B > 100 → too_large", r.ok === false && r.reason === "too_large");
}

// ── contentLengthExceeds ──────────────────────────────────────────────────────────────────────────
check("9.  ⭐⭐⭐ Content-Length peste → true", contentLengthExceeds("200", 100) === true);
check("10. ⭐⭐⭐ Content-Length sub → false", contentLengthExceeds("50", 100) === false);
check("11. ⭐⭐ Content-Length exact = max → false (inclusiv)", contentLengthExceeds("100", 100) === false);
check("12. ⭐⭐⭐ lipsă (null/undefined) → false (stream-ul mărginește)", contentLengthExceeds(null, 100) === false && contentLengthExceeds(undefined, 100) === false);
check("13. ⭐⭐ garbage (NaN) → false (nu bloca pe antet corupt; stream enforce)", contentLengthExceeds("abc", 100) === false);
check("14. ⭐⭐ gol → false", contentLengthExceeds("", 100) === false);
check("15. ⭐ negativ → false", contentLengthExceeds("-5", 100) === false);

// ── validare maxBytes (aruncă ÎNAINTE de citire) ───────────────────────────────────────────────────
async function throwsRange(fn: () => Promise<unknown> | unknown): Promise<boolean> {
  try { await fn(); return false; } catch (e) { return e instanceof RangeError; }
}
{
  // stream care ar ARUNCA la read → dacă am fi citit, am fi primit alt error; primim RangeError ⇒ validat înainte
  const wouldThrowOnRead = () => new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("should-not-read")); } });
  check("16. ⭐⭐⭐ maxBytes NaN → RangeError ÎNAINTE de citire", await throwsRange(() => readBoundedText(wouldThrowOnRead(), NaN)));
  check("17. ⭐⭐⭐ maxBytes Infinity → RangeError", await throwsRange(() => readBoundedText(wouldThrowOnRead(), Infinity)));
  check("18. ⭐⭐⭐ maxBytes -1 → RangeError", await throwsRange(() => readBoundedText(wouldThrowOnRead(), -1)));
  check("19. ⭐⭐⭐ maxBytes 1.5 (fracționar) → RangeError", await throwsRange(() => readBoundedText(wouldThrowOnRead(), 1.5)));
  check("20. ⭐⭐⭐ maxBytes invalid aruncă chiar și cu body null (înainte de body===null)", await throwsRange(() => readBoundedText(null, NaN)));
  check("21. ⭐⭐ contentLengthExceeds cu maxBytes invalid → RangeError", await throwsRange(() => contentLengthExceeds("50", NaN)));
  check("22. ⭐ maxBytes 0 valid (întreg sigur ≥0) → NU aruncă", (await readBoundedText(streamOf(bytes("")), 0)).ok === true);
}

// ── depășirea CHIAR apelează cancel() ──────────────────────────────────────────────────────────────
{
  let cancelled: boolean = false; // anotat: atribuirea e în callback, TS n-o vede altfel
  const s = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(bytes("x".repeat(200))); }, // NU close → cancel-ul propagă la sursă
    cancel() { cancelled = true; },
  });
  const r = await readBoundedText(s, 100);
  check("23. ⭐⭐⭐ depășire → too_large ȘI cancel() apelat pe sursă (stream chiar abortat)", r.ok === false && r.reason === "too_large" && cancelled);
}

// ── eroare de read propagată (lock eliberat în finally) ────────────────────────────────────────────
{
  const s = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("boom")); } });
  let threw = false;
  try { await readBoundedText(s, 100); } catch { threw = true; }
  check("24. ⭐⭐ eroare de read → propagată (nu înghițită); lock eliberat în finally", threw === true);
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
