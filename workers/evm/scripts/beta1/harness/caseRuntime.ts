/**
 * scripts/beta1/harness/caseRuntime.ts — BETA-1, felia 3: mediul de rulare al unui PROCES DE CAZ.
 *
 * Un proces de caz exercită codul REAL al workerului (`src/`), ermetic, și raportează un singur `CaseResult`.
 * Acest fișier face partea comună tuturor cazurilor, în ordine:
 *
 *   1. instalează gărzile și observatorii ÎNAINTE de orice import din `src/`;
 *   2. pornește nodul local și fixează singura destinație permisă;
 *   3. rulează controalele gărzilor (o gardă inertă invalidează cazul);
 *   4. importă DINAMIC modulele din `src/` și verifică precondițiile (nimic pornit la import, store-uri goale);
 *   5. rulează corpul cazului, care folosește barierele de mai jos;
 *   6. închide pe calea de PRODUCȚIE (`markShuttingDown` → `closeAllWebSockets`), apoi nodul local;
 *   7. verdict în trei timpi (E înainte de cleanup, F după, G la `exit`) și scrie rezultatul SINCRON la `exit`.
 *      Sursele PERSISTENTE de erori (captura de consolă, erorile socketului, anomaliile nodului) se recitesc la
 *      fiecare timp, inclusiv la G, înaintea construirii rezultatului: o eroare apărută doar în consolă, în timpul
 *      cleanup-ului sau la `beforeExit`, dă HARNESS_ERROR.
 *
 * LIMITĂ DECLARATĂ: rezultatul se scrie în ascultătorul de `exit` al acestui runtime. Ce ar face un ascultător de
 * `exit` înregistrat ULTERIOR de alt cod rulează după scriere și nu poate fi observat. De aceea prezența unui
 * asemenea ascultător la G invalidează cazul (G3), în loc să fie ignorată.
 *
 * NU e entrypointul workerului: nu importă `src/index.ts` / `src/bootstrap.ts`, nu pornește scan, bucle, persistare.
 *
 * BARIERE (toate mărginite; lipsa sau expirarea uneia = HARNESS_ERROR, niciodată „defect reprodus"):
 *   - subscripția confirmată efectiv: timerele reale de la `open` s-au terminat → tot ce a trimis clientul a ajuns
 *     la nod (ping cu încărcătură unică) → `scopedSubStore.active` poartă exact id-ul emis de nod;
 *   - notificarea primită și procesată: santinelă văzută la DESTINAȚIE după loguri, cu `activeJobCount() === 0`.
 *     Dovada se sprijină pe handlerul de mesaje FĂRĂ `await` din baseline și pe ordinea ascultătorilor
 *     (`EventEmitter`); nu se generalizează dacă handlerul devine asincron — de aceea sonda `activeJobCount`;
 *   - fără erori de transport sau de handler (`[WS ERR`, `error`/`close` pe socket, excepții de proces).
 *
 * EFECT DECLARAT al barierei cu ping: pong-ul nodului actualizează `wsLastPongAt` în worker (semnal de transport).
 * Nu atinge subscripțiile, memoria sau flow-ul.
 */

import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";

import { installNetGuard, GUARD_ERROR_CODE, type NetGuard } from "./netGuard";
import {
  installConsoleCapture, installTimerObserver, installProcessObserver, observeSocket, waitUntil, withDeadline,
  realTimers, HarnessError,
  type ConsoleCapture, type TimerObserver, type ProcessObserver, type SocketObserver, type SeenFrame, type TimerRecord,
} from "./observers";
import { startLocalNode, type LocalNode, type RpcLog, type CapturedRequest } from "./localNode";
import { serializeCaseResult, CASE_RESULT_SCHEMA, type CaseSpec, type Outcome, type CaseResult } from "./caseProtocol";

import type { ChainConfig } from "../../../src/config/chains";

/** Modulele din `src/` folosite de cazuri. Doar TIPURI aici; încărcarea e dinamică, după instalarea gărzilor. */
export interface SrcModules {
  stores:      typeof import("../../../src/state/stores");
  memory:      typeof import("../../../src/state/memory");
  transitions: typeof import("../../../src/pipeline/transitions");
  normalize:   typeof import("../../../src/sources/normalize");
  manager:     typeof import("../../../src/ws/manager");
  lifecycle:   typeof import("../../../src/lib/lifecycle");
  nativePrice: typeof import("../../../src/infra/nativePrice");
}

