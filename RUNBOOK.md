# Preflight — Operations Runbook

Operational reference for running Preflight in production. Two long-lived services:

| Service | What it is | HTTP? | Deploy |
|---|---|---|---|
| `mcp` | Next.js app: OAuth + MCP endpoint + public demo + **health endpoint** | Yes | Railway web service |
| `worker-evm` | EVM worker: WS ingestion + scan/pipeline loops, writes state to Redis | No | Railway worker service |

Both share one Redis. The worker has **no HTTP surface** — its liveness is observed indirectly through the freshness of what it writes to Redis, surfaced by the health endpoint below.

---

## Scope of the health endpoint (read this first)

The health endpoint covers **only the `mcp` web service + the `evm` worker** (`scope: "mcp-web + evm-worker"`, echoed in every response body). It does **not** verify the Solana indexer or any other subsystem — a green health check is **not** a claim that the whole multichain product is healthy, only that the EVM path (web + worker + its WS ingestion) is. If/when other subsystems get their own liveness, extend the classifier and this scope string together.

---

## Expected chains (chain completeness)

The endpoint reports on a configured list of **expected** EVM chains, **not** merely on whatever happens to still exist in Redis. A chain that is expected but has lost **both** of its Redis keys (snapshot + runtime) is reported as **stale / degraded** — it is never silently skipped. This is the difference between `expectedChains` (what we require) and `observedChains` (what actually has a footprint in Redis).

Configured via env, resolved in this order:

| Env | Meaning | Default |
|---|---|---|
| `HEALTH_EXPECTED_CHAINS` | Explicit list for the health endpoint (comma-separated, e.g. `base,arbitrum`). | — |
| `ENABLED_CHAINS` | Fallback: the worker's own chain list (keeps health aligned with what the worker actually runs). | — |
| *(built-in)* | Final fallback if neither is set. | `base,arbitrum` |
| `HEALTH_WS_ENABLED` | `0` disables WS evaluation (scan-only modes) → WS reported `disabled`, never penalized. Any other value = WS expected. | enabled |

**Keep `HEALTH_EXPECTED_CHAINS` (or `ENABLED_CHAINS`) on the `mcp` service aligned with the worker's `ENABLED_CHAINS`.** If the worker runs `base,arbitrum,bsc` but health only expects `base,arbitrum`, a dead BSC worker would go unnoticed. Values are normalized + validated against the known EVM chains; unknown tokens are dropped.

---

## Health endpoint (`GET /api/health`)

Unauthenticated, cheap (two bounded Redis `MGET`s over the expected chains), `Cache-Control: no-store`. To keep an unauthenticated, frequently-polled endpoint from turning every request into two Redis ops, the reader is **coalesced in-process**: signals are read at most once per ~2s and concurrent requests share one in-flight read. The `no-store` header is unchanged — the coalescing is server-side only; clients/proxies must not cache a liveness signal.

### Status values (body `status`)

- **`ok`** — web up, Redis reachable, worker snapshots fresh on **all expected** chains, WS healthy on all expected chains.
- **`degraded`** — web + Redis are fine, but the **worker** is stale (missing/old snapshot on an expected chain, or no expected chains configured) **or** a **WS problem** exists (see WS states below). The web service itself is healthy.
- **`down`** — **Redis is unreachable**; the web service cannot function.

### WS states (per expected chain, honest)

Each expected chain gets an explicit WS state — we do **not** report "subscriptions healthy" without positive evidence:

| `wsState` | Meaning | Surfaced in |
|---|---|---|
| `healthy` | Connected, transport proven live (fresh pong), no stale subscriptions. | — |
| `suspected_stale` | Connected + a subscription looks like a **zombie** (a sibling kind delivers, but this one has gone silent past threshold), **or** transport not proven (pong missing/expired). | `wsStaleSubs` (`chain:kind`, e.g. `base:v2`) |
| `disconnected` | Worker reports the socket is not connected. | `wsUnavailableChains` |
| `unknown` | Runtime record absent / invalid / expired — we can't prove the socket is alive, so we **don't** claim it is. | `wsUnknownChains` |
| `disabled` | WS not expected (`HEALTH_WS_ENABLED=0`); not penalized. | — |

A quiet-but-alive market is **not** turned into a zombie: a connected socket with a fresh pong and no cross-kind stale evidence stays `healthy`.

### HTTP status — two modes

- **`GET /api/health`** → **200** for `ok` and `degraded`, **503** for `down`.
  This is the **Railway healthcheck target** for the `mcp` service. It stays 200 when only the *worker*/WS is degraded, so Railway does **not** restart a healthy web app because of a worker/WS problem (different service).
- **`GET /api/health?strict=1`** → **503** also for `degraded`, 200 only for `ok`.
  This is the **external uptime-monitor target**. Point an HTTP monitor here to get alerted (by status code) when the worker or WS goes unhealthy.

