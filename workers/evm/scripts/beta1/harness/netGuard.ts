/**
 * scripts/beta1/harness/netGuard.ts — BETA-1, felia 1 (harness): gardul de rețea al probei.
 *
 * REGULĂ: o SINGURĂ destinație permisă — `127.0.0.1` + portul exact al nodului local al probei (fixat o dată prin
 * `allowOnly`). Orice altceva e refuzat ÎNAINTE să plece și e numărat:
 *   - TCP către altă gazdă SAU alt port (inclusiv alt port de pe 127.0.0.1, `localhost`, `::1`);
 *   - socketuri Unix / IPC (conectare cu `path`, fără gazdă);
 *   - TLS integral (`tls.connect`, direct sau prin `https`);
 *   - DNS (`dns.*`, `dns.promises.*`, `Resolver`) — cu o singură excepție fără rețea: `dns.lookup` pe o adresă IP
 *     literală primește răspuns local (Node îl cheamă la `listen`), fără a atinge implementarea originală;
 *   - UDP (`dgram`);
 *   - `fetch` global — înlocuit cu un stub care servește NUMAI fixture din memorie. Implementarea originală NU e
 *     păstrată nicăieri și nu e apelată niciodată.
 *
 * Trebuie instalat ÎNAINTEA primului import din `src/`. NU importă nimic din `src/`.
 *
 * LIMITĂ DECLARATĂ: gard la nivelul API-urilor Node din ACEST proces, nu sandbox al sistemului de operare. Nu acoperă
 * cod nativ, `worker_threads` (global-uri proprii) sau procese copil.
 */

import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

export type RefusalKind = "tcp" | "ipc" | "tls" | "dns" | "udp" | "fetch";

export interface Refusal {
  seq:     number;
  kind:    RefusalKind;
  /** Țintă redusă la gazdă/port/nume de API — fără căi de URL, fără query (pot purta secrete). */
  detail:  string;
  /** Eticheta controlului deliberat în curs, sau `null` = încălcare reală. */
  control: string | null;
}

export interface FetchFixture { status: number; body: string; contentType?: string; }

export interface NetGuard {
  /** Fixează destinația permisă (127.0.0.1:port). O SINGURĂ dată; al doilea apel aruncă. */
  allowOnly(port: number): void;
  allowedPort(): number | null;
  /** Rulează SINCRON `fn` ca un control deliberat: refuzurile înregistrate în timpul lui poartă eticheta. */
  runControl<T>(label: string, fn: () => T): T;
  refusals(): Refusal[];
  /** Refuzuri din afara controalelor deliberate. Orice element = HARNESS_ERROR. */
  violations(): Refusal[];
  permittedConnections(): number;
  /** Fixture pentru stubul `fetch`, pe URL EXACT. */
  setFetchFixture(url: string, fixture: FetchFixture): void;
  fetchCalls(): number;
  fetchServed(): number;
}

export const GUARD_ERROR_CODE = "EBETA1GUARD";
const ALLOWED_HOST = "127.0.0.1";

function guardError(what: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`BETA1_NET_GUARD: ${what} refuzat`);
  e.code = GUARD_ERROR_CODE;
  return e;
}

