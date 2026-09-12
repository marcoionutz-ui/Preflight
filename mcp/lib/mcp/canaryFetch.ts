/**
 * lib/mcp/canaryFetch.ts — PH-12 12.5b-4a (adaptoare reale `fetch` pentru transporturile injectate).
 *
 * Produce implementările REALE ale `PostForm` (12.5b-1, /token) și `PostJson` (12.5b-2, /api/mcp) peste `fetch`. Sunt
 * wrappere SUBȚIRI: metoda POST + forward EXACT al headerelor primite (clientul pune Content-Type/Accept/Authorization,
 * adaptorul NU adaugă/suprascrie nimic) + expun `status`/`text()`, iar `PostJson` expune și headerele (pt. content-type,
 * ca parserul JSON/SSE să decidă). `fetch`-ul e injectat → adaptoarele sunt testabile hermetic cu un fake, ÎNAINTE de
 * a lovi serverul local (12.5b-4b).
 *
 * ANTI-LEAK prin DELEGARE (deliberat): adaptorul NU prinde și NU împachetează eroarea de rețea — o lasă să PROPAGE.
 * Clientul injectat (canaryTokenClient/canaryMcpClient) o prinde în `try/catch`-ul lui și întoarce `"transport error"`
 * GENERIC (fără `Error.message`, care ar putea purta URL-ul/corpul). Deci adaptorul nu construiește NICIUN string de
 * eroare (nimic de scurs); singura lui grijă e să NU înghită throw-ul (altfel clientul ar rata detecția de transport).
 *
 * TIMEOUT: fiecare cerere are un `AbortController` cu deadline (implicit 15s). CRITIC: deadline-ul acoperă ȘI citirea
 * BODY-ului, nu doar sosirea headerelor — `res.text()` se face ÎNĂUNTRUL blocului protejat (body memoizat), apoi se
 * întoarce. Altfel un server care trimite headerele și ține body-ul/SSE deschis ar bloca Gate 1 la nesfârșit (la /api/mcp
 * răspunsul e chiar SSE → `text()` așteaptă închiderea stream-ului). La abort, `res.text()` aruncă → clientul clasifică
 * transport. Timerul e curățat în `finally`.
 */

import type { PostForm, HttpResponse }      from "./canaryTokenClient";
import type { PostJson, McpHttpResponse }   from "./canaryMcpClient";

/** Răspunsul minimal pe care-l folosim din `fetch` (compatibil structural cu `Response`). */
export interface FetchResponseLike {
  status: number;
  headers: Headers;
  text(): Promise<string>;
}
/** Init-ul minimal trimis la `fetch` (subset de `RequestInit` → `fetch` global e assignable la `FetchFn`). */
export interface FetchInit {
  method:  "POST";
  headers: Record<string, string>;
  body:    string;
  signal?: AbortSignal;
}
export type FetchFn = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export const DEFAULT_CANARY_TIMEOUT_MS = 15_000;

/** Răspuns brut cu body-ul DEJA citit sub deadline (status + headere + text memoizat). */
interface RawResponse {
  status:   number;
  headers:  Headers;
  bodyText: string;
}

/**
 * POST comun cu timeout via AbortController. Deadline-ul acoperă fetch-ul ȘI citirea body-ului (`res.text()` sub același
 * `signal`). NU prinde throw-ul (îl lasă clientului) — doar curăță timerul în `finally`.
 */
async function post(
  fetchFn:   FetchFn,
  timeoutMs: number,
  url:       string,
  body:      string,
  headers:   Record<string, string>,
): Promise<RawResponse> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res      = await fetchFn(url, { method: "POST", headers, body, signal: ctrl.signal });
    const bodyText = await res.text(); // ÎN interiorul deadline-ului: body/SSE care atârnă → abort → throw
    return { status: res.status, headers: res.headers, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

/** Headers (Fetch) → Record lowercased (Headers normalizează cheile la lowercase). */
export function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => { out[key] = value; });
  return out;
}

/**
 * Adaptor REAL `PostForm` pentru /token: POST application/x-www-form-urlencoded (headerele vin de la client). Întoarce
 * DOAR `status` + `text()` (clientul /token nu are nevoie de headere). `fetch` injectabil pt. teste.
 */
export function makeFetchPostForm(fetchFn: FetchFn = fetch as unknown as FetchFn, timeoutMs = DEFAULT_CANARY_TIMEOUT_MS): PostForm {
  return async (url, body, headers): Promise<HttpResponse> => {
    const res = await post(fetchFn, timeoutMs, url, body, headers);
    return { status: res.status, text: async () => res.bodyText }; // body deja citit sub deadline
  };
}

/**
 * Adaptor REAL `PostJson` pentru /api/mcp: POST application/json (headerele — inclusiv Authorization — vin de la client).
 * Expune `headers` (Record) ca parserul să detecteze JSON vs SSE. `fetch` injectabil pt. teste.
 */
export function makeFetchPostJson(fetchFn: FetchFn = fetch as unknown as FetchFn, timeoutMs = DEFAULT_CANARY_TIMEOUT_MS): PostJson {
  return async (url, body, headers): Promise<McpHttpResponse> => {
    const res = await post(fetchFn, timeoutMs, url, body, headers);
    return { status: res.status, headers: headersToRecord(res.headers), text: async () => res.bodyText }; // body deja citit sub deadline
  };
}
