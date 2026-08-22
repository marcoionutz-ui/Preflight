/**
 * lib/db/quotaKey.ts — PH-2 (cheia de quota LUNARĂ, derivată din SUBIECT). Frunză PURĂ: zero importuri grele → tsx.
 *
 * PH-2 mută enforcement-ul quotei lunare de pe CLIENT pe ACCOUNT (user_id) pentru tokenurile auth-code
 * (subject_kind=user): doi clienți ai aceluiași user împart O SINGURĂ quota lunară, cheia pe user_id. Tokenurile
 * client_credentials rămân pe client, cu namespace-ul IDENTIC cu azi (`mcp:quota:${clientId}:${ym}`, vezi
 * `reserveQuota`) ca să NU reseteze/spargă contoarele existente la deploy. Simetric cu `accountRlKeys`/`clientRlKeys`
 * din `quotaAtomic.ts` (account primește infixul `acct:`, clientul rămâne pe cheia de azi).
 *
 * NB `refundQuota` nu depinde de forma cheii: primește cheia EXACTĂ (pinned) întoarsă de `reserveQuota`, deci mutarea
 * pe user_id nu-l atinge — atâta timp cât reserve produce cheia din acest builder.
 */

/** Subiectul quotei lunare: cont (user_id) pentru auth-code, sau client (client_id) pentru client_credentials. */
export type QuotaSubject =
  | { kind: "account"; userId: string }
  | { kind: "client";  clientId: string };

/** Prefixul namespace-ului de cont — infix după `mcp:quota:`, ca `acct:` din cheile RL. Clientul NU-l folosește. */
const ACCT_INFIX = "acct:";

/**
 * an-lună UTC canonic „YYYY-MM" (lună zero-padded). Pur: determinist pentru un `Date` dat. UTC (nu local) ca luna
 * să nu „sară" cu fusul orar. `Date` invalid (NaN) → aruncă (altfel „NaN-NaN" ar deveni un bucket global partajat).
 */
export function yearMonthUTC(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("quotaKey: Date invalid pentru ym");
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** id ne-gol după trim (fail-closed: id gol/whitespace ar face toți subiecții să împartă un bucket). */
function requireId(raw: string, label: string): string {
  if (typeof raw !== "string") throw new Error(`quotaKey: ${label} lipsă`);
  const id = raw.trim();
  if (id.length === 0) throw new Error(`quotaKey: ${label} gol/whitespace — fail-closed (fără bucket partajat)`);
  return id;
}

/**
 * Cheia contorului de quota lunară pentru `subject` în luna `ym` (din `yearMonthUTC`).
 *   account → `mcp:quota:acct:${userId}:${ym}`   (namespace NOU, izolat de client)
 *   client  → `mcp:quota:${clientId}:${ym}`       (IDENTIC cu azi — client_credentials neschimbat)
 *
 * Fail-closed:
 *  - `ym` trebuie „YYYY-MM" (altfel cheie malformată → bucket greșit);
 *  - id gol/whitespace → aruncă;
 *  - un client al cărui id ar începe cu `acct:` → aruncă (ar coliza cu namespace-ul de cont; clientId-urile reale
 *    nu încep cu `acct:`, deci e o gardă ieftină anti-coliziune, nu o restricție practică).
 */
export function monthlyQuotaKey(subject: QuotaSubject, ym: string): string {
  const m = requireId(ym, "ym");
  // Validăm ȘI luna reală (01–12), nu doar forma: „2026-00"/„2026-13"/„2026-99" ar crea bucket-uri paralele.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error(`quotaKey: ym „${m}" nu e YYYY-MM cu lună 01–12`);

  // Ramuri EXPLICITE, fail-closed: un `kind` necunoscut NU cade tăcut pe client (chiar dacă ar avea `clientId`).
  if (subject.kind === "account") {
    return `mcp:quota:${ACCT_INFIX}${requireId(subject.userId, "userId")}:${m}`;
  }
  if (subject.kind === "client") {
    const clientId = requireId(subject.clientId, "clientId");
    if (clientId.startsWith(ACCT_INFIX)) {
      throw new Error(`quotaKey: clientId nu poate începe cu „${ACCT_INFIX}" (coliziune cu namespace-ul de cont)`);
    }
    return `mcp:quota:${clientId}:${m}`;
  }
  throw new Error(`quotaKey: subject kind invalid „${(subject as { kind?: unknown }).kind}"`);
}