export type ScopedKind = "v2" | "v3" | "v4";

export interface DeliveryReport {
  /** Per `transactionHash`: de câte ori l-a trimis nodul și de câte ori l-a văzut clientul. */
  perLog: Record<string, { sent: number; received: number }>;
  logsSent:     number;
  logsReceived: number;
}

export interface CaseBodyResult {
  outcome:      Outcome;
  reasons:      string[];
  observations: Record<string, unknown>;
}

export interface CaseContext {
  src:   SrcModules;
  node:  LocalNode;
  /** Lanțul probei: `base`, cu `wsUrl` spre nodul local. */
  chain: ChainConfig;
  cons:  ConsoleCapture;
  /** Conectează prin `connectChainWebSocket` și atașează observatorul. Starea trebuie pusă ÎNAINTE. */
  connect(): Promise<void>;
  /** Bariera 5.1.1: cele trei subscrieri programate de handlerul `open` s-au terminat. */
  awaitOpenSubscribes(): Promise<void>;
  /** Bariera 5.1.2: tot ce a trimis clientul până acum a ajuns la nod. Întoarce cererile capturate. */
  clientBarrier(tag: string): Promise<CapturedRequest[]>;
  /** Bariera 5.1.3: cererea dată e activă în `scopedSubStore` cu id-ul emis de nod și instantaneul așteptat. */
  awaitPromoted(kind: ScopedKind, request: CapturedRequest, snapshot: string): Promise<void>;
  /** Oferă loguri prin filtru, apoi bariera 5.2 (santinelă la destinație + `activeJobCount() === 0`). */
  deliver(logs: RpcLog[], tag: string): Promise<DeliveryReport>;
}

/** Minimul folosit de harness din socketul `ws` al workerului. */
interface WsLike { readonly readyState: number; ping(data?: string): void; terminate(): void; }

