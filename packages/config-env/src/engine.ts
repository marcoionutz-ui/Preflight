/**
 * @preflight/config-env — engine.ts (PH-12 slice 12.2b: motor GENERIC de validare env, PUR).
 *
 * Extras din `mcp/lib/config/envSchema.ts` (12.2a) ca sursă UNICĂ pentru toate rolurile (MCP + workeri).
 * Zero I/O, zero dependențe de workspace: primește un snapshot de env + o listă de câmpuri per-rol și
 * întoarce o uniune discriminată `{ ok } | { ok:false; problems }`. Specs-urile per-rol trăiesc LÂNGĂ fiecare
 * serviciu (MCP: `mcp/lib/config/envSchema.ts`; workeri: sub `workers/<rol>/src/config`), fiindcă unele validatoare
 * sunt cuplate la rol (ex. `PUBLIC_BASE_URL` folosește `resolvePublicBaseUrl` din MCP — boot-check == runtime).
 * Motorul oferă doar mecanica reutilizabilă + validatoarele generice de formă.
 *
 * Decizie de produs (Marco 2026-09-02): required+tip FĂRĂ allowlist strictă. Câmpuri OBLIGATORII lipsă/invalide →
 * `problems` (boot crapă). Surplus pe rol (prefixe care aparțin altui rol) → `warnings`, NU crapă. Obligativitatea
 * unui câmp poate depinde de mediu (`required(prod)`). `""`/whitespace == absent. Ieșirea e DETERMINISTĂ
 * (surplusul se iterează sortat) ca log-urile de boot să fie stabile între reporniri.
 *
 * Categorie de securitate (Marco 2026-09-02): un flag de dev/bypass (`MCP_DEV_AUTH_BYPASS`, `*_INTEGRATION_ALLOW`)
 * truthy în producție → `problem` `forbidden` (boot crapă), NU warning — modelat prin `FieldSpec.forbid`
 * (`flagMustBeOffInProd`). E defense-in-depth peste runtime (care deja ignoră bypass-ul în prod): îl face ZGOMOTOS
 * la pornire în loc de tăcut-ignorat, și prinde și cazul în care cineva slăbește ulterior gardul de runtime.
 */

export type EnvSnapshot = Record<string, string | undefined>;

/**
 * O problemă care OPREȘTE boot-ul. `missing` = obligatoriu absent; `invalid` = prezent dar formă greșită;
 * `forbidden` = prezent cu o valoare NEPERMISĂ în mediul curent (ex. un flag de dev/bypass truthy în prod) —
 * valoarea e bine-formată, dar politica o interzice, deci nu e nici missing nici invalid.
 */
export type EnvProblem = {
  name: string;
  kind: "missing" | "invalid" | "forbidden";
  detail: string;
};

/** Un avertisment care NU oprește boot-ul: surplus pe rol, sau opțional-dar-malformat. */
export type EnvWarning = {
  name: string;
  detail: string;
};

/** Rezultatul validării unui rol. Discriminat pe `ok`. `role` e liber (fiecare serviciu își pune eticheta lui). */
export type EnvValidation =
  | { ok: true;  role: string; warnings: EnvWarning[] }
  | { ok: false; role: string; problems: EnvProblem[]; warnings: EnvWarning[] };

/** Validator de formă: întoarce `null` dacă e ok, sau un `detail` de eroare. Rulează DOAR pe valori prezente. */
export type Validate = (value: string, prod: boolean) => string | null;

/**
 * Specificația unui câmp. `required(prod)` decide dacă absența e `problem` (obligatoriu) sau ignorată (opțional).
 * `validate` (opțional) verifică forma unei valori PREZENTE — pe un câmp obligatoriu → `problem` `invalid`;
 * pe un câmp opțional → `warning` (prezent dar malformat).
 * `forbid` (opțional) verifică o valoare PREZENTĂ împotriva unei POLITICI de mediu — non-null → `problem` `forbidden`
 * ÎNTOTDEAUNA (INDEPENDENT de `required`, spre deosebire de `validate` care se degradează la warning pe opțional).
 * Cazul canonic: un flag de dev/bypass care nu are voie truthy în producție. Absent → nimic (categoria e „OFF sau absent").
 */
export type FieldSpec = {
  name: string;
  required: (prod: boolean) => boolean;
  validate?: Validate;
  forbid?: Validate;
};

/** `production` strict — Next/Node setează `NODE_ENV=production` la build/rulare de prod. */
export function isProd(env: EnvSnapshot): boolean {
  return (env.NODE_ENV ?? "") === "production";
}

