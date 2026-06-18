/**
 * infra/rpc.ts
 * RPC client minimal pentru indexer-evm.
 *
 * Funcții expuse:
 *   getBlockNumber(rpcUrl)            — eth_blockNumber
 *   getLogs(rpcUrl, params)           — eth_getLogs
 *
 * Retry: 3 încercări cu exponential backoff 1s / 2s / 4s.
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

const MAX_RETRIES = 3;
const BACKOFF_MS  = [1_000, 2_000, 4_000] as const;

async function rpcCall<T>(
  rpcUrl:  string,
  method:  string,
  params:  unknown[],
): Promise<T> {
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(rpcUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          jsonrpc: "2.0",
          id:      1,
          method,
          params,
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const json = (await res.json()) as { result?: T; error?: { message: string } };

      if (json.error) {
        throw new Error(`RPC error: ${json.error.message}`);
      }

      return json.result as T;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));

      if (attempt < MAX_RETRIES - 1) {
        const delay = BACKOFF_MS[attempt];
        console.warn(
          `[INDEXER][RPC] ${method} failed (attempt ${attempt + 1}/${MAX_RETRIES}), retry in ${delay}ms: ${lastErr.message}`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastErr ?? new Error(`${method} failed after ${MAX_RETRIES} attempts`);
}

/** Returnează block number curent ca număr decimal. */
export async function getBlockNumber(rpcUrl: string): Promise<number> {
  const hex = await rpcCall<string>(rpcUrl, "eth_blockNumber", []);
  return parseInt(hex, 16);
}

/** Returnează log-urile care matches params. */
export async function getLogs(
  rpcUrl: string,
  params: LogParams,
): Promise<RpcLog[]> {
  return rpcCall<RpcLog[]>(rpcUrl, "eth_getLogs", [params]);
}

/** Convertește număr decimal în hex pentru RPC. */
export function toHex(n: number): string {
  return `0x${n.toString(16)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Numele env var pentru RPC URL al unui chain — util în mesaje de eroare. */
export function getRpcEnvName(chain: string): string {
  const map: Record<string, string> = {
    base:     "ALCHEMY_BASE_RPC",
    bsc:      "ALCHEMY_BNB_RPC",
    arbitrum: "ALCHEMY_ARB_RPC",
  };
  return map[chain.toLowerCase()] ?? `ALCHEMY_${chain.toUpperCase()}_RPC`;
}

/** Returnează RPC URL HTTP pentru un chain. Folosește aceleași env vars ca workerul EVM. */
export function getRpcUrl(chain: string): string {
  const map: Record<string, string | undefined> = {
    base:     process.env.ALCHEMY_BASE_RPC,
    bsc:      process.env.ALCHEMY_BNB_RPC,
    arbitrum: process.env.ALCHEMY_ARB_RPC,
  };
  return map[chain.toLowerCase()] ?? "";
}
