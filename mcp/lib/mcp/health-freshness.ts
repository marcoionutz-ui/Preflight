/**
 * lib/mcp/health-freshness.ts — E14 + E15 (reporting honesty pentru tp_health_check & tp_recent_pipeline_drops).
 *
 * Logică PURĂ de clasificare a prospețimii datelor multichain + a încrederii în rapoarte. Extrasă aici (frunză,
 * fără importuri grele — testabilă izolat cu tsx/tsc). `freshnessLabel` + `safeMinAge` sunt mutate din redis-reader
 * (re-exportate acolo), sursă UNICĂ de adevăr pt. praguri.
 *
 * Model multichain (varu R4): agregăm peste `knownChains` (chain-uri cu ORICE amprentă worker: runtime/snapshot/
 * states), NU peste `liveChains` (heartbeat proaspăt). Un chain cunoscut care a murit (heartbeat expirat) NU
 * dispare din evaluare — un snapshot lipsă/vechi pe un chain cunoscut → `unknown`/stale, nu ignorat.
 */

/** E14 (varu R2): respinge timestamp-uri non-finite / din VIITOR (age negativ) → "unknown", nu "fresh". */
export function freshnessLabel(ageMs: number | null): "fresh" | "aging" | "stale" | "unknown" {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  if (ageMs < 45_000) return "fresh";
  if (ageMs < 90_000) return "aging";
  return "stale";
}

export function safeMinAge(entries: number[]): number | null {
  if (!entries.length) return null;
  return Date.now() - Math.max(...entries);
}

export interface KeyFreshness {
  exists:             boolean;
  ageSec:             number | null;
  quality:            "fresh" | "aging" | "stale" | "unknown";
  newestEntryAgeSec?: number | null;
  /** Multichain: `false` dacă cheia lipsește pe ≥1 chain CUNOSCUT (→ quality forțat "unknown"). Omis dacă N/A. */
  complete?:          boolean;
}

/**
 * E14 (Intern M3): prospețimea unei chei Redis raportată ONEST. quality/ageSec = prospețimea CHEII (proxy =
 * worker liveness agregat); vârsta celei mai noi intrări separat ca `newestEntryAgeSec`. Cheie absentă
 * (`exists=false`) → "unknown", NU "fresh". keyAgeMs non-finit/negativ → invalidat → "unknown".
 *
 * E14 (varu R4): `complete` opțional — completitudinea multichain a cheii. `keyExists.*` e agregat „există pe ≥1
 * chain", deci o cheie prezentă pe Base dar LIPSĂ pe BSC (chain cunoscut) ar raporta fals `exists:true` + quality
 * din snapshot-urile globale fresh. Când `complete===false`, quality e forțat "unknown" (nu putem revendica
 * prospețime cu acoperire parțială). `undefined` = check-ul de completitudine nu se aplică cheii (retro-compat).
 */
export function keyFreshness(
  exists:            boolean,
  keyAgeMs:          number | null,
  newestEntryAgeMs?: number | null,
  complete?:         boolean,
): KeyFreshness {
  const validAge =
    exists && keyAgeMs !== null && Number.isFinite(keyAgeMs) && keyAgeMs >= 0 ? keyAgeMs : null;

  // Acoperire parțială (complete===false) → nu putem vouch prospețimea, chiar dacă cheia există pe alt chain.
  const incomplete = complete === false;

  const info: KeyFreshness = {
    exists,
    ageSec:  validAge !== null ? Math.round(validAge / 1000) : null,
    quality: incomplete ? "unknown" : exists ? freshnessLabel(validAge) : "unknown",
  };

  if (complete !== undefined) info.complete = complete;

  if (newestEntryAgeMs !== undefined) {
    info.newestEntryAgeSec =
      newestEntryAgeMs !== null && Number.isFinite(newestEntryAgeMs) && newestEntryAgeMs >= 0
        ? Math.round(newestEntryAgeMs / 1000)
        : null;
  }
  return info;
}

/**
 * E14 (varu R4): completitudinea unei chei agregate peste chain-urile CUNOSCUTE. `true` doar dacă există ≥1 chain
 * cunoscut ȘI cheia e prezentă pe FIECARE (semantica lui `recentDropsReadableByChain`, generalizată). Un chain
 * cunoscut fără cheia respectivă → `false` → quality "unknown" în raport.
 */
export function completeOnKnownChains(
  present:     Record<string, boolean>,
  knownChains: string[],
): boolean {
  return knownChains.length > 0 && knownChains.every(c => present[c] === true);
}

