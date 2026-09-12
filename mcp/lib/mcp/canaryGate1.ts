/**
 * lib/mcp/canaryGate1.ts — PH-12 12.5b-3 (orchestrator PUR al Gate 1 auth-canary).
 *
 * Leagă frunzele 12.5b-0/1/2 într-un lanț:
 *   izolare → setup → readiness → authorize → exchange → MCP → refresh → rotație → MCP(rotated).
 * Pașii cu I/O sunt INJECTAȚI ca o FABRICĂ `makeSteps(targets)` → orchestratorul e determinist și tsx-testabil cu
 * fake-uri, ÎNAINTE de adaptoarele reale (`fetch`/Playwright) din 12.5b-4.
 *
 * P1 — IZOLARE CAPABILITY-BOUND (fix cgpt): `vetGate1Targets` rulează `assertCanaryIsolation` (12.5a, refuză prod) ȘI
 * DERIVĂ endpoint-urile efective O SINGURĂ DATĂ din ORIGINEA vetată (via `new URL().origin`). Fabrica `makeSteps(targets)`
 * e invocată DOAR după ce izolarea trece → pașii nici nu EXISTĂ pe un config care atinge prod, iar când există lovesc
 * EXCLUSIV URL-urile derivate. `authorizeUrl = ${origin}/authorize` — fluxul resource-owner PH-2 începe la GET /authorize
 * (`/api/oauth/authorize` e ruta LEGACY POST cu client_secret și nu pornește consimțământul user).
 *
 * P2 — ORIGINI CURATE (fix cgpt): `mcpBaseUrl`/`supabaseUrl` trebuie să fie ORIGINI (schemă+host+port), fără path/query/
 * fragment. Un base cu `/foo`/`?x=1`/`#frag` ar produce URL-uri greșite prin concatenare → refuz. Endpoint-urile se
 * construiesc din `u.origin` (nu concatenare pe string cu hack de „/" final).
 *
 * P1 — REZILIENȚĂ LA THROW (fix cgpt): construirea pașilor (`makeSteps`, ex. setup Playwright) ȘI fiecare `await` de pas
 * pot arunca. Toate sunt prinse și convertite în eșec GENERIC specific etapei (fără `Error.message`) → orchestratorul
 * NU aruncă niciodată; short-circuit-ul + anti-leak-ul se păstrează.
 *
 * P2 — ANTI-LEAK PRIN CONTRACT (fix cgpt): pașii de ADAPTOR (readiness/authorize/mcp) întorc CODURI dintr-un UNION
 * ÎNCHIS, mapate AICI la mesaje STATICE. `exchange`/`refresh` întorc `TokenResult` (leaf 12.5b-1, `reason` deja anti-leak),
 * dar nici acela nu-l propagăm: mesajul se construiește din `stage` (enum) + `status` (număr).
 *
 * P1 — TOKENUL ROTIT E EXERCITAT (fix cgpt): un `/token` defect poate întoarce un plic VALID cu un access token care nu
 * există în Redis. Diferența `AT2 !== AT1` NU e de ajuns → după rotație re-lovim `/api/mcp` cu `rotated.accessToken` și
 * cerem succes (stage `mcp_rotated`). Forma plicului e deja garantată de client (assertTokenResponse, sursă unică).
 */

import { assertCanaryIsolation, type CanaryConfig } from "./releaseGate";
import type { TokenResult } from "./canaryTokenClient";

// ────────────────────────────── ținte vetate (capability object) ──────────────────────────────

/** Endpoint-urile de canary DERIVATE dintr-o ORIGINE VETATĂ. Singura sursă de URL-uri pentru pași → izolarea le acoperă. */
export interface Gate1Targets {
  mcpOrigin:    string; // originea vetată (ex. http://127.0.0.1:8080), fără path/query/fragment
  supabaseUrl:  string; // originea Supabase vetată
  healthUrl:    string; // `${origin}/api/health`
  authorizeUrl: string; // `${origin}/authorize` (GET, resource-owner — NU /api/oauth/authorize legacy)
  tokenUrl:     string; // `${origin}/api/oauth/token`
  mcpUrl:       string; // `${origin}/api/mcp`
  resource:     string; // audience canonică (RFC 8707) == mcpUrl
}

