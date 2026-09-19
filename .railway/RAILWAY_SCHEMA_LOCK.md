# Railway GraphQL v2 — SCHEMA LOCK (PH-12 12.6 leaf 2b-2a)

**Recon live:** 2026-09-19, proiect Preflight (redenumit din `accomplished-miracle`), env `production`. Identitatea (project/env/service UUID) e injectată prin **manifest** și vetată live (`projectToken` == manifest, `environment.name === "production"`) — **UUID-urile NU se scriu în acest document**; recon-ul a confirmat „manifest matched" pe toate cele 5 servicii.
**Metodă:** discovery read-only + proof pass pe toate cele 5 servicii, redactor total fail-closed (zero valori de env în output). Endpoint fix `https://backboard.railway.com/graphql/v2`, header `Project-Access-Token`.

---

## 1. Query-uri confirmate (nume + args + retur EXACT)

```graphql
query { projectToken { projectId environmentId } }                                             # ProjectToken!
query($e:String!,$p:String){ environment(id:$e, projectId:$p){ id name configEtag unmergedChangesCount } }  # Environment!
query($p:String!){ project(id:$p){ services(first:100){ edges{ node{ id name } } pageInfo{ hasNextPage } } } }  # hasNextPage:true ⇒ REFUZ
query($e:String!,$s:String!){ serviceInstance(environmentId:$e, serviceId:$s){
  serviceId serviceName startCommand railwayConfigFile
  latestDeployment{ id status } activeDeployments{ id status } } }                              # ServiceInstance!
query($e:String!,$p:String!,$s:String!){ variablesForServiceDeployment(environmentId:$e, projectId:$p, serviceId:$s) }  # EnvironmentVariables! (SCALAR map) — rendered curent
query($e:String!,$p:String!,$s:String!){ variables(environmentId:$e, projectId:$p, serviceId:$s, unrendered:true) }     # config brut cu referințe ${{...}} (NU folosit ca env efectiv)
query($d:String!){ deploymentSnapshot(deploymentId:$d){ id variables } }                       # DeploymentSnapshot.variables (SCALAR) — env-ul deploy-time (subset user)
query($e:String!){ environmentStagedChanges(environmentId:$e){ id status } }                    # EnvironmentPatch! (NON-NULL mereu)
```

**Tipuri:** `EnvironmentVariables`, `EnvironmentConfig` = **SCALAR** (map JSON brut). `EnvironmentPatchStatus` = `APPLYING | COMMITTED | FAILED | STAGED`. `DeploymentStatus` (13) = `BUILDING, CRASHED, DEPLOYING, FAILED, INITIALIZING, NEEDS_APPROVAL, QUEUED, REMOVED, REMOVING, SKIPPED, SLEEPING, SUCCESS, WAITING`.

## 2. Coherence fence (OBLIGATORIU în client — anti-generații amestecate)
Railway permite commit fără redeploy → valorile pot proveni din două generații. Clientul citește în ordinea:
1. **Read A (înainte):** `environment.configEtag` (E0), `environmentStagedChanges.status` (S0), topologia `services` (P0), tuple-ul de deployment per serviciu (T0 = ids+statusuri active/latest).
2. **Read B (payload):** `variablesForServiceDeployment` per serviciu (+ `deploymentSnapshot(activeId).variables` pentru serviciile active).
3. **Read C (recitire):** `configEtag` (E1), staged status (S1), topologia (P1), tuple (T1).
4. `E0≠E1 ∨ S0≠S1 ∨ P0≠P1 ∨ T0≠T1` → **`snapshot_changed`** (cod static, snapshot REFUZAT), cu **retry mărginit** (ex. ≤3). Fără fence, o comparație activeEnv↔configEnv poate combina generații.

## 3. Identitate & topologie (UUID-first)
Manifest injectat leagă rol→UUID + declară `commandSource` per rol. `project.services` verifică topologia/redenumiri/servicii neașteptate; `serviceName` = doar cross-check. ServiceInstance din **root** `serviceInstance(env, svc)`. `services(first:100)` cu `pageInfo.hasNextPage:true` ⇒ **refuz** (nu listă trunchiată).