const DEADLINE_MS = 10_000;
const CHAIN_ID = "base";
const OPEN_SUBSCRIBE_DELAYS = [2_500, 3_000, 3_500];

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Egalitate structurală pe valori JSON (ordinea cheilor nu contează). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a as object).sort(), kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every(k => jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** Așteaptă `error` pe un socket refuzat; întoarce codul erorii sau `null` la expirare. */
function refusalCode(s: net.Socket): Promise<string | null> {
  return new Promise(resolve => {
    const t = realTimers.setTimeout(() => resolve(null), 1_000);
    s.once("error", (e: NodeJS.ErrnoException) => { realTimers.clearTimeout(t); resolve(e.code ?? "(fără cod)"); });
  });
}

/**
 * Controalele gărzii de rețea, în FIECARE proces de caz: câte o încercare interzisă, deliberată, pe fiecare cale.
 * Întoarce lista controalelor care NU s-au declanșat (goală = garda e vie).
 */
async function runGuardControls(guard: NetGuard, port: number): Promise<string[]> {
  const failed: string[] = [];
  const other = port === 65535 ? port - 1 : port + 1;
  const hit = (label: string, kind: string): boolean => guard.refusals().some(r => r.control === label && r.kind === kind);

  const tcp: Array<[string, () => net.Socket]> = [
    ["g-tcp-port",  () => net.connect(other, "127.0.0.1")],
    ["g-tcp-local", () => net.connect(port, "localhost")],
    ["g-tcp-v6",    () => net.connect({ host: "::1", port })],
  ];
  for (const [label, fn] of tcp) {
    const s = guard.runControl(label, fn);
    if ((await refusalCode(s)) !== GUARD_ERROR_CODE || !hit(label, "tcp")) failed.push(label);
  }
  {
    const s = guard.runControl("g-ipc", () => net.connect({ path: "/tmp/beta1-caz-nu-exista.sock" }));
    if ((await refusalCode(s)) !== GUARD_ERROR_CODE || !hit("g-ipc", "ipc")) failed.push("g-ipc");
  }
  {
    const s = guard.runControl("g-tls", () => tls.connect({ host: "127.0.0.1", port }));
    if ((await refusalCode(s)) !== GUARD_ERROR_CODE || !hit("g-tls", "tls")) failed.push("g-tls");
  }
  {
    const code = await withDeadline(new Promise<string>(resolve => {
      guard.runControl("g-dns", () => { dns.lookup("example.invalid", (e) => resolve((e as NodeJS.ErrnoException | null)?.code ?? "fără eroare")); });
    }), 1_000, "control DNS");
    if (code !== GUARD_ERROR_CODE || !hit("g-dns", "dns")) failed.push("g-dns");
  }
  {
    let code = "";
    guard.runControl("g-udp", () => { try { dgram.createSocket("udp4"); } catch (e) { code = (e as NodeJS.ErrnoException).code ?? ""; } });
    if (code !== GUARD_ERROR_CODE || !hit("g-udp", "udp")) failed.push("g-udp");
  }
  {
    const p = guard.runControl("g-fetch", () => fetch("https://example.invalid/"));
    const code = await withDeadline(p.then(() => "fără eroare", (e: NodeJS.ErrnoException) => e.code ?? "(fără cod)"), 1_000, "control fetch");
    if (code !== GUARD_ERROR_CODE || !hit("g-fetch", "fetch")) failed.push("g-fetch");
  }
  return failed;
}

export interface RunCaseOptions {
  /**
   * DOAR pentru controalele proprii ale acestui runtime (`caseRuntimeSelfTest`): înlocuiește încărcarea modulelor
   * din `src/` cu un worker FALS, ca ramurile de eșec să poată fi exercitate. Cazurile reale NU îl setează: fără
   * el, se încarcă exclusiv codul real al workerului.
   */
  loadSrc?: () => Promise<SrcModules>;
  /**
   * DOAR pentru controalele proprii ale acestui runtime: chemat sincron la ÎNCEPUTUL cleanup-ului (după E), ca o
   * eroare apărută exact în acea fereastră să poată fi injectată determinist. Cazurile reale NU îl setează.
   */
  selfTestDuringCleanup?: () => void;
}

/** Încărcarea REALĂ: import dinamic din `src/`, după instalarea gărzilor. */
async function loadRealSrc(): Promise<SrcModules> {
  return {
    stores:      await import("../../../src/state/stores"),
    memory:      await import("../../../src/state/memory"),
    transitions: await import("../../../src/pipeline/transitions"),
    normalize:   await import("../../../src/sources/normalize"),
    manager:     await import("../../../src/ws/manager"),
    lifecycle:   await import("../../../src/lib/lifecycle"),
    nativePrice: await import("../../../src/infra/nativePrice"),
  };
}

/**
 * Rulează un proces de caz. Verifică `--case=<id>` față de `spec.id`, apoi execută pașii din antet.
 * NU aruncă și NU apelează `process.exit`: rezultatul se scrie la `exit`, iar procesul se termină singur.
 */
export function runCase(spec: CaseSpec, body: (ctx: CaseContext) => Promise<CaseBodyResult>, options: RunCaseOptions = {}): void {
  // ── 1. Gărzi și observatori, înaintea oricărui import din `src/` ─────────────────────────────────────────
  const guard = installNetGuard();
  const proc  = installProcessObserver();
  const cons  = installConsoleCapture();
  const tobs  = installTimerObserver();

  const harness: string[] = [];                // orice element ⇒ HARNESS_ERROR
  let bodyResult: CaseBodyResult | null = null;
  let node: LocalNode | null = null;
  let src: SrcModules | null = null;
  let sobs: SocketObserver | null = null;
  let clientSocket: WsLike | null = null;
  let connected = false;
  let shutdownDone = false;

  const violationCounts = (): { net: number; timer: number; proc: number } =>
    ({ net: guard.violations().length, timer: tobs.violations().length, proc: proc.violations().length });
  const aliveAtE = new Set<number>();
  const accountedAlive = new Set<number>();
  let countsAtF: { net: number; timer: number; proc: number } | null = null;
  let reported = false;

  // ── 7c. G — la `exit`: orice eroare sau resursă vie apărută după F; rezultatul se scrie ABIA aici, sincron ──
  process.on("exit", () => {
    if (reported) return;
    reported = true;
    // Sursele persistente de erori se recitesc AICI, înaintea construirii rezultatului: prind ce a apărut după F
    // (de exemplu într-un ascultător de `beforeExit`) și ce a apărut doar în consolă.
    try { collectErrors("la terminare", true); }
    catch (e) { harness.push("G. recitirea surselor de erori a aruncat: " + errText(e)); }
    const foreignExit = process.listeners("exit").filter(l => !exitListenersAtInstall.has(l));
    if (foreignExit.length > 0) {
      harness.push(`G3. ${foreignExit.length} ascultător(i) de exit înregistrați după instalarea runtime-ului: ce fac ei rulează după scrierea rezultatului și nu poate fi observat`);
    }
    if (countsAtF === null) {
      harness.push("G0. procesul se termină fără ca verificările finale să fi rulat");
    } else {
      const now = violationCounts();
      if (now.net !== countsAtF.net || now.timer !== countsAtF.timer || now.proc !== countsAtF.proc) {
        harness.push(`G1. erori apărute după cleanup (rețea +${now.net - countsAtF.net}, timer +${now.timer - countsAtF.timer}, proces +${now.proc - countsAtF.proc})`);
      }
      const late = tobs.outstanding().filter(t => !accountedAlive.has(t.id));
      if (late.length > 0) harness.push(`G2. ${late.length} timer(e) vii la terminare, apărute după cleanup`);
    }
    const result: CaseResult = harness.length > 0 || bodyResult === null
      ? { schema: CASE_RESULT_SCHEMA, caseId: spec.id, kind: spec.kind, section: spec.section, outcome: "HARNESS_ERROR",
          reasons: harness.length > 0 ? harness : ["corpul cazului nu a produs un rezultat"], observations: {} }
      : { schema: CASE_RESULT_SCHEMA, caseId: spec.id, kind: spec.kind, section: spec.section,
          outcome: bodyResult.outcome, reasons: bodyResult.reasons, observations: bodyResult.observations };
    const buf = Buffer.from(serializeCaseResult(result), "utf8");
    let off = 0;
    for (let tries = 0; off < buf.length && tries < 1_000; tries++) {
      try { off += fs.writeSync(1, buf, off); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EAGAIN") break; }
    }
    // Protocol: cod 0 pentru ORICE rezultat scris complet (inclusiv HARNESS_ERROR); altfel 3.
    process.exitCode = off === buf.length ? 0 : 3;
  });
  /** Ascultătorii de `exit` existenți după instalare (inclusiv al nostru). Orice altul, la G, invalidează cazul. */
  const exitListenersAtInstall = new Set<unknown>(process.listeners("exit"));

  const main = async (): Promise<void> => {
    const argCase = process.argv.find(a => a.startsWith("--case="))?.slice("--case=".length) ?? null;
    if (argCase !== spec.id) throw new HarnessError(`procesul a fost pornit pentru „${argCase}", dar fișierul implementează „${spec.id}"`);
    if (!cons.selfCheck()) throw new HarnessError("captura de consolă e inertă");

    // ── 2. Nodul local + singura destinație permisă ────────────────────────────────────────────────────────
    tobs.setPhase("setup");
    node = await withDeadline(startLocalNode(), DEADLINE_MS, "pornirea nodului local");
    guard.allowOnly(node.port);

    // ── 3. Controalele gărzii ──────────────────────────────────────────────────────────────────────────────
    const inert = await runGuardControls(guard, node.port);
    if (inert.length > 0) throw new HarnessError(`controale de gardă nedeclanșate: ${inert.join(", ")}`);
    if (guard.violations().length > 0) throw new HarnessError("refuz de rețea în afara controalelor, înainte de import");

    // ── 4. Import dinamic din `src/` + precondiții ─────────────────────────────────────────────────────────
    tobs.setPhase("import");
    const fetchBefore = guard.fetchCalls();
    const loaded: SrcModules = await (options.loadSrc ?? loadRealSrc)();
    src = loaded;
    tobs.setPhase("preconditions");
    const st = loaded.stores;
    const pre: string[] = [];
    if (guard.violations().length > 0)           pre.push("încercare de rețea la import");
    if (guard.fetchCalls() !== fetchBefore)       pre.push("apel fetch la import");
    if (guard.permittedConnections() !== 0)       pre.push("conexiune deschisă la import");
    if (tobs.records().some(t => t.phase === "import")) pre.push("timer creat la import");
    if (proc.violations().length > 0)             pre.push("excepție de proces la import");
    if (cons.count("Preflight Worker ") > 0)      pre.push("a pornit entrypointul workerului");
    if (loaded.lifecycle.isShuttingDown())        pre.push("worker deja în shutdown");
    if (loaded.lifecycle.activeJobCount() !== 0)  pre.push("job-uri active la pornire");
    const sizes: Record<string, number> = {
      memory: st.memory.size, activeWatch: st.activeWatch.size, hotCandidates: st.hotCandidates.size,
      armedEntries: st.armedEntries.size, v3PoolMap: st.v3PoolMap.size, v4PoolMap: st.v4PoolMap.size,
      watchedPoolCache: st.watchedPoolCache.size, wsFlow: st.wsFlow.size, lpEvents: st.lpEvents.size,
      poolLiquidity: st.poolLiquidity.size, "scopedSubStore.active": st.scopedSubStore.active.size,
      "scopedSubStore.pending": st.scopedSubStore.pending.size, "scopedSubStore.latestReq": st.scopedSubStore.latestReq.size,
      scopedConfirmedAt: st.scopedConfirmedAt.size, lastImmediateSub: st.lastImmediateSub.size,
      wsLastMessageAt: st.wsLastMessageAt.size, wsLastMessageAtByKind: st.wsLastMessageAtByKind.size,
      wsLastPongAt: st.wsLastPongAt.size, wsClients: st.wsClients.size,
    };
    for (const [name, n] of Object.entries(sizes)) if (n !== 0) pre.push(`store nevid la pornire: ${name}=${n}`);
    if (pre.length > 0) throw new HarnessError("precondiții: " + pre.join("; "));

    const theNode = node;
    const chain: ChainConfig = { id: CHAIN_ID, gecko: "base", weth: "0x4200000000000000000000000000000000000006", usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", wsUrl: theNode.url };

    // ── 5. Barierele puse la dispoziția corpului ───────────────────────────────────────────────────────────
    const needSobs = (): SocketObserver => { if (!sobs) throw new HarnessError("barieră folosită înainte de connect()"); return sobs; };
    const tagOf = (f: SeenFrame): unknown => (f.json as { params?: { tag?: unknown } } | undefined)?.params?.tag;
    const txOf  = (f: SeenFrame): unknown => (f.json as { params?: { result?: { transactionHash?: unknown } } } | undefined)?.params?.result?.transactionHash;

    const ctx: CaseContext = {
      src: loaded, node: theNode, chain, cons,

      async connect(): Promise<void> {
        if (connected) throw new HarnessError("connect() apelat de două ori");
        tobs.setPhase("connect");
        loaded.manager.connectChainWebSocket(chain);
        const ws = st.wsClients.get(CHAIN_ID) as WsLike | undefined;
        if (!ws) throw new HarnessError("connectChainWebSocket nu a înregistrat niciun socket");
        clientSocket = ws;
        // Înregistrat DUPĂ handlerul managerului: când vede un cadru, corpul sincron al handlerului a rulat deja.
        sobs = observeSocket(ws as unknown as Parameters<typeof observeSocket>[0], () => loaded.lifecycle.activeJobCount());
        connected = true;
        await waitUntil(() => ws.readyState === 1, DEADLINE_MS, "socketul workerului deschis");
      },

      async awaitOpenSubscribes(): Promise<void> {
        const mine = (): TimerRecord[] => tobs.records().filter(t => t.phase === "connect" && t.kind === "timeout" && OPEN_SUBSCRIBE_DELAYS.includes(t.delayMs));
        await waitUntil(() => {
          const m = mine();
          return OPEN_SUBSCRIBE_DELAYS.every(d => m.filter(t => t.delayMs === d).length === 1)
            && m.every(t => t.state === "done" && t.fires === 1 && t.inFlight === 0);
        }, DEADLINE_MS, "cele trei subscrieri programate la open s-au terminat");
        if (mine().length !== OPEN_SUBSCRIBE_DELAYS.length) throw new HarnessError("număr neașteptat de timere de subscriere la open");
      },

      async clientBarrier(tag: string): Promise<CapturedRequest[]> {
        if (!clientSocket) throw new HarnessError("clientBarrier înainte de connect()");
        clientSocket.ping(tag);
        await waitUntil(() => theNode.pings().includes(tag), DEADLINE_MS, `ping-ul „${tag}" văzut de nod`);
        return theNode.requests();
      },

      async awaitPromoted(kind: ScopedKind, request: CapturedRequest, snapshot: string): Promise<void> {
        const key = `${CHAIN_ID}:${kind}`;
        if (request.method !== "eth_subscribe" || request.subId === null) throw new HarnessError("awaitPromoted pe o cerere fără id de subscripție");
        await waitUntil(() => st.scopedSubStore.active.get(key)?.subId === request.subId, DEADLINE_MS, `subscripția ${key} activă cu id-ul emis de nod`);
        const active = st.scopedSubStore.active.get(key);
        if (!active || active.snapshot !== snapshot) throw new HarnessError(`subscripția ${key} e activă pe alt instantaneu decât cel așteptat`);
        if ([...st.scopedSubStore.pending.values()].some(p => p.key === key)) throw new HarnessError(`au rămas cereri în așteptare pentru ${key}`);
        const line = `[SCOPED SUB ${CHAIN_ID}] req#${String(request.id)} → promoted`;
        if (cons.count(line) !== 1) throw new HarnessError(`linia „${line}" apare de ${cons.count(line)} ori (se cere exact o dată)`);
      },

      async deliver(logs: RpcLog[], tag: string): Promise<DeliveryReport> {
        const o = needSobs();
        const sentBefore = theNode.sent().length;
        theNode.offerLogs(logs);
        theNode.sendSentinel(tag);
        const sentinel = await o.waitForFrame(f => tagOf(f) === tag, DEADLINE_MS, `santinela „${tag}" la destinație`);
        if (sentinel.probe !== 0) throw new HarnessError(`la santinelă activeJobCount() = ${sentinel.probe} (se cere 0)`);
        const sentNow = theNode.sent().slice(sentBefore).filter(s => s.kind === "log");
        const frames = o.frames();
        const perLog: DeliveryReport["perLog"] = {};
        let logsReceived = 0;
        for (const log of logs) {
          const sent = sentNow.filter(s => s.marker === log.transactionHash).length;
          const seen = frames.filter(f => txOf(f) === log.transactionHash);
          if (seen.length !== sent) throw new HarnessError(`log ${log.transactionHash.slice(-6)}: trimis de ${sent} ori, văzut la client de ${seen.length} ori`);
          for (const f of seen) {
            if (f.seq >= sentinel.seq) throw new HarnessError("un log a sosit după santinelă");
            if (f.probe !== 0) throw new HarnessError(`la primirea logului activeJobCount() = ${f.probe} (se cere 0)`);
          }
          perLog[log.transactionHash] = { sent, received: seen.length };
          logsReceived += seen.length;
        }
        return { perLog, logsSent: sentNow.length, logsReceived };
      },
    };

    tobs.setPhase("body");
    bodyResult = await body(ctx);
  };

  /**
   * Bariera 5.3 + erori vizibile doar în captură/observatori. Sursele sunt PERSISTENTE (se adună, nu se golesc),
   * deci se recitesc de patru ori: înainte de închidere, după închidere, după cleanup (F) și la `exit` (G).
   */
  const reportedErrors = new Set<string>();
  const collectErrors = (when: string, expectClosed: boolean): void => {
    // Fiecare fel de eroare se raportează o dată, cu momentul la care a fost văzută prima oară.
    const add = (what: string): void => { if (!reportedErrors.has(what)) { reportedErrors.add(what); harness.push(`${when}: ${what}`); } };
    if (cons.count("[WS ERR") > 0) add("linie [WS ERR în captura de consolă");
    if (cons.count(`[WS ${CHAIN_ID}] Error:`) > 0) add("eroare de transport WS în captura de consolă");
    if (sobs) {
      if (sobs.errors().length > 0) add("socketul client a emis error");
      if (!expectClosed && sobs.closedCode() !== null) add("socketul client s-a închis înaintea pasului de închidere");
    }
    if (node && node.anomalies().length > 0) add(`anomalii la nodul local (${node.anomalies().length})`);
    if (cons.count("Preflight Worker ") > 0) add("a pornit entrypointul workerului");
  };

  /** 6. Închidere pe calea de producție, apoi nodul local. */
  const shutdown = async (): Promise<void> => {
    tobs.setPhase("shutdown");
    if (connected && src) {
      src.lifecycle.markShuttingDown();
      await withDeadline(src.manager.closeAllWebSockets(), DEADLINE_MS, "closeAllWebSockets");
      const o = sobs;
      if (o) await waitUntil(() => o.closedCode() !== null, DEADLINE_MS, "socketul client închis");
    }
    if (node) await node.close();
    shutdownDone = true;
  };

  main()
    .catch((e: unknown) => { harness.push("corp: " + errText(e)); })
    .then(async () => {
      collectErrors("înainte de închidere", false);
      try { await shutdown(); }
      catch (e) { harness.push("închidere: " + errText(e)); }
      collectErrors("după închidere", true);

      // ── 7a. E — înainte de cleanup: aici se vede ce a RĂMAS ──────────────────────────────────────────────
      const gv = guard.violations(), tv = tobs.violations(), pv = proc.violations(), left = tobs.outstanding();
      if (gv.length > 0)   harness.push(`E1. refuzuri de rețea în afara controalelor: ${gv.map(r => `${r.kind} ${r.detail}`).join(", ")}`);
      if (tv.length > 0)   harness.push(`E2. erori de callback de timer: ${tv.map(f => f.message).join("; ")}`);
      if (pv.length > 0)   harness.push(`E3. excepții de proces: ${pv.map(f => f.message).join("; ")}`);
      if (left.length > 0) harness.push(`E4. timere vii după închidere: ${left.map(t => `#${t.id} ${t.kind} ${t.delayMs}ms faza=${t.phase} inFlight=${t.inFlight}`).join(", ")}`);
      for (const t of left) { aliveAtE.add(t.id); accountedAlive.add(t.id); }
      const atE = violationCounts();

      // ── 7b. Cleanup forțat (mărginit), apoi F ────────────────────────────────────────────────────────────
      let forced: TimerRecord[] = [];
      try {
        if (options.selfTestDuringCleanup) options.selfTestDuringCleanup();
        if (clientSocket && clientSocket.readyState !== 3) { try { clientSocket.terminate(); } catch { /* best-effort */ } }
        if (node && !shutdownDone) { try { await node.close(1_000); } catch { /* deja închis sau expirat */ } }
        forced = tobs.clearOutstandingForCleanup();
        await new Promise<void>(res => { realTimers.setTimeout(res, 30); });
      } catch (e) { harness.push("cleanup: " + errText(e)); }
      const now = violationCounts();
      if (now.net !== atE.net || now.timer !== atE.timer || now.proc !== atE.proc) harness.push("F1. erori noi în timpul cleanup-ului");
      const forcedNew = forced.filter(t => !aliveAtE.has(t.id));
      if (forcedNew.length > 0) harness.push(`F4. cleanup-ul a anulat forțat ${forcedNew.length} timer(e) apărute după E`);
      const aliveNew = tobs.outstanding().filter(t => !aliveAtE.has(t.id));
      if (aliveNew.length > 0) harness.push(`F5. ${aliveNew.length} timer(e) vii după cleanup, apărute după E`);
      for (const t of [...forcedNew, ...aliveNew, ...tobs.outstanding()]) accountedAlive.add(t.id);
      // F6. sursele persistente de erori, recitite DUPĂ cleanup: ce a apărut doar în consolă în timpul lui.
      collectErrors("după cleanup", true);
      countsAtF = violationCounts();
    })
    .catch((e: unknown) => { harness.push("verificări finale: " + errText(e)); });
}
