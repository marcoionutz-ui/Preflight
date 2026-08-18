/**
 * lib/db/demoCache.ts — PH-11 (wiring Redis pentru protecția demo-ului public).
 *
 * Primitivele PURE de decizie trăiesc în `lib/demo/demoGuard.ts` (frunză testabilă). Aici legăm `getRedis()` +
 * Lua atomic:
 *   • REQUEST-RATE per-IP (generos, ORICE request incl. URL invalid) + BUILD-RATE per-IP (strict) — fereastră fixă.
 *   • BUGET global de RATĂ (token bucket, ceasul Redis) + SEMAFOR global de CONCURENȚĂ (ZSET cu expirare + prune).
 *   • LEASE single-flight per-slug (SET NX + release/renew compare-and-token) — un singur builder per cheie.
 *   • PUBLICARE cache FENCED (SET doar dacă lease-ul e încă al nostru) — un writer VECHI nu suprascrie cache-ul NOU.
 *   • HEARTBEAT owner-safe (renew lease + slot cât rulează un build lent) → nu apare al doilea builder.
 *
 * FAIL-CLOSED: Redis jos / excepție → busy. Cleanup IMEDIAT pe erori parțiale (lease/slot obținute se eliberează în
 * catch, nu așteaptă TTL-ul). Un owner vechi nu poate release/renew/publish peste unul nou (compare-and-token).
 */
import { randomUUID } from "node:crypto";
import { getRedis } from "./redis";
import {
  extractClientIp, resolveCacheFreshness, cacheAgeSec,
  classifyWindowLimit, classifyBuildBudget, classifyConcurrency,
  type DemoAction,
  DEMO_CACHE_TTL_SEC, DEMO_STALE_SERVE_MAX_SEC, DEMO_IP_WINDOW_SEC,
  DEMO_REQ_LIMIT_PER_WINDOW, DEMO_BUILD_LIMIT_PER_WINDOW,
  DEMO_BUILD_BUDGET_MAX, DEMO_BUILD_BUDGET_REFILL_PER_SEC,
  DEMO_MAX_CONCURRENT_BUILDS, DEMO_BUILD_SLOT_TTL_SEC, DEMO_LEASE_TTL_SEC,
  DEMO_HEARTBEAT_INTERVAL_MS,
} from "../demo/demoGuard";

export type { DemoAction } from "../demo/demoGuard"; // re-export pt. paginile care importă din acest modul

type RedisClient = NonNullable<ReturnType<typeof getRedis>>;

/** Wrapper de producție: `x-forwarded-for` e consultat DOAR dacă `DEMO_TRUST_XFF=1` (config trusted-proxy explicită). */
export function resolveClientIp(getHeader: (name: string) => string | null | undefined): string {
  return extractClientIp(getHeader, { trustXff: process.env.DEMO_TRUST_XFF === "1" });
}

// ── Chei Redis (demo-only) ───────────────────────────────────────────────────
const cacheKeyRedis = (slug: string) => `demo:cache:${slug}`;
const reqRateKey    = (ip: string)   => `demo:req:${ip}`;    // request-rate (generos)
const buildRateKey  = (ip: string)   => `demo:build:${ip}`;  // build-rate (strict)
const leaseKeyRedis = (slug: string) => `demo:lease:${slug}`;
const ACTIVE_BUILDS = "demo:active_builds"; // ZSET semafor: member=token, score=expiry(sec)
const BUDGET_KEY    = "demo:build_budget";

// ── Lua atomic ───────────────────────────────────────────────────────────────
export const DEMO_IP_RATE_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return c
`;

export const DEMO_BUDGET_LUA = `
local key   = KEYS[1]
local max   = tonumber(ARGV[1])
local rate  = tonumber(ARGV[2])
local ttl   = tonumber(ARGV[3])
local t     = redis.call('TIME')
local now   = tonumber(t[1]) + tonumber(t[2]) / 1000000
local data  = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])
if tokens == nil or ts == nil then tokens = max; ts = now end
local elapsed = now - ts
if elapsed > 0 then tokens = math.min(max, tokens + elapsed * rate); ts = now end
if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HMSET', key, 'tokens', tokens, 'ts', ts)
  redis.call('EXPIRE', key, ttl)
  return math.floor(tokens)
