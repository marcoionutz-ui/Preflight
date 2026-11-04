/**
 * lib/db/adminClientAccess.ts — lot OAuth staging §4.1 (O1): piesele PURE ale scriptului `scripts/adminClientAccess.ts`.
 *
 * Context: clienții confidențiali legacy din `oauth_clients` (auto-creați de dashboard până la acest lot) sunt închiși
 * prin regula din `classifyClientLookup` → `isUsableLegacyClient`: utilizabil DOAR cu `status = active` ȘI
 * `admin_authorized_at` nenul. „Admin" = DOAR ce autorizează Marco explicit, client cu client, cu acest script. Nu
 * deducem nimic din `user_id = NULL`, din plan sau din scope.
 *
 * Frunză pură (zero I/O; doar `import` din alt leaf pur) → tsx-testabilă. Aici stau:
 *   - `parseAdminClientArgs`  — argv → comandă cu uniune ÎNCHISĂ (`list | authorize | unauthorize | usage_error`).
 *     Fail-closed: flag necunoscut, mod lipsă/dublu, `--by` lângă `--unauthorize`, valoare goală → `usage_error`.
 *   - `ADMIN_CLIENT_COLUMNS`  — coloanele citite EXPLICIT (fără `secret_hash`; nu folosim `select("*")` în script ca un
 *     secret să nu poată ajunge nici măcar în memoria procesului de listare).
 *   - `planAccessChange`      — rândul curent + comanda → `apply {patch} | noop | refuse {code}`. Reguli:
 *       authorize:   rând absent → `not_found`; `status ≠ active` → `not_active` (nu reactivăm clienți revocați/suspendați
 *                    pe ușa din spate); deja autorizat valid → `noop` (păstrăm nota și data originală = audit intact).
 *       unauthorize: rând absent → `not_found`; ORICE status e acceptat (retragerea autorizării e mereu sigură);
 *                    deja neautorizat (ambele null) → `noop`.
 *   - `formatClientRow`       — o linie stabilă pentru `--list` și before/after. `user_id` se afișează COMPLET: e un uuid
 *     de cont (nu credențial), iar §4.1 îl cere ca Marco să poată lega clientul de un cont înainte de a-l autoriza.
 *
 * Coduri de ieșire (scriptul): 0 = ok (inclusiv noop); 1 = eroare de backend/neașteptată; 2 = utilizare/config greșită
 * (argumente sau env lipsă); 3 = refuz pe starea țintei (client inexistent, inactiv, sau update fără rând confirmat).
 */

import { isUsableLegacyClient } from "./clientLookup";

/** Coloanele citite de script. FĂRĂ `secret_hash` (și fără orice alt material de credențial). */
export const ADMIN_CLIENT_COLUMNS =
  "client_id, user_id, name, plan, scopes, status, created_at, admin_authorized_at, admin_authorized_by";

export const EXIT_OK      = 0;
export const EXIT_BACKEND = 1;
export const EXIT_USAGE   = 2;
export const EXIT_REFUSED = 3;

const MAX_ID_LEN   = 200;
const MAX_NOTE_LEN = 200;

export type AdminClientCommand =
  | { kind: "list" }
  | { kind: "authorize";   clientId: string; by: string }
  | { kind: "unauthorize"; clientId: string }
  | { kind: "usage_error"; reason: string };

export const ADMIN_CLIENT_USAGE =
  "Utilizare:\n" +
  "  adminClientAccess --list\n" +
  "  adminClientAccess --authorize --client-id=<id> --by=<notă>\n" +
  "  adminClientAccess --unauthorize --client-id=<id>";

/** client_id acceptat: ne-gol, fără spații/control, ≤ 200. Nu validăm prefixul (`tp_marco_personal` e legitim). */
function isPlausibleClientId(v: string): boolean {
  return v.length > 0 && v.length <= MAX_ID_LEN && /^[\x21-\x7e]+$/.test(v);
}

/** Notă de audit: ne-goală după trim, ≤ 200, fără caractere de control (o singură linie în log/listare). */
function isPlausibleNote(v: string): boolean {
  const t = v.trim();
  return t.length > 0 && t.length <= MAX_NOTE_LEN && !/[\x00-\x1f\x7f]/.test(t);
}

/**
 * argv (fără `node`/script) → comandă. Acceptă DOAR: `--list`, `--authorize`, `--unauthorize`, `--client-id=<v>`,
 * `--by=<v>`; fiecare cel mult o dată. Orice altceva → `usage_error` (nu ghicim intenția unui script care scrie în DB).
 */
