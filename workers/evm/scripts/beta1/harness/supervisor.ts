/**
 * scripts/beta1/harness/supervisor.ts — BETA-1, felia 2: supraveghetorul proceselor de caz.
 *
 * Pornește câte UN proces per caz, cu mediu construit de la zero și termen-limită, și decide verdictul:
 *
 *   ieșire naturală + cod 0 + exact un rezultat valid, coerent cu manifestul, în termen → rezultatul cazului;
 *   termen depășit (procesul e oprit forțat)                                            → HARNESS_ERROR;
 *   ieșire prin semnal sau cod ≠ 0                                                      → HARNESS_ERROR;
 *   rezultat lipsă, dublu, invalid, al altui caz sau incoerent cu manifestul            → HARNESS_ERROR;
 *   proces care nu a putut fi pornit                                                    → HARNESS_ERROR.
 *
 * TERMINAREA SE CONFIRMĂ, nu se presupune: după fiecare caz se verifică (semnal 0) că procesul ȘI grupul lui de
 * procese nu mai au niciun proces VIU (un zombie nu e viu, deși pid-ul lui încă există). Procese rămase în grup →
 * oprite forțat, cazul e HARNESS_ERROR. Dacă lipsa proceselor vii nu poate fi
 * confirmată, SUITA SE OPREȘTE: niciun caz următor nu pornește lângă un proces scăpat. (`unref()` lasă părintele să
 * se termine independent de copil, deci ieșirea naturală a supraveghetorului nu dovedește nimic despre copii.)
 *
 * Controalele pozitive rulează ÎNTÂI. Dacă nu sunt toate `CONTROL_OK`, celelalte cazuri NU se rulează (un caz de
 * defect nu se interpretează fără controale) și rularea e invalidă.
 *
 * Supraveghetorul NU instalează gărzi (pornește procese) și NU importă nimic din `src/`. Nu pornește entrypointul
 * workerului: rulează doar fișierul de caz primit.
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import {
  validateCaseOutput, summarize, specProblem,
  type CaseSpec, type CaseVerdict, type SuiteSummary,
} from "./caseProtocol";

export interface RunnableCase extends CaseSpec {
  /** Fișierul de caz (cale absolută). */
  file:        string;
  /** Argumente suplimentare pentru procesul de caz. */
  args?:       string[];
  /** Termen-limită propriu; altfel cel al rulării. */
  deadlineMs?: number;
}

export interface SupervisorOptions {
  deadlineMs:      number;
  /** Variabile FIXE adăugate mediului de caz (ex. `PREFLIGHT_MODE`). Nu se moștenește nimic altceva. */
  fixedEnv?:       Record<string, string>;
  /** Plafon pentru stdout-ul unui caz; depășirea = HARNESS_ERROR. */
  maxStdoutBytes?: number;
  /** Cât se așteaptă confirmarea terminării după oprirea forțată. */
  killGraceMs?:    number;
  /**
   * Cât i se lasă grupului de procese al cazului să se golească SINGUR după ieșirea cazului, înainte să fie socotit
   * „proces rămas". Necesar fiindcă încărcătorul TypeScript (tsx) pornește, la cache rece, un proces ajutător
   * (serviciul esbuild) care se închide singur la scurt timp după părinte. Ce e încă viu după acest răgaz e proces
   * rămas: oprit forțat, caz HARNESS_ERROR.
   */
  groupSettleMs?:  number;
  /**
   * DOAR pentru controalele supraveghetorului: înlocuiește oprirea forțată (ex. cu una inertă), ca ramura
   * „terminare neconfirmată" să poată fi exercitată. În rulările reale rămâne nesetat.
   */
  killImpl?:       (pid: number) => void;
  log?:            (line: string) => void;
}

/** Singurele variabile moștenite: strictul necesar ca node/tsx să pornească. Nimic cu secrete, nimic de worker. */
export const INHERITED_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot"] as const;