export interface KnownFreshness {
  /** Max age (cel mai VECHI) printre chain-urile CUNOSCUTE care au un timestamp valid; null dacă niciunul. */
  worstAgeMs: number | null;
  /** true dacă FIECARE chain cunoscut are un timestamp valid (nimic lipsă / viitor / non-finit). */
  complete:   boolean;
  /** Chain-uri cunoscute FĂRĂ timestamp valid (lipsă/viitor/corupt) — sursa lui „unknown". */
  missing:    string[];
}

/**
 * E14 (varu R4): agregarea ONESTĂ a prospețimii peste `knownChains`. „Weakest link": cel mai vechi chain cunoscut.
 * Un chain cunoscut FĂRĂ timestamp valid (snapshot lipsă / viitor / corupt) → `complete=false` (→ tool-ul îl
 * tratează ca „unknown"/stale, NU îl sare). Un `savedAt` din viitor e tratat ca lipsă (skew, neîncredere).
 */
export function aggregateKnownFreshness(
  now:         number,
  tsByChain:   Record<string, number>,
  knownChains: string[],
): KnownFreshness {
  let worstAgeMs: number | null = null;
  const missing: string[] = [];
  for (const c of knownChains) {
    const sv = tsByChain[c];
    if (typeof sv !== "number" || !Number.isFinite(sv) || now - sv < 0) { missing.push(c); continue; }
    const age = now - sv;
    worstAgeMs = worstAgeMs === null ? age : Math.max(worstAgeMs, age);
  }
  return { worstAgeMs, complete: knownChains.length > 0 && missing.length === 0, missing };
}

/**
 * Worker „proaspăt" pentru HIGH: există chain-uri cunoscute, TOATE au snapshot valid (complete) ȘI cel mai slab
 * chain cunoscut e < `freshMs` (default 60s). Un chain cunoscut mort/lipsă → false.
 */
export function isWorkerFresh(
  now:         number,
  savedAtByChain: Record<string, number>,
  knownChains: string[],
  freshMs = 60_000,
): boolean {
  const agg = aggregateKnownFreshness(now, savedAtByChain, knownChains);
  return knownChains.length > 0 && agg.complete && agg.worstAgeMs !== null && agg.worstAgeMs < freshMs;
}

export interface DropsReport {
  confidence: "HIGH" | "LOW";
  text:       string;
  warnings?:  string[];
}

/**
 * E15 (Intern M5): raportul „no drops" ONEST. Lista goală ≠ „zero drop-uri". Pentru HIGH avem nevoie de AMBELE:
 *   (1) `dropsReadable` — recent_drops prezentă ȘI JSON array valid pe FIECARE chain cunoscut (absent pe un chain
 *       cunoscut = fără acoperire; corupt = safeJson dă [] dar e tot absență de date);
 *   (2) `workerFresh` — worker proaspăt agregat pe cel mai slab chain cunoscut (nu max, care ascunde un chain mort).
 * Orice altceva → LOW + warning (tratează ca „unknown", nu „clean").
 */
export function classifyEmptyDrops(opts: {
  dropsReadable: boolean;
  workerFresh:   boolean;
  minutesBack:   number;
}): DropsReport {
  const { dropsReadable, workerFresh, minutesBack } = opts;

  if (!dropsReadable) {
    return {
      confidence: "LOW",
      text:
        `No pipeline-drops data is available for the last ${minutesBack} minutes on one or more chains — the ` +
        `recent-drops key is absent or unreadable (worker offline, or the payload is corrupt). This is NOT ` +
        `evidence that zero drops occurred; treat it as "unknown", not "clean".`,
      warnings: ["Recent-drops data absent or unreadable on ≥1 known chain — cannot confirm zero drops."],
    };
  }
  if (!workerFresh) {
    return {
      confidence: "LOW",
      text:
        `The recent-drops keys are present but the worker snapshot is stale on one or more chains (the worker ` +
        `may be offline there), so the last ${minutesBack} minutes may not have been fully observed. No recent ` +
        `drops are recorded, but treat this as "unknown", not confirmed "clean".`,
      warnings: ["Worker snapshot stale on ≥1 known chain — the recent-drops window may be unobserved; empty ≠ confirmed zero."],
    };
  }
  return {
    confidence: "HIGH",
    text: `No pipeline drops were recorded in the last ${minutesBack} minutes.`,
  };
}

