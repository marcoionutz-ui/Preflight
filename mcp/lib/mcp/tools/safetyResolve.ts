/**
 * tools/safetyResolve.ts — P1-1: rezolvarea chain + token + symbol pentru tp_preflight_safety.
 *
 * Hărțile live (states/watch/hot/armed/snapshot.memory) sunt cheiate pe `pairKey(chain, addr)` (Faza B),
 * DAR `tp_preflight_safety` le indexa cu adresa BRUTĂ (`ctx.states[addr]`) → fiecare lookup rata → tool-ul
 * răspundea `UNKNOWN_RISK`/cerea `token_address` chiar când perechea exista în worker. Aici refolosim
 * `resolvePairChain` (exact ca celelalte tool-uri: tp_candidate_brief / tp_why_not / tp_late_move_context /
 * tp_position_context / tp_recent_pipeline_drops) ca să găsim cheia `pairKey` corectă, apoi citim de la ea.
 *
 * PUR (resolvePairChain + normalizeChainId) → testabil izolat cu hărți cheiate pe pairKey.
 */
import { resolvePairChain } from "../redis-reader";
import { normalizeChainId } from "@preflight/schema";

export interface SafetyMaps {
  // symbol e `string | null` în WatchEntry/HotEntry/MemoryEntry (worker) — tipăm la fel ca să nu forțăm
  // un cast la apelant; `resolveSafetyContext` tratează `null` ca lipsă (`?? addr.slice`).
  states: Record<string, { tokenAddress?: string | null; symbol?: string | null }>;
  watch:  Record<string, { symbol?: string | null }>;
  hot:    Record<string, { symbol?: string | null }>;
  armed:  Record<string, unknown>;
  memory: Record<string, { tokenAddress?: string | null; symbol?: string | null }>;
}

export interface SafetyResolution {
  rawTokenAddress: string | null;
  resolvedChain:   string | null;
  symbol:          string;
  ambiguousChains: string[];
}

/** Extrage prefixul de chain dintr-o adresă „base_0x…" (stil Gecko). Ex: "arbitrum_0xabc" → "arbitrum". */
export function deriveChainFromTokenAddress(raw: string): string | null {
  const match = raw.match(/^([a-z]+)_0x/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Rezolvă token address + chain + symbol pentru o adresă de pereche EVM, folosind cheia `pairKey`.
 * Priorități păstrate din tool: token = arg user > memory[pairKey] > states[pairKey];
 * chain = arg user (hint) > prefix din token address > chain dedus din hărți (probă pairKey pe chain-urile EVM).
 */
export function resolveSafetyContext(
  addr:            string,
  hint:            string | null,
  tokenAddressArg: string | null,
  m:               SafetyMaps,
): SafetyResolution {
  // P1-1: cheia corectă = pairKey. Cu hint → pairKey(hint, addr); fără hint → probează chain-urile EVM
  // în hărți și raportează ambiguitatea dacă adresa apare pe >1 chain (nu alegem tăcut primul).
  const resolved = resolvePairChain(addr, [m.states, m.watch, m.hot, m.armed, m.memory], hint);
  const key = resolved.key;

  // token: user-provided > memory[pairKey] > states[pairKey]
  let rawTokenAddress: string | null = tokenAddressArg ?? null;
  if (!rawTokenAddress && key) {
    rawTokenAddress = (m.memory[key]?.tokenAddress ?? m.states[key]?.tokenAddress) ?? null;
  }

  // chain: hint > prefix token > chain rezolvat din hărți
  let resolvedChain: string | null = hint ?? null;
  if (!resolvedChain && rawTokenAddress) resolvedChain = deriveChainFromTokenAddress(rawTokenAddress);
  if (!resolvedChain) resolvedChain = resolved.chain;
  if (resolvedChain) resolvedChain = normalizeChainId(resolvedChain);

  // symbol: memory > hot > watch (pe pairKey); fallback la prefixul adresei
  const symbol = (key ? (m.memory[key]?.symbol ?? m.hot[key]?.symbol ?? m.watch[key]?.symbol) : undefined)
    ?? addr.slice(0, 10);

  return { rawTokenAddress, resolvedChain, symbol, ambiguousChains: resolved.ambiguousChains };
}
