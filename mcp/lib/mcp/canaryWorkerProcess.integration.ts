/**
 * lib/mcp/canaryWorkerProcess.integration.ts — PH-12 12.5c-3a (lifecycle de proces, INTEGRATION opt-in, POSIX/WSL).
 *
 * Dovedește adaptorul REAL (`spawnManagedProcess` + `stopManagedProcess` + `realStopTimers`) pe procese copil REALE,
 * plus BACKSTOP-ul de siguranță al harness-ului. Cazuri:
 *   1. lider SIGTERM→exit 0, fără nepoți                → {ok:true}; teardown confirmat (grup gone + reap) → latch imediat.
 *   2. lider IGNORĂ SIGTERM                             → SIGKILL → stop_timeout; grup gone + reap confirmate.
 *   3. lider ignoră + NEPOT (același grup)              → group-kill → tot grupul dispare.
 *   4. lider IESE 0 dar NEPOTUL ignoră SIGTERM          → ROȘU (stop_timeout) + nepot ucis.
 *   5. buffer stderr > 64KB cu SECRET pe limită         → doar marker static, secret ABSENT.
 *   D1 (în caz 1): teardown confirmat ⇒ intrare LATCH-uită IMEDIAT (înainte de alt start).
 *   D2: intrare latch-uită (simulare PGID reutilizat)   → sweep-ul NU o semnalează.
 *   D3: excepție cu GRUP ACTIV (lider viu)              → backstop SIGKILL + confirmă grup dispărut ȘI reap-ul liderului.
 *   D4: lider reap-uit + nepot viu + excepție           → backstop (pe groupAlive) omoară nepotul orfan.
 *
 * BACKSTOP-ul harness-ului: registrul ține `ManagedProc` (nu doar `pid`); sweep-ul cere AMBELE dovezi — grup dispărut ȘI
 * `waitExit()` rezolvat (ca `confirmTeardown` din modul). Latch-ul (`settled`) e setat la CONFIRMAREA teardown-ului,
 * ÎNAINTE să pornească alt proces → un pgid reutilizat între timp nu mai e semnalat (nu lovim un grup STRĂIN).
 *
 * `.integration.ts` → opt-in, NU gate-14. Cablat în `test:ph12-canary-worker` (în `test:integration`). POSIX-only.
 * Rulează local: `npx tsx lib/mcp/canaryWorkerProcess.integration.ts`.
 */

import { spawnManagedProcess, stopManagedProcess, realStopTimers, isGroupAliveFromProbe, type ManagedProc, type ManagedStopResult } from "./canaryWorkerProcess";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// DOAR ESRCH ⇒ dispărut; orice altă eroare ⇒ fail-closed VIU (refolosim predicatul modulului, nu vechiul fail-open).
function alive(pid: number): boolean { try { process.kill(pid, 0); return isGroupAliveFromProbe(null); } catch (e) { return isGroupAliveFromProbe(e as NodeJS.ErrnoException); } }
function groupAlive(pid: number): boolean { try { process.kill(-pid, 0); return isGroupAliveFromProbe(null); } catch (e) { return isGroupAliveFromProbe(e as NodeJS.ErrnoException); } }
async function waitGone(pid: number, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (!alive(pid)) return true; await sleep(50); }
  return !alive(pid);
}
async function waitGroupGone(pid: number, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (!groupAlive(pid)) return true; await sleep(50); }
  return !groupAlive(pid);
}
/** `waitExit()` rezolvat (reap) în `ms`, altfel `false` — mărginit. Timerul pierzător e ANULAT când reap-ul câștigă
 *  (fără timer rămas activ care să țină event-loop-ul viu — P2). */
function raceReaped(proc: ManagedProc, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const settle = (v: boolean) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => settle(false), ms);
    // FULFILL ⇒ reap confirmat (true); REJECT (eroare) NU e dovadă de reap ⇒ false (fail-closed, nu transformăm o eroare în succes).
    proc.waitExit().then(() => settle(true), () => settle(false));
  });
}

const NODE = process.execPath;

// Registrul ține `ManagedProc` (pt. dovada de reap). `settled` = teardown CONFIRMAT (grup dispărut + reap) → latch: nu-l
// mai atingem (un pgid reutilizat între timp NU e semnalat).
const registry: Array<{ proc: ManagedProc; settled: boolean }> = [];
function settle(proc: ManagedProc): void { const e = registry.find((x) => x.proc === proc); if (e) e.settled = true; }
async function start(script: string, env: Record<string, string> = {}) {
  const r = await spawnManagedProcess({ command: NODE, args: ["-e", script], cwd: process.cwd(), env: { ...process.env, ...env } as Record<string, string> });
  if (r.ok) registry.push({ proc: r.proc, settled: false });
  return r;
}
/** Backstop async + BOUNDED: pentru intrările NElatch-uite, dacă grupul e viu → SIGKILL; apoi cere AMBELE dovezi (grup
 *  dispărut ȘI `waitExit()` rezolvat) și latch-uiește. `true` DOAR dacă toate confirmate. */
