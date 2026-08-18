/**
 * lib/demo/demoGuard.ts — PH-11 (protecția demo-ului public: cache + rate-limit + single-flight + abuse hardening).
 *
 * Problema (varu): `app/demo/*` e `force-dynamic`, neautentificat, reconstruiește un raport Redis la FIECARE acces
 * → amplificator de cost + suprafață de abuz. Ruta de pair ia `[chain]/[address]` arbitrar → adrese unice sparg
 * orice cache naiv.
 *
 * Deciderele PURE trăiesc aici (frunză, testabile izolat; singurul import e `node:net.isIP`, o funcție pură de
 * validare, fără I/O). Wiring-ul Redis (Lua atomic: rate-limit, buget, LEASE single-flight, SEMAFOR de concurență)
 * trăiește în `lib/db/demoCache.ts`.
 *
 * ⚠️ PROTECȚIE APP-LAYER = BEST-EFFORT, NU WAF (cgpt/Railway). Railway nu oferă protecție application-layer și
 * documentează `X-Real-IP` drept headerul de IP; recomandă Cloudflare pentru WAF. Limitele de aici sunt PODEAUA
 * (single-flight + concurență + rate + buget), explicit fail-safe — NU presupun un WAF în față. Un WAF (Cloudflare)
 * rămâne prima linie recomandată pentru volum mare / L7; vezi `DEMO_WAF_RECOMMENDED`.
 */
import { isIP } from "node:net";

/** Dependența explicită (nu implicită): app-layer-ul de aici e podea, nu WAF. Documentat, nu presupus. */
export const DEMO_WAF_RECOMMENDED = "cloudflare"; // prima linie L7 recomandată în fața demo-ului public

// ── Constante (design PH-11; TUNABILE — knobs de produs) ─────────────────────
export const DEMO_CACHE_TTL_SEC        = 45;   // prospețimea unui raport cache-uit înainte de rebuild
export const DEMO_STALE_SERVE_MAX_SEC  = 300;  // cât de vechi acceptăm să servim STALE când suntem peste buget/rate
export const DEMO_IP_WINDOW_SEC        = 60;   // fereastra pt. AMBELE limite per-IP (request + build)

// Item 5 (cgpt): SEPARĂM rata de REQUEST (orice hit, inclusiv cache fresh — anti spam SSR/GET) de rata de BUILD
// (doar operațiile care pot construi raportul — partea scumpă). Request = generos; build = strict.
export const DEMO_REQ_LIMIT_PER_WINDOW   = 120; // generos: orice request/IP/fereastră (fresh cache tot e limitat)
export const DEMO_BUILD_LIMIT_PER_WINDOW = 30;  // strict: requesturi build-capable/IP/fereastră

// Global (între replici): token bucket de RATĂ (builds/min) + SEMAFOR de CONCURENȚĂ (builds active simultan).
export const DEMO_BUILD_BUDGET_MAX            = 120; // capacitatea bucket-ului de build-uri globale (burst rată)
export const DEMO_BUILD_BUDGET_REFILL_PER_SEC = 2;   // refill (2/s = 120/min susținut)
export const DEMO_MAX_CONCURRENT_BUILDS       = 4;   // item 4: cap MIC de build-uri ACTIVE simultan (anti-stampede)
export const DEMO_BUILD_SLOT_TTL_SEC          = 15;  // expirarea unui slot de semafor (self-heal dacă builderul moare)

// Single-flight per slug (item 3): un singur builder per cheie de cache la un moment dat.
export const DEMO_LEASE_TTL_SEC = 10; // TTL lease per-slug (self-heal); < SLOT_TTL ca slotul să acopere lease-ul

// Heartbeat: un build mai lung decât TTL-ul își REÎNNOIEȘTE lease-ul + slotul (owner-safe) cât rulează, ca să nu
// apară un al doilea builder și să nu-i fie suprascris cache-ul de un writer vechi. Intervalul < min(TTL-uri)/2.
export const DEMO_HEARTBEAT_INTERVAL_MS = 4000; // reînnoire la ~4s (lease 10s / slot 15s)