export function parseAdminClientArgs(argv: readonly string[]): AdminClientCommand {
  const modes: Array<"list" | "authorize" | "unauthorize"> = [];
  let clientId: string | undefined;
  let by: string | undefined;

  for (const a of argv) {
    if (a === "--list")        { modes.push("list"); continue; }
    if (a === "--authorize")   { modes.push("authorize"); continue; }
    if (a === "--unauthorize") { modes.push("unauthorize"); continue; }
    if (a.startsWith("--client-id=")) {
      if (clientId !== undefined) return { kind: "usage_error", reason: "--client-id dat de două ori" };
      clientId = a.slice("--client-id=".length);
      continue;
    }
    if (a.startsWith("--by=")) {
      if (by !== undefined) return { kind: "usage_error", reason: "--by dat de două ori" };
      by = a.slice("--by=".length);
      continue;
    }
    return { kind: "usage_error", reason: `argument necunoscut: ${a.slice(0, 40)}` };
  }

  if (modes.length !== 1) {
    return { kind: "usage_error", reason: "exact un mod: --list | --authorize | --unauthorize" };
  }
  const mode = modes[0];

  if (mode === "list") {
    if (clientId !== undefined || by !== undefined) return { kind: "usage_error", reason: "--list nu primește alte argumente" };
    return { kind: "list" };
  }

  if (clientId === undefined || !isPlausibleClientId(clientId)) {
    return { kind: "usage_error", reason: "--client-id=<id> lipsă sau invalid" };
  }

  if (mode === "authorize") {
    if (by === undefined || !isPlausibleNote(by)) {
      return { kind: "usage_error", reason: "--by=<notă> lipsă sau invalid (ne-gol, ≤ 200, o linie)" };
    }
    return { kind: "authorize", clientId, by: by.trim() };
  }

  // unauthorize
  if (by !== undefined) return { kind: "usage_error", reason: "--by nu se folosește cu --unauthorize" };
  return { kind: "unauthorize", clientId };
}

/** Rândul citit de script (doar coloanele din `ADMIN_CLIENT_COLUMNS`). Tipuri lărgite: rândul vine din DB. */
export interface AdminClientRow {
  client_id:           string;
  user_id:             string | null;
  name:                string | null;
  plan:                string | null;
  scopes:              string[] | null;
  status:              string | null;
  created_at:          string | null;
  admin_authorized_at: string | null;
  admin_authorized_by: string | null;
}

export type AccessChangePlan =
  | { kind: "apply";  patch: { admin_authorized_at: string | null; admin_authorized_by: string | null }; requireActive: boolean }
  | { kind: "noop";   reason: string }
  | { kind: "refuse"; code: "not_found" | "not_active"; reason: string };

/**
 * Decizia pentru `--authorize` / `--unauthorize`, pe rândul CITIT înainte de scriere. `nowIso` injectat (pur).
 * `requireActive` = scriptul adaugă `.eq("status","active")` la UPDATE (o revocare între citire și scriere nu se poate
 * „autoriza" printr-o cursă); 0 rânduri confirmate → refuz (exit 3).
 */
export function planAccessChange(
  row: AdminClientRow | null,
  cmd: { kind: "authorize"; by: string } | { kind: "unauthorize" },
  nowIso: string,
): AccessChangePlan {
  if (!row) return { kind: "refuse", code: "not_found", reason: "client inexistent" };

  if (cmd.kind === "authorize") {
    if (row.status !== "active") {
      return { kind: "refuse", code: "not_active", reason: `status=${row.status ?? "(null)"} — se autorizează doar clienți activi` };
    }
    if (isUsableLegacyClient(row)) {
      return { kind: "noop", reason: "deja autorizat — data și nota originale păstrate" };
    }
    return { kind: "apply", patch: { admin_authorized_at: nowIso, admin_authorized_by: cmd.by }, requireActive: true };
  }

  if (row.admin_authorized_at === null && row.admin_authorized_by === null) {
    return { kind: "noop", reason: "deja neautorizat" };
  }
  return { kind: "apply", patch: { admin_authorized_at: null, admin_authorized_by: null }, requireActive: false };
}

/** Valoare afișabilă: null/undefined → `-`; string → ca atare (fără newline); array → `a,b`. */
function show(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (Array.isArray(v)) return v.length ? v.map(x => String(x)).join(",") : "-";
  return String(v).replace(/[\r\n\t]+/g, " ");
}

/** O linie per client. Nu primește și nu afișează niciun câmp de secret (tipul nu-l are). */
export function formatClientRow(row: AdminClientRow): string {
  const usable = isUsableLegacyClient(row) ? "yes" : "no";
  return [
    `client_id=${show(row.client_id)}`,
    `user_id=${show(row.user_id)}`,
    `name=${JSON.stringify(show(row.name))}`,
    `plan=${show(row.plan)}`,
    `scopes=${show(row.scopes)}`,
    `status=${show(row.status)}`,
    `created_at=${show(row.created_at)}`,
    `admin_authorized_at=${show(row.admin_authorized_at)}`,
    `admin_authorized_by=${JSON.stringify(show(row.admin_authorized_by))}`,
    `usable=${usable}`,
  ].join(" ");
}