// ── D1 (health onestitate): semnale WS-liveness per-chain, PURE + testabile ──────────────
// Extrase din redis-reader/tp_health_check ca să fie unit-testate direct (leaf pattern), și ca să
// închidă două capcane de fals-fresh (cgpt P2/P3):
//   P2 — o vârstă publicată NEGATIVĂ (clock skew / bug de writer) nu trebuie clampată la 0 („acum"),
//        ci respinsă → `null` („necunoscut"). Altfel un semnal corupt devine „proaspăt".
//   P3 — un pong NECUNOSCUT (`null`) nu înseamnă „recent"; nu-l putem folosi ca dovadă de transport viu.

/**
 * Vârsta WS publicată de worker (la updatedAt-ul lui) → vârsta CURENTĂ la `now`, adunând `runtimeAgeSec`
 * (câte secunde a stat snapshot-ul în Redis), exact ca adjustMoverReadTime/E38. Respinge orice input
 * ne-numeric, non-finit SAU negativ → `null` (P2: negativul e date corupte, nu „acum"). `runtimeAgeSec`
 * negativ (viitor) e clampat la 0 — deja filtrat upstream, dar defensiv aici.
 */
export function adjustWsAgeSec(published: unknown, runtimeAgeSec: number): number | null {
  if (typeof published !== "number" || !Number.isFinite(published) || published < 0) return null;
  return Math.round(published) + Math.max(0, Math.round(runtimeAgeSec));
}

export interface WsRuntimeRaw {
  chain?:              unknown;
  updatedAt?:          unknown;
  wsConnected?:        unknown;
  lastPongAgeSec?:     unknown;
  lastWsMessageAgeSec?: unknown;
}

export interface WsRuntimeEntry {
  updatedAt:           number;
  wsConnected:         boolean;
  lastPongAgeSec:      number | null;
  lastWsMessageAgeSec: number | null;
}

/**
 * Validează + normalizează un `worker_runtime:{chain}` raw într-o intrare WS-liveness la `now`, SAU `null`
 * dacă e de ignorat. CHEIA MGET (`keyChain`) e autoritatea de chain (refuză payload cu alt chain — bug B4a).
 * Filtre 1:1 cu redis-reader: updatedAt lipsă/NaN → null; viitor > futureSkewMs → null; expirat > maxAgeMs → null.
 * Vârstele WS sunt ajustate la `now` prin adjustWsAgeSec (P2 negativ → null).
 */
export function resolveWsRuntime(
  wr:   WsRuntimeRaw,
  keyChain: string,
  now:  number,
  opts: { maxAgeMs: number; futureSkewMs: number; normalizeChain: (s: string) => string },
): WsRuntimeEntry | null {
  if (opts.normalizeChain(String(wr.chain ?? "")) !== keyChain) return null;
  const updatedAt = Number(wr.updatedAt);
  if (!Number.isFinite(updatedAt)) return null;
  const ageMs = now - updatedAt;
  if (ageMs < -opts.futureSkewMs || ageMs > opts.maxAgeMs) return null;
  const rtAgeSec = Math.max(0, Math.round(ageMs / 1000));
  return {
    updatedAt,
    wsConnected:         wr.wsConnected === true,
    lastPongAgeSec:      adjustWsAgeSec(wr.lastPongAgeSec, rtAgeSec),
    lastWsMessageAgeSec: adjustWsAgeSec(wr.lastWsMessageAgeSec, rtAgeSec),
  };
}

/**
 * „WS stream stale" = transportul e viu (pong PROASPĂT, cunoscut & sub pongFreshSec) DAR data stream-ul e mort
 * (ultima notificare de log > staleSec) — adică „serverul răspunde la ping, dar subscripțiile au murit tăcut".
 * P3: un pong `null` (necunoscut) NU e dovadă de transport viu → NU raportăm stream-stale (n-avem cum ști dacă
 * transportul mai trăiește; ar fi un fals-pozitiv bazat pe necunoscut). La fel, mesaj `null` → nu putem afirma stale.
 */
export function isWsStreamStale(
  w:            { wsConnected: boolean; lastPongAgeSec: number | null; lastWsMessageAgeSec: number | null } | undefined,
  pongFreshSec: number,
  staleSec:     number,
): boolean {
  return !!w
    && w.wsConnected
    && w.lastPongAgeSec !== null && w.lastPongAgeSec < pongFreshSec       // transport DOVEDIT viu (nu doar „necunoscut")
    && w.lastWsMessageAgeSec !== null && w.lastWsMessageAgeSec > staleSec; // data stream dovedit mort
}
