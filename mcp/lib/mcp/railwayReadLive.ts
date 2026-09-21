/**
 * lib/mcp/railwayReadLive.ts — PH-12 12.6 leaf 2b-3: compoziție READ-ONLY (preview de plan din starea live Railway).
 *
 * Leagă cele trei piese pure comise anterior într-un singur pas de OBSERVABILITATE, FĂRĂ NICIO mutație:
 *
 *   readSnapshot(manifest) ──▶ RailwaySnapshot          (client 2b-2, transport injectat de runner)
 *        │
 *        └─ mapRailwaySnapshotToRawState(snapshot) ──▶ RawState   (model 2b-1)
 *                 │
 *                 └─ planFromRaw(rawState, target, caps) ──▶ TransitionPlan   (planner leaf 1, caps = bindRoleCaps leaf 2a)
 *                          │
 *                          └─ formatPlanLines / planSummary ──▶ PREVIEW (text + rezumat)
 *
 * READER INJECTAT (nu transport direct): `readLiveState` primește un `SnapshotReader` → hermetic-testabil cu snapshot-uri
 * construite de mână (fără a reconstrui o lume GraphQL). Runner-ul `.mjs` leagă reader-ul real (`readRailwaySnapshot` + transport).
 *
 * ⚠️ READ-ONLY STRICT: acest modul NU aplică NIMIC (nu pornește/oprește servicii, nu scrie env). Produce DOAR un preview.
 * **Preview-ul NU e input reutilizabil pentru apply (2c):** apply-ul TREBUIE să RECITEASCĂ + REPLĂNUIASCĂ imediat înainte de
 * orice mutație (starea live se poate schimba între preview și apply — commit fără redeploy, alt operator etc.).
 *
 * ANTI-LEAK: rezultatul și render-ul poartă DOAR coduri statice + `ServiceId` (rol intern) + nume de query — niciodată o
 * valoare de env, un status brut, o comandă, un path sau un token (moștenit din contractele client/model/planner).
 */

import type { ClientResult, ClientRejectReason, ReadOptions } from "./railwayReadClient";
import { mapRailwaySnapshotToRawState } from "./railwayReadModel";
import type { RailwayManifest, MapRejectReason, MapDiagnostic } from "./railwayReadModel";
import { planFromRaw, formatPlanLines, planSummary } from "./profilePlan";
import type { Caps, ProfileName, TransitionPlan } from "./profilePlan";

/** Reader injectat: runner-ul leagă `(m, o) => readRailwaySnapshot(transport, m, o)`; testele injectează un fake. */
export type SnapshotReader = (manifest: RailwayManifest, opts?: ReadOptions) => Promise<ClientResult>;

/** Motiv de eșec la stadiul de citire: refuzul clientului SAU un backstop dacă reader-ul (de încredere) totuși aruncă. */
export type ReadStageReason = ClientRejectReason | { readonly kind: "reader_error" };

// O SINGURĂ sursă de adevăr: rezultatul OK poartă DOAR `plan` (+ `target` + diagnostice). `lines`/`summary` NU se stochează —
// sunt funcții PURE de `plan` (`formatPlanLines`/`planSummary`) derivate la render → imposibil să diveargă de plan.
export type LiveReadResult =
  | { readonly ok: true; readonly target: ProfileName; readonly plan: TransitionPlan; readonly diagnostics: readonly MapDiagnostic[] }
  | { readonly ok: false; readonly stage: "read"; readonly reason: ReadStageReason }
  | { readonly ok: false; readonly stage: "map"; readonly reason: MapRejectReason; readonly diagnostics: readonly MapDiagnostic[] }
  | { readonly ok: false; readonly stage: "plan"; readonly reason: "invalid_input" | "unknown_profile" | "validation_unavailable" };

/**
 * Citește live + mapează + plănuiește un PREVIEW pentru `target`. Fail-closed pe fiecare stadiu (read→map→plan). Nicio mutație.
 * `caps` = capabilitatea canonică (`bindRoleCaps()` la runtime; fake în teste).
 */
