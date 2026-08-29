/**
 * app/authorize/page.tsx
 * Endpoint-ul GET de autorizare OAuth (authorization_endpoint din discovery).
 *
 * DOUĂ fluxuri, comutate de flag-ul PH2_RESOURCE_OWNER_AUTHORIZE (isResourceOwnerAuthorizeEnabled):
 *   - flag OFF (azi): userul introduce client_secret → POST /api/oauth/authorize. Ramura LEGACY de mai jos, NEATINSĂ.
 *   - flag ON (PH-2): consent resource-owner. Cererea inițială (fără txn_id) → redirect intern la /api/oauth/authorize/start
 *     (care revalidează + creează tranzacția). Un `txn_id` explicit → RESUME: citește tranzacția + sesiunea și randează
 *     consent/eroare. Pagina NU scrie cookie și NU citește cookie-ul de resume (readResumeCookie e DOAR pentru callback);
 *     resume-ul folosește EXCLUSIV txn_id-ul explicit din URL.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { getClientById, isAllowedRedirectUri } from "@/lib/db/oauth-clients";
import { isResourceOwnerAuthorizeEnabled } from "@/lib/oauth/authorizeResourceOwnerFlag";
import { isValidResumeTxnId } from "@/lib/oauth/sessionResume";
import { getSessionState } from "@/lib/oauth/sessionResumeIo";
import { readAuthzTxn } from "@/lib/db/authzTxnStoreIo";
import { decideAuthorizeGetOutcome } from "@/lib/oauth/authorizeGetDecision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fără colaps: Next dă `string | string[]` (array pe parametru duplicat). Nu unim array-urile — păstrăm multiplicitatea
// până la /start, ca handler-ul să detecteze duplicatele (RFC 6749).
type QueryVal = string | string[] | undefined;

interface Props {
  searchParams: Promise<Record<string, QueryVal>>;
}

/**
 * Forma LEGACY (flag OFF): parametrii OAuth ca string simplu (comportamentul de azi). Toți opționali → ramura legacy
 * destructurează cu default `""`. `resource?: string` = transportat mai departe în POST (PH-3 / RFC 8707).
 */
interface LegacyAuthorizeParams {
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  scope?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  response_type?: string;
  resource?: string;
}

/** Prima valoare (array-safe), possibly `undefined` — legacy (flag OFF) destructurează apoi cu default `""`. */
const firstVal = (v: QueryVal): string | undefined => (Array.isArray(v) ? v[0] : v);

// Parametrii OAuth inițiali (fără txn_id) — folosiți la detecția „resume exclusiv".
const OAUTH_PARAM_NAMES = [
  "client_id", "redirect_uri", "state", "scope",
  "code_challenge", "code_challenge_method", "response_type", "resource",
] as const;

