/**
 * scripts/beta1/harness/selfTest.ts — BETA-1, felia 1: controalele PROPRII ale harness-ului.
 *
 * Verifică gărzile, observatorii și nodul local ÎNTRE ELE, cu un client `ws` simplu pe post de „worker".
 * NU importă nimic din `src/` și NU exercită codul workerului: un rezultat verde aici spune doar că uneltele probei
 * funcționează, nimic despre BETA-1.
 *
 * Fiecare gardă are un control care TREBUIE să se declanșeze (o gardă inertă nu trece drept ermeticitate) și, unde
 * are sens, un control pozitiv (calea permisă chiar funcționează).
 *
 * Ieșire: o linie JSON pe stdout (`{ ok, inject, passed, failed, failures }`); detaliile pe stderr. Cod 0 = toate
 * controalele au trecut; 3 = cel puțin unul a eșuat sau harness-ul a aruncat. Procesul NU apelează `process.exit`:
 * trebuie să se termine singur — de aceea cleanup-ul (mărginit) rulează pe ORICE traseu.
 *
 * Verdictul se dă în TREI timpi, ca nimic să nu scape între ei:
 *   E. înainte de cleanup — aici se vede ce a RĂMAS (timere, execuții); cleanup-ul nu are voie să ascundă asta;
 *   F. după cleanup — erorile ȘI resursele apărute în timpul cleanup-ului (o resursă nouă anulată forțat rămâne eșec);
 *   G. la `exit` — orice eroare sau resursă vie apărută după F, până la terminare. Raportul și codul de ieșire se
 *      scriu ABIA aici.
 *
 * `--inject=<nume>` strică deliberat un singur lucru, în afara oricărui control etichetat. Rularea TREBUIE atunci să
 * eșueze (cod 3) și să se TERMINE. Injecțiile sunt rulate de `selfTestRunner.ts`, care verifică ambele.
 */

import { installNetGuard, GUARD_ERROR_CODE } from "./netGuard";
import {
  installConsoleCapture, installTimerObserver, installProcessObserver, observeSocket, waitUntil, withDeadline,
  realTimers, HarnessError, type TimerRecord,
} from "./observers";
import { INJECTIONS, type InjectionName } from "./injections";
import { startLocalNode, matchesFilter, type RpcLog, type LogFilter, type LocalNode } from "./localNode";

import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import WebSocket from "ws";

// Ordinea contează: gărzile și observatorii ÎNAINTE de orice altă activitate.
const guard = installNetGuard();
const proc  = installProcessObserver();
const cons  = installConsoleCapture();
const tobs  = installTimerObserver();

const out = (s: string): void => { process.stderr.write(s + "\n"); };
let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; out("  ✅ " + name); }
  else      { failures.push(name); out("  ❌ " + name); }
}

const injectArg = process.argv.find(a => a.startsWith("--inject="))?.slice("--inject=".length) ?? null;
if (injectArg !== null && !INJECTIONS.some(i => i.name === injectArg)) {
  throw new Error(`injecție necunoscută: ${injectArg}`);
}
const inject = injectArg as InjectionName | null;

/** Tot ce trebuie închis pe ORICE traseu, ca procesul să se poată termina. */
const opened: { node: LocalNode | null; sockets: WebSocket[] } = { node: null, sockets: [] };

/** Termen-limită pentru orice control care așteaptă un callback. */
const CB_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise(r => { realTimers.setTimeout(r, ms); });

/** Așteaptă `error` pe un socket refuzat; întoarce codul erorii sau `null` la expirare. */
function errorCodeOf(s: net.Socket, deadlineMs = 1_000): Promise<string | null> {
  return new Promise(resolve => {
    const t = realTimers.setTimeout(() => resolve(null), deadlineMs);
    s.once("error", (e: NodeJS.ErrnoException) => { realTimers.clearTimeout(t); resolve(e.code ?? "(fără cod)"); });
  });
}

const T_SWAP  = "0x" + "aa".repeat(32);
const T_MINT  = "0x" + "bb".repeat(32);
const T_OTHER = "0x" + "cc".repeat(32);
const ADDR_A  = "0x" + "a1".repeat(20);
const ADDR_B  = "0x" + "b2".repeat(20);
const POOL_1  = "0x" + "11".repeat(32);
const POOL_2  = "0x" + "22".repeat(32);
const mkLog = (address: string, topics: string[], n: number): RpcLog =>
  ({ address, topics, data: "0x", transactionHash: "0x" + n.toString(16).padStart(64, "0") });

