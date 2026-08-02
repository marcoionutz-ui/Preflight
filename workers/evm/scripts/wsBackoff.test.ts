/**
 * scripts/wsBackoff.test.ts — E27 (leaf pur reconnectDelayMs).
 *
 * `rand01` INJECTAT → determinist. Acoperă: attempt 0 = base, dublare exponențială, plafon (cap),
 * limite jitter (rand01=0 → floor exp·(1-jr); rand01=1 → exp), monotonie pe rand fix, clamp rand
 * în afara [0,1], attempt negativ/NaN → 0, config invalid (base 0/NaN → 1000; cap<base → base;
 * jitterRatio NaN/>1/<0 → clamp), fără NaN/Infinity la attempt uriaș.
 */
import { reconnectDelayMs, type BackoffConfig } from "../src/ws/wsBackoff";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const CFG: BackoffConfig = { baseMs: 1000, capMs: 30_000, jitterRatio: 0.5 };

function main(): void {
  console.log("E27 leaf — reconnectDelayMs(attempt, cfg, rand01)");

  // exp fără jitter (rand=1 → delay = exp cu jr=0.5? nu: delay=exp*(1-0.5+0.5)=exp). rand=1 dă exact exp.
  check("1. attempt 0, rand 1 → base (1000)",   reconnectDelayMs(0, CFG, 1) === 1000);
  check("2. attempt 1, rand 1 → 2×base (2000)", reconnectDelayMs(1, CFG, 1) === 2000);
  check("3. attempt 2, rand 1 → 4000",          reconnectDelayMs(2, CFG, 1) === 4000);
  check("4. attempt 3, rand 1 → 8000",          reconnectDelayMs(3, CFG, 1) === 8000);
  check("5. attempt 4, rand 1 → 16000",         reconnectDelayMs(4, CFG, 1) === 16000);
  check("6. attempt 5, rand 1 → cap 30000 (32000 plafonat)", reconnectDelayMs(5, CFG, 1) === 30000);
  check("7. attempt 10, rand 1 → cap 30000",    reconnectDelayMs(10, CFG, 1) === 30000);

  // jitter: rand=0 → floor = exp*(1-jr) = exp*0.5.
  check("8. attempt 0, rand 0 → floor 500 (0.5·base)", reconnectDelayMs(0, CFG, 0) === 500);
  check("9. attempt 1, rand 0 → 1000 (0.5·2000)",      reconnectDelayMs(1, CFG, 0) === 1000);
  check("10. attempt 0, rand 0.5 → 750 (mid)",         reconnectDelayMs(0, CFG, 0.5) === 750);

  // jitter bounds pentru orice rand01 ∈ [0,1]: delay ∈ [0.5·exp, exp].
  {
    let ok = true;
    for (let a = 0; a <= 8; a++) {
      const exp = Math.min(CFG.capMs, CFG.baseMs * 2 ** a);
      for (const r of [0, 0.13, 0.37, 0.5, 0.78, 1]) {
        const d = reconnectDelayMs(a, CFG, r);
        if (d < Math.round(exp * 0.5) - 1 || d > exp + 1) ok = false;
      }
    }
    check("11. jitter în [0.5·exp, exp] pt. toate attempt×rand", ok);
  }

  // monotonie pe rand fix (nedescrescător cu attempt, până la cap).
  {
    let ok = true, prev = -1;
    for (let a = 0; a <= 10; a++) { const d = reconnectDelayMs(a, CFG, 1); if (d < prev) ok = false; prev = d; }
    check("12. monoton crescător (rand fix) până la cap", ok);
  }

  // clamp rand în afara [0,1].
  check("13. rand > 1 tratat ca 1 (→ exp)",   reconnectDelayMs(0, CFG, 5) === 1000);
  check("14. rand < 0 tratat ca 0 (→ floor)", reconnectDelayMs(0, CFG, -3) === 500);
  check("15. rand NaN tratat ca 0",           reconnectDelayMs(0, CFG, NaN) === 500);

  // attempt invalid.
  check("16. attempt negativ → ca 0", reconnectDelayMs(-5, CFG, 1) === 1000);
  check("17. attempt NaN → ca 0",     reconnectDelayMs(NaN, CFG, 1) === 1000);
  check("18. attempt fracționar (2.9) → floor 2 → 4000", reconnectDelayMs(2.9, CFG, 1) === 4000);

  // config invalid (fail-safe).
  check("19. baseMs 0 → fallback 1000",      reconnectDelayMs(0, { baseMs: 0, capMs: 30_000, jitterRatio: 0.5 }, 1) === 1000);
  check("20. baseMs NaN → fallback 1000",    reconnectDelayMs(0, { baseMs: NaN, capMs: 30_000, jitterRatio: 0.5 }, 1) === 1000);
  check("21. capMs < base → cap = base",     reconnectDelayMs(5, { baseMs: 1000, capMs: 100, jitterRatio: 0 }, 1) === 1000);
  check("22. jitterRatio 0 → fără jitter (delay=exp indiferent de rand)",
    reconnectDelayMs(2, { baseMs: 1000, capMs: 30_000, jitterRatio: 0 }, 0) === 4000);
  check("23. jitterRatio NaN → tratat ca 0", reconnectDelayMs(2, { baseMs: 1000, capMs: 30_000, jitterRatio: NaN }, 0) === 4000);
  check("24. jitterRatio > 1 → clamp la 1 (rand 0 → 0)", reconnectDelayMs(0, { baseMs: 1000, capMs: 30_000, jitterRatio: 5 }, 0) === 0);

  // fără NaN/Infinity la attempt uriaș.
  {
    const d = reconnectDelayMs(1_000_000, CFG, 1);
    check("25. attempt uriaș → cap finit (30000), fără Infinity", d === 30000 && Number.isFinite(d));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