export default async function AuthorizePage({ searchParams }: Props) {
  const params = await searchParams;

  // PH-2 flux resource-owner (flag ON). Flag OFF → cade pe ramura LEGACY de mai jos (neschimbată).
  if (isResourceOwnerAuthorizeEnabled(process.env)) {
    return resourceOwnerAuthorize(params);
  }

  // ── LEGACY (flag OFF): client_secret form (comportament neschimbat) ────────────────
  // Coerce la forma legacy (string simplu, array-safe), apoi destructurează cu default `""` (parametru absent → gol).
  const legacy: LegacyAuthorizeParams = {
    client_id:             firstVal(params.client_id),
    redirect_uri:          firstVal(params.redirect_uri),
    state:                 firstVal(params.state),
    scope:                 firstVal(params.scope),
    code_challenge:        firstVal(params.code_challenge),
    code_challenge_method: firstVal(params.code_challenge_method),
    response_type:         firstVal(params.response_type),
    resource:              firstVal(params.resource),
  };
  const {
    client_id             = "",
    redirect_uri          = "",
    state                 = "",
    scope                 = "",
    code_challenge        = "",
    code_challenge_method = "",
    response_type         = "",
    resource              = "",
  } = legacy;

  if (!client_id || !redirect_uri) {
    return errorCard("⚠️ Invalid Request", "Missing client_id or redirect_uri.");
  }
  if (response_type !== "code") {
    return errorCard("⚠️ Unsupported response_type", "Only response_type=code is supported.");
  }

  // Item e) — fail-fast UX pe redirect_uri (nu security boundary; POST-ul re-verifică). getClientById (fără secret) e ok.
  const client = await getClientById(client_id);
  if (client && (client.redirect_uris.length === 0 || !isAllowedRedirectUri(client, redirect_uri))) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h1 style={styles.title}>⚠️ redirect_uri not allowed</h1>
          <p style={styles.subtitle}>
            This redirect_uri isn&apos;t in the allowlist for this client. Add it in your{" "}
            <Link href="/dashboard" style={styles.link}>dashboard</Link> first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        {/* Logo + Brand */}
        <div style={styles.brand}>
          <span style={styles.logo}>✈</span>
          <span style={styles.brandName}>Preflight</span>
        </div>

        <h1 style={styles.title}>Connect to Preflight</h1>
        <p style={styles.subtitle}>
          Enter your client secret to authorize access.
        </p>

        <div style={styles.clientInfo}>
          <span style={styles.clientLabel}>Client ID</span>
          <span style={styles.clientId}>{client_id}</span>
        </div>

        <div style={styles.scopeInfo}>
          <span style={styles.scopeLabel}>Scope</span>
          <span style={styles.scopeBadge}>{scope || "(client default)"}</span>
        </div>

        {/* Form — POST la /api/oauth/authorize */}
        <form action="/api/oauth/authorize" method="POST" style={styles.form}>
          <input type="hidden" name="client_id"             value={client_id} />
          <input type="hidden" name="redirect_uri"          value={redirect_uri} />
          <input type="hidden" name="state"                 value={state} />
          <input type="hidden" name="scope"                 value={scope} />
          <input type="hidden" name="code_challenge"        value={code_challenge} />
          <input type="hidden" name="code_challenge_method" value={code_challenge_method} />
          <input type="hidden" name="response_type"         value={response_type} />
          {/* PH-3 (RFC 8707): transportă resource în POST → API-ul îl validează (invalid_target la mismatch). */}
          <input type="hidden" name="resource"              value={resource} />

          <label style={styles.label} htmlFor="client_secret">
            Client Secret
          </label>
          <input
            id="client_secret"
            name="client_secret"
            type="password"
            placeholder="Enter your client secret"
            required
            autoFocus
            style={styles.input}
          />

          <button type="submit" style={styles.button}>
            Authorize Access →
          </button>
        </form>

        <p style={styles.footer}>
          Don&apos;t have credentials?{" "}
          <Link href="/signup" style={styles.link}>
            Get access →
          </Link>
        </p>
      </div>
    </div>
  );
}

// ── PH-2 resource-owner (flag ON) ───────────────────────────────────────────────
async function resourceOwnerAuthorize(params: Record<string, QueryVal>) {
  const rawTxn = params.txn_id;

  // RESUME: txn_id prezent → trebuie VALID (format), UNIC (nu array) și EXCLUSIV (fără parametri OAuth inițiali).
  if (rawTxn !== undefined) {
    if (Array.isArray(rawTxn) || !isValidResumeTxnId(rawTxn)) {
      return errorCard("⚠️ Invalid Request", "This authorization link is invalid or has expired.");
    }
    // Exclusiv: un txn_id alături de parametri OAuth inițiali e o cerere ambiguă (nu amestecăm resume cu initial).
    if (OAUTH_PARAM_NAMES.some((n) => params[n] !== undefined)) {
      return errorCard("⚠️ Invalid Request", "This authorization link is invalid or has expired.");
    }

    // DOAR txn_id explicit (fără cookie): readAuthzTxn + sesiune → decizia pură de resume.
    const txnRead = await readAuthzTxn(rawTxn);
    const session = await getSessionState();
    const decision = decideAuthorizeGetOutcome({ mode: "resume", txnRead, session, nowMs: Date.now() });

    if (decision.kind === "render_consent") return consentPlaceholder();
    if (decision.kind === "unavailable") {
      // OUTAGE (Redis/Supabase jos): un 200 ar semnala fals „succes" la monitoring/clienți. RSC nu poate emite 503,
      // deci ARUNCĂM → Next randează pagina de eroare cu status 5xx (nu 200). Un 503 REAL ar cere mutarea resume-ului
      // pe un route handler; până atunci 5xx e semnalul onest că e o eroare de server, nu un succes.
      throw new Error("resume transaction store unavailable");
    }
    // error_local (absent / corrupt / expirat / nelegat / anonim / mismatch) — cerere invalidă, NU outage. Afișare
    // LOCALĂ (RFC 6749 §4.1.2.1: erorile ne-redirectabile se arată resource-owner-ului), 200 e adecvat aici.
    return errorCard("⚠️ Invalid Request", "This authorization link is invalid or has expired.");
  }

  // INITIAL (fără txn_id): forward la /start PĂSTRÂND multiplicitatea (fără colaps). /start revalidează complet.
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else if (typeof v === "string") qs.append(k, v);
  }
  redirect(`/api/oauth/authorize/start?${qs.toString()}`);
}

