/**
 * lib/oauth/authCodeCutover.ts — PH-2 step 10.4c (flag de cutover pt. coduri legacy la /token, PUR).
 *
 * Frunză pură (parsează un env var, zero I/O de rețea) → tsx-testabilă. Codurile authorization_code emise de
 * `/authorize` ÎNAINTE de rescrierea user-consent (10.3b-iv) sunt „legacy client" (fără claim-uri user). Cât timp
 * rollout-ul e în curs, ruta le acceptă (fluxul de azi). DUPĂ ce toți clienții au trecut pe fluxul user, flagul
 * `PH2_REJECT_LEGACY_AUTHCODE` le REFUZĂ (invalid_grant), ca un `/authorize` care ar uita claim-urile să nu mai poată
 * emite silențios token client. Codurile expiră în 5 min, deci fereastra de coexistență e mică.
 *
 * SEMANTICĂ (fail-closed pe config ambiguu — fix cgpt „footgun"):
 *   - ABSENT (var neset) → `false` = legacy ACCEPTAT. E default-ul corect în rollout: un cod legacy legitim în zbor
 *     NU trebuie respins doar fiindcă nimeni n-a atins flagul.
 *   - `""` (var set gol) → `false` (tratat ca neset).
 *   - explicit FALSY (`0`/`false`/`no`/`off`) → `false` = legacy acceptat (dezactivare intenționată a cutover-ului).
 *   - explicit TRUTHY (`1`/`true`/`yes`/`on`) → `true` = legacy REFUZAT (cutover activat).
 *   - PREZENT dar NErecunoscut (ex. typo `treu`, `enable`, gunoi) → `true` = legacy REFUZAT. FAIL-CLOSED: dacă cineva
 *     A SETAT deliberat flagul dar l-a scris greșit, intenția aproape sigură era să ÎNCHIDĂ legacy; vechea variantă îl
 *     colapsa tăcut la `false` și REDESCHIDEA legacy (opusul intenției). Un `true` greșit e ZGOMOTOS (clienții primesc
 *     invalid_grant → observat imediat), pe când un legacy-rămas-deschis-când-credeai-că-l-ai-închis e TĂCUT. Doctrina
 *     PH-2: pe incertitudine → varianta mai restrictivă. (Absent rămâne `false`, deci rollout-ul e neafectat.)
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY  = new Set(["", "0", "false", "no", "off"]);

/** `true` = refuză codurile legacy (cutover). Absent/falsy → `false` (rollout); prezent-necunoscut → `true` (fail-closed). */
export function isLegacyAuthCodeCutoverEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.PH2_REJECT_LEGACY_AUTHCODE;
  if (typeof raw !== "string") return false; // ABSENT → default rollout (legacy acceptat)
  const v = raw.trim().toLowerCase();
  if (FALSY.has(v))  return false;           // explicit dezactivat (inclusiv "")
  if (TRUTHY.has(v)) return true;            // explicit activat
  return true;                               // PREZENT dar necunoscut → FAIL-CLOSED (refuză legacy)
}

/**
 * Lot OAuth staging §4.2 — refuzul refresh-ului LEGACY (forma client, emisă de fluxul confidențial de cod).
 *
 * §4.1 închide clienții neautorizați, dar un client M2M AUTORIZAT trece de `lookupClientById`; fără această regulă,
 * un refresh legacy emis înainte de cutover ar continua să rotească la nesfârșit, deși codul legacy e deja refuzat.
 * Decizia folosește EXACT același flag și același parser ca ramura codului (`PH2_REJECT_LEGACY_AUTHCODE` prin
 * `isLegacyAuthCodeCutoverEnabled`) — o singură sursă de adevăr, aceeași semantică fail-closed pe valori necunoscute:
 *   absent / falsy → `false` (comportamentul de azi, byte-identic); truthy / prezent-necunoscut → `true` (refuz).
 * Ruta o aplică DOAR pe forma client (după bifurcația `isUserRefresh`), ÎNAINTE de lookup, rotație sau `touchClient`.
 * Nu afectează `client_credentials` (nu emite refresh) și nici refresh-ul user/CIMD (`handleUserRefreshGrant`).
 */
export function shouldRejectLegacyRefresh(env: Record<string, string | undefined>): boolean {
  return isLegacyAuthCodeCutoverEnabled(env);
}