export type VetResult =
  | { ok: true;  targets: Gate1Targets }
  | { ok: false; reason: string };

/** Cere o ORIGINE curată (fără path/query/fragment) + întoarce `u.origin`. Fail-closed pe orice abatere. */
function cleanOrigin(url: string, label: string): { origin: string } | { reject: string } {
  let u: URL;
  try { u = new URL(url); } catch { return { reject: `${label} neparsabil` }; }
  if (u.pathname !== "/" && u.pathname !== "") return { reject: `${label} conține path — cere origine curată` };
  if (u.search !== "")                          return { reject: `${label} conține query — cere origine curată` };
  if (u.hash !== "")                            return { reject: `${label} conține fragment — cere origine curată` };
  return { origin: u.origin };
}

/**
 * Poarta zero: `assertCanaryIsolation` (refuză prod/ambiguu, schemă/credențiale) → apoi cere ORIGINI curate → apoi
 * DERIVĂ toate endpoint-urile din origine. Nimeni altcineva nu construiește URL-uri de canary.
 */
export function vetGate1Targets(cfg: Partial<CanaryConfig> | null | undefined): VetResult {
  const iso = assertCanaryIsolation(cfg);
  if (!iso.ok) return { ok: false, reason: iso.reason };
  const mcpBaseUrlRaw = cfg?.mcpBaseUrl;
  const supabaseRaw   = cfg?.supabaseUrl;
  if (typeof mcpBaseUrlRaw !== "string" || typeof supabaseRaw !== "string") {
    return { ok: false, reason: "config de canary invalid după izolare (fail-closed)" }; // practic inaccesibil
  }
  const mcp = cleanOrigin(mcpBaseUrlRaw, "mcpBaseUrl");
  if ("reject" in mcp) return { ok: false, reason: mcp.reject };
  const sup = cleanOrigin(supabaseRaw, "supabaseUrl");
  if ("reject" in sup) return { ok: false, reason: sup.reject };

  const origin = mcp.origin;
  const mcpUrl = `${origin}/api/mcp`;
  return {
    ok: true,
    targets: {
      mcpOrigin:    origin,
      supabaseUrl:  sup.origin,
      healthUrl:    `${origin}/api/health`,
      authorizeUrl: `${origin}/authorize`,
      tokenUrl:     `${origin}/api/oauth/token`,
      mcpUrl,
      resource:     mcpUrl,
    },
  };
}

// ────────────────────────────── contractele pașilor (coduri închise) ──────────────────────────────

/** Bundle-ul produs de authorize (login→consent→callback) — intrarea schimbului de cod. */
export interface AuthCodeBundle {
  code:         string;
  redirectUri:  string; // EXACT string-ul folosit la /authorize (serverul compară exact la /token)
  codeVerifier: string; // PKCE (secret) — doar în corpul cererii /token, niciodată în reason
}

export type ReadinessCode = "unreachable" | "not_ready" | "bad_status" | "malformed";
export type ReadinessResult = { ok: true } | { ok: false; code: ReadinessCode };

export type AuthorizeCode = "browser_failed" | "callback_error" | "state_mismatch" | "iss_mismatch" | "timeout" | "malformed";
export type AuthorizeOutcome = { ok: true; bundle: AuthCodeBundle } | { ok: false; code: AuthorizeCode };

export type McpProbeCode = "unauthorized" | "rate_limited" | "unavailable" | "transport" | "bad_shape" | "protocol_error";
export type McpProbeResult = { ok: true } | { ok: false; code: McpProbeCode };

/**
 * Pașii cu I/O, construiți din `targets` vetate. Adaptorul (12.5b-4) îi implementează peste `fetch`/Playwright folosind
 * EXCLUSIV `targets.*`; fiecare întoarce un rezultat cu COD ÎNCHIS (readiness/authorize/mcp) sau `TokenResult`
 * (exchange/refresh). Niciun `reason` liber nu traversează frontiera.
 */
