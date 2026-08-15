/**
 * scripts/wsSubsPublish.test.ts — Part B (worker): publicarea `wsSubs` per-kind în worker_runtime.
 *
 * Acoperă reader-ul PUR `scopedSubHealth` (confirmed/poolCount/confirmedAgeSec din `active` + harta de confirmări)
 * + un GUARD DE SURSĂ (doctrina „test verde pe helper ≠ producție wired"): manager.ts chiar setează
 * `wsLastMessageAtByKind`/`scopedConfirmedAt`, iar snapshots.ts chiar publică `wsSubs` — dacă cineva scoate
 * cablarea, testul cade, chiar dacă funcția pură rămâne verde.
 */

import { readFileSync } from "node:fs";
import { scopedSubHealth, isActiveKindMessage, scopedSubKey, type ConfirmedSub, type ScopedSubKind } from "../src/ws/scopedSubs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const NOW = 1_000_000_000_000;
const active = (entries: Array<[string, ScopedSubKind, ConfirmedSub]>) => {
  const m = new Map<string, ConfirmedSub>();
  for (const [chain, kind, sub] of entries) m.set(scopedSubKey(chain, kind), sub);
  return m;
};
// oglindește `ageSec` din snapshots.ts (vârsta la `now`, sau null dacă timestamp absent).
const ageSecAt = (t: number | undefined, now: number): number | null =>
  typeof t === "number" ? Math.max(0, Math.round((now - t) / 1000)) : null;

