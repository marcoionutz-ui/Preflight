/**
 * infra/rpc.ts
 * RPC client minimal pentru indexer-evm.
 *
 * Funcții expuse:
 *   getBlockNumber(rpcUrl, deps?)     — eth_blockNumber (validat: hex → număr finit ≥ 0)
 *   getLogs(rpcUrl, params, deps?)    — eth_getLogs (validat: array de log-uri bine-formate)
 *
 * Robustețe (fix audit production-readiness):
 *   - TIMEOUT per-încercare via AbortController (INDEXER_RPC_TIMEOUT_MS, default 15s).
 *     Chain-urile se procesează SECVENȚIAL în indexer → un request care atârnă la
 *     nesfârșit (RPC nu răspunde, socket rămas deschis) ar îngheța TOT indexerul.
 *     Timeout-ul mărginește fiecare încercare; total ≤ MAX_RETRIES × timeout + backoff.
 *   - VALIDARE de formă a răspunsului (leaf pur): envelope JSON-RPC + rezultatul tipat
 *     (blockNumber = hex valid → număr; getLogs = array de log-uri cu câmpurile
 *     load-bearing string). Un răspuns malformat → throw → retry → fail-closed
 *     (apelantul NU avansează pe garbage: parseInt(undefined)=NaN sau `.map` pe non-array).
 *
 * Retry: 3 încercări cu exponential backoff 1s / 2s.
 * Nu wrappează ethers.js — JSON-RPC direct via fetch pentru dependențe minime.
 */

export interface LogParams {
  fromBlock: string; // hex: "0x..."
  toBlock:   string; // hex: "0x..." sau "latest"
  address?:  string | string[];
  topics?:   (string | string[] | null)[];
}

export interface RpcLog {
  address:          string;
  topics:           string[];
  data:             string;
  blockNumber:      string;
  transactionHash:  string;
  transactionIndex: string;
  blockHash:        string;
  logIndex:         string;
  removed:          boolean;
}

/**
 * Dependențe injectabile pentru testare deterministă a timeout-ului + retry-ului
 * (fără rețea, fără așteptări reale). În producție toate au default-uri reale.
 */
export interface RpcDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

const MAX_RETRIES = 3;
// 2 backoff-uri între cele 3 încercări (ultima nu mai așteaptă) → fără element mort.
// Worst-case per-request pe un RPC căzut ≈ MAX_RETRIES × timeout + 1s + 2s; scade timeout-ul
// via INDEXER_RPC_TIMEOUT_MS dacă vrei o fereastră mai mică (chain-urile rulează secvențial).
const BACKOFF_MS  = [1_000, 2_000] as const;

/** Timeout per-încercare (ms). Configurable; un request care atârnă nu mai îngheață indexerul. */
export const DEFAULT_RPC_TIMEOUT_MS = intEnv("INDEXER_RPC_TIMEOUT_MS", 15_000);

// ─────────────── LEAF validators (pure, exportate, testabile fără rețea) ───────────────

/** Extrage `result` din envelope-ul JSON-RPC; throw pe `error` sau formă invalidă. */
export function extractRpcResult(json: unknown): unknown {
  if (typeof json !== "object" || json === null) {
    throw new Error("RPC: răspuns non-obiect");
  }
  const j = json as { result?: unknown; error?: unknown };
  if (j.error != null) {
    const msg =
      typeof j.error === "object" && j.error !== null && "message" in j.error
        ? String((j.error as { message: unknown }).message)
        : JSON.stringify(j.error);
    throw new Error(`RPC error: ${msg}`);
  }
  if (!("result" in j)) {
    throw new Error("RPC: răspuns fără câmp `result`");
  }
  return j.result;
}

const HEX_RE      = /^0x[0-9a-fA-F]+$/; // hex NON-vid: address / hash / quantity (blockNumber, logIndex…)
const HEX_DATA_RE = /^0x[0-9a-fA-F]*$/; // `data` poate fi "0x" (gol) pentru evenimente fără payload

/** Validează rezultatul eth_blockNumber (hex string) → număr decimal SIGUR (≤ MAX_SAFE_INTEGER) ≥ 0. */
export function parseBlockNumber(result: unknown): number {
  if (typeof result !== "string" || !HEX_RE.test(result)) {
    throw new Error(`eth_blockNumber: rezultat invalid (așteptat hex string), primit ${JSON.stringify(result)}`);
  }
  const n = parseInt(result, 16);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`eth_blockNumber: număr nesigur/negativ (peste MAX_SAFE_INTEGER?) din ${result}`);
  }
  return n;
}