// ── Identitate canonică a perechii (item 1: fără coliziune Solana / EVM casing) ─
const EVM_CHAINS = ["base", "arbitrum", "bsc", "ethereum"] as const;
export const DEMO_SUPPORTED_CHAINS = [...EVM_CHAINS, "solana"] as const;
// base58 (alfabetul Bitcoin/Solana: fără 0 O I l). Solana pubkey = 32 bytes → 32..44 caractere base58.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// EVM: adresă 0x+40hex SAU V4 pool id 0x+64hex.
const EVM_ADDR_RE = /^0x[0-9a-f]{40}$/;
const EVM_V4_RE   = /^0x[0-9a-f]{64}$/;

export interface CanonicalPair { chain: string; address: string; }

/** Canonicalizează chain-ul: `eth`→`ethereum`; restul chain-urilor suportate trec lowercase; necunoscut → null. */
export function canonicalChain(chain: string | null | undefined): string | null {
  const c = typeof chain === "string" ? chain.trim().toLowerCase() : "";
  if (c === "eth" || c === "ethereum") return "ethereum";
  if ((DEMO_SUPPORTED_CHAINS as readonly string[]).includes(c)) return c;
  return null;
}

/**
 * Item 1: identitatea CANONICĂ a unei perechi (o SINGURĂ funcție, folosită ȘI de pre-validare ȘI de slug, ca să nu
 * poată diverge). Întoarce `{chain, address}` canonic sau `null` (invalid). Reguli:
 *   • `eth` → `ethereum` (chei identice pt. `eth/addr` și `ethereum/addr`).
 *   • EVM: acceptă DOAR `0x`+40 hex sau `0x`+64 hex (V4 pool id); adresa EVM e lowercase-uită (case-insensitive).
 *   • Solana: validează forma base58 și PĂSTREAZĂ casing-ul original (adrese Solana sunt case-SENSITIVE → două
 *     adrese care diferă doar prin casing sunt pool-uri DIFERITE și trebuie să producă chei diferite).
 */
export function canonicalizeDemoPair(chain: string | null | undefined, address: string | null | undefined): CanonicalPair | null {
  const c = canonicalChain(chain);
  if (!c) return null;
  const a = typeof address === "string" ? address.trim() : "";
  if (a.length === 0) return null;

  if (c === "solana") {
    return BASE58_RE.test(a) ? { chain: c, address: a } : null; // PĂSTREAZĂ casing-ul (case-sensitive)
  }
  // EVM — lowercase (case-insensitive), acceptă adresă sau V4 pool id
  const lower = a.toLowerCase();
  if (EVM_ADDR_RE.test(lower) || EVM_V4_RE.test(lower)) return { chain: c, address: lower };
  return null;
}

/** Slug de cache canonic (numai din identitatea canonică) sau `null` dacă perechea e invalidă. */
export function demoPairSlug(chain: string | null | undefined, address: string | null | undefined): string | null {
  const id = canonicalizeDemoPair(chain, address);
  return id ? `pair:${id.chain}:${id.address}` : null;
}

/** Pre-validare ieftină (fără Redis): perechea e servibilă ⇔ are identitate canonică. Aceeași sursă ca slug-ul. */
export function isServableDemoPair(chain: string | null | undefined, address: string | null | undefined): boolean {
  return canonicalizeDemoPair(chain, address) !== null;
}

// ── IP extraction (item 2: corect pt. Railway) ───────────────────────────────
/**
 * IP-ul clientului, FAIL-SAFE, potrivit pentru Railway. Railway documentează `X-Real-IP` drept headerul de IP al
 * clientului (proxy-ul lor îl setează); `x-forwarded-for` NU e de încredere fără o config explicită de trusted
 * proxy — un client îl poate falsifica și ar primi un bucket nou la fiecare request. Deci:
 *   • preferă `x-real-ip`, validat cu `isIP` (v4/v6);
 *   • consultă `x-forwarded-for` DOAR dacă `opts.trustXff` (config explicită de trusted proxy), primul hop validat;
 *   • absent/invalid → bucket comun `"unknown"` (nu ocolește limita — cade în același coș).
 * Cheia e doar pentru bucketing de rate-limit, nu pentru identitate.
 */
