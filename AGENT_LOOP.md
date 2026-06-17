# Preflight — Agent Loop Documentation

**Preflight reports. The agent decides.**

Preflight is a real-time DEX monitoring layer for AI trading agents.
It compresses thousands of tracked pairs down to a handful of candidates,
so the agent reasons over signal — not noise.

---

## Core agent loop

```
tp_situation_report → tp_next_action → tp_candidate_brief → tp_chase_risk → tp_preflight_safety → tp_next_action
```

Start every session with `tp_situation_report`. It gives you a full snapshot:
pipeline state, ARMED/HOT candidates, market regime, coverage confidence, and recent drops.

Then call `tp_next_action` to get routed to the most relevant tool based on current state.

---

## Example: Standard agent session

```
User: Check what's happening in the market.

Agent calls: tp_situation_report

Returns:
  WORKER: ✅ v5.50 | data:12s
  MARKET: 🟢 RISK_ON | buying:34% | chains:base+arbitrum+bsc
  PIPELINE: watching:56 | hot:2 | armed:1 | gatePassed:3
  COVERAGE_CONFIDENCE: MEDIUM
  COMPRESSION: 281 tracked → 56 watching → 2 hot → 1 priority

  ⚡ ARMED:
    → TOKEN [base] pair:0xabc...123 score:82 age:18s flow:BUYING

  🔥 HOT:
    → DOGE2 [arbitrum] pair:0xdef...456 age:45s buys:12
    → PEPE3 [bsc] pair:0xghi...789 age:22s buys:8

  STATUS: ARMED candidate active. Next verification: tp_candidate_brief + tp_preflight_safety.

Agent calls: tp_next_action

Returns:
  PRIORITY: ARMED — priority candidate present
  NEXT_CHECK:
    1. tp_candidate_brief(0xabc...123) — full context
    2. tp_preflight_safety(0xabc...123) — contract check

Agent calls: tp_candidate_brief(0xabc...123)

Returns:
  [full narrative case file — flow, risk, discovery, timing, sourceAgreement]

Agent calls: tp_chase_risk(0xabc...123)

Returns:
  [late-chase risk assessment — flapping, distribution, failed confirmations]

Agent calls: tp_preflight_safety(0xabc...123)

Returns:
  [contract safety — honeypot, sell tax, owner risk, GoPlus data]

Agent: [reasons over all context, makes its own decision]
```

---

## Example: Watch an external pair

```
User: I want to monitor 0xdef...999 on Base.

Agent calls: tp_watch_pair(pair_address="0xdef...999", chain="base", reason="user supplied")

Returns:
  WATCH REQUEST: 0xdef...999 [base]
  STATUS: queued for monitoring
  NEXT_CHECK: re-run tp_situation_report or tp_next_action after the next worker refresh
  NOTE: pair must pass watch gates to enter pipeline — not guaranteed

Agent rechecks with: tp_situation_report or tp_next_action

If the pair enters HOT/ARMED, use tp_candidate_brief(pair).
Advanced/internal agents with read:all may also call tp_pair_context(pair).
```

---

## Example: Investigate why a pair isn't hot

```
Agent calls: tp_why_not(pair_address="0xabc...456")

Returns:
  WHY NOT HOT/ARMED: TOKEN
  Current pipeline state: NONE
  Recently dropped from HOT (47s ago):
  • Reason: flow faded: NEUTRAL buys:2/5

  LAST_OUTCOME: DROPPED | 47s ago | from:HOT
    reason: flow faded: NEUTRAL
    candidateActive: false
```

---

## Tool reference

| Tool | Credits | Scope | What it returns |
|------|---------|-------|-----------------|
| `tp_situation_report` | 1 | read:basic | Global pipeline snapshot + compression metric |
| `tp_next_action` | 1 | read:basic | Routing signal — which tool to call next |
| `tp_candidate_brief(pair)` | 2 | read:basic | Full narrative case file for a specific pair |
| `tp_chase_risk(pair)` | 2 | read:basic | Late-chase risk assessment |
| `tp_preflight_safety(pair)` | 5 | read:basic | Contract/token safety check via GoPlus |
| `tp_watch_pair(pair, chain)` | 3 | read:basic | Submit external pair for monitoring |
| `tp_health_check` | 1 | read:all | Worker health + Redis key freshness |
| `tp_pair_context(pair)` | 2 | read:all | Raw worker context + risk + lifecycle |
| `tp_worker_pipeline` | 2 | read:all | Full pipeline JSON — ARMED + HOT + WATCHING |
| `tp_why_not(pair)` | 2 | read:all | Why a pair is not HOT/ARMED + last outcome |
| `tp_chain_report(chain)` | 1 | read:all | Per-chain drilldown |
| `tp_do_not_chase` | 2 | read:all | Recent drops — anti-FOMO context |
| `tp_market_overview` | 1 | read:all | Market regime + flow pressure |
| `tp_worker_snapshot` | 2 | read:all | Pair memory with filters + pagination |
| `tp_position_context` | 2 | read:all | Context for user-supplied positions |

---

## System prompt for Claude agent

```
You are a market research agent with access to Preflight — a real-time DEX monitoring system.

Preflight tracks pair activity across Base, Arbitrum, and BSC. It reports pipeline state,
flow quality, risk flags, and discovery provenance. It does NOT give buy/sell signals.
You make all decisions independently based on the data Preflight provides.

Start every session with tp_situation_report to get current market state.
Use tp_next_action to navigate to the most relevant tool.
Always verify ARMED/HOT candidates with tp_candidate_brief + tp_chase_risk + tp_preflight_safety
before drawing any conclusions.

Preflight reports. You decide.
```

---

## Coverage and freshness

Preflight data has TTLs:
- `pair_states`: 120s — live worker data
- `pipeline maps` (watch/hot/armed): 120s
- `lifecycle outcomes`: 600s
- `recent drops`: 600s

`COVERAGE_CONFIDENCE` in `tp_situation_report` reflects WS flow coverage:
- **HIGH**: >50% of tracked pairs have WS flow data
- **MEDIUM**: 10-50% coverage
- **LOW**: <10% — treat flow signals with lower confidence

---

*v5.50 — Base + Arbitrum + BSC live*