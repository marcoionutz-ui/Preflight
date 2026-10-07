/**
 * scripts/beta1/harness/localNode.ts — BETA-1, felia 1 (harness): nod JSON-RPC local pe 127.0.0.1.
 *
 * Face trei lucruri și atât:
 *   1. CAPTUREAZĂ fiecare `eth_subscribe` / `eth_unsubscribe`, exact cum a sosit;
 *   2. CONFIRMĂ cu un id de subscripție propriu, ținut minte per cerere;
 *   3. TRIMITE loguri oferite de caz, dar NUMAI pe cele care se potrivesc cu un filtru activ, etichetate cu id-ul
 *      acelei subscripții.
 *
 * `forceSend` ocolește filtrul și e marcat distinct în evidență: arată doar ce face clientul cu un log care ar sosi
 * totuși; NU dovedește nimic despre filtru sau despre un nod real.
 *
 * `sent()` dovedește TRIMITEREA de către nod, nu primirea sau procesarea la client — bariera de procesare se ia de
 * la destinație (observers.ts), nu de aici.
 *
 * Potrivirea filtrului e cod de harness (nu Alchemy): are controale proprii în selfTest. NU importă nimic din `src/`.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { HarnessError, realTimers } from "./observers";

export interface RpcLog {
  address:         string;
  topics:          string[];
  data:            string;
  /** Unic per log de fixture — marcajul după care clientul îl recunoaște la barieră. */
  transactionHash: string;
  blockNumber?:    string;
  logIndex?:       string;
}

export interface LogFilter {
  address?: string | string[];
  topics?:  Array<string | string[] | null>;
}

export interface CapturedRequest {
  seq:    number;
  /** `id`-ul JSON-RPC trimis de client. */
  id:     unknown;
  method: "eth_subscribe" | "eth_unsubscribe";
  /** `params` exact cum au sosit (copie JSON). */
  params: unknown;
  /** Pentru `eth_subscribe` acceptat: id-ul de subscripție emis. Altfel `null`. */
  subId:  string | null;
}

export interface NodeSubscription { subId: string; filter: LogFilter; active: boolean; requestSeq: number; }

export interface SentFrame {
  seq:    number;
  kind:   "ack" | "log" | "forced-log" | "sentinel" | "error";
  subId:  string | null;
  /** `transactionHash` pentru loguri; eticheta pentru santinelă. */
  marker: string | null;
}

export interface LocalNode {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly url:  string;
  requests(): CapturedRequest[];
  subscriptions(): NodeSubscription[];
  sent(): SentFrame[];
  /** Încărcăturile `ping` primite de la client (utf8). */
  pings(): string[];
  /** Orice lucru neașteptat: a doua conexiune, cadru ne-JSON, metodă necunoscută, eroare la trimitere. */
  anomalies(): string[];
  clientCount(): number;
  /** Oferă loguri: trimite fiecare log o dată per subscripție activă al cărei filtru îl acceptă. Întoarce numărul trimis. */
  offerLogs(logs: RpcLog[]): number;
  /** Trimite un log OCOLIND filtrul, pe subscripția dată. Marcat `forced-log`. */
  forceSend(log: RpcLog, subId: string): void;
  /** Cadru JSON-RPC fără `params.result` — bariera de ordine. */
  sendSentinel(tag: string): void;
  /** Închide clienții și serverul. Mărginit: expirarea aruncă `HarnessError`. */
  close(deadlineMs?: number): Promise<void>;
}

const eqHex = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Semantica filtrului `logs` din JSON-RPC:
 *   - `address` absent → orice adresă; string → egalitate; listă → SAU (listă goală → orice, ca la geth);
 *   - `topics[i]`: `null` → orice; string → egalitate pe poziția i; listă → SAU (listă goală → orice);
 *   - un log cu mai puține topicuri decât pozițiile filtrului NU se potrivește — nici când poziția lipsă e wildcard.
 * Comparațiile hex ignoră majusculele.
 */
export function matchesFilter(filter: LogFilter, log: RpcLog): boolean {
  const { address, topics } = filter;
  if (typeof address === "string") {
    if (!eqHex(address, log.address)) return false;
  } else if (Array.isArray(address) && address.length > 0) {
    if (!address.some(a => eqHex(a, log.address))) return false;
  }
  if (Array.isArray(topics)) {
    // Ca la geth: un filtru cu MAI MULTE poziții decât are logul nu se potrivește, chiar dacă pozițiile în plus
    // sunt wildcard (`null` / listă goală).
    if (topics.length > log.topics.length) return false;
    for (let i = 0; i < topics.length; i++) {
      const want = topics[i];
      if (want === null || want === undefined) continue;
      if (Array.isArray(want) && want.length === 0) continue;
      const have = log.topics[i];
      if (typeof have !== "string") return false;
      if (typeof want === "string") { if (!eqHex(want, have)) return false; }
      else if (!want.some(w => eqHex(w, have))) return false;
    }
  }
  return true;
}

/** Validează forma minimă a unui filtru; întoarce filtrul (copie) sau `null`. */
function parseFilter(raw: unknown): LogFilter | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as { address?: unknown; topics?: unknown };
  const out: LogFilter = {};
  if (o.address !== undefined) {
    if (typeof o.address === "string") out.address = o.address;
    else if (Array.isArray(o.address) && o.address.every(a => typeof a === "string")) out.address = [...o.address] as string[];
    else return null;
  }
  if (o.topics !== undefined) {
    if (!Array.isArray(o.topics)) return null;
    const ts: Array<string | string[] | null> = [];
    for (const t of o.topics) {
      if (t === null) ts.push(null);
      else if (typeof t === "string") ts.push(t);
      else if (Array.isArray(t) && t.every(x => typeof x === "string")) ts.push([...t] as string[]);
      else return null;
    }
    out.topics = ts;
  }
  return out;
}