/** Atribuire pe un obiect de modul/prototip fără a slăbi tipurile la call-site. */
function patch(target: object, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

interface Target { kind: "tcp" | "ipc" | "unknown"; host: string; port: number; }

/** Descifrează argumentele lui `Socket.prototype.connect` în toate formele acceptate de Node. */
function describeTarget(args: unknown[]): Target {
  let a0 = args[0];
  // Forma internă normalizată: `socket.connect([options, cb])` (folosită de `net.connect`).
  if (Array.isArray(a0)) a0 = a0[0];

  if (typeof a0 === "object" && a0 !== null) {
    const o = a0 as { path?: unknown; host?: unknown; port?: unknown };
    if (typeof o.path === "string" && o.path !== "") return { kind: "ipc", host: "", port: NaN };
    if (o.port === undefined || o.port === null) return { kind: "unknown", host: "", port: NaN };
    const host = typeof o.host === "string" && o.host !== "" ? o.host : "localhost";
    return { kind: "tcp", host, port: Number(o.port) };
  }
  if (typeof a0 === "number" || (typeof a0 === "string" && /^[0-9]+$/.test(a0))) {
    const host = typeof args[1] === "string" && args[1] !== "" ? args[1] : "localhost";
    return { kind: "tcp", host, port: Number(a0) };
  }
  if (typeof a0 === "string") return { kind: "ipc", host: "", port: NaN };
  return { kind: "unknown", host: "", port: NaN };
}

/** Doar gazda unui URL (fără cale / query), pentru înregistrare. */
function hostOfUrl(url: string): string {
  try { return new URL(url).host || "(fără gazdă)"; } catch { return "(url invalid)"; }
}

let installed = false;

export function installNetGuard(): NetGuard {
  if (installed) throw new Error("BETA1_NET_GUARD: deja instalat");
  installed = true;

  let allowedPort: number | null = null;
  let currentControl: string | null = null;
  let seq = 0;
  let permitted = 0;
  let fetchCalls = 0;
  let fetchServed = 0;
  const refusals: Refusal[] = [];
  const fixtures = new Map<string, FetchFixture>();

  const record = (kind: RefusalKind, detail: string): void => {
    refusals.push({ seq: ++seq, kind, detail, control: currentControl });
  };

  // ── TCP + IPC: un singur punct de trecere pentru orice socket client (net, http, tls, ws, ioredis…) ──────────
  const origConnect = net.Socket.prototype.connect as (this: net.Socket, ...a: unknown[]) => net.Socket;
  patch(net.Socket.prototype, "connect", function (this: net.Socket, ...args: unknown[]): net.Socket {
    const t = describeTarget(args);
    if (t.kind === "tcp" && t.host === ALLOWED_HOST && allowedPort !== null && t.port === allowedPort) {
      permitted++;
      return origConnect.apply(this, args);
    }
    if (t.kind === "ipc")      record("ipc", "socket Unix/IPC");
    else if (t.kind === "tcp") record("tcp", `${t.host}:${Number.isFinite(t.port) ? t.port : "?"}`);
    else                       record("tcp", "țintă nedescifrată");
    // Refuz FĂRĂ a chema originalul: nimic nu pleacă. Eroarea vine asincron, ca la un eșec real de conectare.
    const err = guardError(t.kind === "ipc" ? "IPC" : "TCP");
    process.nextTick(() => { this.destroy(err); });
    return this;
  });

  // ── TLS: refuzat integral ───────────────────────────────────────────────────────────────────────────────────
  patch(tls, "connect", function (): net.Socket {
    record("tls", "tls.connect");
    const s = new net.Socket();
    const err = guardError("TLS");
    process.nextTick(() => { s.destroy(err); });
    return s;
  });

  // ── DNS: refuzat (destinația permisă e adresă literală) ─────────────────────────────────────────────────────
  const DNS_FNS = [
    "lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname",
    "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse",
  ];
  const dnsCallbackRefuser = (name: string) => function (...args: unknown[]): void {
    // `lookup` pe o adresă IP LITERALĂ nu e rezolvare: Node îl cheamă și la `server.listen({ host: "127.0.0.1" })`.
    // Răspundem LOCAL, fără a delega la original — nimic nu pleacă. Conectarea rămâne supusă gardului TCP.
    if (name === "lookup" && typeof args[0] === "string" && net.isIP(args[0]) !== 0) {
      const address = args[0];
      const family  = net.isIP(address);
      const opts    = typeof args[1] === "object" && args[1] !== null ? args[1] as { all?: boolean } : {};
      const done    = args[args.length - 1];
      if (typeof done === "function") {
        process.nextTick(() => {
          if (opts.all) (done as (e: null, r: unknown) => void)(null, [{ address, family }]);
          else (done as (e: null, a: string, f: number) => void)(null, address, family);
        });
      }
      return;
    }
    record("dns", `dns.${name}`);
    const cb = args[args.length - 1];
    if (typeof cb === "function") process.nextTick(() => { (cb as (e: Error) => void)(guardError("DNS")); });
  };
  const dnsPromiseRefuser = (name: string) => function (): Promise<never> {
    record("dns", `dns.promises.${name}`);
    return Promise.reject(guardError("DNS"));
  };
  for (const name of DNS_FNS) {
    patch(dns, name, dnsCallbackRefuser(name));
    patch(dns.Resolver.prototype, name, dnsCallbackRefuser(name));
    patch(dns.promises, name, dnsPromiseRefuser(name));
    patch(dns.promises.Resolver.prototype, name, dnsPromiseRefuser(name));
  }

  // ── UDP: refuzat ────────────────────────────────────────────────────────────────────────────────────────────
  patch(dgram, "createSocket", function (): never {
    record("udp", "dgram.createSocket");
    throw guardError("UDP");
  });
  for (const name of ["bind", "connect", "send"]) {
    patch(dgram.Socket.prototype, name, function (): never {
      record("udp", `dgram.Socket.${name}`);
      throw guardError("UDP");
    });
  }

  // ── fetch: stub care servește NUMAI fixture. Originalul nu e capturat. ──────────────────────────────────────
  patch(globalThis, "fetch", async function (input: unknown): Promise<Response> {
    fetchCalls++;
    const url =
      typeof input === "string" ? input :
      input instanceof URL      ? input.href :
      typeof (input as { url?: unknown } | null)?.url === "string" ? (input as { url: string }).url : "";
    const fx = fixtures.get(url);
    if (!fx) {
      record("fetch", hostOfUrl(url));
      throw guardError("fetch");
    }
    fetchServed++;
    return new Response(fx.body, {
      status:  fx.status,
      headers: { "content-type": fx.contentType ?? "application/json" },
    });
  });

  // Importurile ESM cu nume (`import { connect } from "node:tls"`) văd și ele înlocuirile.
  syncBuiltinESMExports();

  return {
    allowOnly(port: number): void {
      if (allowedPort !== null) throw new Error("BETA1_NET_GUARD: destinația permisă e deja fixată");
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("BETA1_NET_GUARD: port invalid");
      allowedPort = port;
    },
    allowedPort: () => allowedPort,
    runControl<T>(label: string, fn: () => T): T {
      if (currentControl !== null) throw new Error("BETA1_NET_GUARD: control imbricat");
      currentControl = label;
      try { return fn(); } finally { currentControl = null; }
    },
    refusals:   () => refusals.map(r => ({ ...r })),
    violations: () => refusals.filter(r => r.control === null).map(r => ({ ...r })),
    permittedConnections: () => permitted,
    setFetchFixture(url: string, fixture: FetchFixture): void { fixtures.set(url, { ...fixture }); },
    fetchCalls:  () => fetchCalls,
    fetchServed: () => fetchServed,
  };
}
