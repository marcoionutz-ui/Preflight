/**
 * workers/evm/src/lib/shutdown.ts — PH-13 (graceful shutdown al worker-ului EVM).
 *
 * Worker-ul e doar orchestrare (setInterval-uri + WS), FĂRĂ handler de terminare: la un SIGTERM (redeploy Railway,
 * scale-down, restart) procesul murea BRUSC — memoria în curs nu se salva, socket-urile WS rămâneau half-open pe
 * server, iar un scan/loop în zbor era tăiat. Aici cablăm o închidere ordonată, IDEMPOTENTĂ, cu deadline dur.
 *
 * Logică injectată (frunză testabilă): `on`/`exit`/`setTimeout`/`clearTimeout` vin din afară → orchestratorul se
 * testează pe fake-uri, fără process/timere reale. Producția (index.ts) îl cheamă cu `process`.
 */

export interface ShutdownDeps {
  /** Semnalele care declanșează shutdown (default SIGTERM + SIGINT). */
  signals?:      string[];
  /**
   * Ce facem la închidere: save memory + close WS + quit redis. Poate arunca (→ exit 1); timeout-ul acoperă hang-ul.
   * Dacă REZOLVĂ un `number`, acela devine codul de ieșire (ex. `runShutdownSequence` întoarce 1 dacă persistarea a
   * eșuat, ca să NU raportăm succes fals). Dacă rezolvă `void`/`undefined` → exit 0 (compat).
   */
  onShutdown:    () => Promise<number | void> | number | void;
  /** Deadline dur: dacă `onShutdown` nu termină în `timeoutMs`, ieșim forțat (nu blocăm redeploy-ul). Default 10s. */
  timeoutMs?:    number;
  on:            (signal: string, handler: () => void) => void; // process.on
  exit:          (code: number) => void;                        // process.exit
  setTimeout:    (fn: () => void, ms: number) => unknown;
  clearTimeout:  (handle: unknown) => void;
  log?:          (msg: string) => void;
}

/**
 * Instalează handler-e de shutdown pe semnalele date. La PRIMUL semnal: pornește un timeout de siguranță (exit 1
 * dacă `onShutdown` atârnă), rulează `onShutdown`, apoi exit 0 (succes) / exit 1 (eroare), anulând timeout-ul.
 * IDEMPOTENT: un al DOILEA semnal cât timp închidem → exit forțat imediat (1) — nu re-rulează `onShutdown`
 * (double-Ctrl-C / SIGTERM insistent = „ieși acum"). Un `onShutdown` care aruncă NU lasă procesul agățat.
 */
export function installGracefulShutdown(deps: ShutdownDeps): void {
  const signals   = deps.signals ?? ["SIGTERM", "SIGINT"];
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const log       = deps.log ?? (() => {});
  let shuttingDown = false;

  const handle = (signal: string): void => {
    if (shuttingDown) {
      log(`[SHUTDOWN] ${signal} din nou în timpul închiderii — ieșire forțată`);
      deps.exit(1);
      return;
    }
    shuttingDown = true;
    log(`[SHUTDOWN] ${signal} primit — închidere ordonată (deadline ${timeoutMs}ms)`);

    // Deadline dur: dacă onShutdown nu termină la timp, nu blocăm redeploy-ul.
    const timer = deps.setTimeout(() => {
      log(`[SHUTDOWN] deadline depășit (${timeoutMs}ms) — ieșire forțată`);
      deps.exit(1);
    }, timeoutMs);

    Promise.resolve()
      .then(() => deps.onShutdown())
      .then((code) => {
        deps.clearTimeout(timer);
        const exitCode = typeof code === "number" ? code : 0;
        log(`[SHUTDOWN] închidere completă — exit ${exitCode}`);
        deps.exit(exitCode);
      })
      .catch((err: unknown) => {
        deps.clearTimeout(timer);
        log(`[SHUTDOWN] eroare la închidere: ${err instanceof Error ? err.message : String(err)} — exit 1`);
        deps.exit(1);
      });
  };

  for (const s of signals) deps.on(s, () => handle(s));
}
