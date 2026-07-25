/**
 * scripts/diagPumpfunDead.ts — DIAGNOSTIC READ-ONLY pentru dead-letter-ele pump.fun.
 *
 * Reconcile (DRY_RUN) a arătat că marea majoritate a celor ~1763 dead ies `unsupported UNKNOWN_ACCOUNT_COUNT`
 * cu fingerprint-uri dominante `19,5,18,1,1,1` / `19,27,1,1` / `19,1,27,1`. ÎNAINTE să mutăm 1700+ în
 * quarantine (= doar redenumim sertarul), verificăm CE SUNT de fapt instrucțiunile astea:
 *   - dacă instrucțiunea de 19 conturi are discriminatorul lui `create` → e un CREATE cu LAYOUT NOU (extins)
 *     → lansări REALE ratate → actualizăm parserul (adăugăm shape=19) și DUPĂ aia reconcile → requeue.
 *   - dacă e `buy`/`sell`/altceva → gate-ul de discovery bagă greșit în coadă → problema e la enqueue, nu la parser.
 *
 * Pentru fiecare pump.fun instruction dumpează: nr. conturi, DISCRIMINATOR Anchor (primii 8 bytes = hex),
 * numele (dacă discriminatorul e cunoscut), și LISTA COMPLETĂ de conturi (aici citim layout-ul).
 * Plus numele instrucțiunilor din LOGS (stack-aware) ca a doua sursă de adevăr.
 *
 * ZERO scrieri. Doar citește dead-set + re-fetch RPC.
 *
 * Rulare:  SOLANA_RPC_URL=... tsx --env-file=../../.env.local scripts/diagPumpfunDead.ts
 *          (opțional: DIAG_MAX_FETCH=60  DIAG_PER_FINGERPRINT=3)
 */

import { getRedis } from "../src/infra/redis";
import { getConnection } from "../src/infra/rpc";
import { CHAIN } from "../src/config/constants";
import { readDeadMembers, decodeCandidate } from "../src/discovery/discoveryQueue";
import { PUMPFUN_PROGRAM } from "../src/config/programs";
import { extractTargetProgramInstructions } from "../src/discovery/logStack";

