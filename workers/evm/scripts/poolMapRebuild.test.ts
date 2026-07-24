/**
 * scripts/poolMapRebuild.test.ts — D5.
 *
 * Testează helperele PURE (funcțiile REALE de producție, importate — fără PairMap / Redis / scan):
 *   - `planPoolMapRebuild` → { toDelete, toMarkRouting } (păstrează pool-urile urmărite ABSENTE din scan,
 *     marchează routing-only; șterge cele prezente-dar-reclasificate — „crede scanul");
 *   - `poolSnapshotForScoring` → sursa pt. scoring (routing-only ⇒ NU folosi cache-ul stale);
 * plus o simulare end-to-end (delete + mark + re-add) cu marker routing-only.
 *
 * Fără dependențe externe → rulează mereu, determinist.
 */

import {
  planPoolMapRebuild, poolSnapshotForScoring, type ScopedPoolKey,
} from "../src/pipeline/poolMapRebuild";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const K = (c: string, a: string) => c + ":" + a;
const asSet = (keys: ScopedPoolKey[]) => new Set(keys.map(k => K(k.chain, k.address)));
const NOTSEEN = () => false; // pt. testele directe: intrările existente sunt „absente din scan"

// ── simulare a rebuildPoolMaps folosind decizia REALĂ (mirror al wiring-ului din scan.ts) ──
interface PoolLike { chain: string; pairAddress: string; symbol?: string; eligible?: boolean; }
function simulateRebuild(
  map: Map<string, PoolLike>,
  routingOnly: Set<string>,
  scanPools: PoolLike[],
  isWatched: (c: string, a: string) => boolean,
): void {
  const scanChains = new Set(scanPools.map(p => p.chain));
  const scanKeys = new Set(scanPools.map(p => K(p.chain, p.pairAddress))); // TOATE din scan (elig. sau nu)
  const seenInScan = (c: string, a: string) => scanKeys.has(K(c, a));
  const existing = [...map.keys()].map(k => { const i = k.indexOf(":"); return { chain: k.slice(0, i), address: k.slice(i + 1) }; });
  const { toDelete, toMarkRouting } = planPoolMapRebuild(existing, scanChains, seenInScan, isWatched);
  for (const { chain, address } of toDelete)      { map.delete(K(chain, address)); routingOnly.delete(K(chain, address)); }
  for (const { chain, address } of toMarkRouting) routingOnly.add(K(chain, address));
  for (const p of scanPools) {
    if (p.eligible === false) continue; // ~ isBlockedSymbol / dexType neacceptat → NU re-add
    map.set(K(p.chain, p.pairAddress), p);
    routingOnly.delete(K(p.chain, p.pairAddress)); // reapărut eligibil → snapshot proaspăt
  }
}

