/**
 * lib/oauth/consentView.ts — PH-2 pas 6 frunză 5c-i (view-model PUR pentru ecranul de consent resource-owner).
 *
 * Zero I/O (txn + registration + cont INJECTATE ca date) → tsx-testabil. Produce EXACT ce vede resource-owner-ul pe
 * ecranul de consent (flag PH2_RESOURCE_OWNER_AUTHORIZE ON): numele clientului (fallback pe client_id), client_id,
 * host-ul redirect_uri-ului și scope-urile EFECTIVE etichetate.
 *
 * INVARIANTĂ CRITICĂ (afișare == acordare): scope-urile arătate sunt calculate cu ACELAȘI `resolveGrantedScopes`
 * (requested ∩ entitlement-cont ∩ serverPolicy, cu semantica `read:all`) pe care `decideConsentGrant` îl folosește la
 * POST. Deci userul nu poate aproba un set de scope-uri diferit de cel pe care POST-ul chiar îl emite. Dacă intersecția
 * e GOALĂ, `buildConsentView` întoarce `error` — NU arătăm un buton Approve care ar eșua sigur în `decideConsentGrant`
 * ("no usable scopes"). Aceleași porți fail-closed ca la POST: cont lipsă / neutilizabil / al altui user → `error`.
 *
 * CSRF + txn_id sunt scoase din view ca să fie puse în form-ul POST (hidden). NU conține secrete (csrf_token e un token
 * opac legat de tranzacția server-side; e proiectat să circule în form-ul de consent).
 */

import { resolveGrantedScopes, isAccountUsable, type AccountEntitlement } from "./entitlement";
import { checkRegistrationBinding } from "./registrationGate";
import type { AuthzTransaction } from "./authzTransaction";
import type { AuthorizeRegistration } from "./authorizeRequestValidate";

/** Etichete user-facing pentru cele 8 scope-uri din `SERVER_SCOPE_CATALOG`. Necunoscut → scope-ul brut (fail-safe). */
const SCOPE_LABELS: Readonly<Record<string, string>> = {
  "read:basic":     "Basic account access",
  "read:all":       "Full read access",
  "read:market":    "Market data",
  "read:pipeline":  "Pipeline data",
  "read:pair":      "Pair data",
  "read:safety":    "Safety checks",
  "read:reports":   "Reports",
  "read:positions": "Positions",
};

/** Etichetă lizibilă pentru un scope; necunoscut → scope-ul însuși (nu ascundem ce se acordă). */
export function labelForScope(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

/**
 * Afișarea „unde pleacă codul": host-ul redirect_uri-ului (cu port pentru loopback). Custom scheme nativ (fără host,
 * ex. `com.example.app:/cb`) → schema fără `:`. redirect_uri neparsabil → `null` (caller → error, nu afișăm gunoi).
 * Nu-i o graniță de securitate (allowlist-ul e deja aplicat la crearea txn), doar transparență pentru user.
 */
export function redirectDisplayHost(redirectUri: string): string | null {
  let u: URL;
  try { u = new URL(redirectUri); } catch { return null; }
  if (u.host) return u.host;                       // https/http: host[:port]
  const scheme = u.protocol.replace(/:$/, "");     // custom scheme nativ fără authority
  return scheme.length > 0 ? scheme : null;
}

export interface ConsentScopeView {
  scope: string;
  label: string;
}

export interface ConsentView {
  clientName:   string;              // registration.client_name (trimmed) SAU client_id (fallback)
  clientId:     string;
  redirectHost: string;              // host / scheme din redirect_uri
  scopes:       ConsentScopeView[];  // scope-urile EFECTIVE (ce va emite POST-ul), etichetate, ordine stabilă
  txnId:        string;              // pt. hidden field
  csrfToken:    string;              // pt. hidden field (token opac legat de txn)
}

export type ConsentViewResult =
  | { kind: "consent"; view: ConsentView }
  | { kind: "error";   reason: string };  // cont lipsă/neutilizabil, zero scope-uri acordabile, redirect neparsabil

/**
 * Construiește view-model-ul ecranului de consent. Fail-closed, oglindind TOATE porțile din `decideConsentGrant` ca
 * ecranul să nu promită nimic ce POST-ul n-ar acorda:
 *   - REGISTRATION (poartă PURĂ partajată `checkRegistrationBinding`, `nowMs` injectat): OBLIGATORIE, `registration_id`
 *     + `client_id` = cele sigilate în txn, `active`, ne-expirată, cu `authorization_code`. Fără asta am putea afișa un
 *     client pe care POST-ul îl respinge — sau un `client_name` al ALTUI client lângă `client_id`/cod care aparțin
 *     clientului din txn.
 *   - `account === null` → error (POST: "contul nu are entitlement").
 *   - `!isAccountUsable(account)` (suspendat/revocat/fără scopes) → error.
 *   - `account.user_id !== txn.session_user_id` → error (defensiv; render_consent leagă deja userul, dar nu presupunem).
 *   - `resolveGrantedScopes(...) === []` → error (POST: "no usable scopes").
 *   - `redirect_uri` neparsabil → error.
 * Fallback-ul `client_name → client_id` e valid DOAR după ce registration a trecut poarta (nume lipsă/gol pe un
 * registration CORECT), niciodată ca substitut pentru un registration invalid/absent.
 */
export function buildConsentView(p: {
  txn:          AuthzTransaction;
  registration: AuthorizeRegistration | null;
  account:      AccountEntitlement | null;
  serverPolicy: readonly string[];
  nowMs:        number;
}): ConsentViewResult {
  const { txn, registration, account, serverPolicy } = p;

  // 1. Registration — poartă identică cu POST (sursă unică). Respinge null/mismatch/inactiv/expirat/fără authz_code.
  const regGate = checkRegistrationBinding(registration, txn, p.nowMs);
  if (!regGate.ok) return { kind: "error", reason: regGate.reason };
  // checkRegistrationBinding respinge null → registration e non-null aici; narrowing explicit (fără non-null assertion).
  if (!registration) return { kind: "error", reason: "registration lipsă" };

  // 2. Cont — utilizabil ȘI al userului tranzacției.
  if (!account) return { kind: "error", reason: "cont fără entitlement" };
  if (!isAccountUsable(account)) return { kind: "error", reason: "cont neutilizabil (status/scopes)" };
  if (account.user_id !== txn.session_user_id) return { kind: "error", reason: "cont pentru alt user decât tranzacția" };

  // 3. Scope-uri EFECTIVE (afișare == acordare) + redirect afișabil.
  const effective = resolveGrantedScopes(txn.requested_scopes, account.scopes, serverPolicy);
  if (effective.length === 0) return { kind: "error", reason: "niciun scope acordabil" };

  const redirectHost = redirectDisplayHost(txn.redirect_uri);
  if (redirectHost === null) return { kind: "error", reason: "redirect_uri neparsabil" };

  // Registration e VALIDĂ (client_id === txn.client_id) → client_name e de încredere; lipsă/gol → fallback pe client_id.
  const clientName = typeof registration.client_name === "string" && registration.client_name.trim() !== ""
    ? registration.client_name.trim()
    : txn.client_id;

  return {
    kind: "consent",
    view: {
      clientName,
      clientId:     txn.client_id,
      redirectHost,
      scopes:       effective.map((s) => ({ scope: s, label: labelForScope(s) })),
      txnId:        txn.txn_id,
      csrfToken:    txn.csrf_token,
    },
  };
}
