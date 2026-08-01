/**
 * lib/mcp/tools/pairAddressSchema.ts — E37 (bound Zod partajat pentru pair_address).
 *
 * `pair_address` avea doar `.min(10)` în tp_candidate_brief / tp_why_not / tp_late_move_context / tp_watch_pair
 * → fără `.max()` (bloat, nu injectabil — cheile Redis nu-l concatenează neverificat, confirmat la audit). tp_pair_context
 * și tp_preflight_safety aveau deja `.min(10).max(120)`.
 *
 * Fix: UN singur bound (10..120) folosit de tool-urile care primesc pair_address → nu poate drifta între ele.
 * `.describe(...)` rămâne per-tool (wording-ul diferă), deci se lanțuie: `pairAddressSchema.describe("...")`.
 */
import { z } from "zod";

/** Adresă pair/pool ca input de tool: 10..120 caractere (EVM 0x…, V4 pool ID, sau pool Solana base58). */
export const pairAddressSchema = z.string().min(10).max(120);
