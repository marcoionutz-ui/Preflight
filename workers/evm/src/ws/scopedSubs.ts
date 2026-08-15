/**
 * ws/scopedSubs.ts — D3: state-machine PUR pentru subscripțiile scoped (V2/V3/V4) pe WS.
 *
 * BUG-ul reparat (D3): vechea logică seta „snapshot-ul" (lista de pool-uri cerute) OPTIMIST, ÎNAINTE
 * de a primi confirmarea serverului, și dădea `eth_unsubscribe` la subscripția veche ÎNAINTE de a ști
 * dacă noua reușește. Consecințe:
 *   1. dacă `eth_subscribe` eșua (`msg.error`), snapshot-ul optimist rămânea setat → următorul scan
 *      făcea short-circuit („snapshot neschimbat, nu retrimit") → subscripția nu se mai încerca
 *      NICIODATĂ → flow ZERO pe pool-urile alea.
 *   2. subscripția veche era deja anulată → nici măcar flow-ul vechi nu mai venea (dublă pierdere).
 *
 * Modelul corect (state machine cu confirmare explicită):
 *   - `active`   = snapshot-ul pe care serverul l-a CONFIRMAT (sursa de adevăr; doar asta „există").
 *   - `pending`  = ce am CERUT, dar încă nu-i confirmat (nu pretindem că există).
 *   - failed replacement → subscripția veche (`active`) rămâne intactă; retry la scanul următor.
 *   - stale response → un răspuns pentru o cerere care nu mai e cea mai recentă NU poate reactiva un
 *     snapshot depășit; subId-ul orfan primit se anulează imediat.
 *
 * Modulul e PUR (fără WebSocket, fără I/O, fără Date/random): funcțiile primesc un `ScopedSubStore`
 * injectat, îl mută determinist și întorc EFECTELE (ce reqId de trimis / ce subId-uri de anulat).
 * Wiring-ul (subscriptions.ts / manager.ts) traduce efectele în `ws.send(...)`. Testabil izolat (D3.*).
 */

export type ScopedSubKind = "v2" | "v3" | "v4";

/** Subscripție CONFIRMATĂ de server: id-ul real + snapshot-ul (lista de pool-uri) pe care-l acoperă. */
export interface ConfirmedSub {
  subId:    string;
  snapshot: string;
}

/**
 * Cerere în zbor: cheia (chain:kind) + snapshot-ul cerut + momentul trimiterii. subId-ul vechi se
 * citește LIVE la confirmare. `sentAt` există ca să detectăm o cerere care nu primește NICIODATĂ
 * răspuns (server tăcut, dar socketul viu pe restul mesajelor) — altfel `noop-in-flight` ar bloca
 * retry-ul pe veci (aceeași familie cu bug-ul optimist).
 */
export interface PendingSub {
  key:      string;
  snapshot: string;
  sentAt:   number;
}

/**
 * Cât timp tratăm o cerere ne-confirmată drept „încă în zbor". După asta, un nou scan retrimite (reqId
 * nou), dar cererea expirată RĂMÂNE în `pending` — dacă serverul răspunde totuși, o recunoaștem drept
 * `stale-success` și-i anulăm subId-ul orfan (dacă am șterge-o, orfanul ar rămâne viu pe server → dubluri).
 */
export const SCOPED_SUB_ACK_TIMEOUT_MS = 15_000;

/**
 * Hard-timeout: dacă o cerere stă ne-confirmată mai mult de atât, socketul e considerat „mut" (Alchemy
 * primește alte mesaje dar nu mai confirmă subscribe-uri) → resetăm WS. Soft-timeout-ul de mai sus doar
 * retrimite (cererea expirată rămâne în `pending` pt. cleanup orfan), deci pe un server permanent-mut
 * `pending` ar crește nemărginit (o intrare per soft-timeout × V2/V3/V4 × chain). Reconnect-ul golește
 * tot state-ul scoped (`clearScopedSubsForChain` din handler-ul `close`) → `pending` rămâne mărginit.
 * `>= HARD` cu retry la 15s ⇒ maxim ~4 intrări/cheie înainte de reset.
 */
export const SCOPED_SUB_HARD_TIMEOUT_MS = 60_000;

