/**
 * app/demo/page.tsx
 *
 * Market overview — one card per chain (Base/Arbitrum/BSC/Ethereum/Solana).
 * Calls buildMarketOverviewReport() directly (cache-only, no live calls).
 * Each mover links into /demo/pair/[chain]/[address] — the "aha" screen.
 */

import Link from "next/link";
import { headers } from "next/headers";
import { buildMarketOverviewReport } from "@/lib/reports/market-overview-report";
import type { ChainOverview, MoverSummary, MarketOverviewReport } from "@/lib/reports/market-overview-report";
import { enforceRequestRate, admitBuildRequest, withBuildLease, resolveClientIp } from "@/lib/db/demoCache";
import type { DemoAction, DemoServedFrom } from "@/lib/db/demoCache";

export const dynamic = "force-dynamic";

const OVERVIEW_SLUG = "overview";

export default async function MarketOverviewPage() {
  // PH-11: (item 4) request-rate per-IP ÎNTÂI (orice request). Apoi admitBuildRequest decide: cache fresh/stale,
  // build sub single-flight + concurență + rate/buget, sau refuz ieftin. Build-ul rulează sub withBuildLease
  // (heartbeat owner-safe + publicare fenced + release în finally).
  const h  = await headers();
  const ip = resolveClientIp((n) => h.get(n));
  // FAIL-CLOSED: orice ≠ allow (limited SAU unavailable/Redis-down) → busy; NU construim (nici pentru URL invalid).
  const rate = await enforceRequestRate(ip);
  if (rate !== "allow") return <DemoBusy action={rate === "limited" ? "rate_limited" : "busy"} />;

  const admission = await admitBuildRequest(OVERVIEW_SLUG, ip);

  let report: MarketOverviewReport | null = null;
  if (admission.action === "build" && admission.leaseToken) {
    const res = await withBuildLease(OVERVIEW_SLUG, admission.leaseToken, () => buildMarketOverviewReport());
    if (res.built && res.report) report = res.report; // afișăm ce am calculat (chiar dacă publicarea a fost lost_lease)
  } else if ((admission.action === "serve_fresh" || admission.action === "serve_stale") && admission.payload) {
    report = admission.payload as MarketOverviewReport;
  }
  // rate_limited | busy | (serve fără payload valid) → notă ieftină.
  if (!report) return <DemoBusy action={admission.action} />;

  return (
    <div style={styles.page}>
      <header style={styles.topbar}>
        <Link href="/" style={styles.brand}>✈ PREFLIGHT</Link>
        <nav style={styles.navGroup}>
          <Link href="/docs/connect" style={styles.navLink}>Connect</Link>
          <Link href="/pricing" style={styles.navLink}>Pricing</Link>
          <span style={styles.topbarNote}>demo · cache-only · no live calls</span>
        </nav>
      </header>

      <main style={styles.main}>
        <h1 style={styles.h1}>Market Overview</h1>
        <p style={styles.subtitle}>
          Base-first. Multichain-aware. Coverage badges are honest about per-chain coverage —
          nothing here claims full firehose where it isn&apos;t.
        </p>

        <CacheBanner servedFrom={admission.servedFrom} ageSec={admission.cacheAgeSec} />

        {!report.ok && report.chains.length === 0 ? (
          <div style={styles.card}>
            <div style={{ ...styles.badge, ...styles.badgeRed }}>ERROR</div>
            <p style={styles.dim}>{report.errorMessage ?? "Could not load market overview."}</p>
          </div>
        ) : (
          <>
            {!report.ok && report.chains.length > 0 && (
              <div style={styles.partialWarning}>
                ⚠ Some EVM data unavailable — showing partial cached overview.
              </div>
            )}
            <div style={styles.grid}>
              {report.chains.map(c => (
                <ChainCard key={c.chain} chain={c} />
              ))}
            </div>
          </>
        )}
      </main>

      <footer style={styles.footer}>
        Preflight reports observed market context only. The agent decides.
      </footer>
    </div>
  );
}

// PH-11 (item 6): onestitatea prospețimii — când servim din cache (fresh/stale) marcăm EXPLICIT că valorile-s un
// snapshot cache-uit + vârsta lui; NU prezentăm un freshnessSec înghețat drept vârstă curentă. Build live → fără notă.
function fmtAge(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "recently";
  if (sec < 60)   return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}