else
  redis.call('HMSET', key, 'tokens', tokens, 'ts', ts)
  redis.call('EXPIRE', key, ttl)
  return -1
end
`;

/** Semafor: prune sloturi expirate (self-heal), apoi dacă < cap adaugă slotul. Întoarce nr. ocupate (≥0) sau -1. */
export const DEMO_SEMAPHORE_ACQUIRE_LUA = `
local key = KEYS[1]
local cap = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local token = ARGV[3]
local t = redis.call('TIME')
local now = tonumber(t[1])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
local n = redis.call('ZCARD', key)
if n < cap then
  redis.call('ZADD', key, now + ttl, token)
  redis.call('EXPIRE', key, ttl + 5)
  return n
else
  return -1
end
`;

/** Release LEASE compare-and-delete: șterge DOAR dacă owner-token-ul curent e al nostru (owner vechi ≠ nou). */
export const DEMO_LEASE_RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end
`;

/**
 * RENEW ATOMIC de ownership (cgpt): UN singur Lua care verifică AMBELE — lease key == token ȘI token prezent în
 * ZSET-ul sloturilor active — și DOAR dacă ambele-s adevărate reînnoiește TTL-ul lease-ului + expiry-ul slotului.
 * Întoarce `1` (renewed) sau `0` (lost ownership: lease luat de altul SAU slot prune-uit/expirat). Owner-safe: un
 * owner vechi nu poate reînnoi peste unul nou. KEYS[1]=lease, KEYS[2]=activeBuilds; ARGV: token, leaseTtl, slotTtl.
 */
export const DEMO_BUILD_RENEW_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
local t = redis.call('TIME')
redis.call('ZADD', KEYS[2], tonumber(t[1]) + tonumber(ARGV[3]), ARGV[1])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]) + 5)
return 1
`;

/**
 * PUBLICARE cache FENCED (item 1): scrie cache-ul DOAR dacă lease-ul e ÎNCĂ al nostru. Un writer VECHI (lease-ul
 * expirat + luat de altul) NU poate suprascrie cache-ul publicat de owner-ul NOU. 1 = published, 0 = lost_lease.
 */
export const DEMO_CACHE_PUBLISH_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[3]))
  return 1
else
  return 0
end
`;

// ── Cache blob ───────────────────────────────────────────────────────────────
interface CacheEnvelope { cachedAt: number; payload: unknown; }
function parseCacheEnvelope(raw: string | null): CacheEnvelope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as CacheEnvelope).cachedAt === "number") {
      return parsed as CacheEnvelope;
    }
  } catch { /* corupt → miss */ }
  return null;
}

// ── Tipuri publice ───────────────────────────────────────────────────────────
export type DemoServedFrom = "build" | "fresh" | "stale" | "none";
export type CachePublishResult = "published" | "lost_lease" | "unavailable";

export interface DemoAdmission {
  action:      DemoAction;
  payload?:    unknown;
  cacheAgeSec: number | null;
  servedFrom:  DemoServedFrom;
  leaseToken?: string; // pe action="build": tokenul de folosit la publicare/heartbeat/release (via withBuildLease)
}

// ── Release / renew helpers (owner-safe, best-effort) ────────────────────────
async function releaseLease(r: RedisClient, slug: string, token: string): Promise<void> {
  try { await r.eval(DEMO_LEASE_RELEASE_LUA, 1, leaseKeyRedis(slug), token); } catch { /* best-effort */ }
}
async function releaseSlot(r: RedisClient, token: string): Promise<void> {
  try { await r.zrem(ACTIVE_BUILDS, token); } catch { /* best-effort */ }
}
export type OwnershipResult = "renewed" | "lost" | "unavailable";

/**
 * Renew ATOMIC + OBSERVABIL al ownership-ului (lease + slot într-un singur Lua). `renewed` = încă deținem ambele;
 * `lost` = lease luat de altul sau slot expirat/prune-uit; `unavailable` = eroare Redis. Caller-ul (withBuildLease)
 * observă rezultatul și oprește publicarea la pierdere.
 */