### Body fields

```
{
  "status": "ok" | "degraded" | "down",
  "httpStatus": 200 | 503,
  "scope": "mcp-web + evm-worker",
  "checks": { "web": {...}, "redis": {...}, "worker": {...}, "ws": {...} },
  "worstSnapshotAgeSec": <number|null>,   // oldest snapshot among expected chains
  "expectedChains": [...],                 // chains we require (from env)
  "observedChains": [...],                 // expected chains that actually have a Redis footprint
  "staleChains": [...],                    // expected chains missing/too-old snapshot
  "wsStaleSubs": ["base:v2", ...],         // "chain:kind" suspected-stale (zombie) subscriptions
  "wsUnavailableChains": [...],            // wsState = disconnected
  "wsUnknownChains": [...],                // wsState = unknown (runtime missing/expired)
  "ts": "<ISO timestamp>"
}
```

Freshness threshold: worker snapshot older than **300s** on the weakest expected chain → worker stale (tunable: `HEALTH_WORKER_FRESH_SEC` in `mcp/lib/health/liveness.ts`).

---

## Wiring monitors

**Railway healthcheck (mcp web service).** Set the healthcheck path to `/api/health`. It returns 200 whenever the web app + Redis are up. Do **not** use `?strict=1` here — you don't want Railway cycling the web app because the worker is briefly stale.

**External uptime + alerting (poll-based — no push from code).** Configure an uptime monitor (UptimeRobot, Better Uptime, Pingdom, etc.) against:

- `https://<host>/api/health?strict=1` — alerts on **HTTP 503** (fires on `down` *and* `degraded`, i.e. Redis down **or** worker stale **or** WS problem), **or**
- `https://<host>/api/health` with **keyword monitoring**: alert when the body no longer contains `"status":"ok"` (lets you keep the 200 healthcheck and still alert on `degraded`).

### External monitor — required setup + controlled test (operational gate)

