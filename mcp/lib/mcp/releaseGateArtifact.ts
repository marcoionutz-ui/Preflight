/**
 * lib/mcp/releaseGateArtifact.ts — PH-12 12.5d-2 (primitivele de OWNERSHIP ale artefactului de release-gate, testabile în CI).
 *
 * Runner-ul `runReleaseGateLive.mjs` e `.mjs` opt-in (exclus din tsc/eslint/test). Logica lui critică de fișiere — directorul
 * fix DEȚINUT + PRIVAT, lock-ul exclusiv, scrierea atomică — trăiește AICI, într-un `.ts` typecheck-uit + testat (gate-14), iar
 * `.mjs`-ul o IMPORTĂ (source-guard în test). „Test verde pe helper ≠ producție wired": guard-ul de sursă dovedește cablarea.
 *
 * Garanții (verificate în `releaseGateArtifact.test.ts`, pe directoare temp REALE — fără servicii externe, CI-safe):
 *  - `ensureOwnedPrivateDir`: creăm dir-ul cu `0700`; dacă preexistă, TREBUIE să fie director REAL (nu symlink/fișier),
 *    DEȚINUT de noi (uid) și PRIVAT (fără biți group/other) — altfel fail-closed. Premisa de ownership e VERIFICATĂ, nu presupusă.
 *  - `acquireLock`/`releaseLock`: lock exclusiv `O_CREAT|O_EXCL` (pid). Al doilea run → `held`; lock stale (pid mort) → `stale`
 *    (raportat, fără auto-steal). Orice eroare de creare (inclusiv `writeSync` eșuat DUPĂ open) → curăță lock-ul pe jumătate
 *    creat + `error` (fail-closed complet). `releaseLock` întoarce `false` dacă nu poate șterge (apelantul avertizează).
 *  - `writeArtifactAtomic`: temp în ACELAȘI dir cu flag `wx` (`O_CREAT|O_EXCL` → un symlink pre-plantat pe temp NU e urmărit)
 *    → `rename` atomic (consumatorul nu vede niciodată un fișier parțial). Eșec → temp curățat + `false`.
 */
import { mkdirSync, lstatSync, openSync, closeSync, readFileSync, writeSync, writeFileSync, renameSync, rmSync, constants as FS } from "node:fs";
import path from "node:path";

function errCode(e: unknown): string | undefined {
  return (typeof e === "object" && e !== null && "code" in e) ? String((e as { code?: unknown }).code) : undefined;
}

/** Rezultatul verificării directorului deținut: `created`/`ok` = utilizabil; restul = fail-closed. */
export type DirCheck = "created" | "ok" | "not_a_dir" | "not_owned" | "insecure_perms" | "error";

/**
 * Creează (sau validează) directorul fix al artefactului. `selfUid` injectabil DOAR pentru test (default = uid-ul procesului;
 * `undefined` pe platforme non-POSIX → sărim verificarea de proprietar). Fail-closed: un dir preexistent care NU e al nostru
 * ori nu e privat (biți group/other) e RESPINS — nu-l refolosim (un adversar ar putea planta symlink-uri/fișiere în el).
 */
export function ensureOwnedPrivateDir(
  dir: string,
  selfUid: number | undefined = (typeof process.getuid === "function" ? process.getuid() : undefined),
): DirCheck {
  try { mkdirSync(dir, { mode: 0o700 }); return "created"; } // proaspăt → 0700 & deținut de noi (umask nu lărgește 0700)
  catch (e) { if (errCode(e) !== "EEXIST") return "error"; }
  let st;
  try { st = lstatSync(dir); } catch { return "error"; }     // lstat: un symlink pe locul dir-ului NU e urmărit
  if (!st.isDirectory()) return "not_a_dir";                 // symlink/fișier pe cale
  if (selfUid !== undefined && st.uid !== selfUid) return "not_owned";
  if ((st.mode & 0o077) !== 0) return "insecure_perms";      // orice bit group/other → nu e privat
  return "ok";
}

export type LockOutcome = "acquired" | "held" | "stale" | "error";
export interface LockResult { result: LockOutcome; pid?: number; }

