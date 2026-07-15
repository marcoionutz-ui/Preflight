"use client";

/**
 * app/dashboard/dashboard-client.tsx
 * Renders account info + credentials. freshSecret (from the server
 * component) is the one-time reveal right after account creation; rotate
 * produces a new one-time reveal via a Server Action, held only in local
 * state — never persisted anywhere as plain text.
 */

import { useState } from "react";
import Link from "next/link";
import { rotateSecretAction, signOutAction } from "./actions";

interface Props {
  email:              string;
  clientId:           string;
  freshSecret:        string | null;
  planName:           string;
  scopes:             string[];
  monthlyQuota:       number;
  rateLimitPerMinute: number;
  mcpUrl:             string;
}

export default function DashboardClient({
  email, clientId, freshSecret, planName, scopes,
  monthlyQuota, rateLimitPerMinute, mcpUrl,
}: Props) {
  const [revealedSecret, setRevealedSecret] = useState<string | null>(freshSecret);
  const [rotating, setRotating]             = useState(false);
  const [rotateError, setRotateError]       = useState("");
  const [copiedField, setCopiedField]       = useState<string | null>(null);

  async function copy(value: string, field: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      // clipboard blocked — no-op
    }
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
          <Field label="client_id" value={clientId} onCopy={() => copy(clientId, "id")} copied={copiedField === "id"} />

          {rotateError && <div style={styles.errorBox}>{rotateError}</div>}
          <button onClick={handleRotate} disabled={rotating} style={styles.rotateBtn}>
            {rotating ? "Rotating..." : "Rotate secret"}
          </button>
        </Section>

        <Section title="Plan">
          <div style={styles.metaRow}>
            <MetaItem label="plan" value={planName} />
            <MetaItem label="monthly quota" value={monthlyQuota === -1 ? "Custom" : monthlyQuota.toLocaleString("en-US")} />
            <MetaItem label="rate limit / min" value={String(rateLimitPerMinute)} />
          </div>
          <div style={styles.scopeRow}>
            {scopes.map(s => <span key={s} style={styles.scopeBadge}>{s}</span>)}
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
      </main>
    </div>
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