## 4. `running` din deployment (LISTĂ)
`activeDeployments:[Deployment!]!` (client colapsează: 0→null, 1→[0], **>1→`ambiguous_active_deployments`** înainte de mapare) + `latestDeployment:Deployment`.
- 1 activ coerent (`active.id===latest.id`) + ambele ∈ {SUCCESS, SLEEPING} → `running:true`;
- 0 activ + `latest ∈ {REMOVED, FAILED, CRASHED, SKIPPED}` sau fără deployment → **`running:false` (terminal non-running / parcat startabil)**;
- 0 activ + tranzitoriu (BUILDING/DEPLOYING/QUEUED/WAITING/INITIALIZING/NEEDS_APPROVAL/REMOVING) → `unknown` → omis;
- 0 activ + SUCCESS/SLEEPING (contradictoriu) → `unknown`; activ + latest roșu/divergent → `unknown`.

*(Live: serviciile parcate au `latest=FAILED`/`null`, nu `REMOVED` — de-aia terminal-non-running→false, altfel plannerul n-ar putea porni MCP-ul.)*

## 5. Variabile — rendered vs snapshot
- Sursă pentru planner = `variablesForServiceDeployment` (rendered curent; include `RAILWAY_*` injectate = surplus, tolerat ca warning). Confirmat identic cu `variables(unrendered:false)`.
- `deploymentSnapshot.variables` = env user la deploy-time — **SUBSET** (fără `RAILWAY_*`). Drift running-stale = comparație pe cheile **non-`RAILWAY_*`** (chei egale + valori byte-identice); valorile se compară intern (nu se loghează); drift pe serviciu activ → cod static + snapshot refuzat (fail-closed).

## 6. Staged changes — fail-closed pe `status`
Semnal autoritar = `environmentStagedChanges.status` (`unmergedChangesCount` vine `null` live — NU ne bazăm pe el). `STAGED`/`APPLYING` → staged (snapshot neadmisibil); `FAILED` → necunoscut/eroare (snapshot refuzat, NU „fără pending"); `COMMITTED` → curat DOAR dacă fence-ul e stabil; altceva/indisponibil → refuz. NU selectăm `message` (text liber).
**Finding prod:** `production` are `status=STAGED` acum — de inspectat manual (nu aplica/elimina automat).

## 7. Identitate startCommand (cross-check discriminat)
`ServiceInstance.startCommand` (instanță) present pe inline; `null` pe config_file (comanda în fișierul de config din repo). `ResolvedFileConfig` NU expune startCommand tipizat (`fileManifest: JSON` opac) → **nu parsăm JSON opac**.
- `commandSource: "inline"` (Redis, MCP, Worker EVM, Indexer EVM) → `startCommand` prezent + byte-exact canonic;
- `commandSource: "config_file"` (Worker Solana) → `startCommand===null` + `railwayConfigFile === "/workers/solana/railway.json"` (EXACT). Source-guard (`railwayReadPlan.test.ts`) leagă TREI surse independent: (a) `configFile` din catalog === path canonic; (b) fișierul REAL `workers/solana/railway.json` din repo există, e JSON valid și `deploy.startCommand === canonicul`; (c) blocul IaC al Solanei din `.railway/railway.ts` == canonicul. Catalog ↔ config real ↔ IaC.
- **Interimar:** acceptat doar cu `commandSource` declarat în manifest + path exact + source-guard; profilul `launch` rămâne `finalized:false` până la dovada IaC/deployment la deblocarea launch-ului.

## 8. Sealed variables
Documentația Railway indică faptul că valorile sealed nu sunt returnate de API — dar reconul **nu poate afirma general** acest lucru: a observat doar că, pe cele 5 servicii, **zero valori sunt null/empty** (deci fie nu există vars sealed acum, fie o cheie sealed apare cu valoare goală, fie lipsește). Contractul clientului (exact ca mapper-ul 2b-1): **DOAR o cheie cu valoare `null` (marker sealed/unavailable) — sau o cheie absentă — este OMISĂ din env, fără sentinel inventat**; o cheie cu string, **inclusiv empty string `""`, este PĂSTRATĂ ca atare** (mapper-ul nu o omite). Validatorul canonic tratează apoi `""`/whitespace ca absent → raportează `missing` dacă rolul o cere (fail-closed). Deci sealed → `missing` ajunge prin cheie `null`/absentă, nu prin `""`.

---
*Salvat în repo DOAR după: verificare manuală staged + patch 2b-1 verde (WSL) + verdict cgpt. Versiunea de repo NU conține UUID-uri (doar „manifest matched").*
