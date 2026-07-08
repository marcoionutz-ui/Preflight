/**
 * app/demo/pair/[chain]/[address]/page.tsx
 *
 * Public demo screen — "everything Preflight knows about a pair", the same
 * report the MCP tool tp_pair_context hands to an agent, just rendered for
 * humans. Calls buildPairContextReport() directly — the exact same function
 * tp_pair_context.ts calls — so this page can never drift from what an agent
 * actually sees.
 *
 * Cache-only by construction: buildPairContextReport only does Redis GETs,
 * no Alchemy/GoPlus live calls, no force refresh, no backfill. Safe to leave
 * public and unauthenticated.
 */

import { buildPairContextReport } from "@/lib/reports/pair-context-report";
import { mcpResponse, mcpErr } from "@/lib/mcp/errors";
import PairContextTabs from "./tabs-client";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ chain: string; address: string }>;
}

export default async function PairContextDemoPage({ params }: Props) {
  const { chain, address } = await params;

  const report = await buildPairContextReport({ pairAddress: address, chain });

  // Same envelope an MCP client gets back from tp_pair_context — copy/paste ready.
  const envelope = report.ok
    ? mcpResponse({
        text:         JSON.stringify(report.payload, null, 2),
        freshnessSec: report.freshnessSec,
        confidence:   report.confidence,
        warnings:     report.warnings,
        dataQuality:  report.dataQuality,
      })
    : mcpErr(report.errorCode ?? "INTERNAL", report.errorMessage ?? "Unknown error");

  const agentJson = JSON.stringify(envelope, null, 2);

  return (
    <div style={styles.page}>
      <header style={styles.topbar}>
        <span style={styles.brand}>✈ PREFLIGHT</span>
        <span style={styles.topbarNote}>demo · cache-only · no live calls</span>
      </header>

      <main style={styles.main}>
        {!report.ok ? (
          <ErrorState code={report.errorCode} message={report.errorMessage} />
        ) : (
          <>
            <IdentityHeader chain={chain} address={address} report={report} />
            <PairContextTabs
              human={<HumanView payload={report.payload} warnings={report.warnings} />}
              agentJson={agentJson}
            />
          </>
        )}
      </main>

      <footer style={styles.footer}>
        Preflight reports observed market context only. The agent decides.
      </footer>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ErrorState({ code, message }: { code?: string; message?: string }) {
  return (
    <div style={styles.card}>
      <div style={{ ...styles.badge, ...styles.badgeRed }}>ERROR</div>
      <h1 style={styles.h1}>{code ?? "INTERNAL"}</h1>
      <p style={styles.dim}>{message ?? "Something went wrong reading the report."}</p>
    </div>
  );
}

function IdentityHeader({
  chain,
  address,
  report,
}: {
  chain:  string;
  address: string;
  report: Awaited<ReturnType<typeof buildPairContextReport>>;
}) {
  const p = report.payload as any;
  const found = p.found !== false;

  return (
    <div style={styles.card}>
      <div style={styles.headerRow}>
        <div>
          <div style={styles.pairAddr}>{p.pairAddress ?? address}</div>
          <div style={styles.dim}>
            chain: <strong style={styles.strongLight}>{p.chain ?? chain}</strong>
            {p.symbol ? (
              <>
                {" "}· symbol: <strong style={styles.strongLight}>{p.symbol}</strong>
              </>
            ) : null}
          </div>
        </div>
        <div style={styles.badgeRow}>
          <ConfidenceBadge value={report.confidence} />
          <QualityBadge value={p.contextQuality} />
        </div>
      </div>

      <div style={styles.metaRow}>
        <MetaItem label="freshness" value={formatFreshness(report.freshnessSec)} />
        <MetaItem label="data source" value={String(p.dataSource ?? "unknown")} />
        <MetaItem label="found" value={found ? "yes" : "no — not indexed yet"} />
      </div>

      {!found && (
        <div style={styles.notFoundNote}>
          This pair isn&apos;t in the worker&apos;s cache right now. Preflight never triggers
          a live RPC call to backfill it on demand — it will show up here once the indexer
          observes it.
        </div>
      )}

      {report.warnings && report.warnings.length > 0 && (
        <div style={styles.warningsBox}>
          {report.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function HumanView({ payload, warnings }: { payload: Record<string, unknown>; warnings?: string[] }) {
  const p = payload as any;
  const isSolana = p.chain === "solana" || p.registry !== undefined || p.priceSnapshot !== undefined;

  return (
    <div style={styles.grid}>
      {isSolana ? (
        <SolanaCard p={p} />
      ) : (
        <>
          <LiquidityCard p={p} />
          <FlowPipelineCard p={p} />
          <RiskCard p={p} />
          <DiscoveryCard p={p} />
        </>
      )}
    </div>
  );
}

function SolanaCard({ p }: { p: any }) {
  const snap = p.priceSnapshot ?? {};
  const registry = p.registry ?? {};
  return (
    <>
      <Section title="Registry & price snapshot">
        <Row label="registered" value={p.registry ? "yes" : "no"} />
        <Row label="base symbol" value={snap.baseSymbol ?? registry.baseSymbol ?? "—"} />
        <Row label="quote symbol" value={snap.quoteSymbol ?? "—"} />
        <Row label="price (quote)" value={snap.priceInQuote ?? "—"} />
        <Row label="price (usd)" value={snap.priceUsd ?? "no SOL/USD oracle yet"} />
        <Row label="data age" value={formatFreshness(p.dataAgeSec)} />
      </Section>
      <Section title="Activity & history">
        <Row label="activity observed" value={p.activity ? "yes" : "no"} />
        <Row label="price samples" value={Array.isArray(p.recentHistory) ? p.recentHistory.length : 0} />
        <Row label="observed candidate" value={p.observedCandidate ? "yes" : "no"} />
      </Section>
    </>
  );
}

function LiquidityCard({ p }: { p: any }) {
  return (
    <Section title="Liquidity & market">
      <Row label="dex type" value={p.dexType ?? "—"} />
      <Row label="liquidity status" value={p.liqStatus ?? "—"} />
      <Row label="reserve (usd)" value={formatUsd(p.reserveUsd)} />
      <Row label="reserve (native)" value={p.reserveNative != null ? `${p.reserveNative} ${p.nativeSymbol ?? ""}` : "—"} />
      <Row label="pools for same token" value={p.poolCountSameToken ?? "—"} />
      <Row label="current price" value={p.currentPrice ?? "—"} />
      <Row label="price change" value={p.priceChange ?? "—"} />
      <Row label="vs first seen" value={p.priceVsFirstSeenPct != null ? `${p.priceVsFirstSeenPct}%` : "—"} />
    </Section>
  );
}

function FlowPipelineCard({ p }: { p: any }) {
  const avail = p.dataAvailability ?? {};
  const ready = p.dataReadyForReasoning ?? {};
  return (
    <Section title="Flow & pipeline">
      <Row label="pipeline state" value={p.pipeline?.state ?? "NONE"} />
      <Row label="ws flow" value={avail.wsFlow ?? "—"} />
      <Row label="lp signal" value={avail.lpSignal ?? "—"} />
      <Row label="lp coverage" value={avail.lpCoverage ?? "—"} />
      <Row label="ready for reasoning" value={ready.ready ? "yes" : "no"} />
      {Array.isArray(ready.missingCritical) && ready.missingCritical.length > 0 && (
        <Row label="missing (critical)" value={ready.missingCritical.join(", ")} />
      )}
      {p.marketPattern?.lastMomentumVerdict && (
        <Row label="last momentum verdict" value={p.marketPattern.lastMomentumVerdict} />
      )}
      {p.marketPattern?.monitoringTier && (
        <Row label="monitoring tier" value={p.marketPattern.monitoringTier} />
      )}
    </Section>
  );
}

function RiskCard({ p }: { p: any }) {
  const risk = p.risk;
  if (!risk) {
    return (
      <Section title="Risk & safety">
        <Row label="risk cache" value={p.riskCacheStatus ?? "unavailable"} />
        <div style={styles.dim}>No risk check cached for this pair yet.</div>
      </Section>
    );
  }
  return (
    <Section title="Risk & safety">
      <Row label="risk level" value={risk.riskLevel ?? "—"} />
      <Row label="honeypot" value={boolLabel(risk.isHoneypot)} />
      <Row label="can sell" value={risk.cannotSell === true ? "no" : risk.cannotSell === false ? "yes" : "—"} />
      <Row label="buy / sell tax" value={`${risk.buyTaxPct ?? "?"}% / ${risk.sellTaxPct ?? "?"}%`} />
      <Row label="owner renounced" value={boolLabel(risk.ownerRenounced)} />
      <Row label="can mint" value={boolLabel(risk.canMint)} />
      <Row label="can blacklist" value={boolLabel(risk.canBlacklist)} />
      <Row label="can pause trading" value={boolLabel(risk.canPauseTrading)} />
      <Row label="checked" value={formatFreshness(risk.checkedAgeSec)} />
      {Array.isArray(risk.flags) && risk.flags.length > 0 && (
        <div style={styles.flagsBox}>
          {risk.flags.map((f: string, i: number) => (
            <span key={i} style={styles.flagChip}>{f}</span>
          ))}
        </div>
      )}
      {risk.summary && <div style={styles.dim}>{risk.summary}</div>}
    </Section>
  );
}

function DiscoveryCard({ p }: { p: any }) {
  const d = p.discovery;
  if (!d) return null;
  return (
    <Section title="Discovery">
      <Row label="agreement" value={d.agreement ?? "—"} />
      <Row label="primary source" value={d.primaryDiscoverySource ?? "—"} />
      <Row label="all sources" value={(d.discoverySources ?? []).join(", ") || "—"} />
      <Row label="first discovered" value={formatTs(d.firstDiscoveredAt)} />
      <Row label="last discovery event" value={formatTs(d.lastDiscoveryAt)} />
    </Section>
  );
}

// ── Presentational primitives ───────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      <span style={styles.rowValue}>{value ?? "—"}</span>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.metaItem}>
      <div style={styles.metaLabel}>{label}</div>
      <div style={styles.metaValue}>{value}</div>
    </div>
  );
}

function ConfidenceBadge({ value }: { value: string }) {
  const map: Record<string, React.CSSProperties> = {
    HIGH:   styles.badgeGreen,
    MEDIUM: styles.badgeAmber,
    LOW:    styles.badgeRed,
  };
  return <div style={{ ...styles.badge, ...(map[value] ?? styles.badgeGray) }}>confidence: {value}</div>;
}

function QualityBadge({ value }: { value: string }) {
  const map: Record<string, React.CSSProperties> = {
    fresh: styles.badgeGreen,
    aging: styles.badgeAmber,
    stale: styles.badgeRed,
  };
  return <div style={{ ...styles.badge, ...(map[value] ?? styles.badgeGray) }}>{value ?? "unknown"}</div>;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatFreshness(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "unknown";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function formatTs(ts: number | null | undefined): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
}

function formatUsd(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function boolLabel(v: unknown): string {
  if (v === true) return "yes";
  if (v === false) return "no";
  return "—";
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
  topbarNote: {
    color:    "#555",
    fontSize: "11px",
  },
  main: {
    maxWidth: "880px",
    margin:   "0 auto",
    padding:  "28px 20px 60px",
  },
  footer: {
    textAlign:    "center" as const,
    color:        "#444",
    fontSize:     "11px",
    padding:      "20px",
    borderTop:    "1px solid #161616",
  },
  card: {
    background:   "#0a0a0a",
    border:       "1px solid #1a1a1a",
    borderRadius: "10px",
    padding:      "22px 24px",
    marginBottom: "20px",
  },
  h1: {
    fontSize: "18px",
    margin:   "10px 0 6px",
    color:    "#fff",
  },
  dim: {
    color:    "#777",
    fontSize: "12.5px",
    lineHeight: "1.6",
  },
  strongLight: {
    color: "#c8c8c8",
  },
  headerRow: {
    display:        "flex",
    alignItems:     "flex-start",
    justifyContent: "space-between",
    gap:            "12px",
    flexWrap:       "wrap" as const,
  },
  pairAddr: {
    color:      "#fff",
    fontSize:   "15px",
    fontWeight: 600,
    wordBreak:  "break-all" as const,
    marginBottom: "4px",
  },
  badgeRow: {
    display: "flex",
    gap:     "8px",
    flexShrink: 0,
  },
  badge: {
    fontSize:      "10.5px",
    fontWeight:    700,
    padding:       "4px 9px",
    borderRadius:  "4px",
    letterSpacing: "0.03em",
    textTransform: "uppercase" as const,
    whiteSpace:    "nowrap" as const,
    border:        "1px solid transparent",
  },
  badgeGreen: { background: "#0d2016", border: "1px solid #0a3020", color: "#00ff88" },
  badgeAmber: { background: "#241a05", border: "1px solid #3a2a08", color: "#ffb020" },
  badgeRed:   { background: "#240a0a", border: "1px solid #3a0f0f", color: "#ff5c5c" },
  badgeGray:  { background: "#151515", border: "1px solid #222",   color: "#999" },
  metaRow: {
    display:      "flex",
    gap:          "28px",
    marginTop:    "18px",
    flexWrap:     "wrap" as const,
  },
  metaItem: {},
  metaLabel: {
    color:         "#555",
    fontSize:      "10.5px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    marginBottom:  "3px",
  },
  metaValue: {
    color:    "#ddd",
    fontSize: "13px",
  },
  notFoundNote: {
    marginTop:    "16px",
    padding:      "12px 14px",
    background:   "#0d0d0d",
    border:       "1px solid #1e1e1e",
    borderRadius: "6px",
    color:        "#888",
    fontSize:     "12px",
    lineHeight:   "1.6",
  },
  warningsBox: {
    marginTop:    "14px",
    padding:      "10px 14px",
    background:   "#1a1305",
    border:       "1px solid #3a2a08",
    borderRadius: "6px",
    color:        "#ffb020",
    fontSize:     "12px",
    lineHeight:   "1.7",
  },
  grid: {
    display:             "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap:                 "16px",
  },
  section: {
    background:   "#0a0a0a",
    border:       "1px solid #1a1a1a",
    borderRadius: "10px",
    padding:      "18px 20px",
  },
  sectionTitle: {
    color:         "#00ff88",
    fontSize:      "11px",
    fontWeight:    700,
    letterSpacing: "0.05em",
    textTransform: "uppercase" as const,
    marginBottom:  "14px",
  },
  row: {
    display:        "flex",
    justifyContent: "space-between",
    gap:            "12px",
    padding:        "5px 0",
    borderBottom:   "1px solid #121212",
    fontSize:       "12.5px",
  },
  rowLabel: {
    color: "#666",
  },
  rowValue: {
    color:      "#ddd",
    textAlign:  "right" as const,
    wordBreak:  "break-word" as const,
  },
  flagsBox: {
    display:  "flex",
    flexWrap: "wrap" as const,
    gap:      "6px",
    marginTop: "10px",
  },
  flagChip: {
    background:   "#1a0d0d",
    border:       "1px solid #2a1414",
    color:        "#ff8a8a",
    fontSize:     "10.5px",
    padding:      "3px 8px",
    borderRadius: "4px",
  },
};
