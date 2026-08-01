/**
 * pipeline/verticalBudget.ts — E36 (buget vertical numărat corect).
 *
 * Frunză PURĂ (doar un `import type`, zero importuri runtime) → testabilă în tsx.
 *
 * Bug: bugetul vertical (`scan.ts`: `currentVertical >= MAX_VERTICAL_WATCH`) număra DOAR `kind === "VERTICAL"`,
 * dar `verticalCandidatesLoop` (`loops/vertical.ts`) procesează ȘI `CONFIRMED_MOMENTUM` (varianta prioritară a
 * aceleiași benzi, adăugată tot în `scan.ts`). Deci banda verticală putea depăși `MAX_VERTICAL_WATCH`: fiecare
 * `CONFIRMED_MOMENTUM` ocupa un slot real de procesare, dar nu era numărat la buget.
 *
 * Fix: o SINGURĂ definiție a „ce intră în banda verticală", folosită ÎN AMBELE locuri — count-ul de buget din
 * `scan.ts` și filtrul din `loops/vertical.ts` — ca cele două să nu poată drifta niciodată una față de alta.
 */
import type { WatchKind } from "../state/stores";

/** `true` dacă un watch de acest `kind` e procesat de banda verticală (deci ocupă un slot din `MAX_VERTICAL_WATCH`). */
export function countsTowardVerticalBudget(kind: WatchKind | undefined): boolean {
  return kind === "VERTICAL" || kind === "CONFIRMED_MOMENTUM";
}
