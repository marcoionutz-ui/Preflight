/**
 * infra/redactUrl.ts — E30 (redactare RPC/WS URL în loguri).
 *
 * Frunză PURĂ (doar WHATWG `URL` builtin, zero importuri) → testabilă în tsx.
 *
 * Bug: `index.ts` loga `getSolanaRpcUrl().slice(0, 50) + "..."`. Cheia API a providerului trăiește ÎN URL —
 * Helius `?api-key=<KEY>` (query), QuickNode `/<token>/` (path), Alchemy `/v2/<key>` (path), sau basic-auth
 * `https://user:<KEY>@host` (userinfo) → primele 50 de caractere pot include cheia (host scurt) = cheie SCURSĂ în loguri.
 *
 * Fix: loghează DOAR `host`-ul (hostname + port, doar dacă portul e non-default). `URL.host` NU conține niciodată
 * query, path, fragment sau userinfo → nicio cheie. Am ales `host` (nu doar `hostname`) fiindcă portul non-default
 * e util la debug și NU e secret; pt. providerii standard (443/wss) `host === hostname`. Pe URL neparsabil întoarce
 * un placeholder — NICIODATĂ string-ul brut (care ar putea conține cheia).
 */
export function redactRpcUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<unparseable-url>";
  }
}