function CacheBanner({ servedFrom, ageSec }: { servedFrom: DemoServedFrom; ageSec: number | null }) {
  if (servedFrom === "build" || servedFrom === "none") return null;
  const stale = servedFrom === "stale";
  return (
    <div style={stale ? styles.staleBanner : styles.cacheBanner}>
      {stale
        ? `⚠ Serving a cached fallback — the live demo is busy. Snapshot built ${fmtAge(ageSec)}; values below are not live.`
        : `Cached snapshot · built ${fmtAge(ageSec)}. Values below are a cached snapshot, not live.`}
    </div>
  );
}

// PH-11: notă IEFTINĂ (zero Redis, zero build) când suntem peste rate-limit per-IP sau peste bugetul global.
function DemoBusy({ action }: { action: DemoAction }) {
  const rateLimited = action === "rate_limited";
  return (
    <div style={styles.page}>
      <header style={styles.topbar}>
        <Link href="/" style={styles.brand}>✈ PREFLIGHT</Link>
        <span style={styles.topbarNote}>demo · cache-only · no live calls</span>
      </header>
      <main style={styles.main}>
        <div style={styles.card}>
          <div style={{ ...styles.badge, ...styles.badgeAmber }}>{rateLimited ? "SLOW DOWN" : "BUSY"}</div>
          <h1 style={styles.h1}>{rateLimited ? "Too many requests" : "Demo is busy right now"}</h1>
          <p style={styles.dim}>
            {rateLimited
              ? "You are refreshing faster than the public demo allows. Give it a few seconds and reload."
              : "The public demo is at capacity for a moment. Reload shortly — or connect your own agent for unthrottled access."}
          </p>
          <p style={styles.dim}>
            <Link href="/docs/connect" style={styles.navLink}>Connect your agent →</Link>
          </p>
        </div>
      </main>
      <footer style={styles.footer}>
        Preflight reports observed market context only. The agent decides.
      </footer>
    </div>
  );
}

function ChainCard({ chain }: { chain: ChainOverview }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div style={styles.chainName}>{displayChainName(chain.chain)}</div>
        <div style={styles.badgeRow}>
          <CoverageBadge value={chain.coverage} />
          <OnlineDot online={chain.online} />
        </div>
      </div>

      <div style={styles.metaRow}>
        <MetaItem label="tracked pairs" value={String(chain.trackedPairs)} />
        <MetaItem label="freshness" value={formatFreshness(chain.freshnessSec)} />
        <MetaItem label="confidence" value={chain.confidence} />
      </div>

      {chain.regime && (
        <div style={styles.regimeRow}>
          <RegimeBadge value={chain.regime.label} />
          <span style={styles.dim}>
            buying:{chain.regime.buyingPct}% selling:{chain.regime.sellingPct}% ws-coverage:{chain.regime.wsCoveragePct}%
          </span>
        </div>
      )}

      {(chain.pipeline.watching > 0 || chain.pipeline.hot > 0 || chain.pipeline.armed > 0) && (
        <div style={styles.pipelineRow}>
          <span style={styles.pipelineItem}>watching:{chain.pipeline.watching}</span>
          <span style={styles.pipelineItem}>hot:{chain.pipeline.hot}</span>
          <span style={styles.pipelineItem}>armed:{chain.pipeline.armed}</span>
        </div>
      )}

      {chain.note && <div style={styles.note}>{chain.note}</div>}

      <div style={styles.moversSection}>
        <div style={styles.moversLabel}>
          {chain.movers.length > 0 ? "Movers" : "No movers yet"}
        </div>
        {chain.movers.map(m => (
          <MoverRow key={m.pairAddress} chain={chain.chain} mover={m} />
        ))}
      </div>
    </div>
  );
}

