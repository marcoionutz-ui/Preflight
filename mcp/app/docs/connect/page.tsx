/**
 * app/docs/connect/page.tsx
 *
 * MCP connection instructions. Static content only — the one dynamic bit is
 * the issuer origin, read from request headers the same way the
 * .well-known/* discovery routes derive it (see app/api/.well-known/
 * oauth-protected-resource/route.ts), so the endpoint shown here always
 * matches the host actually serving the page. Static content, dynamic
 * origin detection only — no Redis reads, no live calls to the MCP
 * server itself.
 */

import { headers } from "next/headers";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface ToolRow {
  name: string;
  scope: string;
  tier: "basic" | "all";
}

const TOOLS: ToolRow[] = [
  { name: "tp_situation_report", scope: "read:basic", tier: "basic" },
  { name: "tp_next_action",      scope: "read:basic", tier: "basic" },
  { name: "tp_candidate_brief",  scope: "read:basic", tier: "basic" },
  { name: "tp_late_move_context", scope: "read:basic", tier: "basic" },
  { name: "tp_preflight_safety", scope: "read:basic", tier: "basic" },
  { name: "tp_watch_pair",       scope: "read:basic", tier: "basic" },
  { name: "tp_health_check",     scope: "read:market",    tier: "all" },
  { name: "tp_market_overview",  scope: "read:market",    tier: "all" },
  { name: "tp_worker_pipeline",  scope: "read:pipeline",  tier: "all" },
  { name: "tp_worker_snapshot",  scope: "read:pipeline",  tier: "all" },
  { name: "tp_pair_context",     scope: "read:pair",      tier: "all" },
  { name: "tp_why_not",          scope: "read:reports",   tier: "all" },
  { name: "tp_recent_pipeline_drops", scope: "read:reports",   tier: "all" },
  { name: "tp_position_context", scope: "read:positions", tier: "all" },
  { name: "tp_chain_report",     scope: "read:reports",   tier: "all" },
];