async function renewBuildOwnership(
  r: RedisClient, slug: string, token: string,
  leaseTtlSec: number, slotTtlSec: number,
): Promise<OwnershipResult> {
  try {
    const res = Number(await r.eval(
      DEMO_BUILD_RENEW_LUA, 2, leaseKeyRedis(slug), ACTIVE_BUILDS,
      token, String(leaseTtlSec), String(slotTtlSec),
    ));
    return res === 1 ? "renewed" : "lost";
  } catch {
    return "unavailable";
  }
}

// ── Request-rate (item 4: aplicat ORICĂREI cereri, inclusiv URL invalid) ─────
export type RequestRateResult = "allow" | "limited" | "unavailable";

/**
 * Limita GENERALĂ de requesturi per-IP (generoasă), aplicată de AMBELE pagini ÎNAINTE de validare/canonicalizare —
 * ca un URL invalid să nu poată fi spam-uit ca SSR dinamic. NU atinge build-rate/lease/slot/buget. Un singur INCR
 * (fără dublă-contorizare: build-rate e cheie separată).
 *
 * FAIL-CLOSED (cgpt): Redis absent SAU eroare → `unavailable` (NU `allow`) — nu permitem trafic nelimitat, mai ales
 * spre URL-uri invalide care nu mai ajung în `admitBuildRequest`. Paginile tratează orice ≠ `allow` ca busy.
 */
export async function enforceRequestRate(ip: string): Promise<RequestRateResult> {
  const r = getRedis();
  if (!r) return "unavailable";
  try {
    const c = Number(await r.eval(DEMO_IP_RATE_LUA, 1, reqRateKey(ip), String(DEMO_IP_WINDOW_SEC)));
    return classifyWindowLimit(c, DEMO_REQ_LIMIT_PER_WINDOW); // "allow" | "limited"
  } catch {
    return "unavailable";
  }
}

// ── Build admission (presupune request-rate DEJA aplicat de pagină) ──────────
/**
 * Decide dacă requestul (VALID, request-rate deja trecut) poate CONSTRUI. Ordinea: cache fresh → serve_fresh;
 * BUILD-rate strict per-IP; LEASE single-flight; SEMAFOR concurență; BUGET rată. Pe orice poartă picată → serve_stale
 * (dacă avem) altfel rate_limited/busy. CLEANUP IMEDIAT pe erori parțiale (lease/slot obținute se eliberează în catch).
 */
