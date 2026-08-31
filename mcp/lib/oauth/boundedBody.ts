/**
 * lib/oauth/boundedBody.ts — PH-2 pas 6 frunză 5b-ii-a (citire MĂRGINITĂ a body-ului, protecție reală pe payload).
 *
 * `await req.text()` materializează TOT payload-ul înainte de orice verificare de lungime — nu-i protecție pe un
 * endpoint public. Aici citim stream-ul cu plafon HARD: abortăm (cancel) imediat ce depășim, fără a acumula tot.
 * `contentLengthExceeds` e un fast-reject pe antetul Content-Length (poate minți → stream-ul rămâne autoritatea).
 * I/O-adjacent dar pur-testabil: primește un ReadableStream (construibil în test), nu un NextRequest.
 */
export type BoundedBody =
  | { ok: true;  text: string }
  | { ok: false; reason: "too_large" };

/**
 * `maxBytes` TREBUIE întreg sigur ≥ 0. Altfel plafonul e inutil: `total > NaN`/`total > Infinity` nu se activează
 * NICIODATĂ → citire nemărginită (exact protecția pe care helperul o garantează). Fail-closed: aruncăm ÎNAINTE de citire.
 */
function assertValidMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes invalid");
}

/** Citește un ReadableStream de bytes cu plafon HARD (maxBytes inclusiv). Depășire → cancel + too_large (bounded în memorie). */
export async function readBoundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<BoundedBody> {
  assertValidMaxBytes(maxBytes);               // ÎNAINTE de body===null: un plafon invalid nu trebuie tolerat niciodată
  if (!body) return { ok: true, text: "" }; // fără body → text gol (parse-ul îl respinge oricum ca „câmp lipsă")
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); return { ok: false, reason: "too_large" }; } // abort ÎNAINTE de a păstra chunk-ul
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return { ok: true, text: new TextDecoder("utf-8").decode(buf) };
}

/** Fast-reject pe Content-Length: header prezent + număr finit > maxBytes → true. Lipsă/necunoscut → false (nu blochează). */
export function contentLengthExceeds(header: string | null | undefined, maxBytes: number): boolean {
  assertValidMaxBytes(maxBytes);
  if (!header) return false;
  const n = Number(header);
  return Number.isFinite(n) && n > maxBytes;
}
