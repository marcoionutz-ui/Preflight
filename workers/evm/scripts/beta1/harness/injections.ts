/**
 * scripts/beta1/harness/injections.ts — BETA-1, felia 1: lista injecțiilor pentru selfTest.
 *
 * Fiecare injecție strică UN lucru, în afara oricărui control etichetat. `expect` = fragmentul care TREBUIE să apară
 * printre eșecurile raportate; fără el, rularea a eșuat din alt motiv decât cel injectat.
 */
export const INJECTIONS = [
  { name: "timer-rejection",  expect: "E2." },
  { name: "refresh-unref",    expect: "E4." },
  { name: "sentinel-timeout", expect: "barieră expirată" },
  { name: "leaked-interval",  expect: "E4." },
  { name: "net-violation",    expect: "E1." },
  { name: "process-fault",    expect: "E3." },
  // Anulare în timpul unui callback async: programarea e oprită, dar execuția pornită rămâne neîncheiată.
  { name: "cancel-inflight-timeout",  expect: "E4." },
  { name: "cancel-inflight-interval", expect: "E4." },
  // Eroare async apărută ÎN TIMPUL cleanup-ului (după verificarea E) și una apărută DUPĂ verificarea de după cleanup.
  { name: "cleanup-fault",      expect: "F3." },
  { name: "cleanup-late-fault", expect: "G1." },
  // Resurse (nu erori) apărute după E4: un timer nou în timpul cleanup-ului, anulat forțat de el; și un interval cu
  // `unref()` apărut după F, care nu ține procesul viu și nu aruncă nimic.
  { name: "cleanup-new-timer",   expect: "F4." },
  { name: "late-unref-interval", expect: "G2." },
] as const;

export type InjectionName = typeof INJECTIONS[number]["name"];