function main(): void {
  console.log("Part B (worker) — scopedSubHealth + guard de sursă");

  // ── scopedSubHealth (pur) ────────────────────────────────────────────────────
  console.log(" scopedSubHealth:");
  {
    const a = active([["base", "v3", { subId: "s1", snapshot: "0xa,0xb,0xc" }]]);
    const confAt = new Map<string, number>([[scopedSubKey("base", "v3"), NOW - 120_000]]);
    const h = scopedSubHealth(a, confAt, "base", "v3", NOW);
    check("1a. confirmată → confirmed true", h.confirmed === true);
    check("1b. poolCount = 3 (split pe virgula)", h.poolCount === 3);
    check("1c. confirmedAgeSec = 120 (120s în urmă)", h.confirmedAgeSec === 120);
  }
  check("2. fără subscripție activă → {false, 0, null}", (() => {
    const h = scopedSubHealth(new Map(), new Map(), "base", "v2", NOW);
    return h.confirmed === false && h.poolCount === 0 && h.confirmedAgeSec === null;
  })());
  check("3. activă dar fără confirmedAt (necunoscut) → confirmedAgeSec null", (() => {
    const a = active([["arbitrum", "v4", { subId: "s2", snapshot: "0xpool" }]]);
    const h = scopedSubHealth(a, new Map(), "arbitrum", "v4", NOW);
    return h.confirmed === true && h.poolCount === 1 && h.confirmedAgeSec === null;
  })());
  check("4. snapshot cu 1 pool → poolCount 1", (() => {
    const a = active([["bsc", "v2", { subId: "s3", snapshot: "0xonlyone" }]]);
    return scopedSubHealth(a, new Map(), "bsc", "v2", NOW).poolCount === 1;
  })());
  check("5. chain-guard: cheia (chain,kind) izolează — base:v3 ≠ base:v2", (() => {
    const a = active([["base", "v3", { subId: "s4", snapshot: "0xa,0xb" }]]);
    return scopedSubHealth(a, new Map(), "base", "v2", NOW).confirmed === false;
  })());
  check("6. confirmedAt în viitor (skew) → clamp la 0 (nu negativ)", (() => {
    const a = active([["base", "v2", { subId: "s5", snapshot: "0xa" }]]);
    const confAt = new Map<string, number>([[scopedSubKey("base", "v2"), NOW + 5_000]]);
    return scopedSubHealth(a, confAt, "base", "v2", NOW).confirmedAgeSec === 0;
  })());

  // ── isActiveKindMessage (corectitudine cgpt #1) ──────────────────────────────
  console.log(" isActiveKindMessage:");
  {
    const a = active([["base", "v2", { subId: "sub-NEW", snapshot: "0xa,0xb" }]]);
    check("m1. ⭐ mesaj de la subId ACTIV → acceptat",
      isActiveKindMessage(a, "base", "v2", "sub-NEW") === true);
    check("m2. ⭐ mesaj de la subId VECHI/orfan (≠ active) → ignorat",
      isActiveKindMessage(a, "base", "v2", "sub-OLD") === false);
    check("m3. fără subscripție activă pt. kind → ignorat",
      isActiveKindMessage(a, "base", "v3", "sub-NEW") === false);
    check("m4. subscription non-string (absent) → ignorat",
      isActiveKindMessage(a, "base", "v2", undefined) === false);
    check("m5. chain-guard: subId activ pe base ≠ pe arbitrum → ignorat",
      isActiveKindMessage(a, "arbitrum", "v2", "sub-NEW") === false);
  }

  // ── Comportamental: promovare resetează lastMessage + doar noua generație îl repopulează ─────
  // Reproduce EXACT secvența din manager (fără WebSocket): hărțile reale + helperii puri.
  console.log(" generație nouă (promovare + gating mesaj):");
  {
    const store = { active: new Map<string, ConfirmedSub>() };
    const lastMsg = new Map<string, number>();
    const key = scopedSubKey("base", "v2");
    const now = NOW;

    // gen VECHE confirmată, a livrat acum 2s
    store.active.set(key, { subId: "sub-OLD", snapshot: "0xa" });
    lastMsg.set(key, now - 2_000);
    check("g1. gen veche → lastMessageAgeSec ≈ 2", ageSecAt(lastMsg.get(key), now) === 2);

    // PROMOVARE gen nouă (ca manager pe „promoted"): active := nou + șterge lastMessage moștenit
    store.active.set(key, { subId: "sub-NEW", snapshot: "0xa" });
    lastMsg.delete(key);
    check("g2. ⭐ după promovare → lastMessageAgeSec = null (nu moștenește vârsta veche)",
      ageSecAt(lastMsg.get(key), now) === null);

    // mesaj de la subId-ul VECHI (orfan, sosit după replacement) → NU repopulează
    if (isActiveKindMessage(store.active, "base", "v2", "sub-OLD")) lastMsg.set(key, now);
    check("g3. ⭐ mesaj orfan (sub-OLD) → tot null (ignorat)",
      ageSecAt(lastMsg.get(key), now) === null);

    // primul mesaj REAL al noii generații (subId activ) → repopulează
    if (isActiveKindMessage(store.active, "base", "v2", "sub-NEW")) lastMsg.set(key, now);
    check("g4. ⭐ primul mesaj al noii generații (sub-NEW) → repopulează (age 0)",
      ageSecAt(lastMsg.get(key), now) === 0);
  }

  // ── 7. GUARD de sursă: manager.ts cablează semnalele ─────────────────────────
  {
    const src = readFileSync(new URL("../src/ws/manager.ts", import.meta.url), "utf8");
    check("7a. ⭐ manager importă wsLastMessageAtByKind + scopedConfirmedAt",
      /wsLastMessageAtByKind/.test(src) && /scopedConfirmedAt/.test(src));
    check("7b. ⭐ manager setează wsLastMessageAtByKind (per-kind din topic0)",
      /wsLastMessageAtByKind\.set\(/.test(src));
    check("7c. ⭐ manager marchează confirmarea pe „promoted”",
      /outcome === "promoted"[\s\S]{0,120}scopedConfirmedAt\.set\(/.test(src));
    check("7d. ⭐ mapează topic0 → kind (kindForTopic/TOPIC_TO_KIND)",
      /kindForTopic|TOPIC_TO_KIND/.test(src));
    // fix cgpt #1: mesajul per-kind e gated pe subscripția activă (nu doar topic0)
    check("7e. ⭐ per-kind gated pe isActiveKindMessage(...subscription)",
      /isActiveKindMessage\(\s*scopedSubStore\.active[\s\S]{0,80}wsLastMessageAtByKind\.set\(/.test(src)
      && /msg\.params\.subscription/.test(src));
    // fix cgpt #2: la promovare, vârsta de mesaj a generației vechi e ștearsă
    check("7f. ⭐ pe „promoted” șterge wsLastMessageAtByKind (generație nouă curată)",
      /outcome === "promoted"[\s\S]{0,160}wsLastMessageAtByKind\.delete\(/.test(src));
  }

  // ── 8. GUARD de sursă: snapshots.ts publică wsSubs ───────────────────────────
  {
    const src = readFileSync(new URL("../src/pipeline/snapshots.ts", import.meta.url), "utf8");
    check("8a. ⭐ snapshots importă scopedSubHealth",
      /scopedSubHealth/.test(src));
    check("8b. ⭐ snapshots publică `wsSubs` în worker_runtime",
      /wsSubs:\s*wsSubHealthForChain\(/.test(src));
    check("8c. wsSubs derivat din scopedSubStore.active + hărțile per-kind",
      /scopedSubStore\.active/.test(src) && /wsLastMessageAtByKind/.test(src));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