async function main(): Promise<void> {
  // ── A. Gardul de rețea ────────────────────────────────────────────────────────────────────────────────────
  out("A. gardul de rețea");
  tobs.setPhase("guard");

  // A1. Înainte de `allowOnly`, NIMIC nu e permis — nici 127.0.0.1.
  {
    const s = guard.runControl("A1", () => net.connect(9, "127.0.0.1"));
    check("A1. înainte de allowOnly: TCP către 127.0.0.1 refuzat", (await errorCodeOf(s)) === GUARD_ERROR_CODE);
  }

  const node = await withDeadline(startLocalNode(), CB_MS, "pornirea nodului local");
  opened.node = node;
  guard.allowOnly(node.port);
  check("A2. allowOnly fixează portul nodului", guard.allowedPort() === node.port);
  check("A3. al doilea allowOnly aruncă", (() => { try { guard.allowOnly(node.port); return false; } catch { return true; } })());

  const otherPort = node.port === 65535 ? node.port - 1 : node.port + 1;
  const tcpCases: Array<[string, () => net.Socket, string]> = [
    ["A4. alt port pe 127.0.0.1",        () => net.connect(otherPort, "127.0.0.1"),                `127.0.0.1:${otherPort}`],
    ["A5. `localhost` pe portul permis", () => net.connect(node.port, "localhost"),                `localhost:${node.port}`],
    ["A6. `::1` pe portul permis",       () => net.connect({ host: "::1", port: node.port }),      `::1:${node.port}`],
    ["A7. 127.0.0.2 pe portul permis",   () => net.connect({ host: "127.0.0.2", port: node.port }), `127.0.0.2:${node.port}`],
    ["A8. port fără gazdă (= localhost)", () => net.connect(node.port),                            `localhost:${node.port}`],
    ["A9. new Socket().connect(port, host)", () => new net.Socket().connect(otherPort, "127.0.0.1"), `127.0.0.1:${otherPort}`],
  ];
  for (const [name, fn, detail] of tcpCases) {
    const label = name.slice(0, 2);
    const s = guard.runControl(label, fn);
    const code = await errorCodeOf(s);
    const rec = guard.refusals().filter(r => r.control === label);
    check(`${name}: refuzat și numărat`, code === GUARD_ERROR_CODE && rec.length === 1 && rec[0].kind === "tcp" && rec[0].detail === detail);
  }
  {
    const s = guard.runControl("A10", () => net.connect("/tmp/beta1-harness-nu-exista.sock"));
    const code = await errorCodeOf(s);
    const rec = guard.refusals().filter(r => r.control === "A10");
    check("A10. socket Unix/IPC (string): refuzat ca ipc", code === GUARD_ERROR_CODE && rec.length === 1 && rec[0].kind === "ipc");
  }
  {
    const s = guard.runControl("A11", () => net.connect({ path: "/tmp/beta1-harness-nu-exista.sock" }));
    const code = await errorCodeOf(s);
    check("A11. socket Unix/IPC ({path}): refuzat ca ipc", code === GUARD_ERROR_CODE && guard.refusals().filter(r => r.control === "A11" && r.kind === "ipc").length === 1);
  }
  {
    // TLS chiar către destinația permisă: refuzat integral.
    const s = guard.runControl("A12", () => tls.connect({ host: "127.0.0.1", port: node.port }));
    const code = await errorCodeOf(s);
    check("A12. tls.connect către destinația permisă: refuzat ca tls", code === GUARD_ERROR_CODE && guard.refusals().filter(r => r.control === "A12" && r.kind === "tls").length === 1);
  }
  {
    const res = await withDeadline(new Promise<string>(resolve => {
      guard.runControl("A13", () => {
        const req = https.get({ host: "127.0.0.1", port: node.port, path: "/" }, () => resolve("răspuns"));
        req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "(fără cod)"));
      });
    }), CB_MS, "A13");
    check("A13. https.get: refuzat prin gardul TLS", res === GUARD_ERROR_CODE && guard.refusals().some(r => r.control === "A13" && r.kind === "tls"));
  }
  {
    const res = await withDeadline(new Promise<string>(resolve => {
      guard.runControl("A14", () => {
        const req = http.get({ host: "127.0.0.1", port: otherPort, path: "/" }, () => resolve("răspuns"));
        req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "(fără cod)"));
      });
    }), CB_MS, "A14");
    check("A14. http.get către alt port: refuzat prin gardul TCP", res === GUARD_ERROR_CODE && guard.refusals().some(r => r.control === "A14" && r.kind === "tcp"));
  }
  {
    const code = await withDeadline(new Promise<string>(resolve => {
      guard.runControl("A15", () => { dns.lookup("example.invalid", (e) => resolve((e as NodeJS.ErrnoException | null)?.code ?? "fără eroare")); });
    }), CB_MS, "A15");
    check("A15. dns.lookup: refuzat", code === GUARD_ERROR_CODE && guard.refusals().some(r => r.control === "A15" && r.kind === "dns"));
  }
  {
    const before = guard.refusals().length;
    const r = await withDeadline(new Promise<string>(resolve => { dns.lookup("127.0.0.1", (e, addr, fam) => resolve(e ? "eroare" : `${addr}/${fam}`)); }), CB_MS, "A15b");
    check("A15b. dns.lookup pe IP literal: răspuns local, fără refuz", r === "127.0.0.1/4" && guard.refusals().length === before);
  }
  {
    const p = guard.runControl("A16", () => dns.promises.resolve4("example.invalid"));
    const code = await withDeadline(p.then(() => "fără eroare", (e: NodeJS.ErrnoException) => e.code ?? "(fără cod)"), CB_MS, "A16");
    check("A16. dns.promises.resolve4: refuzat", code === GUARD_ERROR_CODE && guard.refusals().some(r => r.control === "A16" && r.kind === "dns"));
  }
  {
    let threw = "";
    guard.runControl("A17", () => { try { dgram.createSocket("udp4"); } catch (e) { threw = (e as NodeJS.ErrnoException).code ?? ""; } });
    check("A17. dgram.createSocket: refuzat", threw === GUARD_ERROR_CODE && guard.refusals().some(r => r.control === "A17" && r.kind === "udp"));
  }
  {
    const p = guard.runControl("A18", () => fetch("https://example.invalid/cale/secreta?token=abc"));
    const code = await withDeadline(p.then(() => "fără eroare", (e: NodeJS.ErrnoException) => e.code ?? "(fără cod)"), CB_MS, "A18");
    const rec = guard.refusals().filter(r => r.control === "A18");
    check("A18. fetch fără fixture: refuzat", code === GUARD_ERROR_CODE && rec.length === 1 && rec[0].kind === "fetch");
    check("A19. refuzul fetch reține doar gazda (fără cale/query)", rec.length === 1 && rec[0].detail === "example.invalid");
  }
  {
    guard.setFetchFixture("https://fixture.invalid/x", { status: 200, body: '{"ok":true}' });
    const before = guard.refusals().length;
    const r = await withDeadline(fetch("https://fixture.invalid/x"), CB_MS, "A20");
    const body = await withDeadline(r.json() as Promise<{ ok?: boolean }>, CB_MS, "A20 body");
    check("A20. fetch cu fixture exact: servit din memorie, fără refuz", r.status === 200 && body.ok === true && guard.refusals().length === before && guard.fetchServed() === 1);
  }
  check("A21. niciun refuz în afara controalelor deliberate", guard.violations().length === 0);
  check("A22. nicio conexiune permisă până acum; nodul nu a văzut niciun client", guard.permittedConnections() === 0 && node.clientCount() === 0 && node.anomalies().length === 0);

  // ── B. Calea permisă + nodul local ────────────────────────────────────────────────────────────────────────
  out("B. nodul local (client ws pe post de worker)");
  tobs.setPhase("node");
  const client = new WebSocket(node.url);
  opened.sockets.push(client);
  const sobs = observeSocket(client, () => 0);
  await waitUntil(() => client.readyState === WebSocket.OPEN, 2_000, "client conectat la nodul local");
  check("B1. conexiunea către 127.0.0.1:port permis reușește", guard.permittedConnections() === 1 && node.clientCount() === 1);

  // B2. Potrivirea filtrului (funcție pură) — tabel de controale.
  {
    const f: LogFilter = { address: [ADDR_A, ADDR_B], topics: [[T_SWAP, T_MINT]] };
    const fV4: LogFilter = { address: ADDR_A, topics: [[T_SWAP], [POOL_1]] };
    const rows: Array<[string, boolean]> = [
      ["adresă din listă + topic din listă",        matchesFilter(f, mkLog(ADDR_B, [T_MINT], 1)) === true],
      ["adresă cu majuscule diferite",              matchesFilter(f, mkLog(ADDR_A.toUpperCase().replace("0X", "0x"), [T_SWAP], 2)) === true],
      ["adresă în afara listei",                    matchesFilter(f, mkLog("0x" + "ff".repeat(20), [T_SWAP], 3)) === false],
      ["topic0 străin",                             matchesFilter(f, mkLog(ADDR_A, [T_OTHER], 4)) === false],
      ["log fără topicuri",                         matchesFilter(f, mkLog(ADDR_A, [], 5)) === false],
      ["poziția 1: poolId cerut",                   matchesFilter(fV4, mkLog(ADDR_A, [T_SWAP, POOL_1], 6)) === true],
      ["poziția 1: alt poolId",                     matchesFilter(fV4, mkLog(ADDR_A, [T_SWAP, POOL_2], 7)) === false],
      ["poziția 1 lipsește din log",                matchesFilter(fV4, mkLog(ADDR_A, [T_SWAP], 8)) === false],
      ["`null` pe poziția 0 = orice",               matchesFilter({ topics: [null, POOL_1] }, mkLog(ADDR_B, [T_OTHER, POOL_1], 9)) === true],
      ["filtru gol = orice",                        matchesFilter({}, mkLog(ADDR_B, [T_OTHER], 10)) === true],
      ["adresă string, alta în log",                matchesFilter(fV4, mkLog(ADDR_B, [T_SWAP, POOL_1], 11)) === false],
      ["wildcard `null` pe poziție ABSENTĂ din log → nu", matchesFilter({ topics: [T_SWAP, null] }, mkLog(ADDR_A, [T_SWAP], 12)) === false],
      ["wildcard `null` pe poziție PREZENTĂ → da",  matchesFilter({ topics: [T_SWAP, null] }, mkLog(ADDR_A, [T_SWAP, POOL_2], 13)) === true],
      ["listă goală pe poziție ABSENTĂ → nu",       matchesFilter({ topics: [T_SWAP, []] }, mkLog(ADDR_A, [T_SWAP], 14)) === false],
      ["listă goală pe poziție PREZENTĂ → da",      matchesFilter({ topics: [T_SWAP, []] }, mkLog(ADDR_A, [T_SWAP, POOL_2], 15)) === true],
      ["filtru mai scurt decât logul → da",         matchesFilter({ topics: [T_SWAP] }, mkLog(ADDR_A, [T_SWAP, POOL_1, POOL_2], 16)) === true],
    ];
    for (const [name, ok] of rows) check(`B2. filtru — ${name}`, ok);
  }

  // B3. Capturarea cererii, exact cum a fost trimisă, și confirmarea.
  const filterSent = { address: [ADDR_A, ADDR_B], topics: [[T_SWAP, T_MINT]] };
  client.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_subscribe", params: ["logs", filterSent] }));
  const ack = await sobs.waitForFrame(f => (f.json as { id?: unknown } | undefined)?.id === 7, 2_000, "confirmare eth_subscribe");
  const req0 = node.requests()[0];
  const subId = (ack.json as { result?: unknown }).result;
  check("B3a. cererea capturată are parametrii identici cu cei trimiși", node.requests().length === 1 && JSON.stringify(req0.params) === JSON.stringify(["logs", filterSent]) && req0.id === 7);
  check("B3b. confirmarea poartă id-ul de subscripție ținut minte de nod", typeof subId === "string" && subId === req0.subId && node.subscriptions()[0].active === true);

  // B4. Livrare prin filtru + santinelă: ordinea la DESTINAȚIE.
  const logOk  = mkLog(ADDR_A, [T_SWAP], 100);
  const logNo  = mkLog(ADDR_A, [T_OTHER], 101);
  const nSent  = node.offerLogs([logOk, logNo]);
  if (inject !== "sentinel-timeout") node.sendSentinel("s1");
  const s1 = await sobs.waitForFrame(f => (f.json as { params?: { tag?: unknown } } | undefined)?.params?.tag === "s1", 2_000, "santinela s1");
  const txOf = (j: unknown): string | undefined => (j as { params?: { result?: { transactionHash?: string } } } | undefined)?.params?.result?.transactionHash;
  const seenOk = sobs.frames().filter(f => txOf(f.json) === logOk.transactionHash);
  const seenNo = sobs.frames().filter(f => txOf(f.json) === logNo.transactionHash);
  check("B4a. nodul trimite doar logul care trece de filtru", nSent === 1);
  check("B4b. clientul a văzut logul potrivit, etichetat cu subscripția lui", seenOk.length === 1 && (seenOk[0].json as { params: { subscription: string } }).params.subscription === subId);
  check("B4c. clientul NU a văzut logul nepotrivit", seenNo.length === 0);
  check("B4d. logul a sosit ÎNAINTEA santinelei (ordine păstrată)", seenOk.length === 1 && seenOk[0].seq < s1.seq);
  check("B4e. observatorul citește sonda la fiecare cadru", s1.probe === 0 && seenOk[0].probe === 0);
  check("B4f. loguri trimise de nod = loguri văzute la client", node.sent().filter(x => x.kind === "log").length === sobs.frames().filter(f => txOf(f.json) !== undefined).length);

  // B5. Livrare forțată: ocolește filtrul și e marcată distinct.
  node.forceSend(logNo, subId as string);
  node.sendSentinel("s2");
  await sobs.waitForFrame(f => (f.json as { params?: { tag?: unknown } } | undefined)?.params?.tag === "s2", 2_000, "santinela s2");
  check("B5a. logul forțat ajunge la client", sobs.frames().filter(f => txOf(f.json) === logNo.transactionHash).length === 1);
  check("B5b. evidența nodului îl marchează `forced-log`, separat de `log`", node.sent().filter(x => x.kind === "forced-log").length === 1 && node.sent().filter(x => x.kind === "log").length === 1);

  // B6. Bariera client → nod prin ping cu încărcătură unică; dovedește și ABSENȚA unei cereri.
  const reqBefore = node.requests().length;
  client.ping("beta1-ping-1");
  await waitUntil(() => node.pings().includes("beta1-ping-1"), 2_000, "ping văzut de nod");
  check("B6. ping-ul unic ajunge la nod; nicio cerere nouă înaintea lui", node.requests().length === reqBefore);

  // B7. Dezabonare: subscripția devine inactivă și nu mai primește loguri.
  client.send(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "eth_unsubscribe", params: [subId] }));
  await sobs.waitForFrame(f => (f.json as { id?: unknown } | undefined)?.id === 8, 2_000, "confirmare eth_unsubscribe");
  const nAfter = node.offerLogs([mkLog(ADDR_A, [T_SWAP], 102)]);
  check("B7. după eth_unsubscribe nu se mai trimite nimic", node.subscriptions()[0].active === false && nAfter === 0);

  // B8. Anomalii: metodă necunoscută, parametri invalizi, cadru ne-JSON — toate înregistrate, niciuna tăcută.
  const anBefore = node.anomalies().length;
  client.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "eth_chainId", params: [] }));
  client.send(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "eth_subscribe", params: ["newHeads"] }));
  client.send("nu sunt json");
  client.ping("beta1-ping-2");
  await waitUntil(() => node.pings().includes("beta1-ping-2"), 2_000, "ping-2 văzut de nod");
  check("B8a. trei anomalii înregistrate de nod", node.anomalies().length === anBefore + 3);
  check("B8b. cererea invalidă e capturată fără id de subscripție", node.requests().some(r => r.id === 10 && r.subId === null));

  // B9. A doua conexiune e anomalie (proba așteaptă un singur client).
  const second = new WebSocket(node.url);
  opened.sockets.push(second);
  await waitUntil(() => second.readyState === WebSocket.OPEN, 2_000, "al doilea client conectat");
  check("B9. a doua conexiune e înregistrată ca anomalie", node.anomalies().some(a => a.includes("conexiune #2")));
  second.close();
  await waitUntil(() => second.readyState === WebSocket.CLOSED, 2_000, "al doilea client închis");

  // ── C. Observatori ────────────────────────────────────────────────────────────────────────────────────────
  out("C. observatori");
  tobs.setPhase("observers");

  check("C1. captura de consolă regăsește linia-martor", cons.selfCheck());
  console.log("[WS ERR base]", new Error("eroare de probă"));
  check("C2. o linie `[WS ERR` cu obiect Error e capturată ca text", cons.count("[WS ERR base]") === 1 && cons.count("eroare de probă") === 1);

  {
    let ran = false;
    setTimeout(() => { ran = true; }, 20);
    const rec = tobs.records().filter(r => r.phase === "observers" && r.delayMs === 20);
    check("C3a. un setTimeout nou apare în evidență ca `pending`", rec.length === 1 && rec[0].state === "pending" && rec[0].kind === "timeout");
    await waitUntil(() => tobs.records().some(r => r.id === rec[0].id && r.state === "done"), 1_000, "timeout terminat");
    check("C3b. după execuție devine `done`", ran && tobs.outstanding().every(r => r.id !== rec[0].id));
  }
  {
    const h = setTimeout(() => { /* nu trebuie să ruleze */ }, 60_000);
    const id = tobs.records().filter(r => r.delayMs === 60_000)[0].id;
    clearTimeout(h);
    check("C4. clearTimeout îl marchează `cleared` și îl scoate din cele existente", tobs.records().some(r => r.id === id && r.state === "cleared") && tobs.outstanding().every(r => r.id !== id));
  }
  {
    const h = setTimeout(() => { /* unref */ }, 61_000);
    h.unref();
    const mine = tobs.outstanding().filter(r => r.delayMs === 61_000);
    check("C5. un timer cu unref() rămâne în evidență, cu hasRef=false", mine.length === 1 && mine[0].hasRef === false);
    clearTimeout(h);
  }
  {
    let ticks = 0;
    const h = setInterval(() => { ticks++; }, 10);
    await waitUntil(() => ticks >= 2, 1_000, "interval cu două ticuri");
    const mine = tobs.outstanding().filter(r => r.kind === "interval" && r.delayMs === 10);
    check("C6a. un interval activ rămâne în cele existente și numără ticurile", mine.length === 1 && mine[0].fires >= 2);
    clearInterval(h);
    check("C6b. clearInterval îl scoate", tobs.outstanding().every(r => !(r.kind === "interval" && r.delayMs === 10)));
  }
  {
    let release: () => void = () => { /* setat mai jos */ };
    const gate = new Promise<void>(r => { release = r; });
    setTimeout(async () => { await gate; }, 5);
    await waitUntil(() => tobs.records().some(r => r.delayMs === 5 && r.state === "running"), 1_000, "callback async pornit");
    check("C7a. un callback async rămâne `running` cât timp promisiunea e în așteptare", tobs.outstanding().some(r => r.delayMs === 5));
    release();
    await waitUntil(() => tobs.records().some(r => r.delayMs === 5 && r.state === "done"), 1_000, "callback async terminat");
    check("C7b. și devine `done` abia la rezolvare", true);
  }
  {
    let expired = false;
    try { await waitUntil(() => false, 30, "control de expirare"); }
    catch (e) { expired = e instanceof HarnessError; }
    check("C8. o barieră expirată aruncă HarnessError (nu trece tăcut)", expired);
  }
  {
    const marker = "beta1-respingere-deliberată";
    proc.expect(marker);
    void Promise.reject(new Error(marker));
    await waitUntil(() => proc.faults().length > 0, 1_000, "respingere neprinsă observată");
    const f = proc.faults();
    check("C9. o respingere neprinsă e înregistrată de observatorul de proces, etichetată ca deliberată",
      f.length === 1 && f[0].kind === "unhandledRejection" && f[0].message.includes(marker) && f[0].control === marker && proc.violations().length === 0);
  }
  {
    // Respingere ASYNC într-un callback de timer: observatorul de timere o consumă, deci `unhandledRejection` NU o vede.
    const marker = "beta1-timer-respins-deliberat";
    tobs.runControl("C10", () => { setTimeout(async () => { throw new Error(marker); }, 1); });
    await waitUntil(() => tobs.faults().some(f => f.message.includes(marker)), 1_000, "eroare de timer async înregistrată");
    await sleep(20); // lasă loc unui eventual `unhandledRejection`
    const tf = tobs.faults().filter(f => f.message.includes(marker));
    check("C10a. respingerea async dintr-un timer are evidență persistentă", tf.length === 1 && tf[0].kind === "async-rejection" && tf[0].control === "C10");
    check("C10b. observatorul de proces NU o vede (de aceea evidența timerelor e obligatorie)", proc.faults().every(f => !f.message.includes(marker)));
    check("C10c. etichetată ca deliberată, nu contează ca încălcare", tobs.violations().length === 0);
  }
  {
    // Aruncare SINCRONĂ într-un callback de timer: ambele evidențe o văd.
    const marker = "beta1-timer-aruncat-deliberat";
    proc.expect(marker);
    tobs.runControl("C11", () => { setTimeout(() => { throw new Error(marker); }, 1); });
    await waitUntil(() => proc.faults().some(f => f.message.includes(marker)), 1_000, "aruncare sincronă observată");
    const tf = tobs.faults().filter(f => f.message.includes(marker));
    check("C11. aruncarea sincronă apare în ambele evidențe, etichetată", tf.length === 1 && tf[0].kind === "sync-throw" && tf[0].control === "C11"
      && proc.faults().filter(f => f.message.includes(marker) && f.kind === "uncaughtException" && f.control === marker).length === 1);
  }
  {
    // executat → refresh → unref: timerul REAL e din nou viu; evidența trebuie să-l arate, deși ieșirea naturală ar trece.
    let fires = 0;
    const h = setTimeout(() => { fires++; }, 40);
    const id = tobs.records().filter(r => r.delayMs === 40)[0].id;
    await waitUntil(() => tobs.records().some(r => r.id === id && r.state === "done"), 1_000, "timeout executat");
    check("C12a. după prima execuție e `done`, în afara celor existente", fires === 1 && tobs.outstanding().every(r => r.id !== id));
    h.refresh();
    h.unref();
    const again = tobs.outstanding().filter(r => r.id === id);
    check("C12b. executat → refresh → unref: reapare în cele existente, `pending`, hasRef=false", again.length === 1 && again[0].state === "pending" && again[0].hasRef === false && again[0].refreshes === 1);
    await waitUntil(() => fires === 2, 1_000, "a doua execuție după refresh");
    check("C12c. după a doua execuție e din nou `done`, cu fires=2", tobs.records().some(r => r.id === id && r.state === "done" && r.fires === 2) && tobs.outstanding().every(r => r.id !== id));
  }
  {
    // eroarea rămâne în evidență chiar dacă starea e suprascrisă prin refresh()
    const marker = "beta1-timer-respins-apoi-refresh";
    let n = 0;
    const h = tobs.runControl("C13", () => setTimeout(async () => { if (++n === 1) throw new Error(marker); }, 15));
    await waitUntil(() => tobs.faults().some(f => f.message.includes(marker)), 1_000, "prima execuție respinsă");
    h.refresh();
    await waitUntil(() => n === 2, 1_000, "a doua execuție");
    await waitUntil(() => tobs.records().some(r => r.delayMs === 15 && r.state === "done"), 1_000, "a doua execuție terminată");
    check("C13. după refresh starea devine `done`, dar eroarea primei execuții rămâne în `faults`", tobs.faults().filter(f => f.message.includes(marker)).length === 1);
  }
  {
    // refresh() în timp ce o execuție async e încă în lucru: starea nu are voie să devină `done` prematur.
    let release: () => void = () => { /* setat mai jos */ };
    const gate = new Promise<void>(r => { release = r; });
    let n = 0;
    const h = setTimeout(async () => { if (++n === 1) await gate; }, 25);
    const id = tobs.records().filter(r => r.delayMs === 25)[0].id;
    await waitUntil(() => n === 1, 1_000, "prima execuție pornită");
    h.refresh();
    await waitUntil(() => n === 2, 1_000, "a doua execuție");
    await sleep(10);
    check("C14a. cu o execuție veche încă în lucru, timerul rămâne `running`", tobs.outstanding().some(r => r.id === id && r.state === "running"));
    release();
    await waitUntil(() => tobs.records().some(r => r.id === id && r.state === "done"), 1_000, "toate execuțiile încheiate");
    check("C14b. devine `done` abia când toate execuțiile s-au încheiat", true);
  }
  {
    const h = setTimeout(() => { /* anulat */ }, 62_000);
    const id = tobs.records().filter(r => r.delayMs === 62_000)[0].id;
    clearTimeout(h);
    h.refresh();
    check("C15. anulat → refresh: rămâne `cleared` (Node nu-l mai execută)", tobs.records().some(r => r.id === id && r.state === "cleared" && r.refreshes === 1) && tobs.outstanding().every(r => r.id !== id));
    realTimers.clearTimeout(h);
  }
  {
    const h = setTimeout(() => { /* close */ }, 63_000);
    const id = tobs.records().filter(r => r.delayMs === 63_000)[0].id;
    h.close();
    check("C16. handle.close() e recunoscut ca anulare", tobs.records().some(r => r.id === id && r.state === "cleared"));
  }
  {
    let late = false;
    try { await withDeadline(new Promise<void>(() => { /* nu se așază niciodată */ }), 30, "control withDeadline"); }
    catch (e) { late = e instanceof HarnessError; }
    check("C17. withDeadline respinge o promisiune care nu se așază", late);
  }

  {
    // Callbackul async își anulează singur handle-ul, apoi rămâne în așteptare: programarea e anulată, execuția NU.
    let release: () => void = () => { /* setat mai jos */ };
    const gate = new Promise<void>(r => { release = r; });
    let started = false;
    const h: NodeJS.Timeout = setTimeout(async () => { started = true; clearTimeout(h); await gate; }, 7);
    const id = tobs.records().filter(r => r.delayMs === 7)[0].id;
    await waitUntil(() => started, 1_000, "callback async pornit (C18)");
    await sleep(10);
    const mine = tobs.outstanding().filter(r => r.id === id);
    check("C18a. anulat în timpul execuției async: rămâne în cele existente (`running`, cancelled, inFlight=1)",
      mine.length === 1 && mine[0].state === "running" && mine[0].cancelled === true && mine[0].inFlight === 1);
    release();
    await waitUntil(() => tobs.records().some(r => r.id === id && r.inFlight === 0), 1_000, "execuția anulată s-a încheiat (C18)");
    check("C18b. după încheierea execuției devine `cleared` și iese din cele existente", tobs.records().some(r => r.id === id && r.state === "cleared") && tobs.outstanding().every(r => r.id !== id));
  }
  {
    // Interval cu execuții async SUPRAPUSE, anulat cât timp ele sunt în lucru.
    let release: () => void = () => { /* setat mai jos */ };
    const gate = new Promise<void>(r => { release = r; });
    let n = 0;
    const h = setInterval(async () => { n++; await gate; }, 8);
    const id = tobs.records().filter(r => r.kind === "interval" && r.delayMs === 8)[0].id;
    await waitUntil(() => n >= 3, 1_000, "trei ticuri suprapuse (C19)");
    clearInterval(h);
    const firesAtCancel = tobs.records().filter(r => r.id === id)[0].fires;
    await sleep(40);
    const mine = tobs.outstanding().filter(r => r.id === id);
    check("C19a. interval anulat cu execuții suprapuse: rămâne în cele existente cu inFlight ≥ 3",
      mine.length === 1 && mine[0].cancelled === true && mine[0].inFlight >= 3 && mine[0].state === "running");
    check("C19b. după anulare nu mai pornește nicio execuție nouă", mine.length === 1 && mine[0].fires === firesAtCancel);
    release();
    await waitUntil(() => tobs.records().some(r => r.id === id && r.inFlight === 0), 1_000, "execuțiile suprapuse s-au încheiat (C19)");
    check("C19c. iese din cele existente abia când TOATE execuțiile s-au încheiat", tobs.outstanding().every(r => r.id !== id) && tobs.records().some(r => r.id === id && r.state === "cleared"));
  }
  {
    // Aceeași regulă pentru handle.close() chemat din callback.
    let release: () => void = () => { /* setat mai jos */ };
    const gate = new Promise<void>(r => { release = r; });
    let started = false;
    const h: NodeJS.Timeout = setTimeout(async () => { started = true; h.close(); await gate; }, 9);
    const id = tobs.records().filter(r => r.delayMs === 9)[0].id;
    await waitUntil(() => started, 1_000, "callback async pornit (C20)");
    check("C20. close() în timpul execuției async nu o ascunde", tobs.outstanding().some(r => r.id === id && r.cancelled && r.inFlight === 1));
    release();
    await waitUntil(() => tobs.outstanding().every(r => r.id !== id), 1_000, "execuția s-a încheiat (C20)");
  }
  {
    // Receiverul și argumentele callbackului trec neschimbate prin observator (callback `function`, nu arrow).
    let seenThis: unknown = null;
    let seenArgs: unknown[] = [];
    const h = setTimeout(function (this: unknown, ...a: unknown[]) { seenThis = this; seenArgs = a; }, 6, "x", 2);
    await waitUntil(() => seenThis !== null, 1_000, "callback cu receiver (C21)");
    check("C21a. `this` din callback este handle-ul timerului", seenThis === h);
    check("C21b. argumentele suplimentare ajung neschimbate", seenArgs.length === 2 && seenArgs[0] === "x" && seenArgs[1] === 2);
    let ticks = 0;
    let intervalThis: unknown = null;
    const hi: NodeJS.Timeout = setInterval(function (this: NodeJS.Timeout) { intervalThis = this; if (++ticks === 2) this.close(); }, 5);
    await waitUntil(() => ticks === 2, 1_000, "interval care se închide prin `this` (C21)");
    await sleep(20);
    check("C21c. un interval se poate anula prin `this.close()` și evidența îl urmează", intervalThis === hi && ticks === 2 && tobs.outstanding().every(r => !(r.kind === "interval" && r.delayMs === 5)));
  }

  // ── Injecții (doar cu --inject): strică UN lucru, în afara oricărui control etichetat ────────────────────
  if (inject === "cancel-inflight-timeout") {
    const h: NodeJS.Timeout = setTimeout(async () => { clearTimeout(h); await new Promise<void>(() => { /* niciodată */ }); }, 1);
    await sleep(40);
  }
  if (inject === "cancel-inflight-interval") {
    let n = 0;
    const h = setInterval(async () => { n++; await new Promise<void>(() => { /* niciodată */ }); }, 5);
    await waitUntil(() => n >= 2, 1_000, "ticuri suprapuse injectate");
    clearInterval(h);
  }
  if (inject === "timer-rejection") {
    setTimeout(async () => { throw new Error("beta1-injectat: timer respins"); }, 1);
    await sleep(40);
  }
  if (inject === "refresh-unref") {
    const h = setTimeout(() => { /* injectat */ }, 400);
    await sleep(450);
    h.refresh();
    h.unref();
  }
  if (inject === "leaked-interval") {
    setInterval(() => { /* injectat: interval lăsat pornit */ }, 50);
  }
  if (inject === "net-violation") {
    const s = net.connect(otherPort, "127.0.0.1");
    await errorCodeOf(s);
  }
  if (inject === "process-fault") {
    void Promise.reject(new Error("beta1-injectat: respingere neprinsă"));
    await sleep(40);
  }

  // ── D. Închidere ──────────────────────────────────────────────────────────────────────────────────────────
  out("D. închidere");
  tobs.setPhase("shutdown");
  client.close();
  await waitUntil(() => sobs.closedCode() !== null, 2_000, "client închis");
  await node.close();
  await sleep(20);
  check("D1. clientul e închis și observatorul a văzut `close`", client.readyState === WebSocket.CLOSED && sobs.closedCode() !== null);
  check("D2. nodul nu mai are clienți", node.clientCount() === 0);
  check("D3. socketul client nu a emis nicio eroare", sobs.errors().length === 0);
  check("D4. exact conexiunile așteptate au fost permise (client + al doilea client)", guard.permittedConnections() === 2);
}

