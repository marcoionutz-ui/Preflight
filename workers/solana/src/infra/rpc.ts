/**
 * infra/rpc.ts
 * Solana RPC client minimal — Connection wrapper peste @solana/web3.js.
 *
 * Provider-agnostic: funcționează cu Alchemy, Helius, sau orice RPC standard.
 * URL configurat via SOLANA_RPC_URL (fallback HELIUS_RPC_URL / ALCHEMY_SOLANA_RPC_URL).
 * WS URL derivat automat din HTTP URL (https→wss), override cu SOLANA_WS_URL.
 */

import { Connection } from "@solana/web3.js";

let _connection: Connection | null = null;

/** Returnează URL-ul RPC din env vars, în ordinea de prioritate. */
export function getSolanaRpcUrl(): string {
  const url =
    process.env.SOLANA_RPC_URL ??
    process.env.HELIUS_RPC_URL ??
    process.env.ALCHEMY_SOLANA_RPC_URL;

  if (!url) {
    throw new Error(
      "Missing Solana RPC env: set SOLANA_RPC_URL, HELIUS_RPC_URL, or ALCHEMY_SOLANA_RPC_URL",
    );
  }

  return url;
}

/** Derivă WS URL din HTTP URL (https→wss, http→ws). Override cu SOLANA_WS_URL. */
export function getSolanaWsUrl(): string {
  if (process.env.SOLANA_WS_URL) return process.env.SOLANA_WS_URL;
  return getSolanaRpcUrl()
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://");
}

/** Singleton Connection cu WS endpoint pentru subscriptions. */
export function getConnection(): Connection {
  if (_connection) return _connection;
  _connection = new Connection(getSolanaRpcUrl(), {
    wsEndpoint: getSolanaWsUrl(),
    commitment:  "confirmed",
  });
  return _connection;
}

/** Slot curent confirmat pe mainnet. */
export async function getSlot(): Promise<number> {
  return getConnection().getSlot("confirmed");
}

/** Versiunea node-ului Solana (opțional — util la startup log). */
export async function getVersion(): Promise<string> {
  const v = await getConnection().getVersion();
  return v["solana-core"];
}