export async function readLiveState(readSnapshot: SnapshotReader, manifest: RailwayManifest, target: ProfileName, caps: Caps, opts?: ReadOptions): Promise<LiveReadResult> {
  let read: ClientResult;
  try { read = await readSnapshot(manifest, opts); }
  catch { return { ok: false, stage: "read", reason: { kind: "reader_error" } }; } // reader e de încredere; backstop, niciun throw nu iese
  if (!read.ok) return { ok: false, stage: "read", reason: read.reason };

  const mapped = mapRailwaySnapshotToRawState(read.snapshot, manifest);
  if (!mapped.ok) return { ok: false, stage: "map", reason: mapped.reason, diagnostics: mapped.diagnostics };

  const planned = planFromRaw(mapped.rawState, target, caps);
  if (!planned.ok) return { ok: false, stage: "plan", reason: planned.reason };

  // Stocăm DOAR planul — `lines`/`summary` se derivă la render (fără derivate duplicate în rezultat).
  return { ok: true, target, plan: planned.plan, diagnostics: mapped.diagnostics };
}

// ── Render pentru operator (text pur; anti-leak: coduri + rol + nume de query, nimic altceva) ────────────────────
function diagLine(d: MapDiagnostic): string { return `  ℹ️ ${d.service ?? "—"}: ${d.code}`; }

/** Redă `LiveReadResult` ca linii de text pentru runner-ul opt-in. Include stadiul de eșec + diagnosticele de mapare. */
export function formatLiveResult(result: LiveReadResult): string[] {
  if (result.ok) {
    // Derivăm AICI din unica sursă (`result.plan`) — nu citim `lines`/`summary` stocate (nu există).
    const s = planSummary(result.plan);
    const lines: string[] = ["PREVIEW (read-only — NU se aplică nimic):", ...formatPlanLines(result.plan)];
    if (result.diagnostics.length > 0) { lines.push("diagnostice mapare:"); for (const d of result.diagnostics) lines.push(diagLine(d)); }
    lines.push(`rezumat: ${s.admissible ? (s.noop ? "noop" : "admisibil") : "NEadmisibil"} · start=${s.starts} stop=${s.stops} set_env=${s.setEnv} unset_env=${s.unsetEnv} blocaje=${s.blockers}${s.requiresConfirmation ? " · CONFIRMARE necesară" : ""}`);
    return lines;
  }
  if (result.stage === "read") return [`EȘEC @ citire: ${renderReadReason(result.reason)}`];
  if (result.stage === "map") {
    const lines = [`EȘEC @ mapare: ${result.reason}`];
    if (result.diagnostics.length > 0) { lines.push("diagnostice mapare:"); for (const d of result.diagnostics) lines.push(diagLine(d)); }
    return lines;
  }
  return [`EȘEC @ plan: ${result.reason}`];
}

function renderReadReason(r: ReadStageReason): string {
  // EXHAUSTIV (anti-divergență): un `kind` nou de `ClientRejectReason` care nu-i tratat aici → EROARE de compilare la `never`.
  switch (r.kind) {
    case "transport_error": return `transport_error(${r.at}/${r.code})`;
    case "invalid_response": return `invalid_response(${r.at})`;
    case "ambiguous_active_deployments": return `ambiguous_active_deployments(${r.service})`;
    case "running_stale_drift": return `running_stale_drift(${r.service})`;
    case "invalid_manifest":
    case "invalid_options":
    case "aborted":
    case "wrong_scope":
    case "topology_truncated":
    case "unexpected_service":
    case "staged_changes":
    case "staged_indeterminate":
    case "snapshot_unstable":
    case "reader_error":
      return r.kind;
    // Anti-leak: NU reflectăm valoarea runtime a lui `r`/`r.kind` în ieșire. Gardă `never` = exhaustivitate la compilare;
    // dacă totuși se ajunge aici (input malformat), returnăm un marker STATIC, nu conținut de input.
    default: { const _exhaustive: never = r; void _exhaustive; return "unknown"; }
  }
}

/**
 * Cod de exit pt. runner-ul opt-in — o SINGURĂ sursă, testată. `0` DOAR pentru un plan ADMISIBIL (read+map+plan reușite ȘI
 * plan.admissible); orice eșec de stadiu SAU un plan BLOCAT (ex. `launch` NEfinalizat, env lipsă) → `1`. Fără exit-uri dispersate.
 */
export function liveExitCode(result: LiveReadResult): 0 | 1 {
  return result.ok && result.plan.admissible ? 0 : 1;
}
