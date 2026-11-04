"use client";

/**
 * app/dashboard/dashboard-client.tsx
 * Renders account info, the Claude connection instructions, the "revoke Claude's access" control and — only for
 * accounts that already own one — the legacy confidential client (credentials, plan, redirect URIs). Rotate produces
 * a one-time secret reveal via a Server Action, held only in local state — never persisted anywhere as plain text.
 *
 * Lot OAuth staging:
 *   - §4.1 (O1): fără client legacy → mesaj „acces doar pe invitație" + conectarea din Claude („Use Claude's published
 *     identity", URL-ul MCP). Nu se mai creează clienți din dashboard, deci nu mai există reveal la creare.
 *   - §6: butonul de revocare apare pentru orice cont logat și revocă DOAR conexiunile Claude (grant-urile pe
 *     registration-urile Claude); rezultatul spune câte conexiuni Claude au fost revocate. Fără `window.confirm`: revocarea e reversibilă prin
 *     reconectare, iar proba e2e (Playwright) apasă butonul direct (dialogurile sunt închise implicit acolo).
 *     `data-testid` stabile: `revoke-claude-access` (buton) și `revoke-result` (rezultat).
 */

import { useState } from "react";
import Link from "next/link";
import {
  rotateSecretAction, signOutAction, addRedirectUriAction, removeRedirectUriAction, revokeClaudeAccessAction,
} from "./actions";

/** Clientul confidențial legacy al contului (dacă există), deja proiectat pe server — fără secret_hash. */
export interface LegacyClientView {
  clientId:           string;
  planName:           string;
  scopes:             string[];
  monthlyQuota:       number;
  rateLimitPerMinute: number;
  redirectUris:       string[];
}

interface Props {
  email:        string;
  mcpUrl:       string;
  legacyClient: LegacyClientView | null;
}

type RevokeState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done";  revoked: number }
  | { kind: "error"; message: string };

export default function DashboardClient({ email, mcpUrl, legacyClient }: Props) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [revoke, setRevoke]           = useState<RevokeState>({ kind: "idle" });

  async function copy(value: string, field: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      // clipboard blocked — no-op
    }
  }

  async function handleRevokeClaude() {
    setRevoke({ kind: "busy" });
    try {
      const result = await revokeClaudeAccessAction();
      setRevoke(result.ok ? { kind: "done", revoked: result.revoked } : { kind: "error", message: result.error });
    } catch {
      setRevoke({ kind: "error", message: "Could not revoke access — try again" });
    }
  }

  return (
    <div style={styles.page}>
      <header style={styles.topbar}>
        <Link href="/" style={styles.brand}>✈ PREFLIGHT</Link>
        <nav style={styles.navGroup}>
          <Link href="/docs/connect" style={styles.navLink}>Connect</Link>
          <form action={signOutAction}>
            <button type="submit" style={styles.signOutBtn}>Sign out</button>
          </form>
        </nav>
      </header>

      <main style={styles.main}>
        <h1 style={styles.h1}>Dashboard</h1>
        <p style={styles.subtitle}>{email}</p>

        {legacyClient === null && (
          <Section title="Access">
            <p style={styles.bodyText}>
              Preflight beta access is by invitation only. If you were invited, connect from Claude:
              Settings → Connectors → Add custom connector, paste the URL below, and for the OAuth client
              choose <strong>&quot;Use Claude&apos;s published identity&quot;</strong>. Then press Connect and approve
              the consent screen.
            </p>
            <Field label="MCP endpoint" value={mcpUrl} onCopy={() => copy(mcpUrl, "url")} copied={copiedField === "url"} />
          </Section>
        )}

        {legacyClient !== null && (
          <LegacyClientSections client={legacyClient} mcpUrl={mcpUrl} copy={copy} copiedField={copiedField} />
        )}

        <Section title="Claude access">
          <p style={styles.bodyText}>
            Revoking disconnects Claude (claude.ai / claude.com) from your account: tokens already issued to Claude
            stop working on the next call and cannot be refreshed. Other clients are not affected. You can connect
            again from Claude at any time.
          </p>
          <button
            type="button"
            data-testid="revoke-claude-access"
            onClick={handleRevokeClaude}
            disabled={revoke.kind === "busy"}
            style={styles.rotateBtn}
          >
            {revoke.kind === "busy" ? "Revoking..." : "Revoke Claude's access"}
          </button>
          {(revoke.kind === "done" || revoke.kind === "error") && (
            <div
              data-testid="revoke-result"
              data-status={revoke.kind === "done" ? "ok" : "error"}
              role="status"
              style={revoke.kind === "done" ? styles.okBox : styles.errorBox}
            >
              {revoke.kind === "done"
                ? (revoke.revoked === 0
                    ? "No active Claude connections to revoke (0 revoked)."
                    : `Revoked ${revoke.revoked} Claude connection${revoke.revoked === 1 ? "" : "s"}.`)
                : revoke.message}
            </div>
          )}
        </Section>
      </main>
    </div>
  );
}

