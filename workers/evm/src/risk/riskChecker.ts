/**
 * risk/riskChecker.ts
 * Worker-side risk check wrapper.
 * Redis cache (6h) + fire-and-forget trigger + in-flight dedupe cu Promise sharing.
 * Logica stateless e în @preflight/risk-layer.
 */

import { checkTokenRisk } from "@preflight/risk-layer";
import type { RiskResult } from "@preflight/risk-layer";
import { getRedis } from "../infra/redis";

export type { RiskResult };

const RISK_CACHE_TTL_SEC       = 6 * 60 * 60;
const RISK_UNAVAILABLE_TTL_SEC = 10 * 60;

// fix ChatGPT: Map<Promise> — call #2 primește același promise, nu null
const inFlight = new Map<string, Promise<RiskResult | null>>();

function riskCacheKey(chain: string, tokenAddress: string): string {
  return `preflight:risk:${chain.toLowerCase()}:${tokenAddress.toLowerCase()}`;
}

export async function getTokenRisk(
  tokenAddress: string,
  chain:        string,
): Promise<RiskResult | null> {
  const chainKey = chain.toLowerCase();
  const token    = tokenAddress.toLowerCase();
  const key      = riskCacheKey(chainKey, token);
  const r        = getRedis();

  // Cache check
  if (r) {
    try {
      const cached = await r.get(key);
      if (cached) return JSON.parse(cached) as RiskResult;
    } catch { /* cache miss */ }
  }

  // In-flight dedupe — refolosește promise-ul activ
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<RiskResult | null> => {
    try {
      const result = await checkTokenRisk(token, chainKey, process.env.GOPLUS_API_KEY);

      if (r) {
        try {
          const ttl = result.source === "goplus"
            ? RISK_CACHE_TTL_SEC
            : RISK_UNAVAILABLE_TTL_SEC;
          await r.set(key, JSON.stringify(result), "EX", ttl);
        } catch { /* non-fatal */ }
      }

      return result;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/**
 * Cache only — fără fetch.
 * Folosit în scan loop pentru a nu bloca.
 */
export async function getCachedRisk(
  tokenAddress: string,
  chain:        string,
): Promise<RiskResult | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const chainKey = chain.toLowerCase();
    const token    = tokenAddress.toLowerCase();
    const cached = await r.get(riskCacheKey(chainKey, token));
    return cached ? JSON.parse(cached) as RiskResult : null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget — nu blochează scan loop.
 * Rezultatul ajunge în cache pentru tp_preflight_safety / tp_pair_context.
 */
export function triggerRiskCheck(
  tokenAddress: string,
  chain:        string,
): void {
  if (!tokenAddress || !chain) return;
  getTokenRisk(tokenAddress, chain).catch(() => { /* non-fatal */ });
}

/**
 * Bulk cache read cu MGET — un singur Redis call pentru toate pairs.
 * Folosit în buildPairStates() pentru a evita N GET-uri secvențiale.
 */
export async function getCachedRisksBulk(
  items: Array<{ tokenAddress: string; chain: string }>,
): Promise<Map<string, RiskResult>> {
  const r   = getRedis();
  const out = new Map<string, RiskResult>();
  if (!r || items.length === 0) return out;

  // fix ChatGPT: deduplicare pe token — același token în N pool-uri = un singur MGET key
  const byKey = new Map<string, { chain: string; token: string; key: string }>();
  for (const item of items) {
    const chain = item.chain.toLowerCase();
    const token = item.tokenAddress.toLowerCase();
    const key   = riskCacheKey(chain, token);
    byKey.set(key, { chain, token, key });
  }

  const normalized = [...byKey.values()];

  try {
    const values = await r.mget(...normalized.map(i => i.key));
    values.forEach((v, i) => {
      if (!v) return;
      try {
        out.set(`${normalized[i].chain}:${normalized[i].token}`, JSON.parse(v) as RiskResult);
      } catch { /* ignore bad cache entry */ }
    });
  } catch {
    return out;
  }

  return out;
}