export async function admitBuildRequest(slug: string, ip: string): Promise<DemoAdmission> {
  const r = getRedis();
  if (!r) return { action: "busy", cacheAgeSec: null, servedFrom: "none" };

  let leaseHeld: string | null = null;   // token dacă am obținut lease-ul
  let slotHeld:  string | null = null;   // token dacă am obținut slotul de semafor
  try {
    const now = Date.now();

    // cache
    const env = parseCacheEnvelope(await r.get(cacheKeyRedis(slug)));
    const freshness = resolveCacheFreshness(env?.cachedAt ?? null, now, DEMO_CACHE_TTL_SEC, DEMO_STALE_SERVE_MAX_SEC);
    const age = cacheAgeSec(env?.cachedAt ?? null, now);
    if (freshness === "fresh") {
      return { action: "serve_fresh", payload: env?.payload, cacheAgeSec: age, servedFrom: "fresh" };
    }
    const staleFallback = (): DemoAdmission =>
      freshness === "stale"
        ? { action: "serve_stale", payload: env?.payload, cacheAgeSec: age, servedFrom: "stale" }
        : { action: "busy", cacheAgeSec: null, servedFrom: "none" };
    const rateFallback = (): DemoAdmission =>
      freshness === "stale"
        ? { action: "serve_stale", payload: env?.payload, cacheAgeSec: age, servedFrom: "stale" }
        : { action: "rate_limited", cacheAgeSec: null, servedFrom: "none" };

    // build-rate (strict, per-IP)
    const buildCount = Number(await r.eval(DEMO_IP_RATE_LUA, 1, buildRateKey(ip), String(DEMO_IP_WINDOW_SEC)));
    if (classifyWindowLimit(buildCount, DEMO_BUILD_LIMIT_PER_WINDOW) === "limited") return rateFallback();

    // single-flight lease — pierdut → NU consumăm buget/slot
    const token = randomUUID();
    const got = await r.set(leaseKeyRedis(slug), token, "EX", DEMO_LEASE_TTL_SEC, "NX");
    if (got !== "OK") return staleFallback();
    leaseHeld = token;

    // semafor de concurență
    const slots = Number(await r.eval(
      DEMO_SEMAPHORE_ACQUIRE_LUA, 1, ACTIVE_BUILDS,
      String(DEMO_MAX_CONCURRENT_BUILDS), String(DEMO_BUILD_SLOT_TTL_SEC), token,
    ));
    if (classifyConcurrency(slots) === "limited") {
      await releaseLease(r, slug, token); leaseHeld = null;
      return staleFallback();
    }
    slotHeld = token;

    // buget global de rată
    const tokens = Number(await r.eval(
      DEMO_BUDGET_LUA, 1, BUDGET_KEY,
      String(DEMO_BUILD_BUDGET_MAX), String(DEMO_BUILD_BUDGET_REFILL_PER_SEC), String(DEMO_STALE_SERVE_MAX_SEC),
    ));
    if (classifyBuildBudget(tokens) === "limited") {
      await releaseSlot(r, token); slotHeld = null;
      await releaseLease(r, slug, token); leaseHeld = null;
      return staleFallback();
    }

    // toate porțile trecute → build (pagina folosește withBuildLease: heartbeat + publish fenced + release)
    return { action: "build", cacheAgeSec: age, servedFrom: "build", leaseToken: token };
  } catch {
    // item 3: eroare parțială DUPĂ ce am obținut lease/slot → eliberează IMEDIAT (nu aștepta TTL-ul).
    if (slotHeld)  await releaseSlot(r, slotHeld);
    if (leaseHeld) await releaseLease(r, slug, leaseHeld);
    return { action: "busy", cacheAgeSec: null, servedFrom: "none" };
  }
}

// ── Publicare fenced + heartbeat + release (folosite de pagini via withBuildLease) ─
/**
 * Publică raportul în cache DOAR dacă lease-ul e încă al nostru (item 1: fencing). `published` | `lost_lease` |
 * `unavailable`. Un owner vechi (lease pierdut/luat de altul) NU poate suprascrie cache-ul owner-ului nou.
 */
export async function cacheDemoReport(slug: string, payload: unknown, leaseToken: string): Promise<CachePublishResult> {
  const r = getRedis();
  if (!r) return "unavailable";
  try {
    const env: CacheEnvelope = { cachedAt: Date.now(), payload };
    const res = Number(await r.eval(
      DEMO_CACHE_PUBLISH_LUA, 2, leaseKeyRedis(slug), cacheKeyRedis(slug),
      leaseToken, JSON.stringify(env), String(DEMO_STALE_SERVE_MAX_SEC),
    ));
    return res === 1 ? "published" : "lost_lease";
  } catch {
    return "unavailable";
  }
}

/** Eliberează slotul de semafor + lease-ul (compare-and-delete). Best-effort. */
export async function finishBuild(slug: string, leaseToken: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await releaseSlot(r, leaseToken);
  await releaseLease(r, slug, leaseToken);
}

export interface BuildLeaseResult<T> {
  report:    T | null;            // null dacă build-ul NU a rulat (ownership pierdut / Redis indisponibil ÎNAINTE de build)
  built:     boolean;            // callback-ul de build a fost apelat?
  published: CachePublishResult; // published | lost_lease | unavailable
}

export interface BuildLeaseOpts {
  leaseTtlSec?: number;
  slotTtlSec?:  number;
  heartbeatMs?: number;
  // SEAM DE TEST (DI, consistent cu `degraded.ts`/`sanitizeToolError`): override al funcției de renew ca testul să
  // controleze DETERMINIST momentul rezolvării unui renew (ex. build-ul se termină în timp ce renew-ul e încă în zbor).
  // NESETAT în producție → folosește `renewBuildOwnership` real pe Redis.
  renewOwnership?: () => Promise<OwnershipResult>;
}

