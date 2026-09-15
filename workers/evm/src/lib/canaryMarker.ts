/**
 * src/lib/canaryMarker.ts — PH-12 12.5c-4 (primitiva CANONICĂ a markerului de identitate a runului canary).
 *
 * SINGURĂ sursă de adevăr pentru markerul `canaryRunId` publicat de worker. Ambii writeri de payload — `worker_runtime`
 * (`pipeline/snapshots.ts`) și `worker_snapshot` (`state/memory.ts`) — o folosesc prin spread (`{ ...payload, ...canaryRunMarker() }`),
 * ca proprietatea (dormant + byte-compat când env-ul lipsește, marker exact când e prezent) să fie GARANTATĂ identic în
 * ambele locuri și TESTABILĂ o singură dată (nu oglindită în test). Fix cgpt rev6: testul de integritate exercita un
 * `buildMark` propriu → un writer putea pierde markerul fără ca testul să pice. Acum writerii sunt CABLAȚI la primitiva
 * asta, iar testul o exercită direct + dovedește cablarea (source-guard).
 *
 * DORMANT în producție: fără `CANARY_RUN_ID` (config ÎNCHIS injectat DOAR de runnerul de release-gate; allowlist-ul
 * workerului NU-l moștenește din baseEnv) → întoarce `{}` → spread-ul nu adaugă NIMIC → payload byte-identic cu legacy.
 * NU se loghează valoarea.
 */

/** `{ canaryRunId }` când `CANARY_RUN_ID` e un string ne-gol; altfel `{}` (spread no-op → byte-compat legacy). */
export function canaryRunMarker(): { canaryRunId: string } | Record<string, never> {
  const id = process.env.CANARY_RUN_ID;
  return typeof id === "string" && id !== "" ? { canaryRunId: id } : {};
}