export default async function ConnectDocsPage() {
  const h      = await headers();
  const host   = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto  = h.get("x-forwarded-proto") ?? "https";
  const issuer = `${proto}://${host}`;
  const mcpUrl = `${issuer}/api/mcp`;

  const claudeConfig = `{
  "mcpServers": {
    "preflight": {
      "url": "${mcpUrl}"
    }
  }
}`;

  const tokenCurl = `curl -X POST ${issuer}/api/oauth/token \\
  -d "grant_type=client_credentials" \\
  -d "client_id=tp_your_client_id" \\
  -d "client_secret=your_client_secret"`;

  const tokenResponse = `{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "scope": "read:basic"
}`;

  return (
    <div style={styles.page}>
      <header style={styles.topbar}>
        <Link href="/" style={styles.brand}>✈ PREFLIGHT</Link>
        <nav style={styles.navGroup}>
          <Link href="/demo" style={styles.navLink}>Market Overview</Link>
          <Link href="/pricing" style={styles.navLink}>Pricing →</Link>
        </nav>
      </header>

      <main style={styles.main}>
        <h1 style={styles.h1}>Connect an agent to Preflight</h1>
        <p style={styles.subtitle}>
          Preflight is a hosted MCP server. Any MCP-compatible client — Claude Desktop, Cursor,
          or a custom agent — can call it over standard OAuth 2.0. No SDK, no separate gateway.
        </p>

        {/* ── Endpoint ─────────────────────────────────────────────────────── */}
        <Section title="1. The endpoint">
          <p style={styles.bodyText}>
            One MCP endpoint, streamable HTTP transport (GET for the event stream, POST for
            JSON-RPC calls):
          </p>
          <pre style={styles.codeBlock}>{mcpUrl}</pre>
          <p style={styles.bodyText}>
            Every request needs an <code style={styles.inlineCode}>Authorization: Bearer</code>{" "}
            header. A request without one gets a 401 pointing at{" "}
            <code style={styles.inlineCode}>/.well-known/oauth-protected-resource</code> for
            discovery.
          </p>
        </Section>

        {/* ── Interactive clients ─────────────────────────────────────────── */}
        <Section title="2. Interactive clients (Claude Desktop, Cursor)">
          <p style={styles.bodyText}>
            Point the client at the endpoint. OAuth discovery, the{" "}
            <Link href="/authorize" style={styles.inlineLink}>authorize</Link> screen, and PKCE
            are handled automatically by the client during first connect:
          </p>
          <pre style={styles.codeBlock}>{claudeConfig}</pre>
        </Section>

        {/* ── Server-to-server ─────────────────────────────────────────────── */}
        <Section title="3. Server-to-server agents (client_credentials)">
          <p style={styles.bodyText}>
            For an agent that runs unattended, skip the browser step and exchange a client
            ID/secret pair directly for a token:
          </p>
          <pre style={styles.codeBlock}>{tokenCurl}</pre>
          <p style={styles.bodyText}>Response:</p>
          <pre style={styles.codeBlock}>{tokenResponse}</pre>
          <p style={styles.bodyText}>
            Tokens are valid for 24 hours. Use the returned <code style={styles.inlineCode}>access_token</code>{" "}
            as the Bearer token on every call to <code style={styles.inlineCode}>/api/mcp</code>.
          </p>
        </Section>

        {/* ── Tools + scopes ───────────────────────────────────────────────── */}
        <Section title="4. Tools and scopes">
          <p style={styles.bodyText}>
            15 tools, gated by OAuth scope. <code style={styles.inlineCode}>read:basic</code> covers
            the 6 core tools below; <code style={styles.inlineCode}>read:all</code> unlocks all 15.
          </p>
          <div style={styles.table}>
            <div style={styles.tableHeader}>
              <span>Tool</span>
              <span>Scope</span>
            </div>
            {TOOLS.map(t => (
              <div key={t.name} style={styles.tableRow}>
                <span style={styles.toolName}>{t.name}</span>
                <span style={{ ...styles.scopeBadge, ...(t.tier === "basic" ? styles.scopeBasic : styles.scopeAll) }}>
                  {t.scope}
                </span>
              </div>
            ))}
          </div>
        </Section>

        {/* ── Getting credentials ──────────────────────────────────────────── */}
        <Section title="5. Getting credentials">
          <p style={styles.bodyText}>
            Client credentials are issued per account, starting on a free trial (
            <code style={styles.inlineCode}>read:basic</code>).{" "}
            <Link href="/signup" style={styles.inlineLink}>Get access →</Link>
          </p>
        </Section>

        <div style={styles.ctaRow}>
          <Link href="/demo" style={styles.ctaPrimary}>See it running on live data →</Link>
        </div>
      </main>

      <footer style={styles.footer}>
        Preflight reports observed market context only. The agent decides.
      </footer>
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

// ── Styles ───────────────────────────────────────────────────────────────────

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
    display: "flex",
    gap:     "18px",
  },
  navLink: {
    color:          "#888",
    fontSize:       "12px",
    textDecoration: "none",
  },
  main: {
    maxWidth: "760px",
    margin:   "0 auto",
    padding:  "48px 20px 60px",
  },
  h1: {
    color:    "#fff",
    fontSize: "24px",
    margin:   "0 0 12px",
  },
  subtitle: {
    color:      "#999",
    fontSize:   "13px",
    lineHeight: "1.7",
    margin:     "0 0 36px",
    maxWidth:   "620px",
  },
  section: {
    padding:      "28px 0",
    borderTop:    "1px solid #141414",
  },
  h2: {
    color:    "#fff",
    fontSize: "15px",
    margin:   "0 0 14px",
  },
  bodyText: {
    color:      "#999",
    fontSize:   "12.5px",
    lineHeight: "1.7",
    margin:     "0 0 12px",
  },
  inlineCode: {
    background:   "#111",
    border:       "1px solid #222",
    borderRadius: "4px",
    color:        "#7fe3a3",
    fontSize:     "11.5px",
    padding:      "1px 5px",
  },
  inlineLink: {
    color:          "#00ff88",
    textDecoration: "none",
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
  table: {
    border:       "1px solid #1a1a1a",
    borderRadius: "8px",
    overflow:     "hidden",
  },
  tableHeader: {
    display:             "grid",
    gridTemplateColumns: "1fr auto",
    gap:                 "12px",
    padding:             "10px 14px",
    background:          "#0d0d0d",
    color:               "#555",
    fontSize:            "10px",
    textTransform:       "uppercase" as const,
    letterSpacing:       "0.04em",
  },
  tableRow: {
    display:             "grid",
    gridTemplateColumns: "1fr auto",
    gap:                 "12px",
    alignItems:          "center",
    padding:             "9px 14px",
    borderTop:           "1px solid #141414",
  },
  toolName: {
    color:    "#ccc",
    fontSize: "12px",
  },
  scopeBadge: {
    fontSize:      "10px",
    fontWeight:    700,
    padding:       "2px 8px",
    borderRadius:  "4px",
    letterSpacing: "0.02em",
    whiteSpace:    "nowrap" as const,
    justifySelf:   "end",
  },
  scopeBasic: { background: "#0d2016", border: "1px solid #0a3020", color: "#00ff88" },
  scopeAll:   { background: "#151515", border: "1px solid #222",   color: "#999" },
  ctaRow: {
    marginTop: "28px",
  },
  ctaPrimary: {
    display:        "inline-block",
    background:     "#00ff88",
    color:          "#000",
    fontSize:       "13px",
    fontWeight:     700,
    padding:        "12px 20px",
    borderRadius:   "8px",
    textDecoration: "none",
    letterSpacing:  "0.02em",
  },
  footer: {
    textAlign:  "center" as const,
    color:      "#444",
    fontSize:   "11px",
    padding:    "24px",
    borderTop:  "1px solid #161616",
  },
};
