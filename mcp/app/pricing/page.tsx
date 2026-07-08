/**
 * app/pricing/page.tsx
 *
 * Static pricing page — rendered directly from PLANS in lib/mcp/billing.ts,
 * the same config isRequestAllowed()/getPlanConfig() use at request time.
 * No new billing logic, no Redis reads, no live calls. The "internal" plan
 * (dev-bypass / admin only) is intentionally excluded — it isn't a real
 * public offering.
 */

import Link from "next/link";
import { PLANS } from "@/lib/mcp/billing";

export const dynamic = "force-static";

const PUBLIC_PLAN_IDS = ["free_trial", "basic", "starter", "pro", "enterprise"] as const;

function formatQuota(n: number, planId?: string): string {
  if (n !== -1) return n.toLocaleString("en-US");
  return planId === "enterprise" ? "Custom / fair use" : "Custom";
}

function toolAccessLabel(scopes: string[]): string {
  return scopes.includes("read:all") ? "All 15 tools" : "6 core tools";
}

export default function PricingPage() {
  return (
    <div style={styles.page}>
      <header style={styles.topbar}>
        <Link href="/" style={styles.brand}>✈ PREFLIGHT</Link>
        <nav style={styles.navGroup}>
          <Link href="/demo" style={styles.navLink}>Market Overview</Link>
          <Link href="/docs/connect" style={styles.navLink}>Connect →</Link>
        </nav>
      </header>

      <main style={styles.main}>
        <h1 style={styles.h1}>Pricing</h1>
        <p style={styles.subtitle}>
          Quota is measured in credits — most tool calls cost 1 credit; heavier tools like
          the safety check cost more. Rate limits cap bursts independently of monthly quota.
        </p>

        <div style={styles.grid}>
          {PUBLIC_PLAN_IDS.map(id => {
            const plan = PLANS[id];
            return (
              <div key={id} style={styles.card}>
                <div style={styles.planName}>{plan.name}</div>
                <div style={styles.toolAccess}>{toolAccessLabel(plan.allowed_scopes)}</div>

                <div style={styles.statRow}>
                  <span style={styles.statLabel}>monthly quota</span>
                  <span style={styles.statValue}>{formatQuota(plan.monthly_quota, id)}</span>
                </div>
                <div style={styles.statRow}>
                  <span style={styles.statLabel}>rate limit / min</span>
                  <span style={styles.statValue}>{formatQuota(plan.rate_limit_per_minute, id)}</span>
                </div>
                <div style={styles.statRow}>
                  <span style={styles.statLabel}>rate limit / day</span>
                  <span style={styles.statValue}>{formatQuota(plan.rate_limit_per_day, id)}</span>
                </div>

                <div style={styles.scopeRow}>
                  {plan.allowed_scopes.map(s => (
                    <span key={s} style={styles.scopeBadge}>{s}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <p style={styles.note}>
          Every plan authenticates the same way — OAuth 2.0, same MCP endpoint. See{" "}
          <Link href="/docs/connect" style={styles.inlineLink}>/docs/connect</Link> for setup.
        </p>

        <div style={styles.ctaRow}>
          <a href="https://preflight.run" style={styles.ctaPrimary}>Get access →</a>
        </div>
      </main>

      <footer style={styles.footer}>
        Preflight reports observed market context only. The agent decides.
      </footer>
    </div>
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
    maxWidth: "1100px",
    margin:   "0 auto",
    padding:  "28px 20px 60px",
  },
  h1: {
    fontSize: "20px",
    color:    "#fff",
    margin:   "0 0 8px",
  },
  subtitle: {
    color:      "#777",
    fontSize:   "12.5px",
    lineHeight: "1.6",
    margin:     "0 0 28px",
    maxWidth:   "640px",
  },
  grid: {
    display:             "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap:                 "14px",
    marginBottom:        "28px",
  },
  card: {
    background:   "#0a0a0a",
    border:       "1px solid #1a1a1a",
    borderRadius: "10px",
    padding:      "18px 18px 16px",
    display:      "flex",
    flexDirection: "column" as const,
  },
  planName: {
    color:        "#fff",
    fontSize:     "14px",
    fontWeight:   700,
    marginBottom: "4px",
  },
  toolAccess: {
    color:        "#00ff88",
    fontSize:     "11px",
    marginBottom: "16px",
  },
  statRow: {
    display:        "flex",
    justifyContent: "space-between",
    padding:        "6px 0",
    borderTop:      "1px solid #141414",
    fontSize:       "11.5px",
  },
  statLabel: {
    color: "#666",
  },
  statValue: {
    color: "#ddd",
  },
  scopeRow: {
    display:  "flex",
    flexWrap: "wrap" as const,
    gap:      "6px",
    marginTop: "14px",
  },
  scopeBadge: {
    background:   "#151515",
    border:       "1px solid #222",
    borderRadius: "4px",
    color:        "#999",
    fontSize:     "9.5px",
    padding:      "2px 6px",
  },
  note: {
    color:      "#777",
    fontSize:   "12px",
    lineHeight: "1.6",
    margin:     "0 0 20px",
  },
  inlineLink: {
    color:          "#00ff88",
    textDecoration: "none",
  },
  ctaRow: {
    marginTop: "4px",
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
    padding:    "20px",
    borderTop:  "1px solid #161616",
  },
};