export interface ScopedSubStore {
  /** key (chain:kind) → subscripția confirmată activă. Absent = nicio subscripție activă. */
  active:    Map<string, ConfirmedSub>;
  /** reqId → cererea în zbor. Poate ține MAI MULTE cereri simultane pe aceeași cheie. */
  pending:   Map<number, PendingSub>;
  /** key → reqId-ul celei mai RECENTE cereri trimise pentru cheia asta (staleness detection). */
  latestReq: Map<string, number>;
}

export function createScopedSubStore(): ScopedSubStore {
  return { active: new Map(), pending: new Map(), latestReq: new Map() };
}

/** Cheia de stare per (chain, kind). ex. „base:v3". */
export function scopedSubKey(chainId: string, kind: ScopedSubKind): string {
  return chainId + ":" + kind;
}

export type SubscribeOutcome =
  | "sent"              // cerere nouă înregistrată → trimite eth_subscribe cu reqId
  | "noop-active"       // deja confirmat exact pe snapshot-ul dorit, nimic în zbor → nu trimite
  | "noop-in-flight";   // exact snapshot-ul dorit e deja cerut (cea mai recentă cerere) → nu trimite

export interface SubscribePlan {
  /** reqId de trimis, sau null dacă nu trimitem nimic. */
  reqId:   number | null;
  outcome: SubscribeOutcome;
}

/**
 * Decide dacă trimitem un `eth_subscribe` nou pentru `desired` (snapshot-ul dorit, ex. adrese join(",")).
 * MUTĂ store-ul: pe `sent`, înregistrează pending-ul cu `newReqId` (+ `sentAt: now`) și îl marchează drept
 * cel mai recent. NU atinge `active` și NU anulează subscripția veche — aia se întâmplă DOAR la confirmare.
 *
 * `now` (injectat — reducer PUR) e folosit ca să nu tratăm o cerere expirată (fără ACK în
 * `SCOPED_SUB_ACK_TIMEOUT_MS`) drept „încă în zbor" → altfel un server tăcut ar îngheța retry-ul.
 * `desired` trebuie să fie ne-gol; pentru „nimic de urmărit" folosește `planScopedUnsubscribe`.
 */
export function planScopedSubscribe(
  store: ScopedSubStore,
  key: string,
  desired: string,
  newReqId: number,
  now: number,
): SubscribePlan {
  const latestReqId   = store.latestReq.get(key);
  const latestPending = latestReqId != null ? store.pending.get(latestReqId) : undefined;
  const active        = store.active.get(key);

  // exact ce am cerut deja ȘI cererea e încă PROASPĂTĂ (a primit ACK în timp util) → nu re-trimite.
  // Dacă a expirat (server tăcut), cădem prin → retrimitem (cererea veche rămâne în `pending`).
  if (latestPending && latestPending.snapshot === desired && now - latestPending.sentAt < SCOPED_SUB_ACK_TIMEOUT_MS) {
    return { reqId: null, outcome: "noop-in-flight" };
  }
  // deja confirmat activ EXACT pe snapshot-ul dorit ȘI nimic mai nou în zbor → nu trimite
  if (active && active.snapshot === desired && !latestPending) {
    return { reqId: null, outcome: "noop-active" };
  }

  // altfel: înregistrează cererea nouă, lasă `active` neatins (nu pretindem încă că există)
  store.pending.set(newReqId, { key, snapshot: desired, sentAt: now });
  store.latestReq.set(key, newReqId);
  return { reqId: newReqId, outcome: "sent" };
}

/**
 * `ws.send` a EȘUAT (a aruncat sinchron sau callback-ul a raportat eroare) → transportul NU a acceptat
 * mesajul, deci serverul nu va crea nicio subscripție → NU există orfan de anulat. Ștergem cererea din
 * `pending` (spre deosebire de expirare, unde o păstrăm) și, DACĂ era cea mai recentă, curățăm `latestReq`
 * ca scanul următor să retrimită. Dacă cererea nu mai e cea mai recentă (a fost depășită), NU atingem
 * `latestReq` (aparține cererii noi). MUTĂ store-ul.
 */
export function abandonScopedSubRequest(store: ScopedSubStore, reqId: number): void {
  const pending = store.pending.get(reqId);
  if (!pending) return;
  store.pending.delete(reqId);
  if (store.latestReq.get(pending.key) === reqId) {
    store.latestReq.delete(pending.key);
  }
}

