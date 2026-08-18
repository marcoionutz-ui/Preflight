/**
 * app/api/health/route.ts — PH-13 (endpoint extern de liveness/health, NEAUTENTICAT).
 *
 * Două utilizări (vezi `lib/health/liveness.ts` pt. semantica codului HTTP):
 *   - `GET /api/health`          → ținta Railway healthcheck. 200 cât timp web + Redis sunt ok; worker/WS-stale =
 *                                  `degraded` în body, DAR tot 200 (nu repornim un web sănătos pt. un worker stale).
 *   - `GET /api/health?strict=1` → ținta unui uptime monitor extern (UptimeRobot etc.): 503 ȘI pe `degraded`
 *                                  (worker stale / WS-zombie) → alertă prin polling. Redis jos → 503 pe ambele.
 *
 * COALESCING (cgpt #5): endpoint-ul e neautentificat și poll-uit des (2 monitoare × interval scurt). Fără protecție,
 * FIECARE request = 2 operații Redis. Coalescăm în-proces: semnalele Redis sunt citite cel mult o dată la
 * `COALESCE_MS`, iar request-urile concurente care nimeresc un „miss" partajează ACEEAȘI citire în zbor (o singură
 * dublă-MGET, nu una per request). Clasificarea (`computeLiveness`) rulează per-request pe semnalele partajate, ca
 * `?strict=1` și non-strict să dea coduri HTTP diferite din același snapshot. Header-ul rămâne `no-store` — cache-ul
 * e strict SERVER-side (coalescing), clientul/proxy-ul nu trebuie să cacheze un semnal de sănătate.
 */
import { NextResponse } from "next/server";
import { readHealthSignals } from "@/lib/health/readHealthSignals";
import { computeLiveness, type HealthSignals } from "@/lib/health/liveness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COALESCE_MS = 2_000;

// Cache + single-flight la nivel de modul (persistă între request-uri în același proces server).
let sigCache: { at: number; signals: HealthSignals } | null = null;
let inflight: Promise<HealthSignals> | null = null;

function readSignalsCoalesced(): Promise<HealthSignals> {
  const now = Date.now();
  if (sigCache && now - sigCache.at < COALESCE_MS) return Promise.resolve(sigCache.signals);
  if (inflight) return inflight;                     // un miss concurent se agață de citirea deja în zbor
  inflight = readHealthSignals()
    .then((signals) => { sigCache = { at: Date.now(), signals }; return signals; })
    .finally(() => { inflight = null; });
  return inflight;
}

export async function GET(req: Request): Promise<NextResponse> {
  const strict  = new URL(req.url).searchParams.get("strict") === "1";
  const signals = await readSignalsCoalesced();
  const report  = computeLiveness(signals, { strict });

  return NextResponse.json(
    { ...report, ts: new Date().toISOString() },
    { status: report.httpStatus, headers: { "Cache-Control": "no-store" } },
  );
}
