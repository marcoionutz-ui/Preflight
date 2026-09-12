/**
 * lib/mcp/canaryFetch.test.ts — PH-12 12.5b-4a (adaptoare reale fetch, cu fetch FAKE, pur/hermetic).
 */
import {
  makeFetchPostForm, makeFetchPostJson, headersToRecord,
  DEFAULT_CANARY_TIMEOUT_MS, type FetchFn, type FetchInit,
} from "./canaryFetch";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

console.log("PH-12 12.5b-4a — canaryFetch (adaptoare reale peste fetch, fetch injectat)");

interface Cap { url: string; init: FetchInit; }
function okFetch(status: number, bodyText: string, headersObj: Record<string, string>, sink?: { last?: Cap }): FetchFn {
  return async (url, init) => {
    if (sink) sink.last = { url, init };
    return { status, headers: new Headers(headersObj), text: async () => bodyText };
  };
}

async function main(): Promise<void> {
  // ── PostForm: forward exact + shape ──
  {
    const sink: { last?: Cap } = {};
    const post = makeFetchPostForm(okFetch(200, "TOKENBODY", { "content-type": "application/json" }, sink));
    const res = await post("http://127.0.0.1:8080/api/oauth/token", "grant_type=authorization_code&code=C", { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" });
    check("1. ⭐⭐⭐ PostForm → status + text() din fetch", res.status === 200 && (await res.text()) === "TOKENBODY");
    check("2. ⭐⭐⭐ method POST", sink.last!.init.method === "POST");
    check("3. ⭐⭐ URL + body forward EXACT", sink.last!.url === "http://127.0.0.1:8080/api/oauth/token" && sink.last!.init.body === "grant_type=authorization_code&code=C");
    check("4. ⭐⭐⭐ headerele clientului forward EXACT (adaptorul NU adaugă/suprascrie)", JSON.stringify(sink.last!.init.headers) === JSON.stringify({ "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" }));
    check("5. ⭐⭐ AbortSignal atașat (timeout activ)", sink.last!.init.signal instanceof AbortSignal);
  }

  // ── PostJson: forward exact + headers→Record ──
  {
    const sink: { last?: Cap } = {};
    const post = makeFetchPostJson(okFetch(200, "{\"jsonrpc\":\"2.0\"}", { "Content-Type": "text/event-stream; charset=utf-8", "X-Trace": "abc" }, sink));
    const res = await post("http://127.0.0.1:8080/api/mcp", "{\"id\":1}", { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": "Bearer AT" });
    check("6. ⭐⭐⭐ PostJson → status + text()", res.status === 200 && (await res.text()) === "{\"jsonrpc\":\"2.0\"}");
    check("7. ⭐⭐⭐ headers = Record lowercased (content-type detectabil de parser)", res.headers["content-type"] === "text/event-stream; charset=utf-8" && res.headers["x-trace"] === "abc");
    check("8. ⭐⭐ method POST + body forward", sink.last!.init.method === "POST" && sink.last!.init.body === "{\"id\":1}");
    check("9. ⭐⭐⭐ Authorization forward EXACT (secretul e doar în header, adaptorul îl pasează neatins)", sink.last!.init.headers["Authorization"] === "Bearer AT");
    check("10. ⭐⭐ AbortSignal atașat", sink.last!.init.signal instanceof AbortSignal);
  }

  // ── headersToRecord direct ──
  {
    const rec = headersToRecord(new Headers({ "Content-Type": "application/json", "Retry-After": "2" }));
    check("11. ⭐⭐ headersToRecord: chei lowercased + valori", rec["content-type"] === "application/json" && rec["retry-after"] === "2");
  }

  // ── ANTI-LEAK prin DELEGARE: throw-ul de rețea PROPAGĂ (nu e înghițit) ──
  {
    const boom: FetchFn = async () => { throw new Error("ECONNREFUSED http://127.0.0.1:8080 SECRETLEAK"); };
    let threw = false, msg = "";
    try { await makeFetchPostForm(boom)("u", "b", {}); } catch (e) { threw = true; msg = (e as Error).message; }
    check("12. ⭐⭐⭐ PostForm: fetch throw → adaptorul PROPAGĂ (NU-l înghite; clientul îl va face 'transport error')", threw === true);
    check("13. ⭐⭐ throw-ul e cel ORIGINAL (adaptorul nu construiește string nou) — scrubbing-ul e treaba clientului", /SECRETLEAK/.test(msg));
  }
  {
    const boom: FetchFn = async () => { throw new Error("network down"); };
    let threw = false;
    try { await makeFetchPostJson(boom)("u", "b", {}); } catch { threw = true; }
    check("14. ⭐⭐⭐ PostJson: fetch throw → PROPAGĂ", threw === true);
  }

  // ── TIMEOUT: server care atârnă → AbortController abortează → throw ──
  {
    const hang: FetchFn = (_url, init) => new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
    });
    let threw = false;
    const t0 = Date.now();
    try { await makeFetchPostForm(hang, 30)("u", "b", {}); } catch { threw = true; }
    check("15. ⭐⭐⭐ timeout: fetch care atârnă → abort → throw (nu blochează gate-ul)", threw === true && Date.now() - t0 < 5000);
  }
  {
    // P1 cgpt: headerele sosesc IMEDIAT, dar body-ul/SSE atârnă → deadline-ul trebuie să acopere ȘI text().
    const headOkBodyHang: FetchFn = async (_url, init) => ({
      status:  200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      text:    () => new Promise<string>((_, reject) => { init.signal?.addEventListener("abort", () => reject(new Error("aborted"))); }),
    });
    let threw = false;
    const t0 = Date.now();
    try { await makeFetchPostJson(headOkBodyHang, 30)("u", "b", {}); } catch { threw = true; }
    check("15b. ⭐⭐⭐ headere OK dar text() atârnă (SSE deschis) → abort → throw (deadline acoperă body-ul, nu doar headerele)", threw === true && Date.now() - t0 < 5000);
  }

  // ── clearTimeout: pe SUCCES, timerul e curățat (abort NU se declanșează după) ──
  {
    let captured: AbortSignal | undefined;
    const fast: FetchFn = async (_url, init) => { captured = init.signal; return { status: 200, headers: new Headers(), text: async () => "ok" }; };
    await makeFetchPostJson(fast, 30)("u", "b", {});
    check("16. ⭐⭐ succes → semnal NEabortat imediat", captured!.aborted === false);
    await new Promise((r) => setTimeout(r, 60)); // depășește timeoutMs=30
    check("17. ⭐⭐⭐ după > timeoutMs de la succes → semnalul TOT NEabortat (clearTimeout a rulat, fără abort orfan)", captured!.aborted === false);
  }

  // ── default timeout ──
  check("18. ⭐ DEFAULT_CANARY_TIMEOUT_MS rezonabil (5s..60s)", DEFAULT_CANARY_TIMEOUT_MS >= 5000 && DEFAULT_CANARY_TIMEOUT_MS <= 60000);

  // ── non-200 nu e o eroare de adaptor (îl pasează clientului) ──
  {
    const post = makeFetchPostForm(okFetch(400, "{\"error\":\"invalid_grant\"}", { "content-type": "application/json" }));
    const res = await post("u", "b", {});
    check("19. ⭐⭐ non-200 → status pasat (adaptorul NU aruncă pe 4xx/5xx; clientul decide)", res.status === 400 && (await res.text()) === "{\"error\":\"invalid_grant\"}");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("test crashed:", e); process.exit(1); });