/** Mediul unui proces de caz, construit de la ZERO. */
export function buildCaseEnv(parent: NodeJS.ProcessEnv, caseId: string, fixed: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of INHERITED_ENV_KEYS) {
    const v = parent[k];
    if (typeof v === "string") env[k] = v;
  }
  for (const [k, v] of Object.entries(fixed)) env[k] = v;
  env.BETA1_CASE_ID = caseId;
  return env;
}

export interface ProcessOutcome {
  spawned:   boolean;
  /** Pid-ul procesului de caz (= id-ul grupului lui), sau `null` dacă nu a pornit. */
  pid:       number | null;
  code:      number | null;
  signal:    NodeJS.Signals | null;
  timedOut:  boolean;
  overflow:  boolean;
  /** După ieșirea procesului de caz au rămas procese în grupul lui (au fost oprite forțat). */
  leftover:  boolean;
  /**
   * `true` dacă NU s-a putut confirma, în `killGraceMs` după oprirea forțată, că procesul și grupul lui nu mai au
   * procese vii. (Formulat așa cu intenție: confirmăm „niciun proces viu", nu „pid-urile au dispărut".)
   * Singurul caz în care suita se oprește.
   */
  unreaped:  boolean;
  ms:        number;
  stdout:    string;
  /** Coada stderr (mărginită), doar pentru diagnostic. */
  stderrTail: string;
}

const STDERR_TAIL_BYTES = 16_384;
const PROBE_INTERVAL_MS = 25;

/** `true` dacă există un proces VIU cu acest pid (un zombie nu e viu; fără `/proc`: semnal 0, `EPERM` = există). */
export function pidAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // Fie procesul nu există, fie nu există `/proc`. Semnalul 0 decide.
      try { process.kill(pid, 0); return true; }
      catch (e2) { return (e2 as NodeJS.ErrnoException).code === "EPERM"; }
    }
    return true; // nu putem citi starea → presupunem viu (sensul sigur)
  }
}

/** Cititorul de `/proc`, injectabil ca scanarea să poată fi controlată. Metodele aruncă erori cu `code`. */
export interface ProcReader {
  list(): string[];
  stat(pid: string): string;
}