export type ResponseOutcome =
  | "promoted"       // cea mai recentă cerere + succes → active := subId nou; anulează subId-ul vechi
  | "failed-latest"  // cea mai recentă cerere + eroare → păstrează active vechi; retry la scanul următor
  | "stale-success"  // cerere depășită + succes → subId orfan; anulează-l (nu atinge active)
  | "stale-failed"   // cerere depășită + eroare → nimic de făcut
  | "unknown";       // reqId necunoscut (duplicat / după reconnect-clear) → ignoră

export interface ResponsePlan {
  /** subId-uri de anulat (eth_unsubscribe). 0 sau 1 în practică. */
  unsub:   string[];
  outcome: ResponseOutcome;
}

/**
 * Aplică răspunsul serverului la un `eth_subscribe`. MUTĂ store-ul. Întoarce subId-urile de anulat.
 *   - succes + e cea mai recentă cerere → promovează la `active`, anulează subscripția veche pe care o înlocuiește.
 *   - succes + cerere depășită (a venit una mai nouă între timp) → subId orfan → anulează-l, `active` neatins.
 *   - eroare + cea mai recentă → păstrează `active` vechi (flow-ul vechi continuă), curăță `latestReq` ca să re-încerce.
 *   - eroare + depășită → no-op.
 *   - reqId necunoscut (ex. răspuns întârziat după reconnect-clear) → ignorat (subscripția e pe socketul vechi, mort).
 */
export function applyScopedSubResponse(
  store: ScopedSubStore,
  reqId: number,
  result: { ok: true; subId: string } | { ok: false },
): ResponsePlan {
  const p = store.pending.get(reqId);
  if (!p) return { unsub: [], outcome: "unknown" };
  store.pending.delete(reqId);

  const isLatest = store.latestReq.get(p.key) === reqId;

  if (!result.ok) {
    if (isLatest) store.latestReq.delete(p.key); // permite retry la scanul următor; active rămâne
    return { unsub: [], outcome: isLatest ? "failed-latest" : "stale-failed" };
  }

  // succes: avem un subId nou
  if (!isLatest) {
    // o cerere mai nouă a depășit-o pe asta → subId orfan, anulează-l
    return { unsub: [result.subId], outcome: "stale-success" };
  }

  // cea mai recentă + succes → promovează; anulează subscripția activă anterioară (dacă există)
  const prev = store.active.get(p.key);
  store.active.set(p.key, { subId: result.subId, snapshot: p.snapshot });
  store.latestReq.delete(p.key); // rezolvată
  const unsub = prev && prev.subId !== result.subId ? [prev.subId] : [];
  return { unsub, outcome: "promoted" };
}

/**
 * „Nimic de urmărit" → dărâmă subscripția activă. MUTĂ store-ul. Întoarce subId-ul de anulat (dacă era unul).
 * Curăță și `latestReq`, așa că orice cerere rămasă în zbor devine „depășită" și, la sosire, subId-ul ei
 * orfan e anulat de `applyScopedSubResponse` (stale-success). Idempotent: fără active → unsub gol.
 */
export function planScopedUnsubscribe(store: ScopedSubStore, key: string): { unsub: string[] } {
  const active = store.active.get(key);
  store.active.delete(key);
  store.latestReq.delete(key);
  return { unsub: active ? [active.subId] : [] };
}

/**
 * Reconnect: șterge TOATĂ starea scoped pentru un chain (active + pending + latestReq). MUTĂ store-ul.
 * Subscripțiile de pe socketul vechi mor server-side la close, deci nu-i nevoie să le anulăm explicit;
 * răspunsurile întârziate ale cererilor de dinainte de close se vor lovi de `unknown` și vor fi ignorate.
 */
export function clearScopedSubsForChain(store: ScopedSubStore, chainId: string): void {
  const prefix = chainId + ":";
  for (const k of [...store.active.keys()])    if (k.startsWith(prefix)) store.active.delete(k);
  for (const k of [...store.latestReq.keys()]) if (k.startsWith(prefix)) store.latestReq.delete(k);
  for (const [reqId, p] of [...store.pending.entries()]) if (p.key.startsWith(prefix)) store.pending.delete(reqId);
}

