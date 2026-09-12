/**
 * lib/mcp/canaryCallback.ts — PH-12 12.5b-0 (driver Gate 1: parse + verify callback OAuth, PUR).
 *
 * La pasul 4 al fluxului (consent Approve), serverul face 302 la `redirect_uri?code=…&state=…&iss=…` (succes) SAU
 * `redirect_uri?error=…&error_description=…&state=…&iss=…` (deny/eșec). Driver-ul captează query-ul (via listener-ul
 * loopback) și îl trece prin AICI. Fail-closed COMPLET (fix cgpt P2):
 *   - parametru OAuth DUPLICAT (RFC 6749: cel mult o dată) → malformed (nu ghicim care valoare);
 *   - valorile sunt TRIM-uite; whitespace-only == absent (nu trec ca „prezente");
 *   - `verifyCallback` aplică gărzile `state`/`iss` ȘI pe callback-urile de EROARE (nu le sare) — un `error` cu state
 *     greșit/absent sau iss străin e semnalat ca mismatch (posibil injectat), nu surfăsat orbește.
 * Gărzile: `state` = EXACT cel trimis (anti-CSRF/mixup, RFC 6749 §10.12); `iss` = issuer canonic (RFC 9207).
 *
 * PUR: zero I/O; acceptă un query string sau un URL absolut. Nu logăm `code` (secret one-time).
 */

/** Rezultatul parsării query-ului de callback (discriminat, fail-closed). */
export type ParsedCallback =
  | { kind: "code";       code: string; state: string; iss: string | null }
  | { kind: "error";      error: string; error_description: string | null; state: string | null; iss: string | null }
  | { kind: "malformed";  reason: string };

const CALLBACK_PARAMS = ["code", "state", "iss", "error", "error_description"] as const;
// Parametri OPAC-i (comparați EXACT downstream): nu-i normalizăm NICIODATĂ. `error_description` NU e aici — e text
// de afișare, nu-l comparăm, deci whitespace exterior pe el e tolerat (dar whitespace-only → absent).
const OPAQUE_PARAMS = ["code", "state", "iss", "error"] as const;

/**
 * Citire STRICTĂ a unei valori opace, fără normalizare (fix cgpt P2): păstrează valoarea BRUTĂ; `trim()` e folosit DOAR
 * ca detector. Rezultat discriminat: `absent` (lipsă sau whitespace-only), `tainted` (valoare cu whitespace EXTERIOR —
 * respinsă explicit, nu curățată, fiindcă un `state`/`code`/`iss` opac nu are voie normalizat), `value` (valoarea brută).
 */
function rawOpaque(params: URLSearchParams, name: string): { kind: "absent" } | { kind: "tainted" } | { kind: "value"; value: string } {
  const all = params.getAll(name);
  if (all.length === 0) return { kind: "absent" };
  const raw = all[0];
  if (raw.trim() === "") return { kind: "absent" };     // gol sau whitespace-only
  if (raw !== raw.trim()) return { kind: "tainted" };    // whitespace exterior pe o valoare opacă → respins (nu normalizat)
  return { kind: "value", value: raw };
}

/** Text lejer (error_description): valoarea brută dacă are conținut, altfel null pe whitespace-only. NU e opac. */
function looseText(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name);
  if (all.length === 0) return null;
  return all[0].trim() === "" ? null : all[0];
}

/**
 * Parsează query-ul de callback dintr-un URL absolut SAU dintr-un query string (cu sau fără `?`). Fail-closed:
 *   - parametru OAuth DUPLICAT (RFC 6749) → malformed;
 *   - valoare opacă cu whitespace exterior → malformed (nu normalizăm);
 *   - `code` ȘI `error` prezente simultan → malformed (răspuns OAuth contradictoriu, nu-l interpretăm);
 *   - `error` singur → kind error; `code` singur cere ȘI `state` → kind code; altfel malformed.
 */
