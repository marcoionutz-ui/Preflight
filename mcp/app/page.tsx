/**
 * app/page.tsx
 *
 * Landing page. Static — no Redis reads, no report builders. The only
 * "proof" claims here point at /demo and /demo/pair, which are live and
 * cache-only. The JSON snippet below is a hand-written illustration of the
 * shape, explicitly labeled as such — never presented as a live sample.
 */

import Link from "next/link";

export default function LandingPage() {
  return (
    <div style={styles.page}>
      <header style={styles.topbar}>
        <span style={styles.brand}>✈ PREFLIGHT</span>
        <nav style={styles.navGroup}>
          <Link href="/demo" style={styles.navLink}>Market Overview</Link>
          <Link href="/docs/connect" style={styles.navLink}>Connect</Link>
          <Link href="/pricing" style={styles.navLink}>Pricing →</Link>
        </nav>
      </header>

      <main style={styles.main}>
        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <section style={styles.hero}>
          <h1 style={styles.h1}>
            Preflight gives AI trading agents fast, cheap, structured DEX context before they act.
          </h1>
          <p style={styles.heroSub}>Preflight reports. The agent decides.</p>
          <div style={styles.ctaRow}>
            <Link href="/demo" style={styles.ctaPrimary}>View Live Market Overview →</Link>
          </div>
        </section>

        {/* ── How it works ─────────────────────────────────────────────────── */}
        <section style={styles.section}>
          <div style={styles.stepsRow}>
            <Step n="1" label="Agent asks" text="tp_pair_context, tp_market_overview, tp_preflight_safety — via MCP, OAuth-authenticated." />
            <Step n="2" label="Preflight reports" text="Compressed, structured context from what the indexer has actually observed. Cache-only." />
            <Step n="3" label="Agent decides" text="Preflight never trades, advises, or custodies funds. It reports; the agent acts." />
          </div>
        </section>

        {/* ── Feature cards ─────────────────────────────────────────────────── */}
        <section style={styles.section}>
          <div style={styles.grid}>
            <FeatureCard
              title="Pool discovery"
              text="V2/V3/V4 pools observed by the indexers as they appear across supported EVM chains — not scraped after the fact."
            />
            <FeatureCard
              title="Liquidity / flow / risk context"
              text="Reserve state, buy/sell pressure, LP status, and a GoPlus-backed safety check — all with honest freshness and confidence labels."
            />
            <FeatureCard
              title="Agent-readable MCP reports"
              text="Every tool response carries the same freshness/confidence/coverage metadata a human report shows — nothing hidden between the UI and the agent."
            />
          </div>
        </section>

        {/* ── Base-first / multichain ──────────────────────────────────────── */}
        <section style={styles.section}>
          <h2 style={styles.h2}>Base-first. Multichain-aware.</h2>
          <p style={styles.bodyText}>
            Base is the home market. Arbitrum and BSC run on the same live indexer. Ethereum
            is running as a shadow worker ahead of promotion. Solana is indexed separately —
            sampled from observed swap activity, not a full firehose.
          </p>
          <div style={styles.chainBadges}>
            <ChainBadge label="BASE" tier="LIVE" />
            <ChainBadge label="ARBITRUM" tier="LIVE" />
            <ChainBadge label="BSC" tier="LIVE" />
            <ChainBadge label="ETHEREUM" tier="CACHED" />
            <ChainBadge label="SOLANA" tier="SAMPLED" />
          </div>
          <Link href="/demo" style={styles.inlineLink}>See live coverage for every chain →</Link>
        </section>

        {/* ── Illustrative JSON ────────────────────────────────────────────── */}
        <section style={styles.section}>
          <h2 style={styles.h2}>Example agent response shape</h2>
          <p style={styles.bodyText}>
            Example shape only — not a live sample. Open any pair on the{" "}
            <Link href="/demo" style={styles.inlineLink}>market overview</Link> to see the real,
            live Agent JSON for that pair.
          </p>
          <pre style={styles.jsonBlock}>{EXAMPLE_JSON}</pre>
        </section>
      </main>

      <footer style={styles.footer}>
        Preflight reports observed market context only. The agent decides.
      </footer>
    </div>
  );
}

const EXAMPLE_JSON = `{
  "ok": true,
  "format": "preflight.response.v1",
  "text": {
    "found": true,
    "chain": "base",
    "symbol": "EXAMPLE/WETH",
    "contextQuality": "fresh",
    "dataSource": "pair_states",
    "flow": { "pressure": "BUYING", "hasData": true },
    "risk": { "riskLevel": "LOW", "isHoneypot": false }
  },
  "meta": {
    "freshnessSec": 12,
    "confidence": "HIGH",
    "dataQuality": { "wsFlow": "present", "risk": "cached" }
  }
}`;

// ── Sub-components ──────────────────────────────────────────────────────────

