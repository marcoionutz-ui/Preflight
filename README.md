# Preflight

**Base-first, real-time DEX intelligence for AI trading agents.**

Preflight transforms noisy DEX activity on Base into compact, verifiable context that
AI trading agents can query through MCP. Base is the launch network and default
deployment target. The same architecture also supports Arbitrum, BSC, Ethereum, and
Solana as later expansion paths.

**Preflight reports. The agent decides.**

---

## Current status

Preflight is a working pre-launch system validated locally and in CI. Its production
services are intentionally parked while public-beta hardening and the Base canary
deployment are completed. The core Base path already exists end to end: discovery,
indexing, Redis-backed state, compressed MCP reports, OAuth onboarding, quota controls,
and service health checks.

## Why Base

Base combines active onchain markets, low-cost execution, and a growing ecosystem of
AI agents. Preflight's first public-beta configuration will run the complete
discovery → intelligence → MCP flow on Base. Multichain support is an expansion path;
Base is the launch network and default product experience.

---

## What it is

- A real-time DEX monitoring and indexing layer using own-source EVM/Solana indexers, GeckoTerminal, DexScreener, and Alchemy WebSockets
- A Redis-backed state machine tracking pair pipeline: `WATCHING → HOT → ARMED`, with drops and confirmation outcomes tracked separately
- An MCP server exposing compressed market context to AI agents
- A data layer — not a decision layer

## What it is NOT

- Not a trading bot
- Not a signal provider
- Not an advisor
- Not a buy/sell signal service
- Does not execute trades
- Does not manage positions
- Does not recommend entries, exits, or position sizes

Preflight describes `market state`, `pipeline state`, `flow quality`, `risk flags`, `freshness`, `coverage`, and `next verification step`.

---

## Architecture

```
GeckoTerminal / DexScreener / Alchemy WS
                    │
                    ▼
                EVM Worker ──────────────┐
                                         │
EVM RPC logs → Own-source EVM Indexer ───┼──→ Redis  →  MCP Server  →  Agent
                                         │
Solana logs → Solana Indexer ───────────┘
```

One EVM worker codebase can run one or more chains depending on `ENABLED_CHAINS`.
For production, workers can be deployed separately per chain on Railway. The own-source
EVM indexer (`workers/indexer-evm/`) and the Solana indexer (`workers/solana/`) are
separate processes that write pair/pool state directly into the same Redis namespace
the EVM worker and MCP server read from.

---

## Agent loop

```
tp_situation_report → tp_next_action → tp_candidate_brief → tp_late_move_context → tp_preflight_safety → tp_next_action
```

### Core tools (public)

| Tool | What it returns |
|------|-----------------|
| `tp_situation_report` | Global market overview — pipeline state across all chains, ARMED first, coverage confidence |
| `tp_next_action` | Routing context — tells the agent which tool to call next and why |
| `tp_candidate_brief(pair)` | Full narrative case file for a specific pair — discovery provenance, flow, risk, sourceAgreement |
| `tp_late_move_context(pair)` | Late-move evidence — detects HOT flapping, faded flow, distribution pressure, and elevated extension risk |
| `tp_preflight_safety(pair)` | Contract/token safety check via GoPlus |
| `tp_watch_pair(pair, chain)` | Submit an external pair for Preflight monitoring |

### Advanced / internal tools

`tp_chain_report`, `tp_pair_context`, `tp_worker_pipeline`, `tp_worker_snapshot`,
`tp_why_not`, `tp_recent_pipeline_drops`, `tp_position_context`, `tp_health_check`, `tp_market_overview`

---

## Cost philosophy

> Agents should not scan everything. Agents should ask where to look.

Preflight pre-filters thousands of pairs so the agent only reasons about a handful.
Fewer tool calls, fewer LLM tokens, and more focused context.

---

## Illustrative MCP output

```
SITUATION REPORT — Base + Arbitrum + BSC
Tracked: 281 | Watching: 56 | Hot: 2 | Armed: 1

ARMED:
  TOKEN [base] — pair:0xabc...123
  Flow: BUYING | buyVol5m:$397 | sells:0 | lpCoverage:V2_NO_EVENTS_5M | age:4m
  sourceAgreement: MULTI_DISCOVERY_SOURCES

COVERAGE_CONFIDENCE: MEDIUM
geckoHealth: OK | dexscreenerHealth: OK | wsHealth: ACTIVE
```

---

## Stack

- **Worker**: TypeScript, `tsx`, Alchemy WebSockets, GeckoTerminal, DexScreener
- **State**: Redis (ephemeral pipeline state)
- **Auth**: OAuth Authorization Code + PKCE, client credentials
- **MCP**: Next.js MCP server via `mcp-handler`, designed for reproducible Railway deployment
- **Persistent config**: Supabase (`oauth_clients`, usage logs)
- **Chains**: Base (public-beta launch target) — Arbitrum and BSC (implemented) — Ethereum (shadow-worker path) — Solana (implemented with sampled coverage via a separate indexer)

---

## Monorepo structure

```
mcp/                        Next.js MCP server
workers/evm/                EVM worker (Base, Arbitrum, BSC) — discovery + pipeline
  config/                   Chain config + env
  sources/                  GeckoTerminal, DexScreener
  pipeline/                 WATCHING → HOT → ARMED logic
  risk/                     Contract risk, LP tracking
  ws/                       Alchemy WebSocket subscriptions
  shadow/                   Legacy/internal simulation artifacts — not part of public Preflight product
workers/indexer-evm/        Own-source EVM indexer (pair discovery, V2/V3/V4 pricing)
workers/solana/             Solana worker — log-subscribe discovery, CPMM/CLMM pools,
                             pump.fun launches, price/movers tracking
packages/preflight-schema/  Shared TypeScript types
packages/gecko-client/      GeckoTerminal client stub
packages/risk-layer/        Shared risk primitives
```

---

## Running locally

```bash
# Install exactly from the lockfile
npm ci

# Worker (Base only)
ENABLED_CHAINS=base npm run dev --workspace=@preflight/worker-evm

# MCP server
npm run dev --workspace=@preflight/mcp
```

### Environment variables

```
# Required
REDIS_URL

# Base
ALCHEMY_BASE_RPC
ALCHEMY_BASE_WS

# Arbitrum
ALCHEMY_ARB_RPC
ALCHEMY_ARB_WS

# BSC
ALCHEMY_BNB_RPC
ALCHEMY_BNB_WS

# Ethereum (shadow worker — also requires ENABLED_CHAINS=...ethereum
# and INDEXER_ENABLE_ETHEREUM=1 to activate)
ALCHEMY_ETH_RPC
ALCHEMY_ETH_WS

# Solana (one of SOLANA_RPC_URL / HELIUS_RPC_URL / ALCHEMY_SOLANA_RPC_URL)
SOLANA_RPC_URL
SOLANA_WS_URL

# MCP / Auth (Supabase)
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

# Optional
GOPLUS_API_KEY
```

---

*Base-first public beta in preparation · multichain architecture implemented*
