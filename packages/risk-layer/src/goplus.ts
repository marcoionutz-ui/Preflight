/**
 * @preflight/risk-layer — goplus.ts
 * Fetch raw GoPlus data + normalizare minimă.
 * Stateless — fără Redis, fără cache.
 * Cache-ul e responsabilitatea workerului.
 */

import type { RiskResult } from "./types";
import { GOPLUS_CHAIN_IDS } from "./types";
import { parseTaxPct, isTransientGoPlusStatus } from "./goplusParse";

const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const TIMEOUT_MS  = 8_000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface GoPlusFetchOpts {
  fetchImpl?:   typeof fetch;
  maxAttempts?: number;
  retryBaseMs?: number;
  timeoutMs?:   number;
}

/**
 * E29: fetch GoPlus cu 1 retry pe erori tranzitorii. 429/5xx (isTransientGoPlusStatus) și erorile de
 * network/timeout se reîncearcă cu backoff; 4xx permanente (adresă invalidă, chain nesuportat) se întorc imediat.
 * Fiecare încercare are propriul AbortController + timeout de TIMEOUT_MS. `opts` (fetchImpl/maxAttempts/retryBaseMs)
 * e injectabil pentru teste; producția folosește default-urile (fetch global, 2 încercări, backoff 500ms).
 */
export async function goPlusFetchWithRetry(
  url:     string,
  headers: Record<string, string>,
  opts:    GoPlusFetchOpts = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  // Clamp defensiv: valori invalide (0/NaN/negativ) cad pe default. maxAttempts trebuie ≥ 1 ca loop-ul să
  // ruleze cel puțin o dată — altfel s-ar ajunge la `return lastRes as Response` cu lastRes undefined.
  const maxAttempts = Number.isFinite(opts.maxAttempts) && (opts.maxAttempts as number) >= 1
    ? Math.floor(opts.maxAttempts as number) : 2;
  const retryBaseMs = Number.isFinite(opts.retryBaseMs) && (opts.retryBaseMs as number) >= 0
    ? (opts.retryBaseMs as number) : 500;
  const timeoutMs   = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs as number) > 0
    ? (opts.timeoutMs as number) : TIMEOUT_MS;
  let lastRes: Response | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers });
      clearTimeout(t);
      if (!res.ok && isTransientGoPlusStatus(res.status) && attempt < maxAttempts) {
        lastRes = res;
        await sleep(retryBaseMs * attempt);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(t);
      if (attempt < maxAttempts) {
        await sleep(retryBaseMs * attempt);
        continue;
      }
      throw err;
    }
  }
  // Ultima încercare returnează mereu `res` direct (retry-ul e gated pe attempt < maxAttempts) → linia asta e
  // practic inaccesibilă; există doar pentru completitudinea de tip.
  return lastRes as Response;
}

// fix ChatGPT: null = unknown, nu false = safe
function parseBool01(v: unknown): boolean | null {
  if (v === "1" || v === 1 || v === true)  return true;
  if (v === "0" || v === 0 || v === false) return false;
  return null;
}

export const RISK_UNAVAILABLE: RiskResult = {
  chain:        "unknown",
  tokenAddress: "unknown",
  checkedAt:    0,
  source:       "unavailable",
  riskLevel:    "UNKNOWN",
  confidence:   "LOW",
  flags:        ["UNKNOWN_RISK"],
  summary:      "GoPlus API unavailable — check manually",
  isHoneypot:           null,
  buyTaxPct:            null,
  sellTaxPct:           null,
  cannotSell:           null,
  ownerRenounced:       null,
  canChangeTax:         null,
  canBlacklist:         null,
  canMint:              null,
  canPauseTrading:      null,
  canChangeBalance:     null,
  canTakeBackOwnership: null,
  tokenAgeMinutes:      null,
  missingData:          ["GoPlus API unavailable"],
};

// V4 poolId = bytes32 (66 chars: 0x + 64 hex) — NOT an EVM token contract address
const BYTES32_RE    = /^0x[a-f0-9]{64}$/i;
const EVM_ADDR_RE   = /^0x[a-f0-9]{40}$/i;