function Step({ n, label, text }: { n: string; label: string; text: string }) {
  return (
    <div style={styles.step}>
      <div style={styles.stepNum}>{n}</div>
      <div style={styles.stepLabel}>{label}</div>
      <div style={styles.stepText}>{text}</div>
    </div>
  );
}

function FeatureCard({ title, text }: { title: string; text: string }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>{title}</div>
      <div style={styles.cardText}>{text}</div>
    </div>
  );
}

function ChainBadge({ label, tier }: { label: string; tier: "LIVE" | "CACHED" | "SAMPLED" }) {
  const map: Record<string, React.CSSProperties> = {
    LIVE:    styles.badgeGreen,
    CACHED:  styles.badgeAmber,
    SAMPLED: styles.badgeGray,
  };
  return (
    <div style={styles.chainBadge}>
      <span>{label}</span>
      <span style={{ ...styles.tierBadge, ...map[tier] }}>{tier}</span>
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
    color:         "#00ff88",
    fontSize:      "13px",
    fontWeight:    700,
    letterSpacing: "0.08em",
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
    maxWidth: "880px",
    margin:   "0 auto",
    padding:  "0 20px",
  },
  hero: {
    padding:      "64px 0 40px",
    borderBottom: "1px solid #141414",
  },
  h1: {
    color:      "#fff",
    fontSize:   "28px",
    lineHeight: "1.4",
    margin:     "0 0 16px",
    maxWidth:   "680px",
  },
  heroSub: {
    color:      "#00ff88",
    fontSize:   "15px",
    margin:     "0 0 28px",
  },
  ctaRow: {
    display: "flex",
    gap:     "12px",
  },
  ctaPrimary: {
    background:    "#00ff88",
    color:         "#000",
    fontSize:      "13px",
    fontWeight:    700,
    padding:       "12px 20px",
    borderRadius:  "8px",
    textDecoration: "none",
    letterSpacing: "0.02em",
  },
  section: {
    padding:      "40px 0",
    borderBottom: "1px solid #141414",
  },
  h2: {
    color:    "#fff",
    fontSize: "17px",
    margin:   "0 0 12px",
  },
  bodyText: {
    color:      "#999",
    fontSize:   "13px",
    lineHeight: "1.7",
    maxWidth:   "640px",
    margin:     "0 0 16px",
  },
  stepsRow: {
    display:             "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap:                 "20px",
  },
  step: {
    borderLeft: "2px solid #1a1a1a",
    paddingLeft: "16px",
  },
  stepNum: {
    color:      "#00ff88",
    fontSize:   "11px",
    fontWeight: 700,
    marginBottom: "6px",
  },
  stepLabel: {
    color:      "#fff",
    fontSize:   "14px",
    fontWeight: 700,
    marginBottom: "6px",
  },
  stepText: {
    color:      "#888",
    fontSize:   "12px",
    lineHeight: "1.6",
  },
  grid: {
    display:             "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap:                 "16px",
  },
  card: {
    background:   "#0a0a0a",
    border:       "1px solid #1a1a1a",
    borderRadius: "10px",
    padding:      "20px 22px",
  },
  cardTitle: {
    color:         "#fff",
    fontSize:      "13.5px",
    fontWeight:    700,
    marginBottom:  "10px",
  },
  cardText: {
    color:      "#888",
    fontSize:   "12px",
    lineHeight: "1.6",
  },
  chainBadges: {
    display:  "flex",
    flexWrap: "wrap" as const,
    gap:      "10px",
    marginBottom: "16px",
  },
  chainBadge: {
    display:      "flex",
    alignItems:   "center",
    gap:          "8px",
    background:   "#0a0a0a",
    border:       "1px solid #1a1a1a",
    borderRadius: "6px",
    padding:      "8px 12px",
    fontSize:     "11.5px",
    color:        "#ccc",
  },
  tierBadge: {
    fontSize:      "9.5px",
    fontWeight:    700,
    padding:       "2px 6px",
    borderRadius:  "4px",
    letterSpacing: "0.03em",
  },
  badgeGreen: { background: "#0d2016", border: "1px solid #0a3020", color: "#00ff88" },
  badgeAmber: { background: "#241a05", border: "1px solid #3a2a08", color: "#ffb020" },
  badgeGray:  { background: "#151515", border: "1px solid #222",   color: "#999" },
  inlineLink: {
    color:          "#00ff88",
    fontSize:       "12.5px",
    textDecoration: "none",
  },
  jsonBlock: {
    background:    "#080808",
    border:        "1px solid #1a1a1a",
    borderRadius:  "6px",
    color:         "#7fe3a3",
    fontSize:      "12px",
    lineHeight:    "1.6",
    padding:       "18px",
    overflowX:     "auto",
    whiteSpace:    "pre",
  },
  footer: {
    textAlign:  "center" as const,
    color:      "#444",
    fontSize:   "11px",
    padding:    "24px",
  },
};
