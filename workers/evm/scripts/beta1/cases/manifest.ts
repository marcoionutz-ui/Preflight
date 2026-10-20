/**
 * scripts/beta1/cases/manifest.ts — BETA-1: manifestul cazurilor rulate de supraveghetor.
 *
 * Felia 3: cele opt controale pozitive. Felia 4: două controale PERECHE și cazurile de defect din §7.2–§7.7 ale
 * designului. Felia D1 (fixul §4.5): patru controale `D1-DS-*` care afirmă comportamentul REPARAT; cazul D1 e
 * RETRAS (marker `BETA1-D1-FIX`) și nu mai e rulat. Felia T1 (fixul §4.4, Pancake): trei controale `C-PANCAKE-*`
 * (BUY, SELL și forma trunchiată, refuzată tăcut); T1, T1-LP și T1-FORCED sunt RETRASE (marker `BETA1-T1-FIX`).
 * Felia T2 (fixul §4.4, Aerodrome clasic): nouă controale `C-AERO-*` (swap, forme invalide, Mint, Burn); T2 RETRAS
 * (marker `BETA1-T2-FIX`). Felia V4L (topicul V4 `ModifyLiquidity`): controlul `C-V4-LIQ` (rutare diagnostică);
 * niciun caz retras. Supraveghetorul rulează ÎNTÂI toate controalele; un caz de defect se rulează și se
 * interpretează numai dacă toate cele 27 de controale au dat `CONTROL_OK`.
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
  // Felia D1: acceptarea fixului pe traseul real — pool DexScreener; swap BUY/SELL, LP Mint/Burn.
  "D1-DS-BUY", "D1-DS-SELL", "D1-DS-LP-ADD", "D1-DS-LP-REMOVE",
  // Felia T1: acceptarea fixului pe traseul real — pool PancakeSwap V3; swap BUY/SELL, formă trunchiată.
  "C-PANCAKE-BUY", "C-PANCAKE-SELL", "C-PANCAKE-SHORT",
  // Felia T2: acceptarea fixului pe traseul real — pool Aerodrome clasic pe ruta V2.
  "C-AERO-BUY", "C-AERO-SELL", "C-AERO-SHORT", "C-AERO-SWAP-LONG", "C-AERO-SWAP-NONSTRING",
  "C-AERO-LP-ADD", "C-AERO-LP-REMOVE", "C-AERO-BURN-LONG", "C-AERO-BURN-NONSTRING",
  // Felia V4L: rutarea diagnostică a `ModifyLiquidity` V4 (linia `[V4 LIQ]`, fără înregistrări).
  "C-V4-LIQ",
];

const DEFECT_SPECS: Array<Pick<RunnableCase, "id" | "kind" | "section">> = [
  { id: "M1",        kind: "defect",  section: "filter"  },
  { id: "M2",        kind: "defect",  section: "filter"  },
  { id: "P1",        kind: "defect",  section: "filter"  },
  { id: "M1-FORCED", kind: "defect",  section: "forced"  },
  { id: "X1",        kind: "partial", section: "partial" },
];

export const CASES: RunnableCase[] = [
  ...CONTROL_IDS.map((id): RunnableCase => ({ id, kind: "control", section: "filter", file: CONTROLS_FILE })),
  ...DEFECT_SPECS.map((s): RunnableCase => ({ ...s, file: DEFECTS_FILE })),
];