The push side of alerting lives **outside** the codebase; it must be created and verified manually. This is an operator step (it can't be provisioned from the app):

1. **Create** a monitor targeting `https://<host>/api/health?strict=1`.
2. **Interval** 1–2 min; **alert after N consecutive failures** (recommend N=2–3) to avoid flapping on a single blip.
3. **Notifications**: set the alert channel (email / Slack / SMS) **and** enable the **recovery** notification, so you're told when it returns to healthy.
4. **Controlled test — confirm the alert actually fires** (do this once, in a maintenance window):
   - Stop the `worker-evm` service (or point `HEALTH_EXPECTED_CHAINS` at a chain the worker isn't writing). Within the worker freshness window (~300s) `?strict=1` should start returning **503** / body `status: degraded`, `staleChains` non-empty.
   - Verify the monitor fires an alert to the configured channel after N probes.
   - Restore the worker; verify the **recovery** notification arrives and `status` returns to `ok`.
   - Record the tested monitor + channel here so the next operator knows alerting is proven, not assumed.

Recommended baseline: one Railway healthcheck on `/api/health`, plus one external monitor on `/api/health?strict=1` at a 1–2 min interval with a short alert delay, **tested** per step 4.

---

## What the signals mean + remediation

**`worker` stale / `staleChains` non-empty.** The worker isn't writing fresh snapshots for an expected chain (or the chain lost both Redis keys entirely). Causes: worker process down/crashed, Redis write failures, the chain's ingestion wedged, or a mismatch between `HEALTH_EXPECTED_CHAINS` and the worker's `ENABLED_CHAINS`. Checks: is the `worker-evm` service running? Do the expected-chains envs match on both services? Worker logs for crashes/errors? Redis reachable from the worker? Remediation: restart the worker service (graceful — see below); it reloads memory from Redis and resumes.

**`wsStaleSubs` non-empty (`chain:kind`, e.g. `base:v2`).** A WS subscription's transport looks alive (recent pong) but its data stream has been silent past the stale threshold while a sibling subscription is delivering — a suspected **zombie subscription** (the exact class the D1 watchdog + Part A/B observability were built to catch). Remediation: the worker's heartbeat watchdog should `terminate()` a fully-zombie socket and reconnect automatically; if `wsStaleSubs` persists across reconnects, restart the worker and/or check the WS provider status.

**`wsUnavailableChains` non-empty (`disconnected`).** The worker reports the socket is down for that chain — reconnect/backoff should be in progress. Persistent → check the WS provider and the worker's reconnect logs.

**`wsUnknownChains` non-empty (`unknown`).** No valid runtime record for that chain (missing/expired/invalid) — we can't prove WS is alive. Usually means the worker isn't publishing runtime for that chain (worker down there, or chain not actually running). Cross-check against `staleChains`.

**`status: down` (Redis unreachable).** Both the web app and worker are impaired. Check the Redis service/credentials (`REDIS_URL`) and network. This is the only condition where the plain `/api/health` returns 503.

---

## Graceful shutdown (worker)

On **SIGTERM** or **SIGINT** (Railway redeploy, scale-down, Ctrl-C) the worker runs a **truly ordered** shutdown before exiting, so nothing is lost and no socket lingers:

1. **Raise the global shutdown flag** immediately — blocks new scans/loops from starting, guards `connectChainWebSocket()` at entry, and gates the WS `open`/`message`/`close` handlers (a socket that closes during shutdown is **not** reconnected; a late `open`/`message` does not (re)subscribe or mutate memory).
2. **Stop all intervals** — scan, pipeline loops, eth-price refresh, and the periodic save all stop; no new work is queued.
3. **Close all WS sockets** (`closeAllWebSockets`, **async + bounded**) — first cancels all pending reconnect/stability timers, then for each socket sends a clean close and **awaits** the `close` event; if the handshake doesn't finish within a short per-socket timeout it falls back to `terminate()`. Awaiting matters: it guarantees no WS handler can still be mutating memory when we snapshot.
4. **Drain in-flight jobs** — wait (≤5s) for any tracked work already running (scan/loops, eth-price refresh, periodic save, async startup restore, in-flight WS message handlers) to finish, so we don't persist a half-written memory. If the drain **times out**, that is **not** a graceful stop → the process will exit `1` (see below), but we still attempt the snapshot rather than abandon state.
5. **Persist memory — strict** (`saveMemoryToRedisStrict`): throws if Redis is missing, propagates errors, and checks each `pipeline.exec()` result. A failed persist → **exit 1** (never a false success).
6. **Close Redis** (`closeRedis`) after a confirmed persist.

**Exit code is honest — `exit 0` (clean shutdown) only when ALL of the following held:** WS sockets were closed, the drain **finished** (not timed out), the strict snapshot **succeeded**, and Redis closed without error. **Any** of these produces **`exit 1`:** drain timeout, snapshot failure (incl. Redis missing / pipeline error), or a Redis-close failure. On `exit 1` we still try the snapshot + Redis close (don't abandon state) — we just don't report success we didn't achieve.

Guarantees:

- **Hard deadline (10s):** if any step hangs, the process force-exits `1` — it never blocks a redeploy. The deadline is the final authority over the WS-close/drain/persist steps.
- **Idempotent:** a second signal during shutdown forces an immediate exit (`double Ctrl-C` / insistent SIGTERM = "exit now").
- The periodic 60s save stays **best-effort** (a transient Redis blip shouldn't crash the worker between snapshots); only the final shutdown save is strict.

Implementation: lifecycle registry + ordered sequence in `workers/evm/src/lib/lifecycle.ts` (`markShuttingDown`, `trackInterval`/`clearAllIntervals`, `beginJob`/`waitForDrain`, `closeSocketsBounded`, `runShutdownSequence` — deps-injected + unit-tested), WS teardown/guards in `workers/evm/src/ws/manager.ts`, signal handling in `workers/evm/src/lib/shutdown.ts`, wired in `workers/evm/src/index.ts`.

---

## Common failure modes (quick reference)

| Symptom | Likely cause | First check | Action |
|---|---|---|---|
| `/api/health` = 503, `status: down` | Redis unreachable | `REDIS_URL`, Redis service | Restore Redis; both services recover |
| `?strict=1` = 503, `status: degraded`, `staleChains` set | Worker down/stale, or expected-chains mismatch | `worker-evm` running? `ENABLED_CHAINS` vs `HEALTH_EXPECTED_CHAINS`? worker logs | Restart worker (graceful) / align envs |
| `wsStaleSubs` set, snapshots fresh | Zombie WS subscription | Worker WS/reconnect logs | Auto-heals; restart worker if persistent; check WS provider |
| `wsUnavailableChains` / `wsUnknownChains` set | Socket disconnected / no runtime record | Worker WS logs; is the chain actually running? | Auto-reconnect; restart worker if persistent |
| Demo pages return "busy" | Redis down or demo budget/rate hit | `/api/health`, demo limits | See PH-11 demo protection (`lib/demo/demoGuard.ts`) |
| Redeploy hangs | (should not) shutdown deadline is 10s | Worker shutdown logs | Force-exit is automatic after 10s |

---

*Health classifier: `mcp/lib/health/liveness.ts` (pure, tested). Signal reader: `mcp/lib/health/readHealthSignals.ts`. Endpoint (coalesced): `mcp/app/api/health/route.ts`. Graceful shutdown: `workers/evm/src/lib/lifecycle.ts` + `workers/evm/src/lib/shutdown.ts`, wired in `workers/evm/src/index.ts`.*
