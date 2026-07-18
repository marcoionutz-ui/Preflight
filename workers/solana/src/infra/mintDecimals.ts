/**
 * infra/mintDecimals.ts
 * A3: rezolvă decimalele unui mint AUTORITATIV (imutabile on-chain).
 *
 * Ordine: KNOWN (quote stabile) → cache Redis (TTL lung, validat strict) → mint
 * account via RPC (getParsedAccountInfo). Returnează null dacă nu se pot
 * determina — caller-ul TREBUIE să sară snapshot-ul, NU să asume 9 (pump.fun
 * folosește 6 → preț 1000× greșit + movers fabricați).
 *
 * Decimalele nu se schimbă niciodată pentru un mint → cache lung + dedupe
 * in-flight (același mint cerut de N pool-uri = un singur RPC) + cooldown scurt
 * pe eșec (nu spama RPC pe mint-uri problematice la fiecare swap).
 */

import { PublicKey }        from "@solana/web3.js";
import { getConnection }    from "./rpc";
import { getRedis }         from "./redis";
import { KEY_MINT_DECIMALS, MINT_DECIMALS_TTL_SEC } from "../config/constants";
import { WSOL_MINT, USDC_MINT, USDT_MINT }          from "../config/programs";
import { parseMintDecimals, parseCachedDecimals }   from "./parseMintDecimals";

// Quote-uri stabile — decimale hardcodate verificate, fără RPC.
const KNOWN: Record<string, number> = {
  [WSOL_MINT]: 9,
  [USDC_MINT]: 6,
  [USDT_MINT]: 6,
};

const FAILURE_COOLDOWN_MS = 60_000;

// same mint cerut de N pool-uri simultan = un singur RPC
const inFlight = new Map<string, Promise<number | null>>();
// mint-uri care au eșuat recent — nu reîncercăm până expiră cooldown-ul
const failedUntil = new Map<string, number>();

// Curățare periodică a intrărilor expirate din failedUntil — altfel un mint
// invalid nemaiîntâlnit rămâne în map după expirarea cooldown-ului (leak lent).
let nextFailurePruneAt = 0;
function pruneExpiredFailures(now: number): void {
  if (now < nextFailurePruneAt) return;
  for (const [mint, until] of failedUntil) {
    if (until <= now) failedUntil.delete(mint);
  }
  nextFailurePruneAt = now + FAILURE_COOLDOWN_MS;
}

export async function resolveMintDecimals(mint: string): Promise<number | null> {
  const known = KNOWN[mint];
  if (known !== undefined) return known;

  const redis = getRedis();

  // Cache Redis (imutabil → TTL lung), validat strict
  try {
    const cached = await redis.get(KEY_MINT_DECIMALS(mint));
    if (cached !== null) {
      const n = parseCachedDecimals(cached);
      if (n !== null) return n;
      // valoare coruptă (cache manual/vechi) → șterge, best-effort
      redis.del(KEY_MINT_DECIMALS(mint)).catch(() => { /* non-critical */ });
    }
  } catch { /* redis miss — continuăm la RPC */ }

  // Cooldown negativ — in-flight dedupe acoperă doar apeluri simultane, nu succesive
  const now = Date.now();
  pruneExpiredFailures(now);
  if ((failedUntil.get(mint) ?? 0) > now) return null;

  const existing = inFlight.get(mint);
  if (existing) return existing;

  const promise = (async (): Promise<number | null> => {
    try {
      const info = await getConnection().getParsedAccountInfo(new PublicKey(mint));
      const dec  = parseMintDecimals(info.value?.data);
      if (dec !== null) {
        failedUntil.delete(mint);
        try {
          await redis.set(KEY_MINT_DECIMALS(mint), String(dec), "EX", MINT_DECIMALS_TTL_SEC);
        } catch { /* write non-critical */ }
        return dec;
      }
      // account găsit dar nu e mint valid → cooldown
      failedUntil.set(mint, Date.now() + FAILURE_COOLDOWN_MS);
      return null;
    } catch (err) {
      failedUntil.set(mint, Date.now() + FAILURE_COOLDOWN_MS);
      console.warn(
        "[SOLANA][DECIMALS] fetch error mint=" + mint.slice(0, 8) + ":",
        (err as Error).message,
      );
      return null;
    } finally {
      inFlight.delete(mint);
    }
  })();

  inFlight.set(mint, promise);
  return promise;
}