export async function fetchGoPlusRaw(
  tokenAddress: string,
  chain:        string,
  apiKey?:      string,
): Promise<RiskResult> {
  // fix ChatGPT: normalize o dată, folosit peste tot inclusiv în error returns
  const token    = tokenAddress.toLowerCase();
  const chainKey = chain.toLowerCase();

  // V4 poolId guard — bytes32 nu e un token contract address
  if (BYTES32_RE.test(token)) {
    return {
      ...RISK_UNAVAILABLE,
      chain: chainKey, tokenAddress: token, checkedAt: Date.now(),
      summary:     "V4 poolId detected — not an EVM token contract address. Pass the base token address for safety check.",
      missingData: ["V4 poolId (bytes32) cannot be checked with GoPlus — use token address from indexed pair metadata"],
    };
  }

  // Sanity check — rejectăm orice nu e 20-byte EVM address
  if (!EVM_ADDR_RE.test(token)) {
    return {
      ...RISK_UNAVAILABLE,
      chain: chainKey, tokenAddress: token, checkedAt: Date.now(),
      summary:     "Invalid EVM token address format — expected 0x + 40 hex chars",
      missingData: ["Invalid token address format"],
    };
  }

  const chainId  = GOPLUS_CHAIN_IDS[chainKey];
  if (!chainId) {
    return {
      ...RISK_UNAVAILABLE,
      chain: chainKey, tokenAddress: token, checkedAt: Date.now(),
      summary:     `Chain '${chainKey}' not supported by GoPlus`,
      missingData: [`Chain '${chainKey}' not in GOPLUS_CHAIN_IDS`],
    };
  }

  const url  = `${GOPLUS_BASE}/token_security/${chainId}?contract_addresses=${token}`;

  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    // E29: 1 retry cu backoff pe 429/5xx + network/timeout (vezi goPlusFetchWithRetry).
    const res = await goPlusFetchWithRetry(url, headers);

    if (!res.ok) {
      return {
        ...RISK_UNAVAILABLE,
        chain: chainKey, tokenAddress: token, checkedAt: Date.now(),
        summary:     `GoPlus HTTP ${res.status}`,
        missingData: [`GoPlus HTTP error: ${res.status}`],
      };
    }

    const json = await res.json() as { result?: Record<string, unknown> };
    const raw  = (
      json?.result?.[token] ??
      null
    ) as Record<string, unknown> | null;

    if (!raw) {
      return {
        ...RISK_UNAVAILABLE,
        chain: chainKey, tokenAddress: token, checkedAt: Date.now(),
        summary:     "GoPlus returned no data for this token",
        missingData: ["No data in GoPlus response"],
      };
    }

    const ZERO = "0x0000000000000000000000000000000000000000";
    const DEAD = "0x000000000000000000000000000000000000dead";

    const isHoneypot   = parseBool01(raw.is_honeypot);
    const cannotSell   = parseBool01(raw.cannot_sell_all);
    const buyTax       = parseTaxPct(raw.buy_tax);
    const sellTax      = parseTaxPct(raw.sell_tax);

    // fix ChatGPT: empty string => null, nu OWNER_NOT_RENOUNCED pe date goale
    const ownerRaw  = typeof raw.owner_address === "string"
      ? raw.owner_address.trim().toLowerCase()
      : "";
    const ownerAddr = ownerRaw.length > 0 ? ownerRaw : null;
    const ownerRenounced =
      ownerAddr === ZERO || ownerAddr === DEAD ? true :
      ownerAddr !== null                        ? false : null;

    // fix ChatGPT: parseBool01 pentru toate owner controls
    const canMint              = parseBool01(raw.is_mintable);
    const canBlacklist         = parseBool01(raw.is_blacklisted);
    const canPauseTrading      = parseBool01(raw.trading_pausable);
    const canChangeBalance     = parseBool01(raw.owner_change_balance);
    const canTakeBackOwnership = parseBool01(raw.can_take_back_ownership);

    // canChangeTax: true doar dacă cel puțin unul e true; false doar dacă ambele sunt false; altfel null
    const slipMod = parseBool01(raw.slippage_modifiable);
    const persMod = parseBool01(raw.personal_slippage_modifiable);
    const canChangeTax: boolean | null =
      slipMod === true || persMod === true ? true :
      slipMod === false && persMod === false ? false :
      null;

    // fix ChatGPT: tokenAgeMinutes NaN-safe
    const ageNum = raw.token_age_in_minutes != null
      ? Number(raw.token_age_in_minutes)
      : NaN;
    const tokenAgeMinutes = Number.isFinite(ageNum) ? Math.round(ageNum) : null;

    // fix ChatGPT: missingData include buyTax + cannotSell
    const missingData: string[] = [];
    if (isHoneypot === null)           missingData.push("honeypot check unavailable");
    if (cannotSell === null)           missingData.push("sellability check unavailable");
    if (buyTax === null)               missingData.push("buy tax unavailable");
    if (sellTax === null)              missingData.push("sell tax unavailable");
    if (ownerRenounced === null)       missingData.push("owner renounced status unavailable");
    if (tokenAgeMinutes === null)      missingData.push("token age unavailable");
    if (canMint === null)              missingData.push("mint permission unavailable");
    if (canBlacklist === null)         missingData.push("blacklist status unavailable");
    if (canPauseTrading === null)      missingData.push("pause trading status unavailable");
    if (canChangeTax === null)         missingData.push("tax modification status unavailable");
    if (canChangeBalance === null)     missingData.push("balance modification status unavailable");
    if (canTakeBackOwnership === null) missingData.push("ownership reclaim status unavailable");

    return {
      chain:        chainKey,
      tokenAddress: token,
      checkedAt:   Date.now(),
      source:      "goplus",
      riskLevel:   "UNKNOWN", // classify.ts va seta asta
      confidence:  "LOW",     // classify.ts va seta asta
      flags:       [],        // classify.ts va seta asta
      summary:     "",        // classify.ts va seta asta
      isHoneypot,
      buyTaxPct:   buyTax,
      sellTaxPct:  sellTax,
      cannotSell,
      ownerRenounced,
      canChangeTax,
      canBlacklist,
      canMint,
      canPauseTrading,
      canChangeBalance,
      canTakeBackOwnership,
      tokenAgeMinutes,
      missingData,
      raw,
    };
  } catch (err) {
    return {
      ...RISK_UNAVAILABLE,
      chain: chainKey, tokenAddress: token, checkedAt: Date.now(),
      summary:     err instanceof Error ? err.message : "GoPlus fetch failed",
      missingData: ["GoPlus fetch error"],
    };
  }
}