const realProc: ProcReader = {
  list: () => readdirSync("/proc"),
  stat: (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
};

export interface GroupScan {
  /**
   * `true` DOAR dacă fiecare proces listat a fost fie citit și descifrat, fie a dispărut între listare și citire
   * (`ENOENT`/`ESRCH`), ȘI propriul nostru proces a fost văzut (dovada că `/proc` chiar descrie procesele). O intrare
   * necitibilă sau nedescifrabilă face scanarea INCOMPLETĂ: acel proces ar putea fi un membru viu al grupului.
   */
  complete: boolean;
  /** Membrii grupului găsiți VII (stare diferită de `Z` zombie și `X` mort). */
  live:     number[];
}

/**
 * Scanează `/proc` după membrii VII ai grupului de procese `pgid` (Linux). Un zombie (`Z`: proces încheiat, încă
 * necules de părintele lui) nu mai execută nimic, deci nu e viu — deși pid-ul lui încă există. PUR față de `reader`.
 */
export function scanProcGroup(pgid: number, reader: ProcReader = realProc, selfPid: number = process.pid): GroupScan {
  let entries: string[];
  try { entries = reader.list(); } catch { return { complete: false, live: [] }; }
  const live: number[] = [];
  let complete = true;
  let selfSeen = false;
  for (const name of entries) {
    if (!/^[0-9]+$/.test(name)) continue;
    let stat: string;
    try { stat = reader.stat(name); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESRCH") complete = false; // necitibil ≠ dispărut
      continue;
    }
    // Format: `pid (comm) stare ppid pgrp …` — `comm` poate conține spații și paranteze: tăiem după ULTIMA `)`.
    const close = stat.lastIndexOf(")");
    const rest = close < 0 ? [] : stat.slice(close + 2).split(" ");
    const state = rest[0];
    const pgrp = Number(rest[2]);
    if (rest.length < 3 || typeof state !== "string" || !/^[A-Za-z]$/.test(state) || !/^-?[0-9]+$/.test(rest[2])) {
      complete = false; // nedescifrabil: nu știm din ce grup face parte
      continue;
    }
    if (Number(name) === selfPid) selfSeen = true;
    if (pgrp === pgid && state !== "Z" && state !== "X") live.push(Number(name));
  }
  if (!selfSeen) complete = false;
  return { complete, live };
}

/**
 * Decizia „mai are grupul procese vii?". O scanare care a GĂSIT membri vii decide singură. O scanare completă fără
 * membri vii spune „nu". O scanare INCOMPLETĂ fără membri vii nu dovedește nimic → decide proba cu semnalul 0, mai
 * strictă (socotește și zombii ca existenți). PUR.
 */
export function groupAliveFrom(scan: GroupScan, signalProbe: () => boolean): boolean {
  if (scan.live.length > 0) return true;
  if (scan.complete) return false;
  return signalProbe();
}

/** `true` dacă grupul cu acest id mai are vreun proces VIU. */
export function groupAlive(pgid: number): boolean {
  return groupAliveFrom(scanProcGroup(pgid), () => {
    try { process.kill(-pgid, 0); return true; }
    catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
  });
}

/** Oprește procesul și grupul lui (dacă a pornit copii). */
function killTree(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch { /* grupul nu (mai) există */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* deja terminat */ }
}

/** Rulează un proces de caz până la terminare CONFIRMATĂ sau până când confirmarea eșuează. Nu aruncă. */
export function runCaseProcess(c: RunnableCase, opts: SupervisorOptions): Promise<ProcessOutcome> {
  return new Promise<ProcessOutcome>((resolve) => {
    const started = Date.now();
    const deadline = c.deadlineMs ?? opts.deadlineMs;
    const maxOut = opts.maxStdoutBytes ?? 1_048_576;
    const grace = opts.killGraceMs ?? 2_000;
    const kill = opts.killImpl ?? killTree;
    const settle = opts.groupSettleMs ?? 1_000;
    const out: ProcessOutcome = {
      spawned: false, pid: null, code: null, signal: null, timedOut: false, overflow: false, leftover: false,
      unreaped: false, ms: 0, stdout: "", stderrTail: "",
    };
    let settled = false;
    let closed = false;
    let stdoutBytes = 0;
    const chunks: Buffer[] = [];
    let errTail = Buffer.alloc(0);
    let deadlineTimer: NodeJS.Timeout | null = null;
    let confirmTimer: NodeJS.Timeout | null = null;
    let confirmStarted: number | null = null;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (confirmTimer) clearTimeout(confirmTimer);
      out.ms = Date.now() - started;
      out.stdout = Buffer.concat(chunks).toString("utf8");
      out.stderrTail = errTail.toString("utf8");
      resolve(out);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [...process.execArgv, c.file, `--case=${c.id}`, ...(c.args ?? [])], {
        env:      buildCaseEnv(process.env, c.id, opts.fixedEnv),
        stdio:    ["ignore", "pipe", "pipe"],
        detached: true, // grup propriu de procese → oprirea forțată și verificarea prind și eventualii copii
      });
    } catch {
      finish();
      return;
    }

    /** Cazul nu mai are niciun proces VIU: procesul a dat `close`, iar grupul lui nu are membri vii. */
    const gone = (): boolean => closed && (out.pid === null || (!pidAlive(out.pid) && !groupAlive(out.pid)));

    /**
     * Așteaptă MĂRGINIT confirmarea că nu mai există procese vii. Dacă nu vine în `grace`: eliberăm mânerele (ca supraveghetorul să
     * se poată termina) și marcăm `unreaped` — apelantul oprește suita.
     */
    const confirmGone = (): void => {
      if (settled) return;
      if (gone()) { finish(); return; }
      if (confirmStarted === null) confirmStarted = Date.now();
      if (Date.now() - confirmStarted >= grace) {
        out.unreaped = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish();
        return;
      }
      confirmTimer = setTimeout(confirmGone, PROBE_INTERVAL_MS);
    };

    const forceStop = (): void => {
      if (out.pid !== null) kill(out.pid);
      if (confirmStarted === null) confirmGone();
    };

    child.on("spawn", () => { out.spawned = true; out.pid = child.pid ?? null; });
    child.on("error", () => { if (!out.spawned) finish(); });
    child.stdout?.on("data", (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > maxOut) { if (!out.overflow) { out.overflow = true; forceStop(); } return; }
      chunks.push(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      errTail = Buffer.concat([errTail, d]);
      if (errTail.length > STDERR_TAIL_BYTES) errTail = errTail.subarray(errTail.length - STDERR_TAIL_BYTES);
    });
    child.on("close", (code, signal) => {
      closed = true;
      out.code = code;
      out.signal = signal;
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
      // Procesul de caz a ieșit. Lăsăm grupului un răgaz MĂRGINIT să se golească singur (vezi `groupSettleMs`);
      // ce rămâne viu după el a fost scăpat de caz: îl oprim și cerem confirmarea.
      const closedAt = Date.now();
      const settleGroup = (): void => {
        if (settled) return;
        if (out.pid === null || !groupAlive(out.pid)) { confirmGone(); return; }
        if (confirmStarted !== null) { confirmGone(); return; } // oprire forțată deja în curs (termen/plafon)
        if (Date.now() - closedAt >= settle) {
          out.leftover = true;
          kill(out.pid);
          confirmGone();
          return;
        }
        confirmTimer = setTimeout(settleGroup, PROBE_INTERVAL_MS);
      };
      settleGroup();
    });

    deadlineTimer = setTimeout(() => { out.timedOut = true; forceStop(); }, deadline);
  });
}

