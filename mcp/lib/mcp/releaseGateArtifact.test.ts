/**
 * lib/mcp/releaseGateArtifact.test.ts — PH-12 12.5d-2. Lifecycle-ul critic al artefactului de release-gate, testat în CI pe
 * directoare temp REALE (fără servicii externe). Cablat în `test:ph12-canary` (gate-14). + source-guard că runner-ul `.mjs`
 * IMPORTĂ și FOLOSEȘTE aceste primitive („test verde pe helper ≠ producție wired").
 * Rulează: `tsx lib/mcp/releaseGateArtifact.test.ts` din mcp/.
 */
import {
  mkdirSync, mkdtempSync, lstatSync, chmodSync, writeFileSync, readFileSync, symlinkSync, existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ensureOwnedPrivateDir, acquireLock, releaseLock, writeArtifactAtomic, defaultTmpName, demoteArtifactOnCleanupFailure,
} from "./releaseGateArtifact";

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) failures++;
}

const ROOT = mkdtempSync(path.join(tmpdir(), "relgate-art-"));
const uid: number | undefined = (typeof process.getuid === "function" ? process.getuid() : undefined);

// ── A. ensureOwnedPrivateDir ──────────────────────────────────────────────────────────────────────────────
{
  const fresh = path.join(ROOT, "a-fresh");
  check("A1 created (fresh mkdir 0700)", ensureOwnedPrivateDir(fresh, uid) === "created");
  check("A1b dir chiar are mode 0700", (lstatSync(fresh).mode & 0o777) === 0o700);
  check("A2 ok (idempotent pe dir deținut+privat)", ensureOwnedPrivateDir(fresh, uid) === "ok");

  const asFile = path.join(ROOT, "a-file"); writeFileSync(asFile, "x");
  check("A3 not_a_dir (fișier pe cale)", ensureOwnedPrivateDir(asFile, uid) === "not_a_dir");

  const realTgt = path.join(ROOT, "a-realdir"); mkdirSync(realTgt, { mode: 0o700 });
  const asLink = path.join(ROOT, "a-link"); symlinkSync(realTgt, asLink);
  check("A4 not_a_dir (symlink pe cale, lstat nu urmărește)", ensureOwnedPrivateDir(asLink, uid) === "not_a_dir");

  const loose = path.join(ROOT, "a-loose"); mkdirSync(loose, { mode: 0o700 }); chmodSync(loose, 0o777);
  check("A5 insecure_perms (biți group/other)", ensureOwnedPrivateDir(loose, uid) === "insecure_perms");
  const grp = path.join(ROOT, "a-grp"); mkdirSync(grp, { mode: 0o700 }); chmodSync(grp, 0o750);
  check("A5b insecure_perms (doar bit group)", ensureOwnedPrivateDir(grp, uid) === "insecure_perms");

  // not_owned: dir-ul e al nostru, dar pretindem că uid-ul nostru e altul → st.uid ≠ selfUid.
  const owned = path.join(ROOT, "a-owned"); mkdirSync(owned, { mode: 0o700 });
  if (uid !== undefined) check("A6 not_owned (uid injectat diferit)", ensureOwnedPrivateDir(owned, uid + 1) === "not_owned");
  else check("A6 not_owned (skip pe non-POSIX)", true);
  // selfUid undefined → sărim verificarea de proprietar (dir privat rămâne ok)
  check("A6b selfUid undefined → ok (fără check de owner)", ensureOwnedPrivateDir(owned, undefined) === "ok");

  // A7 (ramura de failure "error"): mkdir eșuează non-EEXIST (părinte inexistent) → error, nu creat/ok.
  check("A7 error (mkdir cu părinte inexistent)", ensureOwnedPrivateDir(path.join(ROOT, "no-parent", "child"), uid) === "error");
}

// ── B. acquireLock / releaseLock ──────────────────────────────────────────────────────────────────────────
{
  const gd = path.join(ROOT, "b-gate"); mkdirSync(gd, { mode: 0o700 });
  const LOCK = path.join(gd, ".lock");
  const r1 = acquireLock(LOCK);
  check("B1 acquired", r1.result === "acquired" && existsSync(LOCK));
  check("B1b lock conține pid-ul nostru", parseInt(readFileSync(LOCK, "utf8").trim(), 10) === process.pid);
  check("B2 held (al doilea acquire, pid viu)", acquireLock(LOCK).result === "held");
  check("B3 releaseLock → true + șters", releaseLock(LOCK) === true && !existsSync(LOCK));
  check("B3b releaseLock pe absent → true", releaseLock(LOCK) === true);
  check("B4 re-acquire după release → acquired", acquireLock(LOCK).result === "acquired");
  releaseLock(LOCK);

  // stale: lock cu pid mort (999999 nu rulează).
  writeFileSync(LOCK, "999999");
  const rs = acquireLock(LOCK);
  check("B5 stale (pid mort)", rs.result === "stale" && rs.pid === 999999);
  rmSync(LOCK, { force: true });

  // error: lock într-un director inexistent → open ENOENT (≠ EEXIST) → error.
  check("B6 error (dir inexistent)", acquireLock(path.join(gd, "nope", ".lock")).result === "error");

  // B7 (ramura de failure P1b): writeSync eșuează DUPĂ open → error + lock-ul pe jumătate creat e CURĂȚAT (nu rămâne fără pid).
  const L7 = path.join(gd, ".lock7");
  const r7 = acquireLock(L7, process.pid, () => { throw new Error("write boom"); });
  check("B7 writeSync-fail → error", r7.result === "error");
  check("B7b lock-ul pe jumătate creat e curățat (absent)", !existsSync(L7));

  // B8 (ramura de failure a lui releaseLock): rm aruncă → false (apelantul marchează run-ul ca eșuat).
  const L8 = path.join(gd, ".lock8"); writeFileSync(L8, String(process.pid));
  check("B8 releaseLock rm-fail → false", releaseLock(L8, () => { throw new Error("rm boom"); }) === false);
  rmSync(L8, { force: true });
}

