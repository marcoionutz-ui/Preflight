/**
 * infra/parseMintDecimals.ts
 * A3: validare + extragere `decimals` pentru un mint Solana. Funcții PURE
 * (fără web3/redis) — testabile izolat. Fail-closed peste tot.
 */

/**
 * Decimals SUPORTATE de Preflight: integer 0-18.
 * (Solana `Mint.decimals` e u8 — protocolul permite tehnic >18; 0-18 e limita de
 * suport Preflight, nu a protocolului. Tokenurile peste 18 sunt OMISE — snapshot
 * sărit — nu calculate greșit.)
 */
export function isSupportedDecimals(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 18;
}

/**
 * Extrage `decimals` dintr-un `getParsedAccountInfo().value.data` de mint SPL /
 * Token-2022. Returnează null dacă data nu e un mint parsat valid.
 */
export function parseMintDecimals(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;

  const parsed = (data as { parsed?: unknown }).parsed;
  if (!parsed || typeof parsed !== "object") return null;

  // getParsedAccountInfo întoarce type:"mint" pentru mint accounts (SPL + Token-2022).
  if ((parsed as { type?: unknown }).type !== "mint") return null;

  const info = (parsed as { info?: unknown }).info;
  if (!info || typeof info !== "object") return null;

  const dec = (info as { decimals?: unknown }).decimals;
  return isSupportedDecimals(dec) ? dec : null;
}

/**
 * Validează un decimals citit din cache Redis. Strict: string pur numeric
 * (fără "6junk"/"-1"/spații) + range 0-18. Un cache corupt/manual vechi nu
 * mai poate reintroduce date greșite în calculul prețului.
 */
export function parseCachedDecimals(raw: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const n = Number(raw);
  return isSupportedDecimals(n) ? n : null;
}