export interface Gate1Steps {
  readiness: () => Promise<ReadinessResult>;
  authorize: () => Promise<AuthorizeOutcome>;
  exchange:  (bundle: AuthCodeBundle) => Promise<TokenResult>;
  mcpProbe:  (accessToken: string) => Promise<McpProbeResult>;
  refresh:   (refreshToken: string) => Promise<TokenResult>;
}

// ────────────────────────────── mesaje statice (mapare cod → text) ──────────────────────────────

const READINESS_MSG: Record<ReadinessCode, string> = {
  unreachable: "readiness: /api/health inaccesibil (transport)",
  not_ready:   "readiness: health raportează not-ready (web/Redis jos)",
  bad_status:  "readiness: /api/health a răspuns cu status HTTP neașteptat",
  malformed:   "readiness: raport /api/health malformat (fail-closed)",
};
const AUTHORIZE_MSG: Record<AuthorizeCode, string> = {
  browser_failed: "authorize: pasul de browser (login/consent) a eșuat",
  callback_error: "authorize: callback OAuth a întors o eroare de autorizare",
  state_mismatch: "authorize: state mismatch la callback (posibil CSRF)",
  iss_mismatch:   "authorize: iss mismatch la callback (RFC 9207)",
  timeout:        "authorize: timeout așteptând callback-ul loopback",
  malformed:      "authorize: callback malformat (fail-closed)",
};
const MCP_MSG: Record<McpProbeCode, string> = {
  unauthorized:   "token respins (401 unauthorized/invalid_token)",
  rate_limited:   "rate-limited (429)",
  unavailable:    "auth backend indisponibil (503)",
  transport:      "eroare de transport (rețea)",
  bad_shape:      "răspuns fără formă MCP validă",
  protocol_error: "eroare JSON-RPC de protocol",
};
// Eșec de token (exchange/refresh): din `stage` (enum închis) + `status` (număr) — NU din `reason`-ul leaf-ului.
// `TokenResult` (12.5b-1) are `stage: "http" | "assert"`; transportul e colapsat de client în `stage:"http"` cu
// `status:null` → status null pe http = transport.
function tokenFailMsg(kind: "exchange" | "refresh", stage: "http" | "assert", status: number | null): string {
  if (stage === "assert")  return `${kind}: răspuns /token invalid ca formă (fail-closed)`;
  if (status === null)     return `${kind}: eroare de transport (rețea)`;
  return `${kind}: /token a răspuns HTTP ${status}`;
}

export type Gate1Stage =
  | "isolation" | "setup" | "readiness" | "authorize" | "exchange" | "mcp" | "refresh" | "rotation" | "mcp_rotated";

// Un pas (sau setup) care a ARUNCAT → mesaj generic, fără Error.message.
const THREW: Record<Gate1Stage, string> = {
  isolation:   "izolare: excepție (fail-closed)",
  setup:       "setup: construirea pașilor a aruncat (config/Playwright) (fail-closed)",
  readiness:   "readiness: pasul a aruncat (execuție/transport)",
  authorize:   "authorize: pasul a aruncat (execuție/transport)",
  exchange:    "exchange: pasul a aruncat (execuție/transport)",
  mcp:         "mcp: pasul a aruncat (execuție/transport)",
  refresh:     "refresh: pasul a aruncat (execuție/transport)",
  rotation:    "rotation: excepție (fail-closed)",
  mcp_rotated: "mcp_rotated: pasul a aruncat (execuție/transport)",
};

// ────────────────────────────── orchestrator ──────────────────────────────

export type Gate1Report =
  | { ok: true;  stages: Gate1Stage[]; note: string }
  | { ok: false; stage: Gate1Stage; reason: string };

/** Prinde un pas care aruncă → `{thrown:true}` (fără a propaga excepția / mesajul). Altfel `{thrown:false, value}`. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ thrown: false; value: T } | { thrown: true }> {
  try { return { thrown: false, value: await fn() }; }
  catch { return { thrown: true }; }
}

/**
 * Rulează lanțul Gate 1. Se oprește la PRIMUL pas care eșuează SAU aruncă, întorcând stage-ul + un motiv STATIC.
 * Izolarea e poarta zero: pe config care atinge prod / ambiguu / cu origine murdară, fabrica de pași NU e invocată.
 */
