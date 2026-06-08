/**
 * lib/db/oauth-codes.ts
 * Authorization codes — Redis, TTL 5 minute
 * Folosit în Authorization Code flow cu PKCE
 */

import { createHash, randomBytes } from "crypto";
import { getRedis }                from "./redis";

const CODE_TTL_SEC = 5 * 60; // 5 minute

export interface AuthCodePayload {
  client_id:             string;
  scopes:                string[];
  redirect_uri:          string;
  code_challenge:        string;
  code_challenge_method: string;
  issued_at:             number;
}

export async function issueAuthCode(payload: AuthCodePayload): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;

  const code = randomBytes(32).toString("hex");
  await r.set(`mcp:code:${code}`, JSON.stringify(payload), "EX", CODE_TTL_SEC);
  return code;
}

export async function consumeAuthCode(code: string): Promise<AuthCodePayload | null> {
  const r = getRedis();
  if (!r) return null;

  const raw = await r.getdel(`mcp:code:${code}`);
  if (!raw) return null;

  try { return JSON.parse(raw) as AuthCodePayload; }
  catch { return null; }
}

export function verifyCodeVerifier(verifier: string, challenge: string, method: string): boolean {
  if (method === "S256") {
    const computed = createHash("sha256")
      .update(verifier)
      .digest("base64url");
    return computed === challenge;
  }
  // plain (fallback)
  return verifier === challenge;
}