/**
 * Placeholder INERT pentru ecranul de consent (frunza 5 îl înlocuiește cu Approve/Deny + CSRF). Fără form, fără
 * auto-submit — flag-ul rămâne OFF până când UI-ul + callback-ul sunt complete.
 */
function consentPlaceholder() {
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.brand}>
          <span style={styles.logo}>✈</span>
          <span style={styles.brandName}>Preflight</span>
        </div>
        <h1 style={styles.title}>Authorize access</h1>
        <p style={styles.subtitle}>The consent screen is not available yet.</p>
      </div>
    </div>
  );
}

/** Card de eroare generic (mesaj public, fără detalii interne). */
function errorCard(title: string, message: string) {
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>{title}</h1>
        <p style={styles.subtitle}>{message}</p>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight:       "100vh",
    background:      "#0a0a0a",
    display:         "flex",
    alignItems:      "center",
    justifyContent:  "center",
    fontFamily:      "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding:         "20px",
  },
  card: {
    background:    "#111",
    border:        "1px solid #222",
    borderRadius:  "12px",
    padding:       "40px",
    width:         "100%",
    maxWidth:      "420px",
  },
  brand: {
    display:        "flex",
    alignItems:     "center",
    gap:            "10px",
    marginBottom:   "28px",
  },
  logo: {
    fontSize:     "24px",
  },
  brandName: {
    color:        "#fff",
    fontSize:     "18px",
    fontWeight:   "700",
    letterSpacing: "0.05em",
    textTransform: "uppercase" as const,
  },
  title: {
    color:        "#fff",
    fontSize:     "22px",
    fontWeight:   "600",
    margin:       "0 0 8px 0",
  },
  subtitle: {
    color:        "#888",
    fontSize:     "14px",
    margin:       "0 0 24px 0",
    lineHeight:   "1.5",
  },
  clientInfo: {
    display:        "flex",
    alignItems:     "center",
    gap:            "10px",
    background:     "#0d0d0d",
    border:         "1px solid #1e1e1e",
    borderRadius:   "8px",
    padding:        "10px 14px",
    marginBottom:   "10px",
  },
  clientLabel: {
    color:        "#555",
    fontSize:     "12px",
    fontFamily:   "monospace",
    flexShrink:   0,
  },
  clientId: {
    color:        "#00ff88",
    fontSize:     "13px",
    fontFamily:   "monospace",
    overflow:     "hidden",
    textOverflow: "ellipsis",
    whiteSpace:   "nowrap" as const,
  },
  scopeInfo: {
    display:        "flex",
    alignItems:     "center",
    gap:            "10px",
    marginBottom:   "24px",
  },
  scopeLabel: {
    color:      "#555",
    fontSize:   "12px",
    fontFamily: "monospace",
  },
  scopeBadge: {
    background:   "#0d2016",
    border:       "1px solid #0a3020",
    color:        "#00ff88",
    fontSize:     "11px",
    fontFamily:   "monospace",
    padding:      "3px 8px",
    borderRadius: "4px",
  },
  form: {
    display:        "flex",
    flexDirection:  "column" as const,
    gap:            "14px",
  },
  label: {
    color:      "#aaa",
    fontSize:   "13px",
    fontWeight: "500",
  },
  input: {
    background:   "#0d0d0d",
    border:       "1px solid #222",
    borderRadius: "8px",
    color:        "#fff",
    fontSize:     "14px",
    padding:      "12px 14px",
    outline:      "none",
    width:        "100%",
    boxSizing:    "border-box" as const,
  },
  button: {
    background:   "#00ff88",
    border:       "none",
    borderRadius: "8px",
    color:        "#000",
    cursor:       "pointer",
    fontSize:     "14px",
    fontWeight:   "700",
    padding:      "13px",
    width:        "100%",
    marginTop:    "4px",
    letterSpacing: "0.03em",
  },
  footer: {
    color:      "#555",
    fontSize:   "13px",
    textAlign:  "center" as const,
    marginTop:  "24px",
    marginBottom: "0",
  },
  link: {
    color:          "#00ff88",
    textDecoration: "none",
  },
};