/** Câte urme în afara controalelor deliberate există ACUM, pe fiecare canal. */
function violationCounts(): { net: number; timer: number; proc: number } {
  return { net: guard.violations().length, timer: tobs.violations().length, proc: proc.violations().length };
}

/**
 * E — validitatea ÎNAINTE de cleanup. Aici se vede ce a rămas; cleanup-ul anulează forțat timerele, deci E4 NU are
 * voie să fie mutat după el.
 */
/** Id-urile timerelor vii la E: deja raportate de E4. Tot ce apare viu în plus, mai târziu, e resursă NOUĂ. */
const aliveAtE = new Set<number>();
/** Id-urile timerelor deja socotite eșec (E4, F4, F5) — G2 caută doar ce nu e aici. */
const accountedAlive = new Set<number>();

function checkValidityBeforeCleanup(): void {
  out("E. validitatea rulării (înainte de cleanup)");
  const gv = guard.violations(), tv = tobs.violations(), pv = proc.violations(), left = tobs.outstanding();
  check("E1. niciun refuz de rețea în afara controalelor", gv.length === 0);
  check("E2. nicio eroare de callback de timer în afara controalelor", tv.length === 0);
  check("E3. nicio excepție la nivel de proces în afara controalelor", pv.length === 0);
  check("E4. niciun timer viu în evidență (programat, reactivat, cu unref, sau cu execuții async neîncheiate)", left.length === 0);
  if (gv.length)   out("     refuzuri: " + JSON.stringify(gv));
  if (tv.length)   out("     erori de timer: " + JSON.stringify(tv));
  if (pv.length)   out("     erori de proces: " + JSON.stringify(pv));
  if (left.length) out("     timere vii: " + JSON.stringify(left));
  for (const t of left) { aliveAtE.add(t.id); accountedAlive.add(t.id); }
}