function main(): void {
  console.log("D5 — poolMapRebuild (păstrează absent-urmărit, crede scanul la reclasificare)");

  const NONE = () => false;

  // ── D5.1: pool URMĂRIT absent din scan → toMarkRouting, NU toDelete ──
  {
    const plan = planPoolMapRebuild([{ chain: "base", address: "0xWATCH" }], new Set(["base"]), NOTSEEN,
      (c, a) => c === "base" && a === "0xWATCH");
    check("D5.1a. urmărit, absent → NU în delete", plan.toDelete.length === 0);
    check("D5.1b. urmărit, absent → în markRouting", asSet(plan.toMarkRouting).has("base:0xWATCH"));
  }

  // ── D5.2: pool NEurmărit absent → toDelete ──
  {
    const plan = planPoolMapRebuild([{ chain: "base", address: "0xSTALE" }], new Set(["base"]), NOTSEEN, NONE);
    check("D5.2a. neurmărit, absent → în delete", asSet(plan.toDelete).has("base:0xSTALE"));
    check("D5.2b. neurmărit → NU markRouting", plan.toMarkRouting.length === 0);
  }

  // ── D5.3: pool pe chain NEprezent în scan → neatins ──
  {
    const plan = planPoolMapRebuild([{ chain: "arbitrum", address: "0xARB" }], new Set(["base"]), NOTSEEN, NONE);
    check("D5.3. chain nescanat → neatins", plan.toDelete.length === 0 && plan.toMarkRouting.length === 0);
  }

  // ── D5.4: „urmărit" prin oricare din cele 3 mulțimi + absent → markRouting ──
  {
    const existing: ScopedPoolKey[] = [
      { chain: "base", address: "0xW" }, { chain: "base", address: "0xH" },
      { chain: "base", address: "0xA" }, { chain: "base", address: "0xX" },
    ];
    const w = new Set(["base:0xW"]), h = new Set(["base:0xH"]), ar = new Set(["base:0xA"]);
    const isWatched = (c: string, a: string) => w.has(K(c, a)) || h.has(K(c, a)) || ar.has(K(c, a));
    const plan = planPoolMapRebuild(existing, new Set(["base"]), NOTSEEN, isWatched);
    const mark = asSet(plan.toMarkRouting), del = asSet(plan.toDelete);
    check("D5.4a. activeWatch absent → markRouting", mark.has("base:0xW"));
    check("D5.4b. hot absent → markRouting", mark.has("base:0xH"));
    check("D5.4c. armed absent → markRouting", mark.has("base:0xA"));
    check("D5.4d. neurmărit → delete", del.has("base:0xX") && del.size === 1 && mark.size === 3);
  }

  // ── D5.5: multi-chain — izolare corectă ──
  {
    const existing: ScopedPoolKey[] = [
      { chain: "base", address: "0xB1" }, { chain: "base", address: "0xB2" },
      { chain: "arbitrum", address: "0xA1" },
    ];
    const plan = planPoolMapRebuild(existing, new Set(["base"]), NOTSEEN, (c, a) => K(c, a) === "base:0xB2");
    check("D5.5a. base neurmărit → delete", asSet(plan.toDelete).has("base:0xB1"));
    check("D5.5b. base urmărit absent → markRouting", asSet(plan.toMarkRouting).has("base:0xB2"));
    check("D5.5c. arbitrum nescanat → neatins", !asSet(plan.toDelete).has("arbitrum:0xA1") && !asSet(plan.toMarkRouting).has("arbitrum:0xA1"));
  }

  // ── D5.6 (end-to-end): pool V3 urmărit căzut din scan RĂMÂNE în hartă + routing-only ──
  {
    const map = new Map<string, PoolLike>();
    const routingOnly = new Set<string>();
    map.set("base:0xWATCH", { chain: "base", pairAddress: "0xWATCH", symbol: "WCH" });
    map.set("base:0xOLD",   { chain: "base", pairAddress: "0xOLD",   symbol: "OLD" });
    const scanPools: PoolLike[] = [{ chain: "base", pairAddress: "0xNEW", symbol: "NEW" }];
    simulateRebuild(map, routingOnly, scanPools, (c, a) => K(c, a) === "base:0xWATCH");
    check("D5.6a. urmărit căzut din scan → ÎNCĂ în hartă (rutare WS)", map.has("base:0xWATCH"));
    check("D5.6b. urmărit căzut → marcat routing-only", routingOnly.has("base:0xWATCH"));
    check("D5.6c. neurmărit căzut → curățat", !map.has("base:0xOLD"));
    check("D5.6d. neurmărit căzut → fără marker", !routingOnly.has("base:0xOLD"));
    check("D5.6e. nou din scan → adăugat, fără marker", map.has("base:0xNEW") && !routingOnly.has("base:0xNEW"));
    const map2 = new Map<string, PoolLike>([["base:0xWATCH", { chain: "base", pairAddress: "0xWATCH" }]]);
    simulateRebuild(map2, new Set<string>(), scanPools, NONE);
    check("D5.6f. (regresie) fără preservare → urmăritul AR FI dispărut", !map2.has("base:0xWATCH"));
  }

  // ── D5.7: pool urmărit ȘI prezent (eligibil) în scan → metadata proaspătă + marker curățat ──
  {
    const map = new Map<string, PoolLike>([["base:0xW", { chain: "base", pairAddress: "0xW", symbol: "OLD_META" }]]);
    const routingOnly = new Set<string>();
    simulateRebuild(map, routingOnly, [{ chain: "base", pairAddress: "0xW", symbol: "FRESH_META" }], (c, a) => K(c, a) === "base:0xW");
    check("D5.7a. urmărit + în scan → metadata proaspătă", map.get("base:0xW")?.symbol === "FRESH_META");
    check("D5.7b. urmărit + în scan → NU e routing-only", !routingOnly.has("base:0xW"));
  }

  // ── D5.8: watched absent → hartă păstrată + marker true ──
  {
    const map = new Map<string, PoolLike>([["base:0xW", { chain: "base", pairAddress: "0xW" }]]);
    const routingOnly = new Set<string>();
    simulateRebuild(map, routingOnly, [{ chain: "base", pairAddress: "0xOTHER" }], (c, a) => K(c, a) === "base:0xW");
    check("D5.8. watched absent → map păstrat + routingOnly=true", map.has("base:0xW") && routingOnly.has("base:0xW"));
  }

  // ── D5.9: pool routing-only reapare (eligibil) în scan → marker șters ──
  {
    const map = new Map<string, PoolLike>([["base:0xW", { chain: "base", pairAddress: "0xW", symbol: "STALE" }]]);
    const routingOnly = new Set<string>(["base:0xW"]);
    simulateRebuild(map, routingOnly, [{ chain: "base", pairAddress: "0xW", symbol: "FRESH" }], (c, a) => K(c, a) === "base:0xW");
    check("D5.9a. reapărut → marker șters", !routingOnly.has("base:0xW"));
    check("D5.9b. reapărut → metadata proaspătă", map.get("base:0xW")?.symbol === "FRESH");
  }

  // ── D5.10: pool NEurmărit șters → marker curățat (fără leak) ──
  {
    const map = new Map<string, PoolLike>([["base:0xZ", { chain: "base", pairAddress: "0xZ" }]]);
    const routingOnly = new Set<string>(["base:0xZ"]);
    simulateRebuild(map, routingOnly, [{ chain: "base", pairAddress: "0xOTHER" }], NONE);
    check("D5.10a. neurmărit absent → șters din hartă", !map.has("base:0xZ"));
    check("D5.10b. neurmărit absent → marker curățat", !routingOnly.has("base:0xZ"));
  }

  // ── D5.11 / D5.12: poolSnapshotForScoring ──
  {
    const cached = { chain: "base", pairAddress: "0xW", symbol: "X" };
    check("D5.11. routing-only → undefined (fetch fresh)", poolSnapshotForScoring(cached, true) === undefined);
    check("D5.12a. non-routing-only → folosește cache-ul", poolSnapshotForScoring(cached, false) === cached);
    check("D5.12b. non-routing-only fără cache → undefined", poolSnapshotForScoring(undefined, false) === undefined);
  }

  // ── D5.13: urmărit + ABSENT din scan → routing-only (confirmă seenInScan=false) ──
  {
    const plan = planPoolMapRebuild([{ chain: "base", address: "0xABC" }], new Set(["base"]),
      NOTSEEN, () => true); // seenInScan=false (absent), watched=true
    check("D5.13. urmărit + absent → markRouting", asSet(plan.toMarkRouting).has("base:0xABC") && plan.toDelete.length === 0);
  }

  // ── D5.14: urmărit + PREZENT în scan dar V2 (neeligibil pt. V3) → șters din harta V3 (rutare corectă) ──
  {
    const map = new Map<string, PoolLike>([["base:0xABC", { chain: "base", pairAddress: "0xABC", symbol: "WAS_V3" }]]);
    const routingOnly = new Set<string>();
    // apare în scan dar NEeligibil (ex. acum V2 / dexId neacceptat) → eligible:false → NU re-add în V3
    simulateRebuild(map, routingOnly, [{ chain: "base", pairAddress: "0xABC", symbol: "NOW_V2", eligible: false }], (c, a) => K(c, a) === "base:0xABC");
    check("D5.14a. prezent dar reclasificat → ȘTERS din harta V3", !map.has("base:0xABC"));
    check("D5.14b. NU e marcat routing-only (nu conservăm o rutare greșită)", !routingOnly.has("base:0xABC"));
  }

  // ── D5.15: urmărit + prezent dar blocat (neeligibil) → șters ──
  {
    const plan = planPoolMapRebuild([{ chain: "base", address: "0xBLK" }], new Set(["base"]),
      (c, a) => K(c, a) === "base:0xBLK", // seenInScan=true (e în scan)
      () => true);                         // watched=true
    check("D5.15a. prezent-neeligibil urmărit → în delete", asSet(plan.toDelete).has("base:0xBLK"));
    check("D5.15b. prezent → NU markRouting", plan.toMarkRouting.length === 0);
  }

  // ── D5.16: urmărit + prezent V3 eligibil → re-add fresh, fără marker ──
  {
    const map = new Map<string, PoolLike>([["base:0xE", { chain: "base", pairAddress: "0xE", symbol: "OLD" }]]);
    const routingOnly = new Set<string>();
    simulateRebuild(map, routingOnly, [{ chain: "base", pairAddress: "0xE", symbol: "FRESH", eligible: true }], (c, a) => K(c, a) === "base:0xE");
    check("D5.16a. prezent eligibil → re-add fresh", map.get("base:0xE")?.symbol === "FRESH");
    check("D5.16b. prezent eligibil → fără marker routing-only", !routingOnly.has("base:0xE"));
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
