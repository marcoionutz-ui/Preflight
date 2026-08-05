/**
 * lib/mcp/safeParse.ts — E8 (Zod la granițele de parse Redis).
 *
 * `safeJson<T>` (redis-reader.ts) valida DOAR sintaxa JSON, apoi făcea cast la `T` fără să verifice
 * forma → Redis putea conține orice și câmpurile consumate se scurgeau ca `undefined`/valori de tip
 * greșit. `parseWithSchema` adaugă validare de FORMĂ cu o schemă Zod: pe sintaxă invalidă SAU formă
 * neconformă → `fallback` (fail-closed) + log. Păstrează exact semnătura lui safeJson (tipul `T` e
 * declarat de apelant, ca înainte) — schema doar POARTĂ runtime-ul; passthrough păstrează câmpurile
 * necunoscute (forward-compat), deci `result.data` conține tot payload-ul valid.
 *
 * PUR (doar `zod`, import ușor) → testabil izolat în tsx.
 */
import type { ZodTypeAny } from "zod";

export function parseWithSchema<T>(
  raw:      string | null,
  schema:   ZodTypeAny,
  fallback: T,
  key?:     string,
): T {
  if (!raw) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (key) {
      console.warn(
        `[REDIS PARSE ERROR] key:${key} — invalid JSON, using fallback`,
        err instanceof Error ? err.message : err,
      );
    }
    return fallback;
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    if (key) {
      const issue = result.error.issues[0];
      const where = issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : result.error.message;
      console.warn(`[REDIS SHAPE ERROR] key:${key} — payload failed schema, using fallback — ${where}`);
    }
    return fallback;
  }

  // Schema a validat câmpurile CONSUMATE (+ passthrough restul). `T` rămâne declarat de apelant,
  // ca la safeJson — dar acum garantăm runtime forma câmpurilor pe care le folosim.
  return result.data as T;
}

/**
 * mergeChainRecords — merge al hărților `pairKey → entry` chain-scoped (B4) cu FAIL-CLOSED corect (review varu):
 * un payload prezent dar CORUPT (Zod îl respinge) NU e „cheie prezentă" și NU contribuie la `any`. Doar un parse
 * REUȘIT (inclusiv `{}` valid = chain viu fără intrări) setează `any` + `presentByChain[chain]=true`. Astfel
 * `pair_states="[1,2]"` nu mai devine `marketHasData=true`/regim DEAD (afirmație de piață din date corupte).
 *
 * PUR (doar parseWithSchema + Object.assign) → testabil izolat în tsx.
 */
export function mergeChainRecords<T>(
  raws:   readonly (string | null)[],
  chains: readonly string[],
  schema: ZodTypeAny,
  label?: string,
): { merged: Record<string, T>; any: boolean; presentByChain: Record<string, boolean> } {
  const merged: Record<string, T> = {};
  let any = false;
  const presentByChain: Record<string, boolean> = {};
  for (let i = 0; i < raws.length; i++) {
    const chain = chains[i];
    const raw   = raws[i];
    if (raw == null) { presentByChain[chain] = false; continue; }        // cheie absentă
    // fallback `null` (nu `{}`) → distinge CORUPT de `{}` valid: corupt → nu-i prezent, nu contribuie la `any`.
    const parsed = parseWithSchema<Record<string, T> | null>(raw, schema, null, label);
    if (parsed === null) { presentByChain[chain] = false; continue; }    // payload corupt / formă greșită
    any = true;
    presentByChain[chain] = true;
    Object.assign(merged, parsed);
  }
  return { merged, any, presentByChain };
}

/**
 * mergeChainArrays — merge al ARRAY-urilor per-chain (pipeline_events/recent_drops/pf_momentum/pf_pipeline/
 * pf_qualified/pf_lifecycle) cu validare PE ELEMENT (E8c-2). Înainte: `JSON.parse` + `Array.isArray` +
 * `push(...as T[])` — array-ul era validat doar la nivel de array, elementele curgeau nevalidate (garbage
 * la `.filter`/`.slice`/acces de câmp downstream). Acum fiecare element trece prin `schema`; elementele
 * INVALIDE sunt FILTRATE (validele rămân — un event corupt nu pierde toată lista chain-ului), iar `dropped>0`
 * marchează `allReadable=false` + warn. `any` rămâne pe prezența cheii (semantica E15: chain-ul „are cheia").
 *
 * `readableByIndex[i]` (E8c-2 varu R2) = lizibilitatea PER-INDEX cu ACEEAȘI schemă, ca drops-honesty
 * (`recentDropsReadableByChain`) să nu mai facă un `Array.isArray(JSON.parse)` root-only desincronizat de
 * validarea pe element: absent/JSON-invalid/non-array/orice-element-invalid → `false`; array all-valid
 * (inclusiv `[]`) → `true`. Elementele valide rămân în `merged` indiferent.
 *
 * PUR (doar zod + JSON) → testabil izolat în tsx.
 */
export function mergeChainArrays<T>(
  raws:   readonly (string | null)[],
  schema: ZodTypeAny,
  tsOf:   (x: T) => number,
  label?: string,
): { merged: T[]; any: boolean; allReadable: boolean; readableByIndex: boolean[] } {
  const merged: T[] = [];
  let any = false;
  let allReadable = true;
  const readableByIndex: boolean[] = [];
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];
    if (raw == null) { readableByIndex[i] = false; continue; }   // cheie absentă → nereadable per-index
    any = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      allReadable = false; readableByIndex[i] = false;
      if (label) console.warn(`[REDIS PARSE ERROR] key:${label} — invalid JSON, skipping`, err instanceof Error ? err.message : err);
      continue;
    }
    if (!Array.isArray(parsed)) {
      allReadable = false; readableByIndex[i] = false;
      if (label) console.warn(`[REDIS PARSE ERROR] key:${label} — not an array, skipping`);
      continue;
    }
    let dropped = 0;
    for (const el of parsed) {
      const r = schema.safeParse(el);
      if (r.success) merged.push(r.data as T);
      else dropped++;
    }
    if (dropped > 0) {
      allReadable = false; readableByIndex[i] = false; // payload parțial corupt → nereadable (drops-honesty)
      if (label) console.warn(`[REDIS SHAPE ERROR] key:${label} — ${dropped}/${parsed.length} elemente invalide, filtrate`);
    } else {
      readableByIndex[i] = true; // array all-valid (inclusiv gol) → readable
    }
  }
  merged.sort((a, b) => (Number(tsOf(b)) || 0) - (Number(tsOf(a)) || 0));
  return { merged, any, allReadable, readableByIndex };
}