function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; }                 // fără semnal — doar test de existență
  catch (e) { return errCode(e) === "EPERM"; }               // EPERM = există dar nu e al nostru → viu; ESRCH = mort
}

/**
 * Lock exclusiv via `O_CREAT|O_EXCL`. `acquired` = îl deținem (pid scris). `held` = un alt proces viu îl ține. `stale` = pid
 * mort (crash) — raportat pentru ștergere manuală, FĂRĂ auto-steal (ar avea propria cursă). `error` = orice altă eroare de
 * creare, INCLUSIV un `writeSync` eșuat DUPĂ open (curățăm lock-ul pe jumătate creat → nu lăsăm un lock fără pid).
 */
// `writeFd` e injectabil DOAR pentru test (să forțăm eșecul lui `writeSync` DUPĂ open → ramura de cleanup + `error`).
export function acquireLock(
  lockPath: string,
  selfPid: number = process.pid,
  writeFd: (fd: number, data: string) => void = (fd, data) => { writeSync(fd, data); },
): LockResult {
  let fd: number;
  try { fd = openSync(lockPath, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY, 0o600); }
  catch (e) {
    if (errCode(e) === "EEXIST") {
      let pid = 0;
      try { pid = parseInt(String(readFileSync(lockPath, "utf8")).trim(), 10) || 0; } catch { pid = 0; }
      return pidAlive(pid) ? { result: "held", pid: pid || undefined } : { result: "stale", pid: pid || undefined };
    }
    return { result: "error" };
  }
  try { writeFd(fd, String(selfPid)); }
  catch {
    try { closeSync(fd); } catch { /* */ }
    try { rmSync(lockPath, { force: true }); } catch { /* */ } // curăță lock-ul pe jumătate creat (fail-closed complet)
    return { result: "error" };
  }
  try { closeSync(fd); } catch { /* */ }
  return { result: "acquired" };
}

/**
 * Eliberează lock-ul. `true` = șters (sau deja absent); `false` = NU s-a putut șterge → apelantul TREBUIE să marcheze run-ul
 * ca eșuat (lock stale rămas = cleanup incomplet). `rm` e injectabil DOAR pentru test (să forțăm ramura de eșec).
 */
export function releaseLock(lockPath: string, rm: (p: string) => void = (p) => rmSync(p, { force: true })): boolean {
  try { rm(lockPath); return true; }
  catch { return false; }
}

/** Numele fișierului temporar (injectabil DOAR pentru test — să putem pre-planta un symlink pe el). */
export function defaultTmpName(dir: string, pid: number = process.pid): string {
  return path.join(dir, `.report.${pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
}

/**
 * Scriere ATOMICĂ: temp în ACELAȘI director cu flag `wx` (`O_CREAT|O_EXCL` → un symlink pre-plantat pe temp NU e urmărit,
 * EEXIST → eșec) → `rename` (atomic; consumatorul nu vede niciodată un fișier parțial). Eșec → temp curățat + `false`.
 */
export function writeArtifactAtomic(
  dir: string, dest: string, text: string, makeTmp: (dir: string) => string = defaultTmpName,
): boolean {
  const tmp = makeTmp(dir);
  try {
    writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    renameSync(tmp, dest);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    return false;
  }
}

/**
 * Finalizare la CLEANUP EȘUAT (ex. lock ne-eliberat): artefactul de pe disc (posibil VERDE, scris de emit) NU trebuie să
 * rămână verde după un run al cărui cleanup a eșuat — altfel exit-code-ul (roșu) și artefactul (verde) se contrazic.
 * Suprascrie artefactul cu `redText` (raport `malformed` roșu); dacă suprascrierea eșuează, ȘTERGE artefactul → ABSENȚĂ
 * (tot ne-verde). `dir`/`dest` sunt în directorul deținut+privat, deci scrierea/ștergerea sunt sigure. Întoarce `true` dacă
 * la final artefactul e garantat NE-verde (malformed scris SAU absent), `false` doar dacă nici ștergerea n-a reușit.
 */
export function demoteArtifactOnCleanupFailure(dir: string, dest: string, redText: string): boolean {
  if (writeArtifactAtomic(dir, dest, redText)) return true;
  try { rmSync(dest, { force: true }); return true; } catch { return false; }
}
