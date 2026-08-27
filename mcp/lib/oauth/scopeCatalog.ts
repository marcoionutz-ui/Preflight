/**
 * lib/oauth/scopeCatalog.ts — PH-2 (catalogul CONCRET de scope-uri oferite de server, sursă UNICĂ, PUR).
 *
 * `SERVER_SCOPE_CATALOG` = mulțimea EXHAUSTIVĂ de scope-uri pe care resource server-ul le oferă. E `serverPolicy` din
 * `resolveGrantedScopes` (emiterea grantului la /authorize) și `clampScopes` (rotația refresh-ului, 10.5b). ATENȚIE —
 * ambele consultă catalogul prin APARTENENȚĂ CONCRETĂ (`new Set(serverPolicy).has(scope)`), FĂRĂ semantică wildcard:
 * `read:all` acoperă alte scope-uri DOAR pe partea de entitlement (contul), nu aici. Deci fiecare scope granular pe care
 * un tool îl poate cere TREBUIE listat explicit; o listă prea scurtă clamp-ează scope-uri legitime la GOL (→ reject la
 * refresh / grant emis fără ele), tăcut. `read:ghost` și `read:secret_not_in_policy` sunt EXCLUSIV fixture-uri negative
 * de test — deliberat ABSENTE din catalog.
 *
 * SURSĂ UNICĂ (datorie 10.3b-iv, înainte de cutover): azi cele două rute de metadata AS
 * (`app/.well-known/oauth-authorization-server/route.ts` și `app/api/.well-known/oauth-authorization-server/route.ts`)
 * inline-uiesc ACEEAȘI listă în `scopes_supported`. La rescrierea /authorize ambele TREBUIE să importe această constantă,
 * altfel „sursa unică" rămâne doar declarativă (trei copii care pot deriva). Testul de acoperire (`scopeCatalog.test.ts`)
 * verifică deja că orice scope folosit de tool-uri (`lib/mcp/scopes.ts` → `TOOL_SCOPES`) există în catalog.
 */

export const SERVER_SCOPE_CATALOG: readonly string[] = [
  "read:basic",
  "read:all",
  "read:market",
  "read:pipeline",
  "read:pair",
  "read:safety",
  "read:reports",
  "read:positions",
] as const;
