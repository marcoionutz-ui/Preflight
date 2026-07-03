/**
 * config/env.ts
 * Shared environment helpers pentru indexer-evm.
 */

/**
 * Citește o variabilă de mediu ca număr întreg pozitiv.
 * Returnează fallback dacă variabila lipsește sau nu e un număr valid.
 */
export function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