/** Transformă rezultatul unui proces în verdictul cazului. PUR. */
export function verdictFor(spec: CaseSpec, p: ProcessOutcome): CaseVerdict {
  const diagnostics = {
    pid: p.pid, ms: p.ms, code: p.code, signal: p.signal, timedOut: p.timedOut, overflow: p.overflow,
    leftover: p.leftover, terminationConfirmed: p.spawned && !p.unreaped,
  };
  const harness = (why: string): CaseVerdict =>
    ({ spec, ran: true, outcome: "HARNESS_ERROR", reasons: [why], observations: {}, diagnostics });
  if (!p.spawned)  return harness("procesul de caz nu a putut fi pornit");
  if (p.unreaped)  return harness("NU s-a putut confirma că procesul de caz și grupul lui nu mai au procese vii");
  if (p.timedOut)  return harness(`termen depășit după ${p.ms}ms (proces oprit forțat)`);
  if (p.overflow)  return harness("stdout peste plafon (proces oprit forțat)");
  if (p.leftover)  return harness("procese rămase în grupul cazului după ieșirea lui (oprite forțat)");
  if (p.signal !== null) return harness(`ieșire prin semnal ${p.signal}`);
  if (p.code !== 0)      return harness(`cod de ieșire ${p.code} (se cere 0)`);
  const v = validateCaseOutput(p.stdout, spec);
  if (!v.ok) return harness(v.problem);
  // Un HARNESS_ERROR raportat chiar de caz înseamnă că barierele lui nu au trecut: observațiile lui nu sunt de
  // încredere și nu intră în raport, la fel ca pentru un HARNESS_ERROR decis de supraveghetor.
  const observations = v.result.outcome === "HARNESS_ERROR" ? {} : v.result.observations;
  return { spec, ran: true, outcome: v.result.outcome, reasons: v.result.reasons, observations, diagnostics };
}

