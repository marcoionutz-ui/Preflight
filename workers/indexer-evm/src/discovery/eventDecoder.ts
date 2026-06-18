/**
 * discovery/eventDecoder.ts
 * Decodes raw eth_getLogs entries into typed DecodedPair objects.
 *
 * Adapters supported:
 *   UNISWAP_V2 / PANCAKE_V2 / CAMELOT — PairCreated(address,address,address,uint256)
 *   AERODROME                          — PairCreated(address,address,bool,address,uint256)
 *   UNISWAP_V3 / PANCAKE_V3            — PoolCreated(address,address,uint24,int24,address)
 *
 * Decoding via raw ABI rules (32-byte slots) — no ethers.js.
 * Returns null on any malformed input; caller skips nulls.
 */

import type { RpcLog } from "../infra/rpc";
import type { AdapterType } from "../config/factories";

export interface DecodedPair {
  token0:      string;  // lowercase hex, e.g. "0xabc..."
  token1:      string;  // lowercase hex
  pairAddress: string;  // lowercase hex
  fee?:        number;  // V3 only — e.g. 500, 3000, 10000
  stable?:     boolean; // Aerodrome only
  blockNumber: number;
  txHash:      string;
  logIndex:    number;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ── ABI slot helpers ──────────────────────────────────────────────────────────

/**
 * Extracts the nth 32-byte slot from ABI-encoded data.
 * @param data  hex string with or without "0x" prefix
 * @param index 0-based slot index
 * @returns 64 hex chars (no prefix)
 */
function getSlot(data: string, index: number): string {
  const raw = data.startsWith("0x") ? data.slice(2) : data;
  return raw.slice(index * 64, (index + 1) * 64);
}

/**
 * Decodes a 20-byte address from a 32-byte ABI slot.
 * Input: 64 hex chars (no 0x). Address is right-aligned (last 40 chars).
 */
function slotToAddress(hex64: string): string {
  return ("0x" + hex64.slice(24)).toLowerCase();
}

/**
 * Decodes a bool from a 32-byte ABI slot.
 * ABI encoding: uint8, right-aligned — non-zero last byte = true.
 */
function slotToBool(hex64: string): boolean {
  return hex64.slice(-2) !== "00";
}

/**
 * Decodes a uint/int from a 32-byte ABI slot.
 * Safe for uint24 (fee) — NOT for uint256 (would overflow JS number).
 */
function slotToUint(hex64: string): number {
  return parseInt(hex64, 16);
}

// ── Validation ────────────────────────────────────────────────────────────────

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(addr) && addr !== ZERO_ADDRESS;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Decodes a raw log entry into a DecodedPair.
 * Returns null if the adapter is unknown, topics/data are missing, or decoding throws.
 */
export function decodeLog(log: RpcLog, adapter: AdapterType): DecodedPair | null {
  try {
    const blockNumber = parseInt(log.blockNumber, 16);
    const logIndex    = parseInt(log.logIndex,    16);
    const txHash      = log.transactionHash.toLowerCase();

    // token0 and token1 are always indexed → topics[1] and topics[2]
    if (!log.topics[1] || !log.topics[2]) return null;
    const token0 = slotToAddress(log.topics[1].slice(2));
    const token1 = slotToAddress(log.topics[2].slice(2));

    switch (adapter) {
      case "UNISWAP_V2":
      case "PANCAKE_V2":
      case "CAMELOT": {
        // PairCreated(address indexed token0, address indexed token1, address pair, uint allPairs)
        // data: [pair: address][allPairs: uint256]
        const pairAddress = slotToAddress(getSlot(log.data, 0));
        return { token0, token1, pairAddress, blockNumber, txHash, logIndex };
      }

      case "AERODROME": {
        // PairCreated(address indexed token0, address indexed token1, bool stable, address pair, uint)
        // data: [stable: bool][pair: address][allPairs: uint256]
        const stable      = slotToBool(getSlot(log.data, 0));
        const pairAddress = slotToAddress(getSlot(log.data, 1));
        return { token0, token1, pairAddress, stable, blockNumber, txHash, logIndex };
      }

      case "UNISWAP_V3":
      case "PANCAKE_V3": {
        // PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
        // topics[3] = fee (indexed uint24)
        // data: [tickSpacing: int24][pool: address]
        if (!log.topics[3]) return null;
        const fee         = slotToUint(log.topics[3].slice(2));
        const pairAddress = slotToAddress(getSlot(log.data, 1));
        return { token0, token1, pairAddress, fee, blockNumber, txHash, logIndex };
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Validates a decoded pair for obvious corruption:
 * - no zero addresses
 * - token0 ≠ token1
 * - pairAddress ≠ either token
 */
export function sanityCheck(pair: DecodedPair): boolean {
  return (
    isValidAddress(pair.token0) &&
    isValidAddress(pair.token1) &&
    isValidAddress(pair.pairAddress) &&
    pair.token0 !== pair.token1 &&
    pair.pairAddress !== pair.token0 &&
    pair.pairAddress !== pair.token1
  );
}
