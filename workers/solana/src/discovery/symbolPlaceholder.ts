/**
 * discovery/symbolPlaceholder.ts — E39 (guard placeholder simbol, anti-drift).
 *
 * Frunză PURĂ (zero importuri) → testabilă în tsx.
 *
 * Bug: când metadata nu are simbol, `priceTracker` scrie un placeholder = `mint.slice(0, 8)` (8 caractere, FĂRĂ
 * „..."). Guard-ul din `observedPool` care „actualizează simbolul doar dacă am primit unul mai bun (nu placeholder)"
 * compara însă cu `mint.slice(0, 7) + "..."` — un format care NU s-a scris niciodată → guard-ul nu se potrivea
 * niciodată → condiția era mereu adevărată → un simbol bun stocat putea fi suprascris de un placeholder ulterior.
 *
 * Fix: o SINGURĂ sursă a formatului de placeholder, folosită ÎN AMBELE — producer-ul (`priceTracker`) și guard-ul
 * (`observedPool`) — ca cele două să nu poată drifta niciodată (exact drift-ul de format a fost cauza bug-ului).
 */

/** Simbolul placeholder folosit când metadata nu are simbol: primele 8 caractere ale mint-ului. */
export function placeholderSymbol(mint: string): string {
  return mint.slice(0, 8);
}

/** `true` dacă `symbol` este placeholder-ul pentru `mint` (deci NU un simbol real din metadata enrichment). */
export function isPlaceholderSymbol(symbol: string, mint: string): boolean {
  return symbol === placeholderSymbol(mint);
}
