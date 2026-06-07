/**
 * lib/mcp/goplus.ts
 * GoPlus safety check logic — extras din route.ts
 */

import { getRedis } from "@/lib/db/redis";
import type { GoPlusSafety } from "./types";

const GOPLUS_CHAIN_IDS: Record<string, string> = {
  base:     "8453",
  arbitrum: "42161",
};

export const GOPLUS_UNAVAILABLE: GoPlusSafety = {
  sellability: "UNKNOWN", taxRisk: "UNKNOWN", ownerRisk: "UNKNOWN",
  isHoneypot: null, buyTaxPct: null, sellTaxPct: null,
  ownerRenounced: null, canChangeTax: null, canBlacklist: null,
  canMint: null, canPauseTrading: null, canChangeBalance: null,
  canTakeBackOwnership: null, tokenAgeMinutes: null,
  agentVerdict: "UNKNOWN_CHECK_MANUALLY",
  missingData: ["GoPlus API unavailable — check manually"],
  cachedAt: 0, source: "unavailable",
};

export function cleanTokenAddress(raw: string): string {
  return raw.replace(/^[a-z]+_/i, "").toLowerCase().trim();
}

export function deriveChainFromTokenAddress(raw: string): string | null {
  const match = raw.match(/^([a-z]+)_0x/i);
  return match ? match[1].toLowerCase() : null;
}

function parseTaxPct(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round((n <= 1 ? n * 100 : n) * 100) / 100;
}

async function fetchGoPlusSafety(tokenAddr: string, chainId: string): Promise<GoPlusSafety> {
  const missing: string[] = [];
  try {
    const url  = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${tokenAddr}`;
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 8_000);

    const headers: Record<string, string> = { accept: "application/json" };
    if (process.env.GOPLUS_API_KEY) headers.Authorization = `Bearer ${process.env.GOPLUS_API_KEY}`;

    let raw: Record<string, unknown>;
    try {
      const res  = await fetch(url, { signal: ctrl.signal, headers });
      clearTimeout(t);
      if (!res.ok) throw new Error(`GoPlus HTTP ${res.status}`);
      const json = await res.json() as { result?: Record<string, unknown> };
      raw = (json?.result?.[tokenAddr.toLowerCase()] ?? json?.result?.[tokenAddr] ?? null) as Record<string, unknown>;
    } finally {
      clearTimeout(t);
    }

    if (!raw) return { ...GOPLUS_UNAVAILABLE, missingData: ["GoPlus returned no data for this token"], cachedAt: Date.now() };

    const isHoneypot       = raw.is_honeypot === "1" ? true : raw.is_honeypot === "0" ? false : null;
    const cannotSell       = raw.cannot_sell_all === "1";
    const buyTax           = parseTaxPct(raw.buy_tax);
    const sellTax          = parseTaxPct(raw.sell_tax);
    const ZERO             = "0x0000000000000000000000000000000000000000";
    const DEAD             = "0x000000000000000000000000000000000000dead";
    const ownerAddr        = typeof raw.owner_address === "string" ? raw.owner_address.toLowerCase() : null;
    const ownerRenounced   = ownerAddr === ZERO || ownerAddr === DEAD ? true : ownerAddr !== null ? false : null;
    const canChangeTax     = raw.slippage_modifiable === "1" || raw.personal_slippage_modifiable === "1";
    const canChangeBalance = raw.owner_change_balance === "1";
    const canTakeBackOwn   = raw.can_take_back_ownership === "1";
    const canBlacklist     = raw.is_blacklisted === "1";
    const canMint          = raw.is_mintable === "1";
    const canPause         = raw.trading_pausable === "1";
    const tokenAgeMins     = raw.token_age_in_minutes != null ? Math.round(Number(raw.token_age_in_minutes)) : null;

    if (isHoneypot === null)     missing.push("honeypot check unavailable");
    if (sellTax === null)        missing.push("sell tax unavailable");
    if (ownerRenounced === null) missing.push("owner renounced status unavailable");
    if (tokenAgeMins === null)   missing.push("token age unavailable");

    const sellability: GoPlusSafety["sellability"] =
      isHoneypot === true || cannotSell ? "FAIL" : isHoneypot === false ? "PASS" : "UNKNOWN";

    const taxRisk: GoPlusSafety["taxRisk"] =
      sellTax === null ? "UNKNOWN" : sellTax >= 20 ? "HIGH" : sellTax > 10 || (buyTax ?? 0) > 10 ? "MEDIUM" : "LOW";

    const ownerRisk: GoPlusSafety["ownerRisk"] =
      canMint || canPause || canTakeBackOwn || canChangeBalance ? "HIGH" :
      canChangeTax || canBlacklist || ownerRenounced === false  ? "MEDIUM" :
      ownerRenounced === true                                   ? "LOW" : "UNKNOWN";

    const agentVerdict: GoPlusSafety["agentVerdict"] =
      sellability === "FAIL" || (sellTax ?? 0) >= 20                           ? "BLOCK" :
      ownerRisk === "HIGH" || (sellTax ?? 0) > 10 || canMint || canPause       ? "HIGH_CAUTION" :
      sellability === "PASS" && taxRisk === "LOW"                               ? "OK_TO_INVESTIGATE" :
      "UNKNOWN_CHECK_MANUALLY";

    return {
      sellability, taxRisk, ownerRisk,
      isHoneypot, buyTaxPct: buyTax, sellTaxPct: sellTax,
      ownerRenounced, canChangeTax, canBlacklist, canMint,
      canPauseTrading: canPause, canChangeBalance, canTakeBackOwnership: canTakeBackOwn,
      tokenAgeMinutes: tokenAgeMins,
      agentVerdict, missingData: missing,
      cachedAt: Date.now(), source: "goplus",
    };
  } catch {
    return { ...GOPLUS_UNAVAILABLE, cachedAt: Date.now() };
  }
}

export async function getTokenSafety(
  rawTokenAddress: string,
  chain:           string,
): Promise<GoPlusSafety> {
  const r         = getRedis();
  const tokenAddr = cleanTokenAddress(rawTokenAddress);
  const chainId   = GOPLUS_CHAIN_IDS[chain] ?? null;

  if (!chainId) return { ...GOPLUS_UNAVAILABLE, missingData: [`Chain '${chain}' not supported`], cachedAt: Date.now() };

  const cacheKey = `supreme:token_safety:${chain}:${tokenAddr}`;
  if (r) {
    try {
      const cached = await r.get(cacheKey);
      if (cached) return { ...JSON.parse(cached) as GoPlusSafety, source: "cache" };
    } catch { /* cache miss */ }
  }

  const result = await fetchGoPlusSafety(tokenAddr, chainId);

  if (r && result.source === "goplus") {
    try { await r.set(cacheKey, JSON.stringify(result), "EX", 30 * 60); } catch { /* non-fatal */ }
  }

  return result;
}