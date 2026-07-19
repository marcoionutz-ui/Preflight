/**
 * state/PairMap.ts — Faza B3.
 *
 * Map chain-scoped: cheia internă e `pairKey(chain, address)`, nu adresa goală.
 * Aceeași adresă pe chainuri EVM diferite → intrări DISTINCTE (fix P0-1).
 *
 * API-ul cere `chain` la fiecare acces (get/set/has/delete) — INTENȚIONAT:
 * migrarea map-urilor existente devine compile-error la fiecare call-site până
 * primește chain, deci zero omisiuni tăcute. Iterarea întoarce cheia decodată
 * (`PairRef { chain, address }`) prin `splitPairKey`.
 *
 * `value.chain` (dacă valoarea îl are) rămâne redundant cu cheia, dar inofensiv —
 * multe call-site-uri citesc `entry.chain`, deci nu-l scoatem în această fază.
 */

import { pairKey, splitPairKey, type PairRef, type PairKey } from "@preflight/schema";

export class PairMap<V> {
  private readonly m = new Map<PairKey, V>();

  get(chain: string, address: string): V | undefined {
    return this.m.get(pairKey(chain, address));
  }

  set(chain: string, address: string, value: V): this {
    this.m.set(pairKey(chain, address), value);
    return this;
  }

  has(chain: string, address: string): boolean {
    return this.m.has(pairKey(chain, address));
  }

  delete(chain: string, address: string): boolean {
    return this.m.delete(pairKey(chain, address));
  }

  get size(): number {
    return this.m.size;
  }

  clear(): void {
    this.m.clear();
  }

  values(): IterableIterator<V> {
    return this.m.values();
  }

  /** Iterează cu cheia decodată: `[{ chain, address }, value]`. */
  *entries(): IterableIterator<[PairRef, V]> {
    for (const [k, v] of this.m) yield [splitPairKey(k), v];
  }

  [Symbol.iterator](): IterableIterator<[PairRef, V]> {
    return this.entries();
  }
}