const MAX_FETCH        = Number(process.env.DIAG_MAX_FETCH ?? 60);
const PER_FINGERPRINT  = Number(process.env.DIAG_PER_FINGERPRINT ?? 3);
const COOLDOWN_MS      = 200;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── base58 decode (doar pt. primii bytes ai discriminatorului) ──
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58MAP: Record<string, number> = {};
for (let i = 0; i < B58.length; i++) B58MAP[B58[i]] = i;
function base58Decode(str: string): number[] | null {
  const bytes: number[] = [];
  for (const ch of str) {
    const val = B58MAP[ch];
    if (val === undefined) return null;
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // leading '1' (zero byte) pt. fiecare '1' din față
  for (let k = 0; k < str.length && str[k] === "1"; k++) bytes.push(0);
  return bytes.reverse();
}
function discriminatorHex(dataB58: string): string {
  const bytes = base58Decode(dataB58);
  if (!bytes) return "?(base58 invalid)";
  return bytes.slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Discriminatori Anchor cunoscuți pump.fun (global:<name>, primii 8 bytes hex).
// Discriminatori verificați prin sha256("global:<name>")[:8] (create/buy/sell/initialize/withdraw/migrate)
// + Anchor emit_cpi! event authority (constant fix).
const KNOWN_DISC: Record<string, string> = {
  "181ec828051c0777": "create",
  "66063d1201daebea": "buy",
  "33e685a4017f83ad": "sell",
  "afaf6d1f0d989bed": "initialize",
  "b712469c946da122": "withdraw",
  "9beae792ec9ea21e": "migrate",
  "e445a52e51cb9a1d": "anchor-self-cpi-event", // emit_cpi! (event authority)
};

async function main(): Promise<void> {
  console.log(`[DIAG] chain=${CHAIN} maxFetch=${MAX_FETCH} perFingerprint=${PER_FINGERPRINT}`);
  const redis = getRedis();
  const connection = getConnection();

  const members = await readDeadMembers(redis, CHAIN);
  const pumpfun = members.map(decodeCandidate).filter((c): c is NonNullable<typeof c> => c !== null && c.program === "pumpfun");
  console.log(`[DIAG] dead total=${members.length} pumpfun=${pumpfun.length}`);

  const perFp: Record<string, number> = {};
  let fetched = 0;

  // Eșantionare DISTRIBUITĂ prin TOT dead-set-ul (nu primele N — alea sunt clusterul temporal al unui singur val).
  const sampleCount = Math.min(MAX_FETCH, pumpfun.length);
  const selected = Array.from({ length: sampleCount }, (_, i) => pumpfun[Math.floor((i * pumpfun.length) / sampleCount)]);
  console.log(`[DIAG] eșantionez ${sampleCount} tx distribuite prin cele ${pumpfun.length} dead pump.fun`);

  for (const cand of selected) {
    fetched++;
    let tx = null;
    try {
      tx = await connection.getParsedTransaction(cand.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch (err) {
      console.warn(`[DIAG] fetch error sig=${cand.signature.slice(0, 12)}: ${(err as Error).message}`);
      await sleep(COOLDOWN_MS);
      continue;
    }
    if (!tx) { await sleep(COOLDOWN_MS); continue; }

    const outer = tx.transaction.message.instructions;
    const inner = (tx.meta?.innerInstructions ?? []).flatMap(i => i.instructions);
    const allIx = [...outer, ...inner];

    const pfIx = allIx.filter(ix => ix.programId.toBase58() === PUMPFUN_PROGRAM);
    const counts = pfIx.map(ix => ("accounts" in ix ? (ix as unknown as { accounts: unknown[] }).accounts.length : -1));
    const fp = counts.join(",");
    if ((perFp[fp] ?? 0) >= PER_FINGERPRINT) { await sleep(COOLDOWN_MS); continue; }
    perFp[fp] = (perFp[fp] ?? 0) + 1;

    const logNames = extractTargetProgramInstructions(tx.meta?.logMessages ?? [], PUMPFUN_PROGRAM);
    console.log(`\n── sig=${cand.signature} slot=${cand.slot} err=${JSON.stringify(tx.meta?.err ?? null)} ──`);
    console.log(`   fingerprint=[${fp}]  logInstr(pump.fun)=[${logNames.join(", ")}]`);

    let idx = 0;
    for (const ix of pfIx) {
      if (!("accounts" in ix)) { console.log(`   #${idx++} ParsedInstruction (fără accounts) parsed=${JSON.stringify((ix as unknown as { parsed?: unknown }).parsed ?? null).slice(0, 80)}`); continue; }
      const anyIx = ix as unknown as { accounts: { toBase58(): string }[]; data: string };
      const accs = anyIx.accounts.map(a => a.toBase58());
      const disc = discriminatorHex(anyIx.data);
      const name = KNOWN_DISC[disc] ?? "UNKNOWN";
      console.log(`   #${idx++} accounts=${accs.length} disc=${disc} (${name})`);
      console.log(`        accts=[${accs.map((a, i) => `${i}:${a}`).join("  ")}]`);
    }

    await sleep(COOLDOWN_MS);
  }

  console.log(`\n[DIAG] fingerprint sample counts (din primele ${fetched} fetch-uri):`);
  for (const [fp, n] of Object.entries(perFp).sort((a, b) => b[1] - a[1])) {
    console.log(`   [${fp}] → ${n} sample(uri)`);
  }
  console.log(`[DIAG] done (ZERO scrieri).`);
  process.exit(0);
}

main().catch((err) => { console.error("[DIAG] fatal:", err); process.exit(1); });