/**
 * `true` dacă există VREO cerere pending pentru `key` mai veche de `SCOPED_SUB_HARD_TIMEOUT_MS` (ACK
 * blocat definitiv). Call-site-ul (subscriptions.ts) resetează socketul (`ws.terminate()`) → handler-ul
 * `close` cheamă `clearScopedSubsForChain` → golește pending/active/latestReq acumulate + reconnect fresh.
 * NU mută store-ul (doar citește) — resetarea efectivă e treaba call-site-ului, care deține WebSocket-ul.
 */
export function hasHardExpiredScopedRequest(store: ScopedSubStore, key: string, now: number): boolean {
  for (const p of store.pending.values()) {
    if (p.key === key && now - p.sentAt >= SCOPED_SUB_HARD_TIMEOUT_MS) return true;
  }
  return false;
}

/** Read helper (debug/teste): snapshot-ul confirmat activ pentru cheie, sau null. */
export function activeSnapshot(store: ScopedSubStore, key: string): string | null {
  return store.active.get(key)?.snapshot ?? null;
}

/** Read helper (debug/teste): subId-ul confirmat activ pentru cheie, sau null. */
export function activeSubId(store: ScopedSubStore, key: string): string | null {
  return store.active.get(key)?.subId ?? null;
}

/** Sănătatea unei subscripții scoped per-kind, pt. publicarea în worker_runtime (Part B). Ages-at-`now`. */
export interface ScopedSubHealth {
  confirmed:       boolean;       // există o subscripție CONFIRMATĂ activă pt. (chain, kind)
  poolCount:       number;        // câte pool-uri acoperă snapshot-ul confirmat (split pe „,")
  confirmedAgeSec: number | null; // de cât timp e confirmată (din scopedConfirmedAt); null = necunoscut
}

/**
 * PUR: derivă sănătatea subscripției scoped (chain, kind) din `active` + harta de confirmări. Fără subscripție
 * activă → `{confirmed:false, poolCount:0, confirmedAgeSec:null}`. `poolCount` = numărul de intrări din snapshot-ul
 * confirmat (adresele/pool-id-urile join-uite cu „,"). `confirmedAgeSec` = (now - confirmedAt)/1000, clampat ≥0;
 * `null` dacă nu avem timestamp (ex. confirmat înainte de a exista harta — passthrough-safe). Testabil izolat.
 */
export function scopedSubHealth(
  active:           Map<string, ConfirmedSub>,
  confirmedAtByKey: Map<string, number>,
  chainId:          string,
  kind:             ScopedSubKind,
  now:              number,
): ScopedSubHealth {
  const key = scopedSubKey(chainId, kind);
  const sub = active.get(key);
  if (!sub) return { confirmed: false, poolCount: 0, confirmedAgeSec: null };
  const poolCount    = sub.snapshot.split(",").filter(Boolean).length;
  const confirmedAt  = confirmedAtByKey.get(key);
  const confirmedAgeSec = typeof confirmedAt === "number" && Number.isFinite(confirmedAt)
    ? Math.max(0, Math.round((now - confirmedAt) / 1000))
    : null;
  return { confirmed: true, poolCount, confirmedAgeSec };
}

/**
 * PUR (corectitudine Part B): un log de notificare contează drept „viu" pentru (chain, kind) DOAR dacă vine de
 * la subscripția CONFIRMATĂ ACTIVĂ — `msg.params.subscription === active.subId`. Protejează contra:
 *   - vechea subscripție care mai livrează imediat după replacement (până se dezabonează);
 *   - un stale-success/orfan înainte de unsubscribe;
 *   - o subscripție veche al cărei `eth_unsubscribe` a eșuat;
 *   - orice subscripție străină cu ACELAȘI topic0.
 * Fără asta, un mesaj orfan ar marca fals kind-ul „ACTIVE" (și l-ar face „sibling recent" fals în cross-kind).
 */
export function isActiveKindMessage(
  active:       Map<string, ConfirmedSub>,
  chainId:      string,
  kind:         ScopedSubKind,
  subscription: unknown,
): boolean {
  const activeSub = active.get(scopedSubKey(chainId, kind));
  return !!activeSub && typeof subscription === "string" && subscription === activeSub.subId;
}