function MoverRow({ chain, mover }: { chain: string; mover: MoverSummary }) {
  return (
    <Link href={`/demo/pair/${chain}/${mover.pairAddress}`} style={styles.moverRow}>
      <span style={styles.moverSymbol}>{mover.symbol}</span>
      <span style={styles.moverChanges}>
        {mover.priceChange5m !== null && (
          <span style={pctStyle(mover.priceChange5m)}>5m:{formatPct(mover.priceChange5m)}</span>
        )}
        {mover.priceChange1h !== null && (
          <span style={pctStyle(mover.priceChange1h)}>1h:{formatPct(mover.priceChange1h)}</span>
        )}
        {mover.priceChange24h !== null && (
          <span style={pctStyle(mover.priceChange24h)}>24h:{formatPct(mover.priceChange24h)}</span>
        )}
      </span>
    </Link>
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

function CoverageBadge({ value }: { value: string }) {
  const map: Record<string, React.CSSProperties> = {
    IMPLEMENTED: styles.badgeGreen,
    SHADOW:      styles.badgeAmber,
    SAMPLED:     styles.badgeGray,
  };
  return <div style={{ ...styles.badge, ...(map[value] ?? styles.badgeGray) }}>{value}</div>;
}

function RegimeBadge({ value }: { value: string }) {
  const map: Record<string, React.CSSProperties> = {
    RISK_ON:  styles.badgeGreen,
    RISK_OFF: styles.badgeRed,
    MIXED:    styles.badgeAmber,
    DEAD:     styles.badgeGray,
  };
  return <div style={{ ...styles.badge, ...(map[value] ?? styles.badgeGray) }}>{value}</div>;
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      title={online ? "worker online" : "worker offline / stale"}
      style={{ ...styles.dot, background: online ? "#00ff88" : "#444" }}
    />
  );
}

function displayChainName(chain: string): string {
  return chain === "eth" ? "ETHEREUM" : chain.toUpperCase();
}

function formatFreshness(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "unknown";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function formatPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function pctStyle(v: number): React.CSSProperties {
  return { color: v > 0 ? "#00ff88" : v < 0 ? "#ff5c5c" : "#999" };
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
    display:    "flex",
    alignItems: "center",
    gap:        "18px",
  },
  navLink: {
    color:          "#888",
    fontSize:       "12px",
    textDecoration: "none",
  },
  topbarNote: {
    color:    "#555",
    fontSize: "11px",
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
    margin:     "0 0 24px",
    maxWidth:   "640px",
  },
  footer: {
    textAlign:  "center" as const,
    color:      "#444",
    fontSize:   "11px",
    padding:    "20px",
    borderTop:  "1px solid #161616",
  },
  grid: {
    display:             "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap:                 "16px",
  },
  partialWarning: {
    background:   "#1a1305",
    border:       "1px solid #3a2a08",
    borderRadius: "6px",
    color:        "#ffb020",
    fontSize:     "12px",
    padding:      "10px 14px",
    marginBottom: "16px",
  },
  staleBanner: {
    background:   "#1a1305",
    border:       "1px solid #3a2a08",
    borderRadius: "6px",
    color:        "#ffb020",
    fontSize:     "12px",
    padding:      "10px 14px",
    marginBottom: "16px",
  },
  cacheBanner: {
    background:   "#0a0a0a",
    border:       "1px solid #1a1a1a",
    borderRadius: "6px",
    color:        "#777",
    fontSize:     "11.5px",
    padding:      "8px 14px",
    marginBottom: "16px",
  },
  card: {
    background:   "#0a0a0a",
    border:       "1px solid #1a1a1a",
    borderRadius: "10px",
    padding:      "20px 22px",
  },
  cardHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   "16px",
  },
  chainName: {
    color:         "#fff",
    fontSize:      "14px",
    fontWeight:    700,
    letterSpacing: "0.04em",
  },
  badgeRow: {
    display:    "flex",
    alignItems: "center",
    gap:        "8px",
  },
  dot: {
    width:        "8px",
    height:       "8px",
    borderRadius: "50%",
    display:      "inline-block",
  },
  metaRow: {
    display:      "flex",
    gap:          "22px",
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
  regimeRow: {
    display:      "flex",
    alignItems:   "center",
    gap:          "10px",
    marginBottom: "12px",
    flexWrap:     "wrap" as const,
  },
  pipelineRow: {
    display:      "flex",
    gap:          "14px",
    marginBottom: "12px",
  },
  pipelineItem: {
    color:    "#999",
    fontSize: "11.5px",
  },
  note: {
    color:        "#888",
    fontSize:     "11px",
    lineHeight:   "1.6",
    marginBottom: "12px",
    fontStyle:    "italic" as const,
  },
  badge: {
    fontSize:      "10px",
    fontWeight:    700,
    padding:       "3px 8px",
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
  moversSection: {
    borderTop: "1px solid #141414",
    paddingTop: "12px",
  },
  moversLabel: {
    color:         "#555",
    fontSize:      "10px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    marginBottom:  "8px",
  },
  moverRow: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "6px 0",
    borderBottom:   "1px solid #101010",
    textDecoration: "none",
    color:          "inherit",
    fontSize:       "12px",
  },
  moverSymbol: {
    color: "#ccc",
  },
  moverChanges: {
    display: "flex",
    gap:     "10px",
    fontSize: "11px",
  },
  dim: {
    color:      "#777",
    fontSize:   "11.5px",
  },
};