export function extractClientIp(
  getHeader: (name: string) => string | null | undefined,
  opts: { trustXff?: boolean } = {},
): string {
  const xri = getHeader("x-real-ip");
  if (typeof xri === "string") {
    const v = xri.trim();
    if (isIP(v) !== 0) return v.toLowerCase();
  }
  if (opts.trustXff) {
    const xff = getHeader("x-forwarded-for");
    if (typeof xff === "string") {
      const first = xff.split(",")[0]?.trim() ?? "";
      if (isIP(first) !== 0) return first.toLowerCase();
    }
  }
  return "unknown";
}

// ── Cache freshness + vârstă (item 6: onestitate stale) ──────────────────────
export type CacheFreshness = "fresh" | "stale" | "miss";

/** Vârsta cache-ului în secunde (≥0), sau `null` dacă timestamp-ul lipsește/e corupt/în viitor. */
export function cacheAgeSec(cachedAtMs: number | null | undefined, now: number): number | null {
  if (cachedAtMs === null || cachedAtMs === undefined || !Number.isFinite(cachedAtMs)) return null;
  const ageMs = now - cachedAtMs;
  if (ageMs < 0) return null;
  return Math.round(ageMs / 1000);
}

/**
 * Clasifică un rezultat de cache. Absent/corupt/viitor → miss. `≤ttl` → fresh; între ttl și staleMax → stale
 * (candidat de fallback); peste staleMax → miss. Pur, `now` injectat.
 */
export function resolveCacheFreshness(
  cachedAtMs:  number | null,
  now:         number,
  ttlSec:      number = DEMO_CACHE_TTL_SEC,
  staleMaxSec: number = DEMO_STALE_SERVE_MAX_SEC,
): CacheFreshness {
  if (cachedAtMs === null || !Number.isFinite(cachedAtMs)) return "miss";
  const ageMs = now - cachedAtMs;
  if (ageMs < 0) return "miss";
  if (ageMs <= ttlSec * 1000)      return "fresh";
  if (ageMs <= staleMaxSec * 1000) return "stale";
  return "miss";
}

// ── Rate-limit / budget / concurrency classifiers (pure, fail-closed) ────────
export type Admission = "allow" | "limited";

/**
 * Fereastră fixă per-IP (generică pt. request-rate ȘI build-rate — apelată cu limita potrivită). `countAfterIncr`
 * = contorul DUPĂ INCR-ul atomic (primul request = 1). `≤limit` → allow; peste → limited. Non-finit/≤0 (Lua corupt)
 * → FAIL-CLOSED limited.
 */
export function classifyWindowLimit(countAfterIncr: number, limit: number): Admission {
  if (!Number.isFinite(countAfterIncr) || countAfterIncr <= 0) return "limited";
  return countAfterIncr <= limit ? "allow" : "limited";
}

/** Buget global de BUILD-uri (rată, token bucket). `tokensAfterTake` ≥0 = luat/allow; -1 = gol; non-finit → limited. */
export function classifyBuildBudget(tokensAfterTake: number): Admission {
  if (!Number.isFinite(tokensAfterTake)) return "limited";
  return tokensAfterTake >= 0 ? "allow" : "limited";
}

/** Semafor global de CONCURENȚĂ (item 4). `slotsAfterAcquire` ≥0 = slot obținut/allow; -1 = plin; non-finit → limited. */
export function classifyConcurrency(slotsAfterAcquire: number): Admission {
  if (!Number.isFinite(slotsAfterAcquire)) return "limited";
  return slotsAfterAcquire >= 0 ? "allow" : "limited";
}

// ── Acțiunea finală + onestitate stale ───────────────────────────────────────
export type DemoAction =
  | "serve_fresh"   // cache fresh (sub request-rate) → servește direct
  | "build"         // câștigat lease + slot + buget → construiește (și scrie cache)
  | "serve_stale"   // nu putem construi acum (rate/buget/concurență/lease pierdut) dar avem cache stale → servește-l
  | "rate_limited"  // peste request-rate SAU build-rate per-IP, fără stale de servit
  | "busy";         // peste buget/concurență global (sau Redis jos / lease pierdut), fără stale

/**
 * Fallback-ul de NON-build când o poartă (build-rate/buget/concurență/lease) a picat: servește stale dacă îl avem,
 * altfel `busy`. Pur.
 */
export function nonBuildFallback(cache: CacheFreshness): DemoAction {
  return cache === "stale" ? "serve_stale" : "busy";
}
