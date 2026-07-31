/**
 * app/authorize/page.tsx
 * Pagina de autorizare OAuth — utilizatorul introduce client_secret
 * Claude.ai redirectează aici, userul se "loghează", primește code
 */

import Link from "next/link";
import { getClientById, isAllowedRedirectUri } from "@/lib/db/oauth-clients";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{
    client_id?:             string;
    redirect_uri?:          string;
    state?:                 string;
    scope?:                 string;
    code_challenge?:        string;
    code_challenge_method?: string;
    response_type?:         string;
  }>;
}

export default async function AuthorizePage({ searchParams }: Props) {
  const params = await searchParams;

  const {
    client_id             = "",
    redirect_uri          = "",
    state                 = "",
    // Fără default "read:all" — era un bug real: câmpul ăsta se duce direct
    // în hidden input-ul POST-at, deci API-ul (/api/oauth/authorize) nu mai
    // vedea NICIODATĂ scope gol, iar fallback-ul lui corect
    // (`requestedScopes.length > 0 ? requestedScopes : client.scopes`) nu se
    // declanșa vreodată. Orice client read:basic (free_trial/basic) pica cu
    // "scope not allowed" la fiecare conectare interactivă, fiindcă cerea
    // implicit read:all fără să aibă acest scope. Default gol → API-ul
    // aplică natural client.scopes.
    scope                 = "",
    code_challenge        = "",
    // E1: NU mai defaulta la "S256" pe metodă absentă. RFC 7636 §4.3: lipsa lui
    // code_challenge_method înseamnă "plain", nu S256 — iar Preflight acceptă DOAR
    // S256, deci un request fără metodă trebuie respins, nu reinterpretat tacit ca
    // S256. Default gol → /api/oauth/authorize îl respinge (validateAuthorizeChallenge).
    code_challenge_method = "",
    // Fără default "code" — obligatoriu prin RFC 6749, un request care nu-l
    // trimite deloc trebuie respins, nu tratat tacit ca valid.
    response_type         = "",
  } = params;

  // Validare minimă
  if (!client_id || !redirect_uri) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h1 style={styles.title}>⚠️ Invalid Request</h1>
          <p style={styles.subtitle}>Missing client_id or redirect_uri.</p>
        </div>
      </div>
    );
  }

  if (response_type !== "code") {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h1 style={styles.title}>⚠️ Unsupported response_type</h1>
          <p style={styles.subtitle}>Only response_type=code is supported.</p>
        </div>
      </div>
    );
  }

  // Item e) — verificare fail-fast pe redirect_uri: fără asta, userul tastează
  // client_secret degeaba, doar ca să vadă eroarea DUPĂ submit la POST (care
  // face aceeași verificare, dar acolo e obligatorie oricum — asta e doar UX,
  // nu security boundary; nu are secretul, deci getClientById (nu
  // verifyClientCredentials) e suficient aici).
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
