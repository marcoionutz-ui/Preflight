/**
 * scripts/goplusRetry.test.ts — E29 (wiring retry `goPlusFetchWithRetry`).
 *
 * Dovedește COMPORTAMENTUL retry-ului, nu doar predicatul: 429/5xx și network error se reîncearcă O DATĂ; 4xx
 * (≠429) NU; două eșecuri se termină corect (răspuns transient întors / throw propagat). Folosește un `fetchImpl`
 * FAKE injectat (numără apelurile) + `retryBaseMs: 0` (fără așteptare reală). Importă goplus.ts (light: ./types +
 * ./goplusParse, pure) → rulează în tsx.
 */
import { goPlusFetchWithRetry } from "../src/goplus";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

type Step = { status: number } | "throw";

function makeFetch(script: Step[]) {
  let calls = 0;
  const fn = async (_url: unknown, _init: unknown): Promise<Response> => {
    const step = script[Math.min(calls, script.length - 1)];
    calls++;
    if (step === "throw") throw new Error("network down");
    return { ok: step.status >= 200 && step.status < 300, status: step.status } as unknown as Response;
  };
  return { fetchImpl: fn as unknown as typeof fetch, calls: () => calls };
}

const OPTS = (fetchImpl: typeof fetch) => ({ fetchImpl, retryBaseMs: 0 });

async function main(): Promise<void> {
  console.log("E29 wiring — goPlusFetchWithRetry (1 retry pe 429/5xx + network; 4xx imediat)");

  // 429 -> 200: exact 2 fetch-uri, rezultat OK.
  {
    const m = makeFetch([{ status: 429 }, { status: 200 }]);
    const res = await goPlusFetchWithRetry("u", {}, OPTS(m.fetchImpl));
    check("1. * 429->200: exact 2 fetch-uri", m.calls() === 2);
    check("2. * 429->200: rezultat OK (200)", res.ok && res.status === 200);
  }

  // 500 -> 200: retry pe 5xx.
  {
    const m = makeFetch([{ status: 500 }, { status: 200 }]);
    const res = await goPlusFetchWithRetry("u", {}, OPTS(m.fetchImpl));
    check("3. * 500->200: 2 fetch-uri + OK", m.calls() === 2 && res.ok);
  }

  // network throw -> 200: eroarea de rețea se reîncearcă.
  {
    const m = makeFetch(["throw", { status: 200 }]);
    const res = await goPlusFetchWithRetry("u", {}, OPTS(m.fetchImpl));
    check("4. * network throw->200: 2 fetch-uri + OK", m.calls() === 2 && res.ok);
  }

  // 400: permanent -> NUMAI 1 fetch, fără retry.
  {
    const m = makeFetch([{ status: 400 }]);
    const res = await goPlusFetchWithRetry("u", {}, OPTS(m.fetchImpl));
    check("5. * 400: exact 1 fetch (fără retry)", m.calls() === 1);
    check("6. 400: rezultat !ok, status 400", !res.ok && res.status === 400);
  }

  // 429 de două ori: retry o dată, apoi întoarce ultimul răspuns transient (apelantul îl tratează ca HTTP error).
  {
    const m = makeFetch([{ status: 429 }, { status: 429 }]);
    const res = await goPlusFetchWithRetry("u", {}, OPTS(m.fetchImpl));
    check("7. * 429x2: exact 2 fetch-uri (1 retry, apoi stop)", m.calls() === 2);
    check("8. 429x2: întoarce ultimul răspuns (429, !ok)", !res.ok && res.status === 429);
  }

  // network throw de două ori: retry o dată, apoi PROPAGĂ throw-ul (prins de catch-ul din fetchGoPlusRaw).
  {
    const m = makeFetch(["throw", "throw"]);
    let threw = false;
    try { await goPlusFetchWithRetry("u", {}, OPTS(m.fetchImpl)); }
    catch { threw = true; }
    check("9. * network throw x2: 2 fetch-uri", m.calls() === 2);
    check("10. * network throw x2: propagă throw-ul (nu-l înghite)", threw === true);
  }

  // Timeout REAL via AbortController: primul fetch rămâne pending până când `signal` emite abort (după timeoutMs),
  // se respinge cu AbortError → retry → a doua încercare întoarce 200. Dovedește exact 2 fetch-uri + 200.
  {
    let calls = 0;
    const fetchImpl = (async (_url: unknown, init: { signal?: AbortSignal }): Promise<Response> => {
      calls++;
      if (calls === 1) {
        // Rămâne pending până la abort-ul provocat de timeout-ul din goPlusFetchWithRetry.
        return new Promise<Response>((_resolve, reject) => {
          const sig = init.signal;
          const fail = () => { const e = new Error("The operation was aborted"); e.name = "AbortError"; reject(e); };
          if (sig?.aborted) { fail(); return; }
          sig?.addEventListener("abort", fail);
        });
      }
      return { ok: true, status: 200 } as unknown as Response;
    }) as unknown as typeof fetch;

    const res = await goPlusFetchWithRetry("u", {}, { fetchImpl, retryBaseMs: 0, timeoutMs: 5 });
    check("11. * timeout(abort)->200: exact 2 fetch-uri", calls === 2);
    check("12. * timeout(abort)->200: rezultat OK (200)", res.ok && res.status === 200);
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
}

main();
