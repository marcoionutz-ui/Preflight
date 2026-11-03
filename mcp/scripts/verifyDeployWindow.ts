/**
 * scripts/verifyDeployWindow.ts — runner LOCAL pentru verificatorul ferestrei `base-canary` (design rev2 §11).
 *
 * Citește DOAR fișierele din directorul de dovezi dat (`--dir=<cale>`), prin `makeFsEvidenceReader` (limita
 * directorului verificată pe destinația REALĂ, inclusiv prin symlink / junction), le trece prin `verifyDeployWindow`
 * (pur) și tipărește raportul. Fără rețea, fără tokenuri, fără Railway, fără Redis, fără `.env`. Nu scrie nimic.
 *
 * Cod de ieșire: 0 = criterii automate îndeplinite (inclusiv C3a/C3b); 2 = criterii automate îndeplinite fără flux
 * (candidat NECONCLUDENT); 3 = criterii automate neîndeplinite; 4 = dovezi incomplete/invalide; 1 = argumente greșite
 * sau director inexistent. Niciun cod nu înseamnă verdictul final: logurile, operațiile manuale și consumul se verifică
 * separat.
 *
 * Rulare: npm run verify:deploy-window -w @preflight/mcp -- --dir=<directorul evidence> --commit=<sha deployat>
 */
import { verifyDeployWindow, renderReport, OUTCOME_EXIT } from "../lib/mcp/deployWindowVerify";
import { makeFsEvidenceReader } from "../lib/mcp/deployWindowFsReader";

/**
 * Lotul „Base canary”: commitul DEPLOYAT se dă explicit (`--commit=<sha>`, 7–40 hex), nu e fixat în cod — după
 * commitul lotului, `main` nu mai e `8b1ca61`, iar Railway deployează ultimul commit al ramurii. Runbook-ul cere ca
 * diferența față de `8b1ca61` să fie doar uneltele lotului (produsul identic).
 */
const argOf = (name: string): string | undefined => {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a === undefined ? undefined : a.slice(name.length + 3);
};
const dir = argOf("dir");
const commit = argOf("commit");
const reader = dir ? makeFsEvidenceReader(dir) : null;
if (!reader || commit === undefined || !/^[0-9a-f]{7,40}$/.test(commit)) {
  console.log("utilizare: verifyDeployWindow --dir=<directorul evidence existent> --commit=<sha deployat, 7–40 hex>");
  process.exitCode = 1;
} else {
  const report = verifyDeployWindow(reader, commit);
  console.log(renderReport(report));
  process.exitCode = OUTCOME_EXIT[report.outcome];
}
