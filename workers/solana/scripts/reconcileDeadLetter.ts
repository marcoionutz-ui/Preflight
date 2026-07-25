/**
 * scripts/reconcileDeadLetter.ts — NF3: reconcile ONE-TIME al dead-letter-elor deja existente.
 *
 * NF3 previne dead-letter-ele FALSE de acum înainte, dar cele deja în Redis rămân — iar `queueStats.dead > 0`
 * ține health-ul DEGRADED la infinit. Scriptul re-fetch-uiește fiecare membru pump.fun din dead-set și aplică
 * politica NF3 (`reconcileActionFor`):
 *   ok          → requeue (era o creare validă, fals dead-letter din vechiul `null`) → reprocesează
 *   invalid     → drop (sigur nu-i creare → scoate din dead, curăță health-ul)
 *   unsupported → quarantine (variantă nouă → mută în quarantine durabil + scoate din dead)
 *   unavailable → leave (RPC tot nu servește → lasă în dead, nu inventăm o decizie; re-rulează mai târziu)
 *
 * SIGURANȚĂ: DRY_RUN implicit — doar RAPORTEAZĂ planul, NU mută nimic. Setează `RECONCILE_APPLY=1` ca să aplice.
 * (Nu DEL manual la grămadă — fiecare decizie e per-candidat, verificată prin re-fetch.)
 *
 * Rulare:  tsx --env-file=../../.env.local scripts/reconcileDeadLetter.ts            # DRY_RUN
 *          RECONCILE_APPLY=1 tsx --env-file=../../.env.local scripts/reconcileDeadLetter.ts   # aplică
 */

import { getRedis } from "../src/infra/redis";
import { getConnection } from "../src/infra/rpc";
import { CHAIN } from "../src/config/constants";
import {
  readDeadMembers, removeFromDead, requeueDeadCandidate, quarantineUnsupported,
  reconcileActionFor, decodeCandidate,
} from "../src/discovery/discoveryQueue";
import { fetchPumpfunCreate } from "../src/discovery/pumpfunFetcher";

const APPLY = process.env.RECONCILE_APPLY === "1";
const RECONCILE_RETRY_MS = [500, 2_000]; // fetch scurt pt. bulk; unavailable → leave (re-rulează)
const COOLDOWN_MS = 250;                  // rate-limit blând între re-fetch-uri
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`[RECONCILE] mode=${APPLY ? "APPLY" : "DRY_RUN"} chain=${CHAIN}`);
  const redis = getRedis();
  const connection = getConnection();

  const members = await readDeadMembers(redis, CHAIN);
  console.log(`[RECONCILE] dead members: ${members.length}`);

  const tally = { requeue: 0, drop: 0, quarantine: 0, leave: 0, skipNonPumpfun: 0, corrupt: 0 };

  for (const member of members) {
    const candidate = decodeCandidate(member);
    if (!candidate) {
      tally.corrupt++;
      console.warn(`[RECONCILE] corrupt member (drop): ${member.slice(0, 40)}`);
      if (APPLY) await removeFromDead(redis, CHAIN, member);
      continue;
    }

    // NF3 e pump.fun-scoped; cpmm/clmm rămân în dead (follow-up separat).
    if (candidate.program !== "pumpfun") {
      tally.skipNonPumpfun++;
      console.log(`[RECONCILE] skip ${candidate.program} sig=${candidate.signature.slice(0, 12)} (non-pumpfun)`);
      continue;
    }

    const fetched = await fetchPumpfunCreate(connection, candidate.signature, RECONCILE_RETRY_MS);
    const action = reconcileActionFor(fetched.status);
    const detail = fetched.status === "unsupported" ? ` reason=${fetched.reason} accountCounts=${fetched.accountCounts.join(",")}`
                 : fetched.status === "invalid"     ? ` reason=${fetched.reason}` : "";
    console.log(
      `[RECONCILE] ${action.toUpperCase()} sig=${candidate.signature.slice(0, 12)} slot=${candidate.slot}`
      + ` status=${fetched.status}${detail}`,
    );

    if (APPLY) {
      if (action === "requeue") {
        await requeueDeadCandidate(redis, CHAIN, member); // ATOMIC (dead→pending într-un EVAL)
      } else if (action === "drop") {
        await removeFromDead(redis, CHAIN, member);
      } else if (action === "quarantine") {
        if (fetched.status === "unsupported") {
          // quarantine ÎNAINTE de removeFromDead (HSET idempotent → crash între ele = re-rulare sigură).
          await quarantineUnsupported(redis, CHAIN, candidate, fetched.accountCounts, fetched.reason);
        }
        await removeFromDead(redis, CHAIN, member);
      }
      // "leave" → nimic
    }

    tally[action]++;
    await sleep(COOLDOWN_MS);
  }

  console.log(
    `[RECONCILE] done. requeue=${tally.requeue} drop=${tally.drop} quarantine=${tally.quarantine}`
    + ` leave=${tally.leave} skipNonPumpfun=${tally.skipNonPumpfun} corrupt=${tally.corrupt}`
    + (APPLY ? " (APPLIED)" : " (DRY_RUN — nimic mutat; RECONCILE_APPLY=1 ca să aplici)"),
  );
  process.exit(0);
}

main().catch((err) => { console.error("[RECONCILE] fatal:", err); process.exit(1); });
