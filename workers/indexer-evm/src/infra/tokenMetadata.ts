/**
 * infra/tokenMetadata.ts
 * Fetch + cache ERC-20 token metadata via raw eth_call.
 * Nu folosește ethers.js — ABI decoded manual din hex brut.
 *
 * Selectors:
 *   symbol()   = 0x95d89b41  → string (ABI dynamic) sau bytes32 (legacy, e.g. MKR)
 *   decimals() = 0x313ce567  → uint8/uint256 (ultima byte = valoarea)
 *
 * Redis cache:
 *   key: preflight:indexed:token:{chain}:{tokenAddress}
 *   TTL: 7 zile pentru OK/PARTIAL, 1 oră pentru FAILED (retry mai rapid la RPC hiccup)
 *
 * Metadata failure nu aruncă erori spre caller.
 */

import { getRedis } from "./redis";
import { intEnv } from "../config/env";

// ── Native currency (V4) ──────────────────────────────────────────────────────

/**
 * V4 pools can use native currency (ETH/BNB) as address(0).
 * No eth_call possible — return hardcoded metadata immediately.
 */
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

// ── Selectors ─────────────────────────────────────────────────────────────────

const SEL_SYMBOL   = "0x95d89b41";
const SEL_DECIMALS = "0x313ce567";

// ── TTLs ──────────────────────────────────────────────────────────────────────

const TTL_OK     = 7 * 24 * 3600; // 7 zile — metadata stabilă
const TTL_FAILED = 3_600;          // 1 oră — retry la RPC hiccup

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IndexedTokenMeta {
  chain:        string;
  tokenAddress: string;
  symbol:       string | null;
  decimals:     number | null;
  status:       "OK" | "PARTIAL" | "FAILED";
  fetchedAt:    number;
  error?:       string;
}

// ── Redis key ─────────────────────────────────────────────────────────────────

function metaKey(chain: string, token: string): string {
  return `preflight:indexed:token:${chain.toLowerCase()}:${token.toLowerCase()}`;
}

// ── ABI decode helpers ────────────────────────────────────────────────────────

/**
 * Decode symbol() response.
 * Handles two encodings:
 *   - ABI dynamic string: offset(32b) + length(32b) + data
 *   - bytes32 legacy (e.g. MKR, SNX): exactly 32 bytes, right-padded with zeros
 */
function decodeSymbol(hex: string): string | null {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!raw || raw === "0".repeat(raw.length)) return null;

  // bytes32 format: exactly 32 bytes (64 hex chars)
  if (raw.length === 64) {
    try {
      const buf = Buffer.from(raw, "hex");
      const end = buf.indexOf(0); // first null byte
      const str = buf.slice(0, end === -1 ? buf.length : end).toString("utf8").trim();
      return str || null;
    } catch {
      return null;
    }
  }

  // ABI dynamic string: [offset 32b][length 32b][data...]
  if (raw.length >= 128) {
    try {
      const len = parseInt(raw.slice(64, 128), 16);
      if (len === 0 || len > 512) return null; // sanity — symbol nu are 512+ chars
      const strHex = raw.slice(128, 128 + len * 2);
      const str    = Buffer.from(strHex, "hex").toString("utf8").trim();
      return str || null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Decode decimals() response.
 * Returns the last byte of the 32-byte word as uint8 (valid range: 0–255).
 */
function decodeDecimals(hex: string): number | null {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!raw) return null;
  try {
    // decimals() returns uint8 ABI-encoded as uint256 — value is in last 2 hex chars
    const val = parseInt(raw.slice(-2), 16);
    return val >= 0 && val <= 255 ? val : null;
  } catch {
    return null;
  }
}

// ── eth_call (single attempt, timeout-guarded) ────────────────────────────────

const METADATA_TIMEOUT_MS = intEnv("INDEXER_METADATA_RPC_TIMEOUT_MS", 4_000);

async function ethCall(
  rpcUrl: string,
  to:     string,
  data:   string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);

  try {
    const res = await fetch(rpcUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        jsonrpc: "2.0",
        id:      1,
        method:  "eth_call",
        params:  [{ to, data }, "latest"],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string; error?: unknown };
    if (json.error || !json.result || json.result === "0x") return null;
    return json.result;
  } catch {
    // Covers AbortError (timeout) + network errors — both return null, never throw
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch token metadata via eth_call and cache in Redis.
 * Checks Redis cache first — skips fetch if already cached.
 * Never throws — returns status="FAILED" on any error.
 */
export async function fetchAndCacheTokenMetadata(
  rpcUrl:       string,
  chain:        string,
  tokenAddress: string,
): Promise<IndexedTokenMeta> {
  const addr = tokenAddress.toLowerCase();

  // Native currency guard (V4 — address(0) = ETH/BNB, no eth_call needed)
  if (addr === NATIVE_ADDRESS) {
    const symbol = chain.toLowerCase() === "bsc" ? "BNB" : "ETH";
    return { chain, tokenAddress: addr, symbol, decimals: 18, status: "OK", fetchedAt: Date.now() };
  }

  const r   = getRedis();
  const now = Date.now();

  // Cache check
  if (r) {
    try {
      const cached = await r.get(metaKey(chain, addr));
      if (cached) return JSON.parse(cached) as IndexedTokenMeta;
    } catch {
      // cache miss — proceed to fetch
    }
  }

  // Fetch symbol + decimals in parallel (single attempt each)
  const [symbolRaw, decimalsRaw] = await Promise.all([
    ethCall(rpcUrl, addr, SEL_SYMBOL),
    ethCall(rpcUrl, addr, SEL_DECIMALS),
  ]);

  const symbol   = symbolRaw   ? decodeSymbol(symbolRaw)     : null;
  const decimals = decimalsRaw ? decodeDecimals(decimalsRaw) : null;

  const status: IndexedTokenMeta["status"] =
    symbol !== null && decimals !== null ? "OK"      :
    symbol !== null || decimals !== null ? "PARTIAL" :
    "FAILED";

  const meta: IndexedTokenMeta = {
    chain,
    tokenAddress: addr,
    symbol,
    decimals,
    status,
    fetchedAt: now,
    ...(status === "FAILED" ? { error: "eth_call returned null for both symbol and decimals" } : {}),
  };

  // Cache with status-appropriate TTL
  if (r) {
    try {
      const ttl = status === "FAILED" ? TTL_FAILED : TTL_OK;
      await r.set(metaKey(chain, addr), JSON.stringify(meta), "EX", ttl);
    } catch {
      // cache write failure — not critical, next call will re-fetch
    }
  }

  return meta;
}

/** Read cached metadata only — returns null if not cached or Redis unavailable. */
export async function getCachedTokenMetadata(
  chain:        string,
  tokenAddress: string,
): Promise<IndexedTokenMeta | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(metaKey(chain, tokenAddress.toLowerCase()));
    return raw ? (JSON.parse(raw) as IndexedTokenMeta) : null;
  } catch {
    return null;
  }
}
