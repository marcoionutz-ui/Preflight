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
