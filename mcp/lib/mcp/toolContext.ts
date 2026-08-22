/**
 * lib/mcp/toolContext.ts — request context izolat per request (AsyncLocalStorage) + builder PUR din AuthResult.
 *
 * Extras din `middleware.ts` ca partea de context (fără importuri grele: doar `async_hooks` + type `QuotaSubject`)
 * să fie testabilă izolat în tsx. `middleware.ts` re-exportă tot de aici, deci caller-ii (`route.ts`,
 * `tp_watch_pair.ts`) nu-și schimbă importurile.
 */

import { AsyncLocalStorage } from "async_hooks";
import type { QuotaSubject } from "../db/quotaKey";

export interface ToolContext {
  clientId:     string;
  scopes:       string[];
  plan?:        string;
  // PH-2 (9b-wire): subiectul de quota, purtat NESCHIMBAT din `resolveAuth` (account pe user_id / client pe
  // client_id). Middleware-ul îl trece direct la `reserveQuota` — NU-l reconstruiește din clientId.
  quotaSubject: QuotaSubject;
}

/**
 * PH-2 (9b-wire): construiește `ToolContext` dintr-un `AuthResult` (câmpurile relevante). Subiectul EXPLICIT din
 * `resolveAuth` are prioritate; dacă lipsește (cale neașteptată), cade fail-closed pe subiect CLIENT din clientId
 * (comportamentul de azi), NU pe account tăcut. Pur → testabil izolat.
 */
export function buildToolContext(auth: { clientId: string; scopes: string[]; plan?: string; subject?: QuotaSubject }): ToolContext {
  const quotaSubject: QuotaSubject = auth.subject ?? { kind: "client", clientId: auth.clientId };
  return { clientId: auth.clientId, scopes: auth.scopes, plan: auth.plan, quotaSubject };
}

const contextStorage = new AsyncLocalStorage<ToolContext>();

/** Rulează fn în contextul requestului curent. Fiecare request are contextul lui izolat — thread-safe. */
export function withToolContext<T>(ctx: ToolContext, fn: () => T): T {
  return contextStorage.run(ctx, fn);
}

export function getToolContext(): ToolContext {
  return contextStorage.getStore() ?? { clientId: "unknown", scopes: [], quotaSubject: { kind: "client", clientId: "unknown" } };
}
