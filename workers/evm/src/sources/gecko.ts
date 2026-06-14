/**
 * sources/gecko.ts
 * GeckoTerminal API client.
 * Expune doar SourcePool[] normalizat — raw attributes nu ies din acest modul.
 */

import type { ChainConfig } from "../config/chains";
import { GECKO_BASE } from "../config/constants";
import { normalizePool, type SourcePool } from "./normalize";
import { geckoSourceHealth } from "../state/stores";

async function fetchWithTimeout(url: string, ms = 8_000): Promise<Response> {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchDiscoveryPools(chain: ChainConfig): Promise<SourcePool[]> {
  try {
    const res1   = await fetchWithTimeout(`${GECKO_BASE}/networks/${chain.gecko}/trending_pools?page=1`);
    await new Promise(r => setTimeout(r, 600));
    const res2   = await fetchWithTimeout(`${GECKO_BASE}/networks/${chain.gecko}/trending_pools?page=2`);
    await new Promise(r => setTimeout(r, 600));
    const resNew = await fetchWithTimeout(`${GECKO_BASE}/networks/${chain.gecko}/new_pools?page=1`);

	const now    = Date.now();
    const got429 = [res1, res2, resNew].some(r => r.status === 429);

    if (got429) {
      const prev = geckoSourceHealth.get(chain.id);
      geckoSourceHealth.set(chain.id, {
        lastResultCount:  prev?.lastResultCount  ?? 0,
        emptyStreak:      prev?.emptyStreak      ?? 0,
        consecutiveEmpty: prev?.consecutiveEmpty ?? prev?.emptyStreak ?? 0,
        lastFetchAt:      now,
        last429At:        now,
        status:           "RATE_LIMITED",
      });
      console.log(`[GECKO 429] ${chain.id} — partial/full rate limit observed`);
    }

    const d1   = res1.ok   ? await res1.json()   as any : { data: [] };
	const d2   = res2.ok   ? await res2.json()   as any : { data: [] };
	const dNew = resNew.ok ? await resNew.json() as any : { data: [] };

    const seen = new Set<string>();
    const p1Raw  = (d1.data   ?? []).map((r: any) => ({ raw: r, source: "GECKO_TRENDING_P1" as const }));
    const p2Raw  = (d2.data   ?? []).map((r: any) => ({ raw: r, source: "GECKO_TRENDING_P2" as const }));
    const newRaw = (dNew.data ?? []).map((r: any) => ({ raw: r, source: "GECKO_NEW_POOL"    as const }));

    const pools: SourcePool[] = [];
    for (const { raw, source } of [...p1Raw, ...p2Raw, ...newRaw]) {
      const addr = raw.attributes?.address?.toLowerCase();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      const pool = normalizePool(raw, chain);
      if (pool) pools.push({ ...pool, discoverySource: source });
    }

    console.log(`[FETCH] ${chain.id}: ${pools.length} pools (trend p1+p2 + new)`);
    return pools;
  } catch {
    return [];
  }
}

export async function fetchPoolByAddress(
  chain: ChainConfig,
  pairAddress: string,
): Promise<SourcePool | null> {
  try {
    const res = await fetchWithTimeout(`${GECKO_BASE}/networks/${chain.gecko}/pools/${pairAddress}`);
    if (!res.ok) return null;
    const json = await res.json() as any;
	if (!json.data) return null;
	return normalizePool(json.data, chain);
  } catch {
    return null;
  }
}

// Re-export pentru backward compat cu codul care folosea fetchWithTimeout direct
export { fetchWithTimeout };

// Backward compat alias
export const fetchTrendingPools = fetchDiscoveryPools;