export async function runGate1(
  cfg:       Partial<CanaryConfig> | null | undefined,
  makeSteps: (targets: Gate1Targets) => Gate1Steps,
): Promise<Gate1Report> {
  const done: Gate1Stage[] = [];

  // 0. IZOLARE + derivare ținte (pur) — ÎNAINTEA construirii pașilor și a oricărui I/O.
  const vet = vetGate1Targets(cfg);
  if (!vet.ok) return { ok: false, stage: "isolation", reason: vet.reason };
  done.push("isolation");

  // 1. SETUP — construirea pașilor din ținte vetate poate arunca (config/Playwright) → prins.
  let steps: Gate1Steps;
  try { steps = makeSteps(vet.targets); }
  catch { return { ok: false, stage: "setup", reason: THREW.setup }; }
  done.push("setup");

  // 2. READINESS
  const rd = await attempt(() => steps.readiness());
  if (rd.thrown)      return { ok: false, stage: "readiness", reason: THREW.readiness };
  if (!rd.value.ok)   return { ok: false, stage: "readiness", reason: READINESS_MSG[rd.value.code] };
  done.push("readiness");

  // 3. AUTHORIZE
  const az = await attempt(() => steps.authorize());
  if (az.thrown)      return { ok: false, stage: "authorize", reason: THREW.authorize };
  if (!az.value.ok)   return { ok: false, stage: "authorize", reason: AUTHORIZE_MSG[az.value.code] };
  const bundle = az.value.bundle;
  done.push("authorize");

  // 4. EXCHANGE
  const ex = await attempt(() => steps.exchange(bundle));
  if (ex.thrown)      return { ok: false, stage: "exchange", reason: THREW.exchange };
  if (!ex.value.ok)   return { ok: false, stage: "exchange", reason: tokenFailMsg("exchange", ex.value.stage, ex.value.status) };
  const first = ex.value;
  done.push("exchange");

  // 5. MCP — access token INIȚIAL acceptat la /api/mcp + formă MCP validă.
  const mc = await attempt(() => steps.mcpProbe(first.accessToken));
  if (mc.thrown)      return { ok: false, stage: "mcp", reason: THREW.mcp };
  if (!mc.value.ok)   return { ok: false, stage: "mcp", reason: `mcp (AT inițial): ${MCP_MSG[mc.value.code]}` };
  done.push("mcp");

  // 6. REFRESH
  const rf = await attempt(() => steps.refresh(first.refreshToken));
  if (rf.thrown)      return { ok: false, stage: "refresh", reason: THREW.refresh };
  if (!rf.value.ok)   return { ok: false, stage: "refresh", reason: tokenFailMsg("refresh", rf.value.stage, rf.value.status) };
  const rotated = rf.value;
  done.push("refresh");

  // 7. ROTAȚIE — access ȘI refresh trebuie să difere (forma ambelor e deja garantată de client; aici doar diferența).
  if (first.accessToken === rotated.accessToken) {
    return { ok: false, stage: "rotation", reason: "access_token neschimbat după refresh (lanțul nu s-a rotit)" };
  }
  if (first.refreshToken === rotated.refreshToken) {
    return { ok: false, stage: "rotation", reason: "refresh_token neschimbat după refresh (reuse-detection nu s-ar declanșa)" };
  }
  done.push("rotation");

  // 8. MCP(rotated) — tokenul ROTIT trebuie să fie EFECTIV utilizabil. Un `/token` defect poate emite un plic valid cu
  //    un AT2 inexistent în Redis; diferența nu-l prinde → îl exercităm real pe /api/mcp și cerem succes.
  const mc2 = await attempt(() => steps.mcpProbe(rotated.accessToken));
  if (mc2.thrown)     return { ok: false, stage: "mcp_rotated", reason: THREW.mcp_rotated };
  if (!mc2.value.ok)  return { ok: false, stage: "mcp_rotated", reason: `mcp (AT rotit): ${MCP_MSG[mc2.value.code]}` };
  done.push("mcp_rotated");

  return { ok: true, stages: done, note: "Gate 1 verde: izolare + readiness + authorize + exchange + MCP + rotație + MCP(rotated)" };
}