/**
 * Orchestrează un build sub lease-ul obținut (cgpt R4):
 *  1. VERIFICARE IMEDIATĂ de ownership (renew atomic lease+slot) ÎNAINTE de a apela build-ul. Redis indisponibil sau
 *     ownership pierdut → NU pornește build-ul (`built:false`, report `null`).
 *  2. HEARTBEAT SERIALIZAT (fără tick-uri suprapuse: un tick în curs sare peste următorul) care reînnoiește atomic
 *     lease+slot și OBSERVĂ pierderea (`lost`/`unavailable` → marchează ownership pierdut).
 *  3. După build: publică FENCED DOAR dacă n-am observat pierderea (fenced publish rămâne oricum protecția finală).
 *  4. `finally`: oprește heartbeat-ul + release owner-safe (lease + slot).
 * Întoarce raportul calculat (chiar dacă publicarea a fost `lost_lease` — pagina poate afișa ce a calculat pt.
 * requestul curent) + starea publicării. `report:null`+`built:false` = pagina arată busy.
 */
export async function withBuildLease<T>(
  slug: string, leaseToken: string, build: () => Promise<T>, opts: BuildLeaseOpts = {},
): Promise<BuildLeaseResult<T>> {
  const leaseTtl = opts.leaseTtlSec ?? DEMO_LEASE_TTL_SEC;
  const slotTtl  = opts.slotTtlSec  ?? DEMO_BUILD_SLOT_TTL_SEC;
  const hbMs     = opts.heartbeatMs ?? DEMO_HEARTBEAT_INTERVAL_MS;

  const r = getRedis();
  if (!r) return { report: null, built: false, published: "unavailable" };

  // renew: real pe Redis, SAU override injectat (test determinist). Aceeași funcție pt. check-ul imediat ȘI heartbeat.
  const doRenew = opts.renewOwnership ?? (() => renewBuildOwnership(r, slug, leaseToken, leaseTtl, slotTtl));

  // 1. Ownership check IMEDIAT înainte de build. Pierdut / indisponibil → nu construim.
  const initial = await doRenew();
  if (initial !== "renewed") {
    await finishBuild(slug, leaseToken); // eliberează ce mai deținem (owner-safe, no-op dacă deja pierdut)
    return { report: null, built: false, published: initial === "unavailable" ? "unavailable" : "lost_lease" };
  }

  // 2. Heartbeat SERIALIZAT (fără tick-uri suprapuse) + observarea pierderii cu stare (cgpt R5):
  //    ORICE rezultat ≠ "renewed" (lost SAU unavailable) = failure fail-closed → oprește tick-urile viitoare.
  //    Păstrăm referința promise-ului renew în curs ca să-l putem AȘTEPTA înainte de decizia de publicare.
  let ownershipFailure: OwnershipResult | null = null; // "lost" | "unavailable" (null = încă deținem)
  let inflight: Promise<void> | null = null;
  let hb: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (inflight) return; // un renew încă rulează → nu suprapune tick-urile
    inflight = doRenew()
      .then(res => {
        if (res !== "renewed") {
          ownershipFailure = res;                       // fail-closed: lost SAU unavailable
          if (hb) { clearInterval(hb); hb = null; }     // oprește heartbeat-urile următoare
        }
      })
      .finally(() => { inflight = null; });
  }, hbMs);
  hb?.unref?.();

  try {
    const report = await build();
    // 3. Oprește timerul ȘI AȘTEAPTĂ renew-ul aflat în curs înainte de a decide publicarea (verdict complet).
    if (hb) { clearInterval(hb); hb = null; }
    if (inflight) await inflight;
    // NU publica dacă am observat pierderea; fenced publish rămâne garda finală pt. schimbări după ultimul heartbeat.
    let published: CachePublishResult;
    if (ownershipFailure === "lost")             published = "lost_lease";
    else if (ownershipFailure === "unavailable") published = "unavailable";
    else                                         published = await cacheDemoReport(slug, report, leaseToken);
    return { report, built: true, published };
  } finally {
    if (hb) clearInterval(hb);
    await finishBuild(slug, leaseToken); // 4. release owner-safe
  }
}
