/**
 * scripts/beta1/cases/manifest.ts — BETA-1: manifestul cazurilor rulate de supraveghetor.
 *
 * Felia 3: cele opt controale pozitive. Felia 4: două controale PERECHE și cazurile de defect din §7.2–§7.7 ale
 * designului. Supraveghetorul rulează ÎNTÂI toate controalele; un caz de defect se rulează și se interpretează
 * numai dacă toate cele zece controale au dat `CONTROL_OK`.
 *
 * Secțiunile de raport nu se amestecă: `filter` (prin filtrul nodului local), `forced` (livrare forțată),
 * `partial` (X1). Un cod de ieșire 0 înseamnă „experiment valid, predicții confirmate" — adică defectele din
 * diagnostic se reproduc pe aceste montaje sintetice. NU înseamnă produs sănătos și nu stabilește cauza din
 * 2026-09-08.
 *
 * NU importă fișierele de caz (ar porni un caz) și nici definițiile lor: id-urile, felul și secțiunea sunt
 * repetate aici și verificate de procesul de caz și de supraveghetor.
 */

import path from "node:path";
import type { RunnableCase } from "../harness/supervisor";

const CONTROLS_FILE = path.join(__dirname, "positiveControls.ts");
const DEFECTS_FILE  = path.join(__dirname, "defectCases.ts");

const CONTROL_IDS = [
  "C-V2-BUY", "C-V2-SELL", "C-V3-BUY", "C-V3-SELL", "C-V4-BUY", "C-V4-SELL", "C-STABLE-BUY", "C-STABLE-SELL",
  // Controalele pereche ale lui D1 și P1 (același log, o singură variabilă schimbată).
  "D1-CONTROL", "P1-CONTROL",
];

const DEFECT_SPECS: Array<Pick<RunnableCase, "id" | "kind" | "section">> = [
  { id: "M1",        kind: "defect",  section: "filter"  },
  { id: "M2",        kind: "defect",  section: "filter"  },
  { id: "D1",        kind: "defect",  section: "filter"  },
  { id: "T1",        kind: "defect",  section: "filter"  },
  { id: "T1-LP",     kind: "defect",  section: "filter"  },
  { id: "T2",        kind: "defect",  section: "filter"  },
  { id: "P1",        kind: "defect",  section: "filter"  },
  { id: "M1-FORCED", kind: "defect",  section: "forced"  },
  { id: "T1-FORCED", kind: "defect",  section: "forced"  },
  { id: "X1",        kind: "partial", section: "partial" },
];

export const CASES: RunnableCase[] = [
  ...CONTROL_IDS.map((id): RunnableCase => ({ id, kind: "control", section: "filter", file: CONTROLS_FILE })),
  ...DEFECT_SPECS.map((s): RunnableCase => ({ ...s, file: DEFECTS_FILE })),
];