// ── C. writeArtifactAtomic ────────────────────────────────────────────────────────────────────────────────
{
  const gd = path.join(ROOT, "c-gate"); mkdirSync(gd, { mode: 0o700 });
  const dest = path.join(gd, "report.json");
  const payload = JSON.stringify({ version: 1, ok: true }, null, 2) + "\n";
  check("C1 happy write → true", writeArtifactAtomic(gd, dest, payload) === true);
  check("C1b conținut EXACT (nu parțial)", readFileSync(dest, "utf8") === payload);
  const payload2 = JSON.stringify({ version: 1, ok: false }, null, 2) + "\n";
  check("C2 overwrite atomic peste artefactul vechi", writeArtifactAtomic(gd, dest, payload2) === true && readFileSync(dest, "utf8") === payload2);

  // wx: temp pre-plantat ca SYMLINK → writeFileSync(wx) EEXIST → false, ținta symlink-ului NEATINSă, dest neschimbat.
  const victim = path.join(gd, "victim.txt"); writeFileSync(victim, "SACRU");
  const fixedTmp = path.join(gd, "fixed.tmp"); symlinkSync(victim, fixedTmp);
  const wrote = writeArtifactAtomic(gd, dest, "ATTACK\n", () => fixedTmp);
  check("C3 wx blochează temp-symlink → false", wrote === false);
  check("C3b ținta symlink-ului NEATINSă", readFileSync(victim, "utf8") === "SACRU");
  check("C3c dest NEschimbat (rămâne payload2)", readFileSync(dest, "utf8") === payload2);

  // failure: rename către un subdir inexistent → false (temp curățat).
  check("C4 failure (dest în subdir inexistent) → false", writeArtifactAtomic(gd, path.join(gd, "missing", "r.json"), payload) === false);
  check("C4b defaultTmpName e în același dir", path.dirname(defaultTmpName(gd)) === gd);
}

// ── E. demoteArtifactOnCleanupFailure (finalizare la cleanup eșuat: artefactul NU rămâne verde) ───────────────
{
  const gd = path.join(ROOT, "e-gate"); mkdirSync(gd, { mode: 0o700 });
  const dest = path.join(gd, "report.json");
  const green = JSON.stringify({ version: 1, ok: true, malformed: false }, null, 2) + "\n";
  const red   = JSON.stringify({ version: 1, ok: false, malformed: true }, null, 2) + "\n";
  // Artefact VERDE pe disc (ca după un emit verde) + cleanup eșuat → demote SUPRASCRIE cu roșu.
  writeFileSync(dest, green);
  check("E1 demote suprascrie verde → true", demoteArtifactOnCleanupFailure(gd, dest, red) === true);
  check("E1b artefactul de pe disc e ROȘU (nu mai e verde)", readFileSync(dest, "utf8") === red && readFileSync(dest, "utf8") !== green);
  // Fallback: dacă suprascrierea eșuează (dir inexistent → rename ENOENT), demote ȘTERGE dest → absență (tot ne-verde).
  const gone = path.join(ROOT, "e-missing"); // dir inexistent
  const destGone = path.join(gone, "report.json");
  check("E2 demote cu suprascriere imposibilă → true (fallback)", demoteArtifactOnCleanupFailure(gone, destGone, red) === true);
  check("E2b dest absent (ne-verde prin absență)", !existsSync(destGone));
}

// ── D. source-guard: runner-ul .mjs IMPORTĂ și FOLOSEȘTE primitivele (producție wired) ────────────────────
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runnerPath = path.resolve(here, "../../runReleaseGateLive.mjs");
  let src = "";
  try { src = readFileSync(runnerPath, "utf8"); } catch { src = ""; }
  check("D0 runner-ul .mjs e prezent", src.length > 0);
  check("D1 importă din releaseGateArtifact", /from\s+["']\.\/lib\/mcp\/releaseGateArtifact\.ts["']/.test(src));
  for (const fn of ["ensureOwnedPrivateDir", "acquireLock", "releaseLock", "writeArtifactAtomic", "demoteArtifactOnCleanupFailure"]) {
    check("D2 folosește " + fn, new RegExp("\\b" + fn + "\\s*\\(").test(src));
  }
}

rmSync(ROOT, { recursive: true, force: true });
console.log(failures === 0 ? "\nrelegateArtifact: ALL GREEN ✅" : `\nrelegateArtifact: ${failures} FAIL ❌`);
process.exit(failures === 0 ? 0 : 1);