/** Cleanup MĂRGINIT, pe orice traseu: fără el, o barieră expirată ar lăsa socketurile deschise și procesul agățat. */
async function cleanup(): Promise<TimerRecord[]> {
  if (inject === "cleanup-new-timer") {
    setTimeout(() => { /* injectat: timer nou apărut în timpul cleanup-ului */ }, 60_000);
  }
  if (inject === "late-unref-interval") {
    // Apare DUPĂ verificarea F; nu aruncă nimic și, având unref(), nu ține procesul viu.
    realTimers.setTimeout(() => { setInterval(() => { /* injectat */ }, 60_000).unref(); }, 150);
  }
  if (inject === "cleanup-fault") {
    void Promise.reject(new Error("beta1-injectat: eroare în timpul cleanup-ului"));
  }
  if (inject === "cleanup-late-fault") {
    // `realTimers`: în afara evidenței și a anulării forțate — apare DUPĂ verificarea F, înainte de terminare.
    realTimers.setTimeout(() => { void Promise.reject(new Error("beta1-injectat: eroare târzie, după cleanup")); }, 150);
  }
  for (const ws of opened.sockets) {
    if (ws.readyState !== WebSocket.CLOSED) { try { ws.terminate(); } catch { /* best-effort */ } }
  }
  if (opened.node) {
    try { await opened.node.close(1_000); } catch { /* deja închis sau expirat: clienții au fost opriți forțat */ }
  }
  const forced = tobs.clearOutstandingForCleanup();
  if (forced.length > 0) out(`  cleanup: ${forced.length} timer(e) anulate forțat`);
  await sleep(30); // lasă erorile produse de cleanup să ajungă la observatori
  return forced;
}

