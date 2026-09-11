/**
 * lib/mcp/canaryListener.ts — PH-12 12.5b-0 (driver Gate 1: listener loopback pentru captura codului).
 *
 * I/O LOCAL (nu extern): un server HTTP efemer pe `127.0.0.1:0` (port liber ales de OS) care prinde redirect-ul de
 * callback OAuth de la browser (pasul 4→5). Ordinea cerută (ajustarea lui Marco): deschide ÎNTÂI listener-ul → citește
 * portul efectiv → construiește `redirectUri` EXACT → fixture-ul înregistrează exact acel URI. `/api/oauth/token`
 * compară `redirect_uri` ca STRING exact (nu relaxarea de port loopback din redirectMatch), deci driver-ul refolosește
 * `handle.redirectUri` identic la /authorize ȘI la token exchange.
 *
 * Single-shot + terminal UNIC (fix cgpt P1): O SINGURĂ funcție `finish` închide socketul ȘI setează promisiunea, pe
 * TOATE căile — callback primit (resolve), timeout (reject), eroare de server DUPĂ listen (reject), anulare manuală
 * `close()` (reject). Astfel `waitForCallback()` NU poate rămâne pending la infinit: orice terminare a serverului îl
 * decide. Doar loopback (bind 127.0.0.1). Fără leak: nu logăm query-ul (poate conține `code`).
 */

import { createServer, type Server } from "http";
import { parseCallbackParams, type ParsedCallback } from "./canaryCallback";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PATH = "/callback";
const DEFAULT_TIMEOUT_MS = 120_000;

export interface LoopbackCapture {
  /** URI EXACT de înregistrat + refolosit cap-coadă (ex. `http://127.0.0.1:53187/callback`). */
  redirectUri: string;
  /** Portul efectiv ales de OS. */
  port: number;
  /** Se rezolvă cu primul callback parsat; reject pe timeout / eroare server / anulare. Idempotent (aceeași promisiune). */
  waitForCallback: () => Promise<ParsedCallback>;
  /** Închide serverul (idempotent). Dacă niciun callback n-a sosit încă, respinge `waitForCallback` (anulare). Apelabil din `finally`. */
  close: () => void;
}

/**
 * Deschide listener-ul loopback și întoarce handle-ul (după ce portul e legat). `path` = calea pe care se așteaptă
 * callback-ul (default `/callback`); `timeoutMs` mărginește așteptarea (default 120s). Cereri pe alte căi → 404.
 */
export function startLoopbackCapture(opts: { path?: string; timeoutMs?: number } = {}): Promise<LoopbackCapture> {
  const path      = opts.path ?? DEFAULT_PATH;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<LoopbackCapture>((resolveHandle, rejectHandle) => {
    let listening = false;               // devine true în callback-ul lui listen()
    let finished  = false;               // terminal UNIC pt. callbackPromise + close server
    let resolveCb!: (p: ParsedCallback) => void;
    let rejectCb!:  (e: Error) => void;
    const callbackPromise = new Promise<ParsedCallback>((res, rej) => { resolveCb = res; rejectCb = rej; });
    // Fără unhandledRejection dacă nimeni nu apelează waitForCallback() înainte de un finish care respinge.
    callbackPromise.catch(() => { /* consumat de waitForCallback la nevoie */ });

    const server: Server = createServer((req, res) => {
      const url = req.url ?? "";
      const qIdx = url.indexOf("?");
      const reqPath = qIdx === -1 ? url : url.slice(0, qIdx);
      if (reqPath !== path) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const query = qIdx === -1 ? "" : url.slice(qIdx + 1);
      const parsed = parseCallbackParams(query);

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        "<!DOCTYPE html><html><head><title>Canary callback</title></head>"
        + "<body style=\"font-family:-apple-system,sans-serif;text-align:center;padding:60px\">"
        + "<p>Authorization received. You can close this window.</p></body></html>",
      );

      finish(() => resolveCb(parsed)); // single-shot: prima cerere validă termină
    });

    const timer = setTimeout(() => {
      finish(() => rejectCb(new Error(`loopback capture timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref(); // nu ține procesul viu doar pentru timer

    /** Terminal UNIC: rulează `action` (resolve/reject) o singură dată, oprește timer-ul și închide serverul pe ORICE cale. */
    function finish(action: () => void): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { action(); } finally { server.close(); }
    }

    server.on("error", (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      if (!listening) {
        // Eroare de bind ÎNAINTE de listen → pornirea a eșuat (handle-ul nu s-a produs încă).
        clearTimeout(timer);
        rejectHandle(e);
        return;
      }
      // Eroare DUPĂ ce ascultam → decide callbackPromise (nu-l lăsa pending). Fix cgpt P1.
      finish(() => rejectCb(e));
    });

    server.listen(0, LOOPBACK_HOST, () => {
      listening = true;
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        finish(() => rejectCb(new Error("failed to resolve loopback listener port")));
        rejectHandle(new Error("failed to resolve loopback listener port"));
        return;
      }
      const port = addr.port;
      resolveHandle({
        redirectUri:     `http://${LOOPBACK_HOST}:${port}${path}`,
        port,
        waitForCallback: () => callbackPromise,
        // Anulare manuală: dacă nu s-a primit încă un callback, respinge (nu lăsa waitForCallback pending). Fix cgpt P1.
        close: () => finish(() => rejectCb(new Error("loopback capture cancelled"))),
      });
    });
  });
}