export interface SuiteReport {
  verdicts: CaseVerdict[];
  summary:  SuiteSummary;
  /** Setat dacă suita s-a OPRIT: terminarea unui proces de caz nu a putut fi confirmată. */
  aborted:  { caseId: string; pid: number | null } | null;
}

/**
 * Rulează manifestul: întâi controalele pozitive, apoi restul — DOAR dacă toate controalele sunt `CONTROL_OK`.
 * Un manifest incoerent (id duplicat, specificație invalidă) nu rulează nimic: toate cazurile ies HARNESS_ERROR.
 * Un termen depășit cu terminare CONFIRMATĂ nu oprește suita; o terminare NECONFIRMATĂ o oprește pe loc.
 */
export async function runSuite(cases: RunnableCase[], opts: SupervisorOptions): Promise<SuiteReport> {
  const log = opts.log ?? ((): void => { /* tăcut */ });
  const specOf = (c: RunnableCase): CaseSpec => ({ id: c.id, kind: c.kind, section: c.section });
  const notRun = (c: RunnableCase, why: string): CaseVerdict =>
    ({ spec: specOf(c), ran: false, outcome: null, reasons: [why], observations: {}, diagnostics: null });

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    const p = specProblem(c);
    if (p) problems.push(p);
    if (seen.has(c.id)) problems.push(`id de caz duplicat: ${c.id}`);
    seen.add(c.id);
  }
  if (problems.length > 0) {
    const verdicts = cases.map((c): CaseVerdict => ({
      spec: specOf(c), ran: true, outcome: "HARNESS_ERROR",
      reasons: ["manifest invalid: " + problems.join("; ")], observations: {}, diagnostics: null,
    }));
    return { verdicts, summary: summarize(verdicts), aborted: null };
  }

  const byId = new Map<string, CaseVerdict>();
  let aborted: SuiteReport["aborted"] = null;
  const row = (label: string, c: RunnableCase, tail: string): void => {
    log(`${label.padEnd(22)} ${c.id.padEnd(16)} ${c.section.padEnd(8)} ${tail}`);
  };

  const controls = cases.filter(c => c.kind === "control");
  const others   = cases.filter(c => c.kind !== "control");
  let controlsOk = controls.length > 0;

  for (const c of [...controls, ...others]) {
    if (aborted !== null) {
      byId.set(c.id, notRun(c, `nerulat: suită oprită — terminarea procesului cazului ${aborted.caseId} nu a putut fi confirmată`));
      row("NOT_RUN", c, "— suită oprită");
      continue;
    }
    if (c.kind !== "control" && !controlsOk) {
      byId.set(c.id, notRun(c, "nerulat: nu toate controalele pozitive sunt CONTROL_OK"));
      row("NOT_RUN", c, "— controalele pozitive nu au trecut");
      continue;
    }
    const p = await runCaseProcess(c, opts);
    const v = verdictFor(specOf(c), p);
    byId.set(c.id, v);
    row(v.outcome ?? "?", c, `${p.ms}ms${v.outcome === "HARNESS_ERROR" ? "  — " + v.reasons.join("; ") : ""}`);
    if (c.kind === "control" && v.outcome !== "CONTROL_OK") controlsOk = false;
    if (p.unreaped) {
      aborted = { caseId: c.id, pid: p.pid };
      log(`SUITĂ OPRITĂ: procesul cazului ${c.id} (pid ${p.pid}) poate fi încă în viață`);
    }
  }

  // Raportul păstrează ordinea manifestului.
  const verdicts = cases.map(c => byId.get(c.id) as CaseVerdict);
  const summary = summarize(verdicts);
  if (aborted !== null) summary.invalid.push(`suită oprită: terminarea procesului cazului ${aborted.caseId} neconfirmată`);
  return { verdicts, summary, aborted };
}