export function startLocalNode(): Promise<LocalNode> {
  return new Promise<LocalNode>((resolve, reject) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const requests: CapturedRequest[] = [];
    const subs: NodeSubscription[] = [];
    const sent: SentFrame[] = [];
    const pings: string[] = [];
    const anomalies: string[] = [];
    let client: WebSocket | null = null;
    let reqSeq = 0, sentSeq = 0, subN = 0, connections = 0;

    const send = (kind: SentFrame["kind"], payload: unknown, subId: string | null, marker: string | null): void => {
      if (!client) { anomalies.push(`trimitere ${kind} fără client conectat`); return; }
      sent.push({ seq: ++sentSeq, kind, subId, marker });
      client.send(JSON.stringify(payload), (err?: Error) => {
        if (err) anomalies.push(`eroare la trimitere ${kind}: ${err.message}`);
      });
    };

    const notification = (subId: string, log: RpcLog): unknown => ({
      jsonrpc: "2.0", method: "eth_subscription", params: { subscription: subId, result: log },
    });

    wss.on("error", (e: Error) => { anomalies.push(`eroare server: ${e.message}`); reject(e); });

    wss.on("connection", (ws: WebSocket) => {
      connections++;
      if (connections > 1) anomalies.push(`conexiune #${connections} (se aștepta una singură)`);
      client = ws;
      ws.on("ping",  (data: Buffer) => { pings.push(data.toString("utf8")); });
      ws.on("error", (e: Error) => { anomalies.push(`eroare socket server: ${e.message}`); });
      ws.on("close", () => { if (client === ws) client = null; });

      ws.on("message", (data: Buffer) => {
        let msg: { id?: unknown; method?: unknown; params?: unknown };
        try { msg = JSON.parse(data.toString("utf8")); }
        catch { anomalies.push("cadru ne-JSON de la client"); return; }
        if (typeof msg !== "object" || msg === null) { anomalies.push("cadru JSON care nu e obiect"); return; }

        const paramsCopy: unknown = msg.params === undefined ? undefined : JSON.parse(JSON.stringify(msg.params));

        if (msg.method === "eth_subscribe") {
          const p = Array.isArray(msg.params) ? msg.params : [];
          const filter = p[0] === "logs" ? parseFilter(p[1]) : null;
          if (!filter) {
            requests.push({ seq: ++reqSeq, id: msg.id, method: "eth_subscribe", params: paramsCopy, subId: null });
            anomalies.push("eth_subscribe cu parametri neacceptați");
            send("error", { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "invalid params" } }, null, null);
            return;
          }
          const subId = "0xb1" + (++subN).toString(16).padStart(30, "0");
          const seq = ++reqSeq;
          requests.push({ seq, id: msg.id, method: "eth_subscribe", params: paramsCopy, subId });
          subs.push({ subId, filter, active: true, requestSeq: seq });
          send("ack", { jsonrpc: "2.0", id: msg.id, result: subId }, subId, null);
          return;
        }

        if (msg.method === "eth_unsubscribe") {
          const target = Array.isArray(msg.params) ? msg.params[0] : undefined;
          requests.push({ seq: ++reqSeq, id: msg.id, method: "eth_unsubscribe", params: paramsCopy, subId: null });
          const s = subs.find(x => x.subId === target && x.active);
          if (s) s.active = false;
          send("ack", { jsonrpc: "2.0", id: msg.id, result: s !== undefined }, typeof target === "string" ? target : null, null);
          return;
        }

        anomalies.push(`metodă necunoscută: ${typeof msg.method === "string" ? msg.method.slice(0, 40) : "(fără metodă)"}`);
        send("error", { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }, null, null);
      });
    });

    wss.on("listening", () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({
        host: "127.0.0.1",
        port,
        url:  `ws://127.0.0.1:${port}`,
        requests:      () => requests.map(r => ({ ...r })),
        subscriptions: () => subs.map(s => ({ ...s })),
        sent:          () => sent.map(s => ({ ...s })),
        pings:         () => [...pings],
        anomalies:     () => [...anomalies],
        clientCount:   () => wss.clients.size,

        offerLogs(logs: RpcLog[]): number {
          let n = 0;
          for (const log of logs) {
            for (const s of subs) {
              if (!s.active || !matchesFilter(s.filter, log)) continue;
              send("log", notification(s.subId, log), s.subId, log.transactionHash);
              n++;
            }
          }
          return n;
        },

        forceSend(log: RpcLog, subId: string): void {
          send("forced-log", notification(subId, log), subId, log.transactionHash);
        },

        sendSentinel(tag: string): void {
          send("sentinel", { jsonrpc: "2.0", method: "beta1_harness_sentinel", params: { tag } }, null, tag);
        },

        close(deadlineMs = 2_000): Promise<void> {
          return new Promise<void>((res, rej) => {
            const timer = realTimers.setTimeout(() => {
              for (const c of wss.clients) c.terminate();
              rej(new HarnessError(`nodul local nu s-a închis în ${deadlineMs}ms`));
            }, deadlineMs);
            for (const c of wss.clients) c.close();
            wss.close((err?: Error) => {
              realTimers.clearTimeout(timer);
              if (err) rej(new HarnessError(`eroare la închiderea nodului: ${err.message}`)); else res();
            });
          });
        },
      });
    });
  });
}