async function sweepGroups(): Promise<boolean> {
  let allGone = true;
  for (const e of registry) {
    if (e.settled) continue;                                     // teardown deja confirmat → anti reuse de PID
    const pid = e.proc.pid;
    if (groupAlive(pid)) { try { process.kill(-pid, "SIGKILL"); } catch { /* dispărut */ } }
    const groupGone = await waitGroupGone(pid, 3_000);
    const reaped    = await raceReaped(e.proc, 3_000);
    if (groupGone && reaped) e.settled = true; else allGone = false;
  }
  return allGone;
}
/** Oprește și LATCH-uiește IMEDIAT din `res.teardownConfirmed` — FĂRĂ re-sondarea pgid-ului (modulul a confirmat deja
 *  intern grup dispărut + reap, sincron cu rezultatul → nicio fereastră de reutilizare de PID între stop și latch). */
async function teardownAndLatch(proc: ManagedProc, timing: { workerShutdownGraceMs: number }): Promise<ManagedStopResult> {
  const res = await stopManagedProcess(proc, timing, realStopTimers);
  if (res.teardownConfirmed) settle(proc);
  return res;
}

async function main(): Promise<void> {
  console.log("PH-12 12.5c-3a — lifecycle de proces (INTEGRATION, procese reale)");

  if (process.platform === "win32") {
    console.log("  SKIP  win32 — group-kill POSIX indisponibil (rulează în WSL/CI Linux)");
    console.log("\n0 passed, 0 failed (skip)");
    return;
  }

  const workdir = mkdtempSync(join(tmpdir(), "canary-worker-"));
  async function waitFile(path: string, ms: number): Promise<boolean> {
    const t0 = Date.now();
    while (!existsSync(path) && Date.now() - t0 < ms) await sleep(25);
    return existsSync(path);
  }

  try {
    // ── 1. SIGTERM → exit 0, fără nepoți → curat + D1 (latch imediat) ──
    {
      const ready = join(workdir, "ready1");
      const script = `process.on('SIGTERM',()=>{setTimeout(()=>process.exit(0),50)});require('fs').writeFileSync(process.env.READY,'1');setInterval(()=>{},1000);`;
      const s = await start(script, { READY: ready });
      check("1a. spawn OK", s.ok === true);
      if (s.ok) {
        check("1b. READY", await waitFile(ready, 3_000));
        const res = await teardownAndLatch(s.proc, { workerShutdownGraceMs: 3_000 });
        check("1c. → {ok:true}", res.ok === true);
        check("1d. teardownConfirmed (grup dispărut + reap)", res.teardownConfirmed === true);
        check("1e. ⭐ D1: LATCH-uit IMEDIAT din rezultat, FĂRĂ re-sondarea pgid-ului", registry.find((x) => x.proc === s.proc)?.settled === true);
      }
    }

    // ── 2. ignoră SIGTERM → SIGKILL → stop_timeout ──
    {
      const ready = join(workdir, "ready2");
      const script = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.env.READY,'1');setInterval(()=>{},1000);`;
      const s = await start(script, { READY: ready });
      check("2a. spawn OK", s.ok === true);
      if (s.ok) {
        check("2b. READY", await waitFile(ready, 3_000));
        const res = await teardownAndLatch(s.proc, { workerShutdownGraceMs: 800 });
        check("2c. → stop_timeout", res.ok === false && res.code === "stop_timeout");
        check("2d. teardownConfirmed (SIGKILL confirmat) + latch imediat", res.teardownConfirmed === true && registry.find((x) => x.proc === s.proc)?.settled === true);
      }
    }

    // ── 3. lider ignoră + NEPOT → group-kill dărâmă tot ──
    {
      const gcPidFile = join(workdir, "gc3.pid");
      const script = `
        process.on('SIGTERM',()=>{});
        const {spawn}=require('child_process');
        const gc=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
        require('fs').writeFileSync(process.env.GC_PIDFILE,String(gc.pid));
        setInterval(()=>{},1000);
      `;
      const s = await start(script, { GC_PIDFILE: gcPidFile });
      check("3a. spawn OK", s.ok === true);
      if (s.ok) {
        check("3b. nepotul și-a scris PID-ul", await waitFile(gcPidFile, 3_000));
        const gcPid = existsSync(gcPidFile) ? parseInt(readFileSync(gcPidFile, "utf8").trim(), 10) : NaN;
        check("3c. nepotul e viu", Number.isInteger(gcPid) && alive(gcPid));
        const res = await teardownAndLatch(s.proc, { workerShutdownGraceMs: 800 });
        check("3d. → stop_timeout", res.ok === false && res.code === "stop_timeout");
        check("3e. NEPOTUL a dispărut (group-kill)", await waitGone(gcPid, 3_000));
      }
    }

    // ── 4. lider IESE 0 dar NEPOTUL ignoră SIGTERM → ROȘU + nepot ucis ──
    {
      const gcReady = join(workdir, "gc4.pid");
      const script = `
        const {spawn}=require('child_process');
        const gc=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.env.GC_READY,String(process.pid));setInterval(()=>{},1000)"],{stdio:'ignore',env:process.env});
        process.on('SIGTERM',()=>{setTimeout(()=>process.exit(0),50)});
        setInterval(()=>{},1000);
      `;
      const s = await start(script, { GC_READY: gcReady });
      check("4a. spawn OK", s.ok === true);
      if (s.ok) {
        check("4b. nepotul (ignoră SIGTERM) a semnalat READY", await waitFile(gcReady, 3_000));
        const gcPid = existsSync(gcReady) ? parseInt(readFileSync(gcReady, "utf8").trim(), 10) : NaN;
        check("4c. nepotul e viu", Number.isInteger(gcPid) && alive(gcPid));
        const res = await teardownAndLatch(s.proc, { workerShutdownGraceMs: 2_000 });
        check("4d. lider exit 0 DAR nepot supraviețuitor → ROȘU (stop_timeout)", res.ok === false && res.code === "stop_timeout");
        check("4e. NEPOTUL orfan a fost ucis (niciun consumator Alchemy rămas)", await waitGone(gcPid, 3_000));
      }
    }

    // ── 5. buffer stderr > 64KB cu SECRET pe limită → doar marker static, secret ABSENT ──
    {
      const captured: string[] = [];
      const secret = "SECRET_STRADDLE_TOKEN_abcXYZ";
      const script = `
        process.stderr.write('A'.repeat(65000));
        process.stderr.write(process.env.SECRET);
        process.stderr.write('B'.repeat(10000) + '\\n');
        process.stderr.write('linie scurta normala\\n');
        setTimeout(()=>process.exit(0),100);
      `;
      const r = await spawnManagedProcess({
        command: NODE, args: ["-e", script], cwd: process.cwd(),
        env: { ...process.env, SECRET: secret } as Record<string, string>,
        onDebugLine: (l) => captured.push(l),
      });
      check("5a. spawn OK", r.ok === true);
      if (r.ok) {
        registry.push({ proc: r.proc, settled: false });
        await r.proc.waitExit();
        await sleep(150);
        const joined = captured.join("\n");
        check("5b. SECRETUL care traversează limita e ABSENT", !joined.includes(secret));
        check("5c. marker STATIC de suprimare emis", captured.some((l) => l.includes("suprimată")));
        check("5d. linia scurtă ULTERIOARĂ e emisă (suprimarea nu contaminează)", captured.some((l) => l.includes("linie scurta normala")));
        settle(r.proc); // procesul a ieșit singur → confirmat
      }
    }

    // ── D1b. ⭐ teardown NEconfirmat → teardownAndLatch NU latch-uiește (rămâne pt. backstop). Determinist (fake proc). ──
    {
      const fake: ManagedProc = { pid: 2_000_000_001, waitExit: () => new Promise<never>(() => {}), signalGroup: () => {}, groupAlive: () => true };
      registry.push({ proc: fake, settled: false });
      // grup mereu viu + waitExit care nu se rezolvă → stopManagedProcess NU confirmă (buget mic → rapid).
      const res = await stopManagedProcess(fake, { workerShutdownGraceMs: 20, killConfirmIntervalMs: 5, killConfirmMaxMs: 20 }, realStopTimers);
      if (res.teardownConfirmed) settle(fake);
      check("D1b. teardown NEconfirmat → teardownConfirmed === false", res.teardownConfirmed === false);
      check("D1b. → intrarea NU e latch-uită (rămâne pt. sweep)", registry.find((x) => x.proc === fake)?.settled === false);
      const idx = registry.findIndex((x) => x.proc === fake); if (idx >= 0) registry.splice(idx, 1); // scoatem fake-ul (nu-l lăsăm în backstop)
    }

    // ── D2. ⭐ intrare LATCH-uită cu pgid VIU (simulare reutilizare de PID) → sweep-ul NU o SONDEAZĂ și NU o SEMNALEAZĂ. Determinist. ──
    {
      let signaled = false, probed = false;
      const fake: ManagedProc = {
        pid: 2_000_000_002,
        waitExit: () => new Promise<never>(() => {}),          // nu se rezolvă (ca un pgid „viu")
        signalGroup: () => { signaled = true; },
        groupAlive: () => { probed = true; return true; },      // pgid VIU (reutilizat de un proces STRĂIN)
      };
      registry.push({ proc: fake, settled: true });            // latch-uit din rezultatul unui teardown anterior confirmat
      const swept = await sweepGroups();
      check("D2a. intrare latch-uită → signalGroup NEapelat (nu lovim grupul străin)", signaled === false);
      check("D2b. intrare latch-uită → pgid-ul NU e re-sondat", probed === false);
      check("D2c. sweep raportează allGone (sare intrarea latch-uită)", swept === true);
      const idx = registry.findIndex((x) => x.proc === fake); if (idx >= 0) registry.splice(idx, 1);
    }

    // ── D2r. ⭐ raceReaped: waitExit RESPINS → false (rejection ≠ reap; nu transformă eroarea în succes). Determinist. ──
    {
      const rejecting: ManagedProc = { pid: 2_000_000_009, waitExit: () => Promise.reject(new Error("boom")), signalGroup: () => {}, groupAlive: () => false };
      const reaped = await raceReaped(rejecting, 500);
      check("D2r. raceReaped pe waitExit respins → false", reaped === false);
    }

    // ── D3. ⭐ excepție cu GRUP ACTIV (lider viu) → backstop SIGKILL + confirmă grup dispărut ȘI reap-ul liderului ──
    {
      const s = await start(`process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`); // lider VIU, ignoră SIGTERM
      check("D3a. spawn OK", s.ok === true);
      if (s.ok) {
        const pid = s.proc.pid;
        check("D3b. grupul e ACTIV înainte de excepție", groupAlive(pid));
        let thrown = false;
        try { throw new Error("excepție cu grup activ"); } catch { thrown = true; }
        const swept = await sweepGroups(); // grup activ → SIGKILL + confirmă (grup gone + reap)
        check("D3c. calea de excepție atinsă", thrown);
        check("D3d. backstop confirmat (grup dispărut + reap)", swept === true);
        check("D3e. grupul chiar a dispărut", !groupAlive(pid));
        check("D3f. liderul e reap-uit (waitExit rezolvat)", await raceReaped(s.proc, 2_000));
      }
    }

    // ── D4. ⭐ lider reap-uit + nepot viu + excepție → backstop (pe groupAlive) omoară nepotul orfan ──
    {
      const gcPidFile = join(workdir, "gc6.pid");
      const script = `
        const {spawn}=require('child_process');
        const gc=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
        require('fs').writeFileSync(process.env.GC_PIDFILE,String(gc.pid));
        setTimeout(()=>process.exit(0),50);
      `;
      const s = await start(script, { GC_PIDFILE: gcPidFile });
      check("D4a. spawn OK", s.ok === true);
      if (s.ok) {
        const leaderPid = s.proc.pid;
        check("D4b. nepotul și-a scris PID-ul", await waitFile(gcPidFile, 3_000));
        const gcPid = existsSync(gcPidFile) ? parseInt(readFileSync(gcPidFile, "utf8").trim(), 10) : NaN;
        check("D4c. liderul a ieșit SINGUR (reap-uit)", await waitGone(leaderPid, 2_000));
        check("D4d. nepotul e VIU (orfan)", Number.isInteger(gcPid) && alive(gcPid));
        let thrown = false;
        try { throw new Error("excepție"); } catch { thrown = true; }
        const swept = await sweepGroups(); // decide pe groupAlive → grupul are un membru viu (nepotul) → îl ucide
        check("D4e. calea de excepție atinsă", thrown);
        check("D4f. backstop confirmat", swept === true);
        check("D4g. NEPOTUL orfan a fost UCIS (nu sărit pe motiv că liderul a ieșit)", await waitGone(gcPid, 3_000));
      }
    }
  } finally {
    const swept = await sweepGroups(); // backstop: SIGKILL + CONFIRMARE (grup + reap), chiar dacă un test a aruncat
    if (!swept) { failed++; console.log("  FAIL  backstop: nu am putut CONFIRMA dispariția + reap-ul tuturor grupurilor"); }
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(async () => {
  let swept = false;
  try { swept = await sweepGroups(); } catch { /* best-effort */ }
  console.error(swept
    ? "integration: eroare neașteptată — toate grupurile CONFIRMATE dispărute + reap (mesaj static)"
    : "integration: eroare neașteptată — grupuri POSIBIL RĂMASE, backstop NECONFIRMAT (mesaj static)");
  process.exit(1);
});