/** F — erori apărute ÎN TIMPUL cleanup-ului (față de numărătoarea de la E). */
function checkAfterCleanup(atE: { net: number; timer: number; proc: number }, forced: TimerRecord[]): void {
  out("F. după cleanup");
  const now = violationCounts();
  check("F1. niciun refuz de rețea nou în timpul cleanup-ului", now.net === atE.net);
  check("F2. nicio eroare de timer nouă în timpul cleanup-ului", now.timer === atE.timer);
  check("F3. nicio excepție de proces nouă în timpul cleanup-ului", now.proc === atE.proc);
  // Dovada resurselor apărute DUPĂ E: anularea forțată nu le face verzi.
  const forcedNew = forced.filter(t => !aliveAtE.has(t.id));
  check("F4. cleanup-ul nu a anulat forțat niciun timer apărut după E", forcedNew.length === 0);
  if (forcedNew.length) out("     anulate forțat, apărute după E: " + JSON.stringify(forcedNew));
  const aliveNew = tobs.outstanding().filter(t => !aliveAtE.has(t.id));
  check("F5. după cleanup nu e viu niciun timer apărut după E", aliveNew.length === 0);
  if (aliveNew.length) out("     vii după cleanup, apărute după E: " + JSON.stringify(aliveNew));
  for (const t of [...forcedNew, ...aliveNew, ...tobs.outstanding()]) accountedAlive.add(t.id);
}

