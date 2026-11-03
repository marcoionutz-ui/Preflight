/**
 * lib/mcp/deployWindowFsReader.ts — cititorul de dovezi pe disc pentru verificatorul ferestrei `base-canary`.
 *
 * rev2 (cgpt P2): limita directorului e verificată pe DESTINAȚIA REALĂ, nu lexical. Directorul de dovezi se rezolvă o
 * dată cu `realpathSync`; fiecare cale cerută se rezolvă tot cu `realpathSync` (urmează symlink-uri / junction-uri pe
 * fiecare componentă) și e acceptată doar dacă rămâne în directorul real. Un fișier sau subdirector legat în afară →
 * `null` (tratat de verificator ca „lipsă”), fără să fie citit. Doar citire: nu scrie, nu creează, nu șterge.
 */
import fs from "node:fs";
import path from "node:path";
import type { EvidenceReader } from "./deployWindowVerify";

/** `null` dacă directorul de dovezi nu există sau nu e director. */
export function makeFsEvidenceReader(dir: string): EvidenceReader | null {
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(dir));
    if (!fs.statSync(root).isDirectory()) return null;
  } catch { return null; }

  /** Calea REALĂ a unei intrări din directorul de dovezi, sau `null` dacă lipsește ori iese din director. */
  const inside = (rel: string): string | null => {
    if (path.isAbsolute(rel)) return null;
    let real: string;
    try { real = fs.realpathSync(path.resolve(root, rel)); } catch { return null; }
    return real === root || real.startsWith(root + path.sep) ? real : null;
  };

  return {
    read(rel) {
      const real = inside(rel);
      if (real === null) return null;
      try { return fs.statSync(real).isFile() ? fs.readFileSync(real, "utf8") : null; } catch { return null; }
    },
    list(relDir) {
      const real = inside(relDir);
      if (real === null) return null;
      try { return fs.statSync(real).isDirectory() ? fs.readdirSync(real) : null; } catch { return null; }
    },
  };
}
