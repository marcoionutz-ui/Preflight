/**
 * infra/wsWatchdog.ts — D1 (Solana WS hard-stall watchdog).
 *
 * BUG-ul din familia Fazei D (pandant Solana al zombie-ului EVM): `@solana/web3.js` multiplexează TOATE
 * subscripțiile `onLogs` peste UN SINGUR WebSocket al `Connection`-ului. Dacă acel socket se blochează tăcut
 * (TCP viu, dar serverul nu mai livrează notificări — „half-open"/wedged), web3.js NU emite eroare și NU
 * reconectează de la sine → toate cele 4 subscripții de discovery amuțesc simultan, procesul rămâne „viu"
 * (event loop-ul se învârte, health-ul poate arăta STARTING/BEHIND), dar discovery-ul e ZERO pe veci.
 *
 * D2 raportează deja moartea PARȚIALĂ (un program critic tăcut → DEGRADED). D1 tratează moartea TOTALĂ a
 * socketului: dacă TOATE programele critice au livrat cândva un log în procesul CURENT dar toate au tăcut de
 * mai mult de `stallMs`, socketul comun e mort → nu are rost să reparăm subscripție-cu-subscripție într-un
 * proces wedged → `process.exit(1)` (call-site) → process manager-ul (Railway) repornește curat cu un
 * `Connection` proaspăt. Decizia e PURĂ (fără Connection/timere) → testabilă izolat.
 *
 * De ce `every` (TOATE critice), nu `some`: un subset tăcut poate fi un program genuin liniștit sau o
 * singură subscripție picată — asta e treaba lui D2 (DEGRADED, raportare), NU un motiv să omori tot procesul
 * (ar produce restart-loops). Doar tăcerea SIMULTANĂ a tuturor programelor critice indică socketul comun mort.
 *
 * Cum tratăm `lastLogAgeMs === null` (program care n-a livrat NICIODATĂ un log în procesul curent): NU e
 * „necunoscut, nu acționa niciodată" — ar masca stall-ul total pe veci (un singur critic rămas null ar face
 * `every` fals la nesfârșit, inclusiv când socketul e mort chiar de la startup). `null` înseamnă „tăcut de la
 * pornirea subscripțiilor", deci vârsta lui de tăcere = `subscriptionsAgeMs` (cât timp rulează subscripțiile).
 * Astfel, la pornire (sesiune tânără < `stallMs`) un null NU declanșează (socketul poate încă se conectează),
 * dar după ce sesiunea depășește `stallMs` cu programul tot tăcut → e stall real, nu ignorat.
 */

export interface ProgramLiveness {
  program:      string;
  critical:     boolean;
  lastLogAgeMs: number | null; // ms de la ultimul log în procesul CURENT; null = niciodată în acest proces
}

/**
 * Hard stall al WS-ului Solana = FIECARE program CRITIC a tăcut mai mult de `stallMs`. Vârsta de tăcere a
 * unui program:
 *   - a livrat cândva în procesul curent (`lastLogAgeMs !== null`) → chiar `lastLogAgeMs`;
 *   - n-a livrat niciodată (`null`) → `subscriptionsAgeMs` (tăcut de la pornirea subscripțiilor).
 * Întoarce `false` dacă nu există programe critice. Un subset tăcut (restul proaspete) NU e stall total —
 * asta e treaba lui D2 (DEGRADED); doar tăcerea SIMULTANĂ a tuturor criticelor = socketul comun mort.
 */
export function isWsStalled(
  programs: readonly ProgramLiveness[],
  stallMs: number,
  subscriptionsAgeMs: number,
): boolean {
  const critical = programs.filter((p) => p.critical);
  if (critical.length === 0) return false; // fără programe critice → nimic de vegheat
  return critical.every((p) => (p.lastLogAgeMs ?? subscriptionsAgeMs) > stallMs);
}
