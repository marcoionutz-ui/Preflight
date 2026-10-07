/**
 * scripts/beta1/cases/manifest.ts — BETA-1, felia 3: manifestul cazurilor rulate de supraveghetor.
 *
 * Deocamdată DOAR controalele pozitive. Cazurile de defect vin în felia următoare; până atunci, un cod de ieșire 0
 * înseamnă „controalele pozitive înregistrează swapul", nimic despre defecte și nimic despre BETA-1.
 *
 * NU importă fișierele de caz (ar porni un caz): id-urile sunt repetate aici și verificate de procesul de caz.
 */

import path from "node:path";
import type { RunnableCase } from "../harness/supervisor";

const CONTROLS_FILE = path.join(__dirname, "positiveControls.ts");

const CONTROL_IDS = [
  "C-V2-BUY", "C-V2-SELL", "C-V3-BUY", "C-V3-SELL", "C-V4-BUY", "C-V4-SELL", "C-STABLE-BUY", "C-STABLE-SELL",
];

export const CASES: RunnableCase[] = CONTROL_IDS.map((id): RunnableCase => ({
  id, kind: "control", section: "filter", file: CONTROLS_FILE,
}));