let countsAtF: { net: number; timer: number; proc: number } | null = null;
let reported = false;

/**
 * G — la TERMINARE. Raportul și codul de ieșire se scriu abia aici, sincron, ca o eroare apărută oricând după F să
 * invalideze rularea. Un `exit` fără ca fluxul să fi ajuns la F e el însuși eșec.
 */
process.on("exit", () => {
  if (reported) return;
  reported = true;
  if (countsAtF === null) {
    failures.push("G0. procesul se termină fără ca verificările E/F să fi rulat");
  } else {
    const now = violationCounts();
    if (now.net !== countsAtF.net || now.timer !== countsAtF.timer || now.proc !== countsAtF.proc) {
      failures.push(`G1. erori apărute după cleanup, până la terminare (rețea +${now.net - countsAtF.net}, timer +${now.timer - countsAtF.timer}, proces +${now.proc - countsAtF.proc})`);
    }
    // Resurse, nu doar erori: un timer cu unref() apărut după F nu aruncă nimic și nu ține procesul viu.
    const lateAlive = tobs.outstanding().filter(t => !accountedAlive.has(t.id));
    if (lateAlive.length > 0) {
      failures.push(`G2. ${lateAlive.length} timer(e) vii la terminare, apărute după F: ` +
        lateAlive.map(t => `#${t.id} ${t.kind} ${t.delayMs}ms hasRef=${t.hasRef} inFlight=${t.inFlight}`).join(", "));
    }
  }
  const failed = failures.length;
  const line = JSON.stringify({ ok: failed === 0, inject, passed, failed, failures }) + "\n";
  try { fs.writeSync(2, `\n${passed} trecute, ${failed} eșuate\n`); } catch { /* stderr indisponibil */ }
  // Scriere SINCRONĂ: în handlerul de `exit` nu mai rulează nimic asincron.
  let off = 0;
  const buf = Buffer.from(line, "utf8");
  for (let tries = 0; off < buf.length && tries < 1_000; tries++) {
    try { off += fs.writeSync(1, buf, off); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EAGAIN") break; }
  }
  process.exitCode = failed === 0 && off === buf.length ? 0 : 3;
});

main()
  .catch((e: unknown) => { failures.push("excepție în selfTest: " + (e instanceof Error ? e.message : String(e))); })
  .then(async () => {
    checkValidityBeforeCleanup();
    const atE = violationCounts();
    let forced: TimerRecord[] = [];
    try { forced = await cleanup(); }
    catch (e) { failures.push("excepție în cleanup: " + (e instanceof Error ? e.message : String(e))); }
    checkAfterCleanup(atE, forced);
    countsAtF = violationCounts();
  })
  .catch((e: unknown) => { failures.push("excepție în verificările finale: " + (e instanceof Error ? e.message : String(e))); });