/**
 * Type-guard COMPLET pentru un log eth_getLogs. Validează TOATE câmpurile din `RpcLog`
 * (nu doar cele „load-bearing") + formatul hex — un log fără `address`/`logIndex` a trecut
 * înainte, iar downstream `getFactoryByAddress(..., log.address).toLowerCase()` ar fi crăpat
 * fatal indexerul pe `undefined`. Fail-closed: orice câmp lipsă/greșit tipat → nu-i un log valid.
 */
export function isRpcLog(x: unknown): x is RpcLog {
  if (typeof x !== "object" || x === null) return false;
  const l = x as Record<string, unknown>;
  const hex = (v: unknown): boolean => typeof v === "string" && HEX_RE.test(v);
  return (
    hex(l.address) &&
    hex(l.blockNumber) &&
    hex(l.transactionHash) &&
    hex(l.transactionIndex) &&
    hex(l.blockHash) &&
    hex(l.logIndex) &&
    typeof l.data === "string" && HEX_DATA_RE.test(l.data) &&
    Array.isArray(l.topics) && (l.topics as unknown[]).every(t => typeof t === "string" && HEX_RE.test(t)) &&
    typeof l.removed === "boolean"
  );
}

/** Validează rezultatul eth_getLogs → array de log-uri; throw pe non-array sau element malformat. */
export function parseLogs(result: unknown): RpcLog[] {
  if (!Array.isArray(result)) {
    throw new Error(`eth_getLogs: rezultat non-array (${typeof result})`);
  }
  for (let i = 0; i < result.length; i++) {
    if (!isRpcLog(result[i])) {
      throw new Error(`eth_getLogs: log[${i}] malformat (câmpuri load-bearing lipsă/greșit tipate)`);
    }
  }
  return result as RpcLog[];
}

// ─────────────────────────────── transport ───────────────────────────────

async function rpcCall<T>(
  rpcUrl:  string,
  method:  string,
  params:  unknown[],
  parse:   (result: unknown) => T,
  deps:    RpcDeps = {},
): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const sleepImpl = deps.sleepImpl ?? sleep;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(rpcUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal:  controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const json   = (await res.json()) as unknown;
      const result = extractRpcResult(json); // envelope: throw pe error/formă
      return parse(result);                  // shape: throw pe rezultat malformat
    } catch (err) {
      // Un abort (timeout) e etichetat clar indiferent cum propagă runtime-ul reason-ul.
      lastErr = controller.signal.aborted
        ? new Error(`${method}: timeout după ${timeoutMs}ms`)
        : err instanceof Error ? err : new Error(String(err));

      if (attempt < MAX_RETRIES - 1) {
        const delay = BACKOFF_MS[attempt];
        console.warn(
          `[INDEXER][RPC] ${method} eșuat (încercarea ${attempt + 1}/${MAX_RETRIES}), retry în ${delay}ms: ${lastErr.message}`,
        );
        await sleepImpl(delay);
      }
    } finally {
      clearTimeout(timer); // nu lăsăm timer scurs pe calea de succes/eroare
    }
  }

  throw lastErr ?? new Error(`${method} eșuat după ${MAX_RETRIES} încercări`);
}

/** Returnează block number curent ca număr decimal (validat). */
export async function getBlockNumber(rpcUrl: string, deps?: RpcDeps): Promise<number> {
  return rpcCall(rpcUrl, "eth_blockNumber", [], parseBlockNumber, deps);
}

/** Returnează log-urile care matches params (validate: array de log-uri bine-formate). */
export async function getLogs(rpcUrl: string, params: LogParams, deps?: RpcDeps): Promise<RpcLog[]> {
  return rpcCall(rpcUrl, "eth_getLogs", [params], parseLogs, deps);
}

/** Convertește număr decimal în hex pentru RPC. */
export function toHex(n: number): string {
  return `0x${n.toString(16)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Numele env var pentru RPC URL al unui chain — util în mesaje de eroare. */
export function getRpcEnvName(chain: string): string {
  const map: Record<string, string> = {
    base:     "ALCHEMY_BASE_RPC",
    bsc:      "ALCHEMY_BNB_RPC",
    arbitrum: "ALCHEMY_ARB_RPC",
    ethereum: "ALCHEMY_ETH_RPC",
  };
  return map[chain.toLowerCase()] ?? `ALCHEMY_${chain.toUpperCase()}_RPC`;
}

/** Returnează RPC URL HTTP pentru un chain. Folosește aceleași env vars ca workerul EVM. */
export function getRpcUrl(chain: string): string {
  const map: Record<string, string | undefined> = {
    base:     process.env.ALCHEMY_BASE_RPC,
    bsc:      process.env.ALCHEMY_BNB_RPC,
    arbitrum: process.env.ALCHEMY_ARB_RPC,
    ethereum: process.env.ALCHEMY_ETH_RPC,
  };
  return map[chain.toLowerCase()] ?? "";
}
