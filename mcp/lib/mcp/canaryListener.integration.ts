/**
 * lib/mcp/canaryListener.integration.ts — PH-12 12.5b-0 (listener loopback, dovadă I/O hermetică).
 *
 * HERMETIC: doar loopback (127.0.0.1), fără rețea externă / Supabase / Redis / credențiale — deci nu are nevoie de
 * gate opt-in. Rulează cu `npm run test:ph12-canary-listener` (cablat în `test:integration`). Verifică: bind pe port
 * liber + `redirectUri` exact, captura primului callback (parsat), 404 pe altă cale, timeout mărginit → reject.
 */
import { startLoopbackCapture } from "./canaryListener";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

async function main(): Promise<void> {
  console.log("PH-12 12.5b-0 — canaryListener (loopback capture, hermetic)");

  // 1. Captura unui callback de succes.
  {
    const cap = await startLoopbackCapture({ timeoutMs: 5_000 });
    check("1. ⭐ redirectUri = http://127.0.0.1:<port>/callback exact",
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(cap.redirectUri) && cap.redirectUri.endsWith(`:${cap.port}/callback`));

    const res = await fetch(`${cap.redirectUri}?code=THECODE&state=st1&iss=${encodeURIComponent("http://localhost:8080")}`);
    check("2. răspuns 200 la browser (poți închide fereastra)", res.status === 200);
    await res.text();

    const parsed = await cap.waitForCallback();
    check("3. ⭐⭐⭐ callback capturat + parsat: kind code, code+state corecte",
      parsed.kind === "code" && parsed.kind === "code" && parsed.code === "THECODE" && parsed.state === "st1");
    cap.close(); // idempotent (deja închis single-shot)
  }

  // 2. 404 pe altă cale (nu confundă alt request cu callback-ul).
  {
    const cap = await startLoopbackCapture({ timeoutMs: 5_000 });
    const res = await fetch(`http://127.0.0.1:${cap.port}/nope?code=x&state=y`);
    check("4. ⭐ cale greșită → 404 (nu captează)", res.status === 404);
    await res.text();
    // callback-ul de succes tot trebuie să meargă după 404
    const res2 = await fetch(`${cap.redirectUri}?code=c2&state=s2&iss=${encodeURIComponent("http://localhost:8080")}`);
    check("5. după 404, callback-ul real pe /callback → 200", res2.status === 200);
    await res2.text();
    const parsed = await cap.waitForCallback();
    check("6. captură corectă după 404", parsed.kind === "code" && parsed.kind === "code" && parsed.code === "c2");
    cap.close();
  }

  // 3. Timeout mărginit → reject (nu atârnă driver-ul).
  {
    const cap = await startLoopbackCapture({ timeoutMs: 200 });
    let rejected = false;
    try {
      await cap.waitForCallback();
    } catch (e) {
      rejected = e instanceof Error && /timed out/.test(e.message);
    }
    check("7. ⭐⭐ fără callback în timeoutMs → reject (mesaj timeout)", rejected);
    cap.close();
  }

  // 4. Anulare manuală înainte de callback → reject (fix cgpt P1: waitForCallback NU rămâne pending la close()).
  {
    const cap = await startLoopbackCapture({ timeoutMs: 30_000 });
    const p = cap.waitForCallback();
    cap.close();
    let cancelled = false;
    try { await p; } catch (e) { cancelled = e instanceof Error && /cancelled/.test(e.message); }
    check("8. ⭐⭐⭐ close() înainte de callback → waitForCallback REJECT (nu pending la infinit)", cancelled);
  }

  // 5. close() DUPĂ un callback reușit NU răstoarnă rezultatul (idempotent, terminal unic).
  {
    const cap = await startLoopbackCapture({ timeoutMs: 5_000 });
    const res = await fetch(`${cap.redirectUri}?code=cok&state=sok&iss=${encodeURIComponent("http://localhost:8080")}`);
    await res.text();
    const parsed = await cap.waitForCallback();
    cap.close(); // după resolve → no-op (finished deja)
    let stillResolved = false;
    try { const again = await cap.waitForCallback(); stillResolved = again.kind === "code"; } catch { stillResolved = false; }
    check("9. ⭐⭐ close() după callback → rezultatul rămâne (aceeași promisiune rezolvată, nu răsturnată)",
      parsed.kind === "code" && stillResolved);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("integration crashed:", e); process.exit(1); });
