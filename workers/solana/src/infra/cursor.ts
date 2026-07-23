/**
 * infra/cursor.ts
 * Slot watermarks persistente în Redis pentru indexer-solana.
 * Analog cu block cursor din indexer-evm, dar pe Solana "slot" ≈ "block".
 *
 * C6 (F5/#6): SEPARĂ două watermark-uri distincte care înainte erau colapsate într-unul singur:
 *
 *   OBSERVED slot  (`advanceObservedSlot`) — cel mai mare slot pentru care am VĂZUT un log WS.
 *     Avansat la simpla observare, la fiecare event. E un semnal de LIVENESS (WS livrează logs
 *     aproape de head), NU o garanție că am procesat ceva. Înainte se numea „cursor" și era
 *     raportat de health CA ȘI CUM ar fi însemnat „am indexat tot până aici" → false positive.
 *
 *   PROCESSED slot (`advanceProcessedSlot`) — cel mai mare slot pentru care am SCRIS DURABIL un
 *     record (pool/launch inserted/exists confirmat). Avansat DOAR din drain, după ack. Plus
 *     `lastProcessedAt` (ms) = când a reușit ultima scriere.
 *
 * Fail-closed la citire (doctrina C4 EVM): parse STRICT — o valoare coruptă ARUNCĂ, nu e tratată
 * tăcut ca first-run. Compat: `readCursor`/`advanceCursor` rămân alias-uri (observed).
 */

import { getRedis } from "./redis";
import { KEY_CURSOR, KEY_PROCESSED_SLOT, KEY_PROCESSED_AT } from "../config/constants";

/**
 * Parse STRICT al unui watermark stocat (slot / timestamp ms). Fail-closed:
 *   null                → prima pornire (cheie absentă)
 *   doar cifre, >= 0    → valoarea
 *   orice altceva       → ARUNCĂ (coruptă — NU o trata ca first-run, ca în bug-ul C4 EVM)
 * `parseInt` accepta "123abc"→123, "12.5"→12, "-1"→-1 — exact ce evităm aici.
 */
export function parseStoredSlot(raw: string | null, key: string): number | null {
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`[SOLANA][CURSOR] ${key}: valoare coruptă "${raw}" — fail-closed`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`[SOLANA][CURSOR] ${key}: valoare invalidă "${raw}" — fail-closed`);
  }
  return n;
}

// ── OBSERVED slot (liveness WS) ────────────────────────────────────────────────

/** Citește OBSERVED slot. null = prima pornire. ARUNCĂ pe valoare coruptă (fail-closed). */
export async function readObservedSlot(): Promise<number | null> {
  const raw = await getRedis().get(KEY_CURSOR);
  return parseStoredSlot(raw, "observed");
}

/**
 * Avansează OBSERVED slot atomic via Lua (compare-and-set: doar dacă slot > current). Robust la
 * o valoare stocată ne-numerică: `tonumber(GET) or -1` → orice slot real o suprascrie (self-heal).
 * Semnal de liveness, NU de procesare.
 */
export async function advanceObservedSlot(slot: number): Promise<void> {
  await (getRedis() as any).eval(
    `local cur = tonumber(redis.call('GET', KEYS[1])) or -1
     local inc = tonumber(ARGV[1])
     if inc > cur then redis.call('SET', KEYS[1], ARGV[1]) end
     return 1`,
    1,
    KEY_CURSOR,
    String(slot),
  );
}

/** @deprecated alias istoric — „cursor" înseamnă OBSERVED slot. Folosește readObservedSlot(). */
export const readCursor = readObservedSlot;
/** @deprecated alias istoric — „cursor" înseamnă OBSERVED slot. Folosește advanceObservedSlot(). */
export const advanceCursor = advanceObservedSlot;

// ── PROCESSED slot (integritate write durabil) ─────────────────────────────────

/**
 * Citește PROCESSED slot. null = nimic scris încă. ARUNCĂ pe valoare coruptă (fail-closed).
 * NB: NU e un watermark gapless — write-urile sunt rare (doar la creare de pool), deci
 * `latest - processed` NU e o măsură de „în urmă". Onestitatea de health vine din starea cozii
 * (dead-letter / backlog vechi), nu din diferența de slot processed.
 */
export async function readProcessedSlot(): Promise<number | null> {
  const raw = await getRedis().get(KEY_PROCESSED_SLOT);
  return parseStoredSlot(raw, "processed");
}

/** Citește lastProcessedAt (ms epoch). null = niciuna. ARUNCĂ pe valoare coruptă (fail-closed). */
export async function readLastProcessedAt(): Promise<number | null> {
  const raw = await getRedis().get(KEY_PROCESSED_AT);
  return parseStoredSlot(raw, "lastProcessedAt");
}

/**
 * Avansează PROCESSED slot (compare-and-set: doar dacă slot > current, ordinea de drain e arbitrară)
 * ȘI setează lastProcessedAt = now (ÎNTOTDEAUNA, chiar dacă slotul e mai vechi). Un singur EVAL Lua.
 * Robust la valoare stocată ne-numerică (`tonumber(GET) or -1`).
 */
export async function advanceProcessedSlot(slot: number, nowMs: number = Date.now()): Promise<void> {
  await (getRedis() as any).eval(
    `local cur = tonumber(redis.call('GET', KEYS[1])) or -1
     local inc = tonumber(ARGV[1])
     if inc > cur then redis.call('SET', KEYS[1], ARGV[1]) end
     redis.call('SET', KEYS[2], ARGV[2])
     return 1`,
    2,
    KEY_PROCESSED_SLOT,
    KEY_PROCESSED_AT,
    String(slot),
    String(nowMs),
  );
}