export function parseCallbackParams(input: string): ParsedCallback {
  if (typeof input !== "string" || input.trim() === "") {
    return { kind: "malformed", reason: "empty callback input" };
  }

  let params: URLSearchParams;
  try {
    if (input.includes("://")) {
      params = new URL(input).searchParams;
    } else {
      params = new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
    }
  } catch {
    return { kind: "malformed", reason: "unparseable callback query" };
  }

  // RFC 6749: fiecare parametru cel mult o dată. Duplicat → ambiguu → fail-closed.
  for (const name of CALLBACK_PARAMS) {
    if (params.getAll(name).length > 1) {
      return { kind: "malformed", reason: `duplicate parameter: ${name}` };
    }
  }
  // Valori opace cu whitespace exterior → respinse explicit (nu normalizate — contract de comparație exactă).
  for (const name of OPAQUE_PARAMS) {
    if (rawOpaque(params, name).kind === "tainted") {
      return { kind: "malformed", reason: `parameter has surrounding whitespace: ${name}` };
    }
  }

  const iss   = rawOpaque(params, "iss");
  const state = rawOpaque(params, "state");
  const error = rawOpaque(params, "error");
  const code  = rawOpaque(params, "code");

  const issVal   = iss.kind === "value" ? iss.value : null;
  const stateVal = state.kind === "value" ? state.value : null;

  // Răspuns OAuth CONTRADICTORIU (code ȘI error) → malformed (nu-l interpretăm ca error).
  if (error.kind === "value" && code.kind === "value") {
    return { kind: "malformed", reason: "both code and error present (contradictory OAuth response)" };
  }

  // Callback de EROARE (deny/eșec).
  if (error.kind === "value") {
    return {
      kind:              "error",
      error:             error.value,
      error_description: looseText(params, "error_description"),
      state:             stateVal,
      iss:               issVal,
    };
  }

  if (code.kind !== "value") {
    return { kind: "malformed", reason: "no code and no error in callback" };
  }
  if (stateVal === null) {
    // state e obligatoriu în cererile driver-ului → un răspuns fără el (sau whitespace-only) e necredibil.
    return { kind: "malformed", reason: "code present but state missing" };
  }

  return { kind: "code", code: code.value, state: stateVal, iss: issVal };
}

/** Rezultatul verificării unui callback parsat, față de așteptările cererii (state + issuer). */
export type CallbackVerdict =
  | { ok: true;  code: string }
  | { ok: false; reason: string };

/**
 * Verifică un callback parsat față de cererea driver-ului. Ordine fail-closed: (1) malformed → fail; (2) gărzile
 * `state` + `iss` se aplică pe AMBELE kind-uri (code ȘI error) — un `error` cu state/iss greșit e mismatch, nu surfăsat
 * orbește; (3) doar după ce state/iss trec, un kind `error` raportează eroarea de autorizare, iar `code` întoarce codul.
 * `requireIss` (default true) refuză un callback fără `iss` (serverul îl setează mereu, RFC 9207).
 */
export function verifyCallback(
  parsed:  ParsedCallback,
  opts:    { expectedState: string; issuer: string; requireIss?: boolean },
): CallbackVerdict {
  const requireIss = opts.requireIss !== false;

  if (parsed.kind === "malformed") {
    return { ok: false, reason: `malformed callback: ${parsed.reason}` };
  }
  if (typeof opts.expectedState !== "string" || opts.expectedState === "") {
    return { ok: false, reason: "expectedState is required for callback verification" };
  }

  // Gărzile state + iss se aplică ȘI pe error (fix cgpt P2): un error injectat cu state/iss greșit → mismatch.
  if (parsed.state !== opts.expectedState) {
    return { ok: false, reason: "state mismatch (possible CSRF / crossed request)" };
  }
  if (parsed.iss === null) {
    if (requireIss) return { ok: false, reason: "missing iss on callback (RFC 9207)" };
  } else if (parsed.iss !== opts.issuer) {
    return { ok: false, reason: "iss mismatch (authorization server mix-up)" };
  }

  if (parsed.kind === "error") {
    // Anti-leak (fix cgpt 4b, P2): reason COMPLET STATIC. ATÂT `error_description` (text liber) CÂT ȘI `error` sunt
    // controlate de cine fabrică redirect-ul (`?error=SECRETCODE`) — un caller care loghează reason-ul le-ar scurge.
    // Codul + descrierea rămân pe structura parsată (`parseCallbackParams`) pentru inspecție programatică; NU în motiv.
    return { ok: false, reason: "authorization error returned by the authorization server" };
  }

  return { ok: true, code: parsed.code };
}