/** „Prezent" = string ne-gol după trim (un env setat la `""` de deploy NU numără ca setat). */
export function present(raw: string | undefined): raw is string {
  return typeof raw === "string" && raw.trim() !== "";
}

// ── validatoare de formă generice (pure, reutilizabile de orice rol) ──────────────
/** Nu cere nimic în plus peste prezență (prezența e verificată de `present`). */
export const nonEmpty: Validate = () => null;

/** URL http(s) absolut cu host; în prod cere https. `label` apare în mesajul de eroare. */
export function absoluteUrl(label: string): Validate {
  return (value, prod) => {
    let u: URL;
    try { u = new URL(value.trim()); } catch { return `${label} nu e un URL absolut valid`; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return `${label} trebuie http(s)`;
    if (u.hostname === "") return `${label} fără host`;
    if (prod && u.protocol !== "https:") return `${label} trebuie https în producție`;
    return null;
  };
}

/** URL Redis: schema `redis:` sau `rediss:` (TLS), cu host. `label` pentru mesaj (default REDIS_URL). */
export function redisUrl(label = "REDIS_URL"): Validate {
  return (value) => {
    let u: URL;
    try { u = new URL(value.trim()); } catch { return `${label} nu e un URL valid`; }
    if (u.protocol !== "redis:" && u.protocol !== "rediss:") return `${label} trebuie redis:// sau rediss://`;
    if (u.hostname === "") return `${label} fără host`;
    return null;
  };
}

/**
 * URL HTTP consumat de `fetch`/`Request` (ex. RPC): `absoluteUrl` (http(s), host, https în prod) + INTERZICE
 * credențialele în URL. Constructorul `Request` aruncă pe `user:pass@host` ÎNAINTE de orice conexiune, deci un endpoint
 * cu credențiale ar eșua la prima cerere, nu ar degrada grațios. NU ecouă valoarea (fără scurgere de credențiale în boot-log).
 * (Promovat din indexer-evm la 12.2c-3-engine3; consumat de indexer RPC + solana RPC.)
 */
export function fetchHttpUrl(label: string): Validate {
  return (value, prod) => {
    const base = absoluteUrl(label)(value, prod);
    if (base !== null) return base;
    const u = new URL(value.trim()); // absoluteUrl a garantat deja că parsează
    if (u.username !== "" || u.password !== "") return `${label} nu poate conține credențiale în URL (user:pass@…) — clientul fetch le respinge`;
    return null;
  };
}

/**
 * URL WebSocket: `ws://` sau `wss://` cu host și FĂRĂ fragment. Clientul `ws` (8.20.1) respinge explicit un URL cu
 * `#fragment` (lib/websocket.js) → ar duce în retry-uri pe o config invalidă, nu într-o conexiune. `label` pentru mesaj.
 * (Promovat din worker-evm la 12.2c-3-engine3; consumat de worker-evm WS + solana `SOLANA_WS_URL`.)
 */
export function wsUrl(label: string): Validate {
  return (value) => {
    let u: URL;
    try { u = new URL(value.trim()); } catch { return `${label} nu e un URL valid`; }
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return `${label} trebuie ws:// sau wss://`;
    if (u.hostname === "") return `${label} fără host`;
    if (u.hash !== "") return `${label} nu poate avea fragment (#...) — clientul ws îl respinge`;
    return null;
  };
}

/**
 * Întreg zecimal ≥ 0 (ex. PORT). Sintaxă zecimală EXPLICITĂ (`/^\d+$/` după trim) + `Number.isSafeInteger`:
 * respinge `1e3`/`0x10` (pe care `parseInt(...,10)` le taie diferit), zecimalele care rotunjesc la întreg
 * (`1.0000000000000001`) și magnitudinile peste sigur (`9007199254740993`). Limitele specifice (ex. intervalul
 * unui port) rămân în schema rolului.
 */
export function nonNegativeInt(label: string): Validate {
  return (value) => {
    const t = value.trim();
    if (!/^\d+$/.test(t)) return `${label} trebuie întreg zecimal ≥ 0 (fără semn/zecimale/exponent/hex)`;
    if (!Number.isSafeInteger(Number(t))) return `${label} depășește întregul sigur (MAX_SAFE_INTEGER)`;
    return null;
  };
}

/**
 * Număr FINIT peste un prag, oglindind parserele `Number()`-based ale workerilor (indexer `confirmationDepth`
 * `Number(raw)` finite `>= 0`; indexer `intEnv`/solana `SOLANA_*_MS` finite `> 0`). Deliberat MAI PERMISIV decât
 * `nonNegativeInt`: runtime-ul folosește `Number(...)`, deci acceptă `1e3`/`0x10`/zecimale — validatorul TREBUIE să
 * accepte exact ce runtime-ul acceptă, altfel ar warn-ui pe o valoare pe care runtime-ul o consumă corect (fals-pozitiv).
 * Semnalează DOAR ce runtime-ul RESPINGE (și de-aceea cade TĂCUT pe default): `NaN`/`Infinity` sau sub prag. `gt` =
 * strict `>` (respinge zero/negativ, ex. timeout MS), `gte` = `>=` (permite zero, ex. confirmation depth = dezactivat).
 * Exact unul din `gt`/`gte`. NU ecouă valoarea (doar câmpul + pragul, statice). `present` a filtrat whitespace-only.
 */
export function finiteNumber(label: string, bound: { gt: number } | { gte: number }): Validate {
  return (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${label} — nu e număr finit (IGNORAT la runtime, se folosește default)`;
    if ("gt" in bound) {
      return n > bound.gt ? null : `${label} — trebuie număr finit > ${bound.gt} (IGNORAT la runtime, se folosește default)`;
    }
    return n >= bound.gte ? null : `${label} — trebuie număr finit ≥ ${bound.gte} (IGNORAT la runtime, se folosește default)`;
  };
}

/**
 * Întreg zecimal STRICT pozitiv pentru un câmp `parseInt(v,10)`-based (`INDEXER_RPC_TIMEOUT_MS`, `SOLANA_BACKFILL_MAX_
 * ACCOUNTS`), prag `> 0`. Cere cifre CURATE (`/^\d+$/`) fiindcă `parseInt` ar trunchia `1e3`→1, `15abc`→15, `1.5`→1 —
 * valori pe care operatorul le crede altceva → le respingem la boot în loc să lăsăm runtime-ul să folosească un întreg
 * tăiat. Deosebit de `finiteNumber` (`Number()`-based, tolerează `1e3`=1000): alege-l DOAR când parserul runtime e
 * `parseInt`. NU ecouă valoarea. (Promovat din indexer-evm la 12.2c-3-engine3.)
 */
export function positiveIntStrict(label: string): Validate {
  return (value) => {
    const t = value.trim();
    if (!/^\d+$/.test(t)) return `${label} — trebuie întreg zecimal din cifre curate (parseInt taie '1e3'→1, '15abc'→15)`;
    const n = Number(t);
    if (!Number.isSafeInteger(n) || n <= 0) return `${label} — trebuie întreg > 0`;
    return null;
  };
}

// ── flag-uri boolean (dev/bypass, toggle-uri) — vocabular canonic partajat de roluri ──
/** Tokenii recunoscuți ca „aprins". Set INTERN: schimbarea lui derivă politica peste tot deodată. */
const FLAG_TRUTHY = new Set(["1", "true", "yes", "on"]);
/** Tokenii recunoscuți ca „stins" (dezactivare INTENȚIONATĂ). `""` nu ajunge aici (filtrat de `present`). */
const FLAG_FALSY = new Set(["0", "false", "no", "off"]);

/**
 * Flag boolean opțional: valoarea prezentă trebuie să fie un token bool recunoscut (`1/0/true/false/yes/no/on/off`,
 * trim + case-insensitive). Pe un câmp opțional un token NErecunoscut (typo `treu`, `enabled`) → `warning`, NU crapă —
 * dar îl face vizibil la boot (clasa de footgun „flag scris greșit tratat tăcut ca off"). Nu impune valoarea, doar forma.
 */
export const boolFlag: Validate = (value) => {
  const v = value.trim().toLowerCase();
  if (FLAG_TRUTHY.has(v) || FLAG_FALSY.has(v)) return null;
  return `token boolean nerecunoscut (așteptat unul din: 1/0/true/false/yes/no/on/off)`;
};

/**
 * Flag opțional pe care runtime-ul îl compară STRICT, BYTE-EXACT cu un mic set de tokeni (nu bool permisiv, nu trim):
 * un cod ca `x === "1"` / `x === "true"` / `x !== "false"` recunoaște EXACT acei literali și tratează TĂCUT orice
 * altceva drept celălalt pol. `exactFlag(label, recognized)` oglindește asta: prezent + valoare ∉ `recognized`
 * (comparație byte-exact, FĂRĂ trim/lowercase) → `warning`. Generalizează `strictZeroOne` (0/1) la orice vocabular:
 *   - `INDEXER_ENABLE_*` (`=== "1"`)                 → `exactFlag(name, ["0","1"])`
 *   - `INDEXER_DRY_RUN` (`!== "false"`, default dry)  → `exactFlag(name, ["true","false"])` (`=0` NU dezactivează dry!)
 *   - `INDEXER_SKIP_TO_LATEST`/`SOLANA_BACKFILL_*`    → vocabularul lor byte-exact
 * FĂRĂ trim (blocker cgpt 12.2e-2): runtime-ul compară `process.env.X` BRUT, deci `" 1 "` cu spații NU se potrivește la
 * runtime → un trim aici ar aproba tăcut o valoare pe care runtime-ul o interpretează invers. NU ecouă valoarea (doar
 * câmpul + tokenii recunoscuți, statici din cod). `present` a filtrat deja whitespace-only ca absent.
 */
export function exactFlag(label: string, recognized: readonly string[]): Validate {
  const allowed = new Set(recognized);
  return (value) =>
    allowed.has(value)
      ? null
      : `${label} — runtime recunoaște DOAR ${recognized.join("/")} byte-exact (spații/alt token → interpretat implicit invers)`;
}

/**
 * Politică pentru `FieldSpec.forbid`: un flag care în PRODUCȚIE trebuie să fie OFF sau absent. Semantică FAIL-LOUD
 * (aliniată doctrinei `authCodeCutover`): în prod, orice valoare prezentă care NU e un token falsy explicit
 * (`0/false/no/off`) → interzisă — asta prinde nu doar `1/true` ci și un typo (`treu`) sau gunoi, ca un bypass „aproape
 * setat" în prod să oprească boot-ul ZGOMOTOS în loc să fie tratat tăcut ca off. În non-prod → mereu permis (dev-ul îl
 * folosește legitim). Absența e permisă de `runFieldSpecs` (forbid rulează doar pe valori prezente).
 */
export function flagMustBeOffInProd(label: string): Validate {
  return (value, prod) => {
    if (!prod) return null;
    if (FLAG_FALSY.has(value.trim().toLowerCase())) return null;
    return `${label} nu are voie activ în producție (flag de dev/bypass — setează-l OFF sau scoate-l)`;
  };
}

// ── liste CSV de tokeni cunoscuți (ex. chain list) — generic, parametrizat pe (allowed, normalize) ──
/**
 * Tokenii dintr-un CSV care NU se rezolvă la un membru cunoscut și de-aceea sunt DROPAȚI TĂCUT la runtime.
 * Oglindește EXACT logica per-token a consumatorilor (`chains.ts`, `parseExpectedChains`): `split(",")`, per token
 * `trim().toLowerCase()`, apoi `normalize(...)`, apoi test de apartenență. Fiecare ROL își trece propriul `(allowed,
 * normalize)` — worker-ul EVM folosește ids literale (`normalize` = identitate: `eth` NU se mapează la `ethereum`),
 * MCP health folosește `normalizeChainId` (alias-tolerant). Setul valid se normalizează la fel ca la consumatori
 * (`allowed.map(normalize)`). Tokenii goli (virgulă în plus) sunt săriți (dropați tăcut, nu-i raportăm). Rezultat
 * dedup, lowercase, ordine de apariție.
 */
export function unknownCsvTokens(
  raw: string,
  allowed: readonly string[],
  normalize: (s: string) => string = (s) => s,
): string[] {
  const valid = new Set(allowed.map((c) => normalize(c)));
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim().toLowerCase();
    if (t === "") continue; // token gol → dropat tăcut de consumatori, nu-l semnalăm
    if (!valid.has(normalize(t)) && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Validator de formă pentru un câmp CSV-de-tokeni-cunoscuți (ex. `ENABLED_CHAINS`/`HEALTH_EXPECTED_CHAINS`): pe un
 * câmp OPȚIONAL, tokeni necunoscuți prezenți → `warning` (nu crapă). Prinde clasa de footgun „un chain scris greșit
 * e IGNORAT tăcut la runtime → chain nepornit/nemonitorizat". `allowed`+`normalize` vin din vocabularul ROLULUI.
 *
 * NU ecouă VALORILE din env în mesaj (fix cgpt 12.2c-1): un env poate conține secret/injecție, iar mesajul ajunge în
 * log-ul de boot prin `formatEnvValidation`. Raportează doar CÂMPUL, NUMĂRUL de necunoscute și OPȚIUNILE PERMISE
 * (setul canonic din cod, sigur de afișat). Tokenii bruți rămân disponibili programatic prin `unknownCsvTokens`.
 */
export function csvKnownTokens(label: string, allowed: readonly string[], normalize?: (s: string) => string): Validate {
  return (value) => {
    const n = unknownCsvTokens(value, allowed, normalize).length;
    return n === 0
      ? null
      : `${label} — ${n} token(i) necunoscut(i), IGNORAȚI la runtime (permise: ${allowed.join("/")})`;
  };
}

/**
 * Rulează un set de câmpuri peste snapshot. Colectează TOATE problemele/avertismentele (nu short-circuit).
 * Câmp obligatoriu absent → problem missing; prezent + invalid → problem invalid. Câmp opțional absent → nimic;
 * prezent + invalid → warning.
 */
export function runFieldSpecs(
  fields: readonly FieldSpec[],
  env: EnvSnapshot,
  prod: boolean,
): { problems: EnvProblem[]; warnings: EnvWarning[] } {
  const problems: EnvProblem[] = [];
  const warnings: EnvWarning[] = [];
  for (const spec of fields) {
    const raw = env[spec.name];
    const req = spec.required(prod);
    if (!present(raw)) {
      if (req) problems.push({ name: spec.name, kind: "missing", detail: prod ? "lipsă (obligatoriu în producție)" : "lipsă" });
      continue;
    }
    // Contract: `null` == valid. ORICE non-null e eroare — inclusiv `""` (nu-l trata ca succes prin falsy).
    const err = spec.validate ? spec.validate(raw, prod) : null;
    if (err !== null) {
      const detail = err.trim() === "" ? "formă invalidă" : err; // detaliu gol → mesaj generic, tot eroare
      if (req) problems.push({ name: spec.name, kind: "invalid", detail });
      else     warnings.push({ name: spec.name, detail: `${detail} (opțional — ignorat)` });
    }
    // Politică de mediu: `forbid` non-null → `problem` `forbidden` ÎNTOTDEAUNA (INDEPENDENT de `required` —
    // un flag de bypass e opțional, dar prezent-truthy-în-prod trebuie să OPREASCĂ boot-ul, nu să dea doar warning).
    const forbidden = spec.forbid ? spec.forbid(raw, prod) : null;
    if (forbidden !== null) {
      const detail = forbidden.trim() === "" ? "valoare nepermisă în acest mediu" : forbidden;
      problems.push({ name: spec.name, kind: "forbidden", detail });
    }
  }
  return { problems, warnings };
}

/**
 * Detectează variabile prezente care aparțin ALTUI rol (prefixe de surplus). Ordine DETERMINISTĂ (chei sortate).
 * `roleLabel` apare în mesaj. NU produce probleme — doar avertismente (decizia „fără allowlist strictă").
 */
export function detectUnexpected(
  env: EnvSnapshot,
  unexpectedPrefixes: readonly string[],
  roleLabel: string,
): EnvWarning[] {
  const warnings: EnvWarning[] = [];
  for (const key of Object.keys(env).sort()) {
    if (!present(env[key])) continue;
    if (unexpectedPrefixes.some((p) => key.startsWith(p))) {
      warnings.push({ name: key, detail: `unexpected for role ${roleLabel} (variabilă de alt rol — separă pe rol)` });
    }
  }
  return warnings;
}

/**
 * Compune validarea unui rol: rulează câmpurile + detectează surplusul, apoi asamblează uniunea discriminată.
 * Ordinea warnings: mai întâi cele din câmpuri (ordinea din catalog), apoi surplusul (sortat) — deterministă.
 */
export function validateEnv(
  role: string,
  fields: readonly FieldSpec[],
  unexpectedPrefixes: readonly string[],
  env: EnvSnapshot,
): EnvValidation {
  const prod = isProd(env);
  const { problems, warnings } = runFieldSpecs(fields, env, prod);
  const surplus = detectUnexpected(env, unexpectedPrefixes, role);
  const allWarnings = [...warnings, ...surplus];
  return problems.length > 0
    ? { ok: false, role, problems, warnings: allWarnings }
    : { ok: true,  role, warnings: allWarnings };
}

/**
 * Formatare pentru boot-log (PUR, un string). Boot-guard-ul o printează; fără I/O aici.
 */
export function formatEnvValidation(v: EnvValidation): string {
  const lines: string[] = [];
  if (v.ok) {
    lines.push(`[env:${v.role}] OK`);
  } else {
    lines.push(`[env:${v.role}] FAIL — ${v.problems.length} problemă(e) obligatorie:`);
    for (const p of v.problems) lines.push(`  ✗ ${p.name}: ${p.kind} — ${p.detail}`);
  }
  for (const w of v.warnings) lines.push(`  ⚠ ${w.name}: ${w.detail}`);
  return lines.join("\n");
}
