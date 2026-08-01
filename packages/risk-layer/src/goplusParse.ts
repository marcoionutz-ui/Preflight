/**
 * @preflight/risk-layer — goplusParse.ts (E29)
 *
 * Frunză PURĂ (zero importuri) → testabilă în tsx.
 *
 * parseTaxPct: GoPlus documentează taxele ca FRACȚIE pe scala 0..1 (1 = 100%) — vezi
 * https://docs.gopluslabs.io/reference/response-details . Vechea logică `n <= 1 ? n*100 : n` trata orice valoare
 * > 1 drept „deja procent", ceea ce:
 *   - producea un fail-open pe date malformate (`false`/`[]`/`" "` → `Number(...)` = 0 → „0% tax" fals);
 *   - lăsa valori absurde (ex. 1.5) să treacă drept 1.5% în loc să fie marcate necunoscute.
 *
 * Fix (monoton, aliniat la spec, fail-safe): acceptăm DOAR string ne-gol sau number; orice non-finit, negativ sau
 * > 1 (în afara scalei 0..1 documentate) → `null` (necunoscut → clasificatorul îl tratează ca „tax unavailable",
 * NU ca „fără taxă"). `[0,1]` → ×100, rotunjit la 2 zecimale. Fără prag arbitrar, fără discontinuitate.
 */
export function parseTaxPct(v: unknown): number | null {
  // Acceptă doar string sau number — respinge boolean, array, object, null, undefined.
  if (typeof v !== "string" && typeof v !== "number") return null;
  // String gol / doar spații → necunoscut (NU 0; `Number(" ")` ar da 0 = fail-open).
  if (typeof v === "string" && v.trim() === "") return null;

  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // Scala GoPlus e 0..1 (1 = 100%). În afara ei = malformat → necunoscut, nu ghicim.
  if (n < 0 || n > 1) return null;

  return Math.round(n * 100 * 100) / 100;
}

/**
 * Statusuri HTTP GoPlus tranzitorii care merită un retry: 429 (rate limit) + 5xx real (500..599, erori server).
 * 4xx (cu excepția 429) sunt permanente (adresă invalidă, chain nesuportat); ≥600 nu-i un status HTTP valid → NU retry.
 */
export function isTransientGoPlusStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}