/**
 * Secțiunile clientului confidențial legacy — neschimbate față de dashboard-ul de dinainte (credentials, plan,
 * redirect URIs, config). Componentă separată ca hook-urile ei să existe doar când contul are un client.
 */
function LegacyClientSections({ client, mcpUrl, copy, copiedField }: {
  client:      LegacyClientView;
  mcpUrl:      string;
  copy:        (value: string, field: string) => Promise<void>;
  copiedField: string | null;
}) {
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [rotating, setRotating]             = useState(false);
  const [rotateError, setRotateError]       = useState("");
  const [uris, setUris]                     = useState<string[]>(client.redirectUris);
  const [newUri, setNewUri]                 = useState("");
  const [uriError, setUriError]             = useState("");
  const [uriBusy, setUriBusy]               = useState(false);

  async function handleAddUri() {
    if (!newUri.trim()) return;
    setUriBusy(true);
    setUriError("");
    const result = await addRedirectUriAction(newUri.trim());
    setUriBusy(false);
    if (!result.ok) { setUriError(result.error); return; }
    setUris(result.redirectUris);
    setNewUri("");
  }

  async function handleRemoveUri(uri: string) {
    setUriBusy(true);
    setUriError("");
    const result = await removeRedirectUriAction(uri);
    setUriBusy(false);
    if (!result.ok) { setUriError(result.error); return; }
    setUris(result.redirectUris);
  }

  async function handleRotate() {
    if (!window.confirm(
      "Rotate your secret? The current secret stops working immediately for new logins, " +
      "and any access tokens already issued are invalidated immediately too.",
    )) {
      return;
    }
    setRotating(true);
    setRotateError("");
    const result = await rotateSecretAction();
    setRotating(false);

    if (!result.ok) {
      setRotateError(result.error);
      return;
    }
    setRevealedSecret(result.secret);
  }

  const configSnippet = `{
  "mcpServers": {
    "preflight": {
      "url": "${mcpUrl}"
    }
  }
}`;

  return (
    <>
      {revealedSecret && (
        <div style={styles.revealBox}>
          <div style={styles.revealTitle}>⚠ Save your client secret now</div>
          <p style={styles.revealText}>
            This is shown once. If you lose it, rotate to get a new one — the old secret stops
            working immediately for new logins, and any access tokens already issued are
            invalidated immediately too.
          </p>
          <div style={styles.credRow}>
            <code style={styles.credValue}>{revealedSecret}</code>
            <button onClick={() => copy(revealedSecret, "secret")} style={styles.copyBtn}>
              {copiedField === "secret" ? "copied ✓" : "copy"}
            </button>
          </div>
        </div>
      )}

      <Section title="Credentials">
        <Field label="MCP endpoint" value={mcpUrl} onCopy={() => copy(mcpUrl, "url")} copied={copiedField === "url"} />
        <Field label="client_id" value={client.clientId} onCopy={() => copy(client.clientId, "id")} copied={copiedField === "id"} />

        {rotateError && <div style={styles.errorBox}>{rotateError}</div>}
        <button onClick={handleRotate} disabled={rotating} style={styles.rotateBtn}>
          {rotating ? "Rotating..." : "Rotate secret"}
        </button>
      </Section>

      <Section title="Plan">
        <div style={styles.metaRow}>
          <MetaItem label="plan" value={client.planName} />
          <MetaItem label="monthly quota" value={client.monthlyQuota === -1 ? "Custom" : client.monthlyQuota.toLocaleString("en-US")} />
          <MetaItem label="rate limit / min" value={String(client.rateLimitPerMinute)} />
        </div>
        <div style={styles.scopeRow}>
          {client.scopes.map(s => <span key={s} style={styles.scopeBadge}>{s}</span>)}
        </div>
      </Section>

      <Section title="Redirect URIs">
        <p style={styles.bodyText}>
          The interactive /authorize screen only redirects back to a URI listed here — exact
          match, no wildcards. Your MCP client (Claude Desktop, Cursor, a custom agent) shows
          its own callback URL during first connect; add it here before authorizing.
        </p>
        {uris.length === 0 && (
          <p style={{ ...styles.bodyText, color: "#ffb020" }}>
            No redirect URIs configured yet — /authorize will refuse every request until you add one.
          </p>
        )}
        {uris.map(u => (
          <div key={u} style={styles.credRow}>
            <div style={styles.credLabelWrap}>
              <code style={styles.credValue}>{u}</code>
            </div>
            <button onClick={() => handleRemoveUri(u)} disabled={uriBusy} style={styles.copyBtn}>
              remove
            </button>
          </div>
        ))}
        {uriError && <div style={styles.errorBox}>{uriError}</div>}
        <div style={styles.credRow}>
          <input
            value={newUri}
            onChange={e => setNewUri(e.target.value)}
            placeholder="https://... or myapp://callback"
            style={styles.uriInput}
          />
          <button onClick={handleAddUri} disabled={uriBusy || !newUri.trim()} style={styles.copyBtn}>
            add
          </button>
        </div>
      </Section>

      <Section title="Connect a client">
        <p style={styles.bodyText}>
          Claude Desktop / Cursor config — OAuth discovery and PKCE happen automatically:
        </p>
        <pre style={styles.codeBlock}>{configSnippet}</pre>
        <p style={styles.bodyText}>
          See <Link href="/docs/connect" style={styles.inlineLink}>/docs/connect</Link> for
          server-to-server (client_credentials) setup and the full tools/scopes reference.
        </p>
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={styles.section}>
      <h2 style={styles.h2}>{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value, onCopy, copied }: { label: string; value: string; onCopy: () => void; copied: boolean }) {
  return (
    <div style={styles.credRow}>
      <div style={styles.credLabelWrap}>
        <div style={styles.credLabel}>{label}</div>
        <code style={styles.credValue}>{value}</code>
      </div>
      <button onClick={onCopy} style={styles.copyBtn}>{copied ? "copied ✓" : "copy"}</button>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={styles.metaLabel}>{label}</div>
      <div style={styles.metaValue}>{value}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight:  "100vh",
    background: "#030303",
    color:      "#e0e0e0",
    fontFamily: "'Courier New', Courier, monospace",
  },
  topbar: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "16px 24px",
    borderBottom:   "1px solid #161616",
  },
  brand: {
    color:          "#00ff88",
    fontSize:       "13px",
    fontWeight:     700,
    letterSpacing:  "0.08em",
    textDecoration: "none",
  },
  navGroup: {
    display:    "flex",
    alignItems: "center",
    gap:        "18px",
  },
  navLink: {
    color:          "#888",
    fontSize:       "12px",
    textDecoration: "none",
  },
  signOutBtn: {
    background: "transparent",
    border:     "1px solid #222",
    borderRadius: "6px",
    color:      "#888",
    fontSize:   "11px",
    padding:    "6px 10px",
    cursor:     "pointer",
    fontFamily: "'Courier New', Courier, monospace",
  },
  main: {
    maxWidth: "640px",
    margin:   "0 auto",
    padding:  "40px 20px 60px",
  },
  h1: {
    color:    "#fff",
    fontSize: "20px",
    margin:   "0 0 6px",
  },
  subtitle: {
    color:      "#666",
    fontSize:   "12.5px",
    margin:     "0 0 28px",
  },
  revealBox: {
    background:   "#1a1305",
    border:       "1px solid #3a2a08",
    borderRadius: "8px",
    padding:      "16px 18px",
    marginBottom: "24px",
  },
  revealTitle: {
    color:        "#ffb020",
    fontSize:     "13px",
    fontWeight:   700,
    marginBottom: "6px",
  },
  revealText: {
    color:      "#bba",
    fontSize:   "12px",
    lineHeight: "1.6",
    margin:     "0 0 12px",
  },
  section: {
    padding:   "24px 0",
    borderTop: "1px solid #141414",
  },
  h2: {
    color:    "#fff",
    fontSize: "14px",
    margin:   "0 0 14px",
  },
  bodyText: {
    color:      "#999",
    fontSize:   "12.5px",
    lineHeight: "1.7",
    margin:     "0 0 12px",
  },
  inlineLink: {
    color:          "#00ff88",
    textDecoration: "none",
  },
  credRow: {
    display:      "flex",
    alignItems:   "center",
    gap:          "10px",
    background:   "#0a0a0a",
    border:       "1px solid #1a1a1a",
    borderRadius: "8px",
    padding:      "10px 12px",
    marginBottom: "10px",
  },
  credLabelWrap: {
    flex:     1,
    minWidth: 0,
  },
  credLabel: {
    color:         "#555",
    fontSize:      "10px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    marginBottom:  "3px",
  },
  credValue: {
    color:        "#7fe3a3",
    fontSize:     "12px",
    wordBreak:    "break-all" as const,
  },
  copyBtn: {
    flexShrink:   0,
    background:   "#111",
    border:       "1px solid #222",
    borderRadius: "4px",
    color:        "#888",
    fontSize:     "11px",
    padding:      "6px 10px",
    cursor:       "pointer",
    fontFamily:   "'Courier New', Courier, monospace",
  },
  uriInput: {
    flex:         1,
    minWidth:     0,
    background:   "transparent",
    border:       "none",
    color:        "#ddd",
    fontSize:     "12px",
    fontFamily:   "'Courier New', Courier, monospace",
    outline:      "none",
  },
  rotateBtn: {
    background:   "transparent",
    border:       "1px solid #3a0f0f",
    borderRadius: "6px",
    color:        "#ff5c5c",
    fontSize:     "12px",
    padding:      "8px 14px",
    cursor:       "pointer",
    fontFamily:   "'Courier New', Courier, monospace",
    marginTop:    "6px",
  },
  okBox: {
    background:   "#07170e",
    border:       "1px solid #0f3a22",
    borderRadius: "6px",
    color:        "#7fe3a3",
    fontSize:     "12px",
    padding:      "8px 12px",
    marginTop:    "10px",
  },
  errorBox: {
    background:   "#240a0a",
    border:       "1px solid #3a0f0f",
    borderRadius: "6px",
    color:        "#ff5c5c",
    fontSize:     "12px",
    padding:      "8px 12px",
    marginBottom: "10px",
  },
  metaRow: {
    display:      "flex",
    gap:          "24px",
    marginBottom: "14px",
    flexWrap:     "wrap" as const,
  },
  metaLabel: {
    color:         "#555",
    fontSize:      "10px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    marginBottom:  "3px",
  },
  metaValue: {
    color:    "#ddd",
    fontSize: "12.5px",
  },
  scopeRow: {
    display:  "flex",
    flexWrap: "wrap" as const,
    gap:      "6px",
  },
  scopeBadge: {
    background:   "#151515",
    border:       "1px solid #222",
    borderRadius: "4px",
    color:        "#999",
    fontSize:     "9.5px",
    padding:      "2px 6px",
  },
  codeBlock: {
    background:    "#080808",
    border:        "1px solid #1a1a1a",
    borderRadius:  "6px",
    color:         "#7fe3a3",
    fontSize:      "12px",
    lineHeight:    "1.6",
    padding:       "16px",
    overflowX:     "auto",
    whiteSpace:    "pre",
    margin:        "0 0 14px",
  },
};
