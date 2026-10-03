# Railway GraphQL v2 — SCHEMA LOCK (PH-12 12.6 leaf 2b-2a READ + 2c-2a WRITE)

**Recon live:** 2026-09-19 (READ, 2b-2a) + 2026-09-21 (WRITE, 2c-2a), proiect Preflight (redenumit din `accomplished-miracle`), env `production`. Identitatea (project/env/service UUID) e injectată prin **manifest** și vetată live (`projectToken` == manifest, `environment.name === "production"`) — **UUID-urile NU se scriu în acest document**; recon-ul a confirmat „manifest matched" pe toate cele 5 servicii.
**Metodă:** discovery read-only + proof pass pe toate cele 5 servicii, redactor total fail-closed (zero valori de env în output). Endpoint fix `https://backboard.railway.com/graphql/v2`, header `Project-Access-Token`. Reconul WRITE (2c-2a) = **introspecție `__type` + citiri LIVE read-only VETATE (scope exact) — ZERO mutație executată** pe prod (reconw3/w4 fac și probe live: latestDeployment, volume, variabile).

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

## 9. WRITE mutations — schema-lock (12.6 leaf 2c-2a, recon read-only 2026-09-21)

Recon în etape, DOAR `__type` introspection, ZERO mutație executată pe prod:
`reconRailwayWrite1.mjs` (suprafața de 243 mutații → candidați) + `reconRailwayWrite2.mjs` (forma exactă a input/retur).

### 9.0 ⚠️ CORECȚIE DE MODEL (2026-10-02) — TREI fluxuri distincte; modelul vechi path-A/path-B e INVALID

Proba §9.6 (probe96/rev11) + diagnosticele read-only/țintite (reconw7/8/9, pe environment DISPENSABIL) + research read-only în sursa oficială Railway (CLI + docs) au demonstrat că **modelul anterior de config-write din acest document era greșit**: amesteca trei mecanisme Railway SEPARATE într-o compunere care nu există. Modelul vechi **path-A = `APPLY_CHANGESET`** și **path-B = `STAGE_COMMIT` (`variableUpsert ×N → environmentPatchCommitStaged`)** este **INVALID** și se retrage (vezi §9.5.3). `WriteSemanticsCapability` cu enum-ul `path: "APPLY_CHANGESET" | "STAGE_COMMIT"` se retrage odată cu el (§9.5.2/§9.5.3).

**Legenda de dovezi** (folosită în tot §9 de aici încolo): **[CONFIRMAT]** = din sursa oficială Railway (CLI `railwayapp/cli` și/sau docs); **[OBSERVAT]** = măsurat live pe environmentul dispensabil (reconw8/9); **[NEDOVEDIT]** = nici confirmat din sursă, nici dovedit live — rămâne deschis.

**Cele TREI mecanisme reale (fiecare = flux PROPRIU, cu probă proprie înainte de orice WRITE în prod):**

1. **Variabile DIRECTE — `variableUpsert` / `variableDelete`.** `variableUpsert` aplică la **configul stocat**, iar `skipDeploys:true` suprimă DOAR redeploy-ul automat — NU „stagează pentru un commit" (config stocat ≠ runtime al deployment-ului) **[CONFIRMAT docs]** (NU verificat prin read-back live). reconw8 a dovedit DOAR **ACCEPTAREA** mutației (HTTP 200, `variableUpsert:true`) — **NU** un read-back al valorii stocate **[OBSERVAT reconw8: acceptare]**. `variableUpsert` **NU** alimentează `environmentPatchCommitStaged` **[OBSERVAT reconw9: „No patch to apply"]** **[CONFIRMAT CLI: mecanisme separate]**. ⚠️ `variableDelete` are comportament PROPRIU — **NU se deduce din `variableUpsert`** **[NEDOVEDIT]** (fără `skipDeploys`; staging vs apply vs deploy nedovedit — §9.6 Q-D2).
2. **Patch staged EXPLICIT — `environmentStageChanges` → `environmentPatchCommitStaged`.** `environmentStageChanges(environmentId, input: EnvironmentConfig!, merge)` unde `EnvironmentConfig` = obiect nativ `{ services: { <serviceId>: { variables: { <name>: {…} } } } }`; apoi `environmentPatchCommitStaged(environmentId, commitMessage, skipDeploys)` comite acel `EnvironmentPatch` **[CONFIRMAT docs/CLI + station]**. Acesta e fluxul „Staged changes" din dashboard — **separat** de `variableUpsert`. Compunerea `variableUpsert → environmentPatchCommitStaged` **NU** funcționează **[OBSERVAT reconw9]**.
3. **IaC ChangeSet — `environmentApplyChangeSet`.** `environmentApplyChangeSet(environmentId, input: JSON!, commitMessage, baseConfigEtag, waitForCompletion)`; `input` = un ChangeSet = `{ version: 1, changes: [ … ], diagnostics: [] }` (`RAILWAY_CHANGE_SET_VERSION = 1`), un **DIFF calculat** — un `change` de variabilă = `{ kind:"variable.set", address, variable, after, path:"resources.<addr>.variables.<key>", summary, details, before? }` **[CONFIRMAT CLI `src/iac/change_set.rs`+`engine.rs`]**. Trimiterea `{ variableUpserts:[…] }` (modelul vechi) → „Unsupported RailwayChangeSet version: undefined" **[OBSERVAT reconw9]**. ⚠️ Payload-ul ChangeSet **NU se construiește manual** din simpla listă de câmpuri: CLI generează structuri specifice pentru `after`/`address`/metadate → **referința canonică = un plan produs de CLI**; forma și efectul unui payload construit separat rămân **[NEDOVEDIT LIVE]**.

**OCC:** `baseConfigEtag` e un parametru explicit DOAR pe `environmentApplyChangeSet` (fluxul 3) **[CONFIRMAT CLI]**; `variableUpsert`/`variableDelete` NU au ancoră OCC **[CONFIRMAT: lipsește din input]**. Dar **enforcement-ul lui `baseConfigEtag` ca write-fence (respingere pe etag stale) rămâne [NEDOVEDIT]** — NU se afirmă „OCC garantează prospețimea la write", NICI „OCC există doar pe fluxul 3" ca regulă universală.

**Consecință:** nimic de mai jos NU deblochează WRITE în prod. Fiecare flux ales la §9.5 cere **proba lui proprie** pe environment dispensabil înainte de orice mutație în prod; până atunci NU se emite nicio capabilitate de semantică. Secțiunile 9.1–9.3 (FORME, din introspecție) rămân valide; afirmațiile de SEMANTICĂ din 9.4–9.6 sunt re-derivate mai jos pe modelul corect.

### 9.1 Maparea `ApplyStep` (2c-1) → mutație Railway

| ApplyStep | Mutație canonică | Semnătură (args) | Retur |
|---|---|---|---|
| `set_env` | **FLUX NEALES încă (§9.6)** — candidați: (1) `variableUpsert` direct (aplicare imediată la configul stocat) [CONFIRMAT]; (2) staged explicit `environmentStageChanges`→`environmentPatchCommitStaged`; (3) IaC `environmentApplyChangeSet` (plan din CLI). Modelul vechi „variableUpsert sub STAGE_COMMIT / în input-ul APPLY_CHANGESET" = INVALID (§9.0) | `variableUpsert(input: VariableUpsertInput!)` | `Boolean!` |
| `unset_env` | `variableDelete` — REFUZAT până la proba §9.6 (comportament propriu, NU dedus din `variableUpsert`) | `variableDelete(input: VariableDeleteInput!)` | `Boolean!` |
| `start` (serviciu parcat) — **CANONIC, UNIC** | `serviceInstanceDeployV2` | `(environmentId: String!, serviceId: String!, commitSha: String)` | `String!` (**deploymentId** — tracking/after-read OBLIGATORIU) |
| `redeploy` — **ELIMINAT (reconw3)**; restart activ = `deployV2(pinned)` | ~~`serviceInstanceRedeploy`~~ (nefolosit) | `(environmentId: String!, serviceId: String!)` | `Boolean!` |
| `stop` — **CANONIC** | `deploymentStop` | `(id: String!)` — **deploymentId, NU serviceId** | `Boolean!` |
| (eliminare din ISTORIC — **NU** e operația de stop, exclus din apply) | `deploymentRemove` | `(id: String!)` — deploymentId | `Boolean!` |
| (**NEFOLOSIT** — fără id ⇒ rupe tracking-ul; exclus) | `serviceInstanceDeploy` | `(environmentId: String!, serviceId: String!, commitSha: String, latestCommit: Boolean)` | `Boolean!` |
| IaC ChangeSet (flux 3) | `environmentApplyChangeSet` | `(environmentId: String!, input: JSON!, baseConfigEtag: String, commitMessage: String, waitForCompletion: Boolean)` — `input` = `{version:1, changes:[…], diagnostics:[]}` DIN PLAN CLI, NU construit manual (§9.0) [CONFIRMAT CLI] | `ChangeSetApplyResult!` |
| Staged patch explicit (flux 2) | `environmentStageChanges` + `environmentPatchCommitStaged` | stage: `(environmentId!, input: EnvironmentConfig! = {services:{<id>:{variables:{…}}}}, merge)` → `EnvironmentPatch`; commit: `(environmentId!, commitMessage, skipDeploys)` → `String!`. **Separat de `variableUpsert`** (§9.0) [OBSERVAT/CONFIRMAT] | |

### 9.2 Input types (forme EXACTE, INPUT_OBJECT)

**`VariableUpsertInput`** — `set_env`:
- `projectId: String!`, `environmentId: String!`, `name: String!`, `value: String!` — OBLIGATORII
- `serviceId: String` — **OPȚIONAL** ⚠️ omis ⇒ variabilă la nivel de ENVIRONMENT (shared), NU per-serviciu
- `skipDeploys: Boolean` — suprimă redeploy-ul automat declanșat de set

**`VariableDeleteInput`** — `unset_env`:
- `projectId: String!`, `environmentId: String!`, `name: String!` — OBLIGATORII
- `serviceId: String` — OPȚIONAL (aceeași capcană)
- ⚠️ **NU are `skipDeploys`** — asimetrie față de upsert

**`VariableCollectionUpsertInput`** — batch (NEFOLOSIT de apply-ul nostru individual):
- `projectId: String!`, `environmentId: String!`, `variables: EnvironmentVariables!` (SCALAR), `serviceId: String`, `replace: Boolean`, `skipDeploys: Boolean`

**`EnvironmentVariables`** = **SCALAR** (JSON/map brut) — ⚠️ poartă VALORI de secret → anti-leak: NICIODATĂ reflectat/logat/construit din input netrusted
**`EnvironmentConfig`** = **SCALAR** (JSON/map brut) — idem (confirmă 2b-2a)

### 9.3 Return / config types (calea de launch/IaC)

**`EnvironmentPatch`** (OBJECT): `id: ID!`, `environmentId: String!`, `status: EnvironmentPatchStatus!`, `message: String`, `lastAppliedError: String`, `appliedAt: DateTime`, `appliedBy: AppliedByMember`, `createdAt: DateTime!`, `updatedAt: DateTime!`, `patch(decryptVariables: Boolean): EnvironmentConfig!`
**`EnvironmentPatchStatus`** (ENUM) = `APPLYING | COMMITTED | FAILED | STAGED` (confirmă 2b-2a)
**`ChangeSetApplyResult`** (OBJECT): `id: String!`, `status: String!`, `deploymentId: String`, `stagedPatchId: String`, `operationId: String`, `changes: [ChangeOperationResult!]!`, `diagnostics: JSON!`
**`ChangeOperationResult`** (OBJECT): `kind: String!`, `status: String!`, `path: String`, `summary: String`, `outputs: JSON`
**`ChangeSetPreview`** (OBJECT): `changeSet: JSON!`, `diagnostics: JSON!`, `effects: JSON!`
**`IacPartialOwnershipResult`** (OBJECT): `affectedResources: [String!]!`, `iacPartials: JSON!`
**`Environment`** (extras relevant pentru write): `configEtag: String!` (ancoră OCC), `unmergedChangesCount: Int`

### 9.4 Doctrina WRITE (obligatorie pentru clientul 2c-2b + orchestratorul 2c-3)

Referințe Railway (semantică oficială, nu doar formă GraphQL): [Manage Deployments](https://docs.railway.com/integrations/api/manage-deployments) (stop ≠ remove-din-istoric), [Manage Services](https://docs.railway.com/integrations/api/manage-services) (deploy întoarce un deployment id; redeploy reutilizează commit-ul deployment-ului existent), [Public API](https://docs.railway.com/integrations/api) (**NU presupune exactly-once** pentru mutații).

1. **`serviceId` ÎNTOTDEAUNA explicit** pe `variableUpsert`/`variableDelete`. Câmpul e nullable în schemă → omiterea îl face shared/env-level TĂCUT. Clientul WRITE refuză să trimită o variabilă per-serviciu fără `serviceId` (fail-closed pe capcană).
2. **`start` = `serviceInstanceDeployV2`, CANONIC și UNIC.** Întoarce `deploymentId: String!` — OBLIGATORIU pentru tracking + after-read. `serviceInstanceDeploy` (`Boolean!`, fără id) **NU e folosit**: fără `deploymentId` orchestratorul nu poate face after-read/tracking → rupe invariantul de urmărire. Exclus din apply (fără fallback).
3. **`stop` = `deploymentStop(deploymentId)`** (CANONIC). Railway separă *oprirea* de *eliminarea din istoric*: `deploymentStop` oprește deployment-ul care rulează; `deploymentRemove` ȘTERGE din istoric și **NU** e operația de stop — apply-ul NU o folosește. 🔒 `deploymentStop` ia `deploymentId` (NU serviceId) → confirmă lock-ul freshness/replay 2c-3: orchestratorul RE-CITEȘTE (via clientul READ 2b-2) deployment-ul ACTIV al serviciului IMEDIAT înainte de stop, apoi `deploymentStop(id)`.
4. **Config→runtime pe serviciu ACTIV — `deployV2(pinned)`, CONDIȚIONAT de proba fluxului ales.** `variableUpsert` modifică configul STOCAT; `skipDeploys:true` suprimă DOAR redeploy-ul automat **[CONFIRMAT docs]** (reconw8 a dovedit doar acceptarea mutației, nu un read-back; config stocat ≠ runtime al deployment-ului curent → o schimbare poate cere un deploy ca să ajungă în runtime). Fiindcă `activeCommitSha` nu are sursă tipizată (reconw3), NU folosim `serviceInstanceRedeploy`. DACĂ proba fluxului ales arată că write-ul de config NU redeployează singur serviciul activ → `serviceInstanceDeployV2(commitSha: pinned)` (deploy nou la SHA reproductibil, preia configul). ⚠️ Ramura „redeployează singur ⇒ niciun deploy explicit" e BLOCATĂ până putem dovedi tipizat că auto-deploy-ul rulează SHA-ul pinned (nu putem — reconw3: `deploymentId` arată CARE deployment, nu CE commit); default = **suprimăm auto-deploy-ul (unde fluxul permite) și folosim `deployV2(pinned)` CONTROLAT** (vezi §9.5.4, regula auto-redeploy+SHA). **Care anume e „write-ul de config" depinde de fluxul ales (§9.0/§9.6), nedecis încă.** Serviciile PARCATE pornesc oricum cu `deployV2` din `start`.
5. **Fazare cost-aware — PER FLUX (corecție §9.0; argumentele diferă pe flux).** `skipDeploys` NU e un parametru global: există pe `variableUpsert` (flux 1) și pe `environmentPatchCommitStaged` (flux 2 commit), DAR **NU** pe `environmentApplyChangeSet` (flux 3, care folosește `waitForCompletion`). Deci „zero deploy prematur în faza configure" se exprimă diferit pe fiecare flux și se fixează de proba fluxului; nu se presupune `skipDeploys:true` uniform. Deploy-ul controlat (`deployV2(pinned)`) vine o singură dată (pct.4 serviciu activ, sau `start` serviciu parcat).
6. **`unset_env` — REFUZ DUR NECONDIȚIONAT până la proba semantică (§9.6).** `variableDelete` NU are `skipDeploys` → efectul lui asupra staging-ului/deploy-ului NU e dovedit de introspecție, nici pe serviciu activ, nici pe serviciu oprit. Până când proba din environmentul dispensabil (§9.6) demonstrează comportamentul sigur, compilarea (§9.5) **REFUZĂ ÎNTREGUL program** (`unset_env_unproven`) la ORICE `unset_env`. Profilurile `parked`→`auth-canary`/`base-canary`/`launch` nu au nevoie de `unset_env` la deblocarea inițială (sunt tranziții de tip start+config), deci refuzul nu blochează calea de lansare. Se re-activează (posibil doar pe servicii oprite) DOAR după verdictul probei.
7. **Politica `commitSha` — PINNED, niciodată „latest" flotant.** `serviceInstanceDeployV2` acceptă `commitSha: String`. Apply-ul pasează un `commitSha` PINNED (SHA-ul known-good din capabilitatea de release, §9.4 pct.12), NU `latestCommit:true` și NU un „latest" flotant → deploy REPRODUCTIBIL (aceeași revizie pe care planul a fost construit; fără moving-target între plan și apply). `serviceInstanceRedeploy` (care reutilizează commit-ul existent, [Manage Services](https://docs.railway.com/integrations/api/manage-services)) NU e folosit — reconw3 a dovedit că nu putem verifica SHA-ul activ, deci restartul e mereu `deployV2(pinned)`.
8. **OCC pe frontiera de WRITE — parametru prezent, enforcement NEDOVEDIT (corecție §9.0).** `environmentApplyChangeSet` acceptă `baseConfigEtag`, iar `Environment.configEtag` e candidatul de ancoră optimistic-concurrency **[CONFIRMAT CLI: parametrul există pe fluxul 3]**. DAR că serverul **respinge** pe etag stale (enforcement ca write-fence) rămâne **[NEDOVEDIT]** — NU se afirmă „prospețime garantată pe write". `variableUpsert`/`variableDelete` (fluxul 1) NU au ancoră OCC **[CONFIRMAT: lipsește din input]**. Deci: clientul poate transporta `configEtag` și-l poate pasa la fluxul 3, dar prospețimea la write rămâne un RESIDUAL până când o probă dovedește enforcement-ul; re-read+re-plan NU e un fence la write (starea se poate schimba între re-read și aterizarea mutației).
9. **SCALAR JSON = secret-bearing** (`EnvironmentConfig`/`EnvironmentVariables`) → clientul WRITE e VALUE-NON-LEAKING. **Sursa valorii de `set_env` (P1):** `name`+`value` vin EXCLUSIV din `ApplyStep`-ul GENUIN (declarat-de-profil, 2c-1) — **NU din `RawState`** (care conține valorile LIVE, inclusiv secrete, și servește DOAR citirii + validării/comparației interne, nu ca sursă a valorii de scris). Clientul nu loghează, nu reflectă, nu construiește/consumă blobul JSON opac din input netrusted. `set_env` individual (`variableUpsert` cu `name`+`value` de la profil) e PREFERAT față de `variableCollectionUpsert` — valori punct-cu-punct, niciodată un blob opac.
10. **Retry DOAR pe dovadă TERMINALĂ — altfel oprire + reconciliere (P1, corecție).** Introspecția NU dovedește idempotența; API-ul public Railway spune explicit să NU presupui exactly-once. Pentru ORICE mutație cu rezultat incert (timeout, eroare de rețea, răspuns ambiguu), clientul WRITE face un RE-READ **via reader-ul staged-aware §9.5.5**. ⚠️ **Efectul ABSENT la re-read NU dovedește că mutația nu e încă în curs** (in-flight) — deci NU licențiază un retry. Retry e permis DOAR dacă re-read-ul dă o dovadă **TERMINALĂ** că mutația nu a aterizat și nu va ateriza (stare terminală non-aplicată, corelată pe identificator). Fără dovadă terminală → **OPRIRE + `MANUAL_RECONCILIATION_REQUIRED`**, niciodată retry orb. Nicio mutație nu e idempotentă a priori.
11. **Doar programe GENUINE + allowlist de mutații.** Doar programele `isGenuineProgram` (2c-1) ajung la etapa de compilare; fiecare `ApplyStep` se traduce într-o mutație CANONICĂ din tabelul 9.1; nicio mutație în afara acestui allowlist (analog allowlist-ului de query din 2b-2) nu e permisă — orice alt nume → refuz fără request.
12. **SHA-ul dorit vine dintr-o CAPABILITATE DE RELEASE (post-CI), nu dintr-un string liber.** `pinnedCommitSha` NU se ia dintr-un env/manifest arbitrar → provine dintr-o capabilitate de release emisă DUPĂ ce CI a trecut (leagă „Wait for CI" 2c-4) și e validat STRICT ca SHA Git COMPLET (40 hex). Un SHA neînsoțit de dovada de release → refuz (fail-closed). Astfel `deployV2(pinned)` fixează exact revizia known-good. `serviceInstanceRedeploy` NU e folosit nicăieri (reconw3: fără sursă tipizată pentru SHA-ul activ → orice restart = `deployV2(pinned)`).

### 9.5 `FreshWriteEvidence` + COMPILAREA `ApplyProgram → RailwayWriteProgram` (binding atomic, one-shot)

**Problema:** `RawState` (mapper-ul READ 2b-1) e ABSTRACT — poartă starea logică (running/config per rol) ȘI **conține VALORI** (`RawService.env` = valori de variabile), dar NU identificatorii concreți de care mutațiile GraphQL au nevoie ca argumente (UUID project/env/service, `deploymentId`-ul activ, `configEtag`-ul OCC, SHA-ul). Deci `RawState` **NU poate alimenta direct compilarea de WRITE** (lipsesc identificatorii) ȘI, fiindcă **poartă valori**, NU e „value-blind" → trebuie ținut PRIVAT (vezi §9.5.2: capabilitate de prepare OPACĂ, cu valorile private; §9.5.5: reader de progres FĂRĂ valori). Corecție de contract: afirmația veche „`RawState` value-blind" era greșită.

#### 9.5.1 `FreshWriteEvidence` = `ObservedWriteEvidence` (pur, GENUIN+înregistrat, FĂRĂ secrete)
Partea OBSERVATĂ (identificatori live) derivată de `prepareWrite` (§9.5.2) din ACEEAȘI citire proaspătă ca `RawState`; `pinnedCommitSha` NU face parte din ea (e în `ReleaseCapability`):
```
FreshWriteEvidence {
  projectId: string                 // UUID (manifest, vetat live)
  environmentId: string             // UUID (manifest, vetat live — env "production")
  configEtag: string                // ancoră OCC (fence 2b-2) — non-gol
  services: {                       // EXACT rolurile canonice (ServiceId), nici lipsă, nici în plus
    [role: ServiceId]: {
      serviceId: string             // UUID
      gitBacked: boolean            // Git (deployV2+SHA) vs managed/image (Redis — fără SHA)
      running: boolean              // din tuple 2b-1; "unknown" → evidence INVALIDĂ
      activeDeploymentId: string | null   // pentru stop; deployment-ul activ
      // ⛔ `pinnedCommitSha` NU e aici — NU e observație live → trăiește în `ReleaseCapability` GENUINĂ (§9.4 pct.12, §9.5.2).
      // ⛔ `activeCommitSha` ELIMINAT — reconw3 (2026-09-22): NICIUN câmp de commit TIPIZAT în suprafața LOCK-uită
      //    (Deployment/DeploymentMeta/DeploymentSnapshot; SHA doar în `meta:JSON` opac, neacceptat ca contract).
      //    Consecință: NU comparăm SHA activ vs pinned, NU folosim `redeploy` → restart = `deployV2(pinned)` (§9.5.3).
    }
  }
}
ReleaseCapability { pinnedCommitSha: string /* 40-hex, post-CI, GENUINĂ+înregistrată */ }  // per rol gitBacked; NU din evidence
```
**Coerență fail-closed (P2):** chei EXACT rolurile canonice; `running === true ⟺ activeDeploymentId` UUID valid, `running === false ⟺ activeDeploymentId === null`; orice altă combinație → evidence INVALIDĂ. Toate UUID trec regex strict; niciun `"unknown"`; ZERO valori de env (secret-free by construction). `ReleaseCapability.pinnedCommitSha` validat ca SHA Git COMPLET (40 hex), GENUINĂ (post-CI), doar pentru rolurile `gitBacked`. Registry propriu → `prepareWrite` acceptă DOAR evidence + capabilități genuine.

✅ **`activeCommitSha` — REZOLVAT prin reconw3 (2026-09-22): NICIUN câmp tipizat ACCEPTAT în suprafața LOCK-uită → eliminat.** Introspecția concluzivă pe `Deployment`/`DeploymentMeta`/`DeploymentSnapshot` a găsit ZERO câmp de commit tipizat acceptat; SHA-ul apare doar în `meta:JSON` opac (`metaShaShaped:true`), pe care doctrina NU-l acceptă ca contract fără parser+formă blocată. Decizie `NO_TYPED_SOURCE__DROP_REDEPLOY_USE_DEPLOYV2`: fără comparație SHA-activ vs pinned, fără `redeploy`; restartul controlat = `deployV2(pinnedCommitSha)` (SHA reproductibil).

#### 9.5.2 `prepareWrite(...)` — O SINGURĂ trecere, proveniență COMUNĂ (P1)

**Problema P1:** `compile(program genuin, evidence genuină)` acceptă un program produs din starea A ÎMPREUNĂ cu evidence din starea B — WeakSet-urile dovedesc doar autenticitatea SEPARATĂ, iar re-`deriveActions(program, evidence)` reproduce ACELAȘI program posibil stale fără să detecteze acțiuni LIPSĂ (evidence-ul nu conține întregul `RawState`/`managedEnv`). Deci NU compunem două obiecte independente. În schimb, o SINGURĂ funcție, dintr-o SINGURĂ citire proaspătă, produce tot lanțul INTERN:
```
prepareWrite(
  readFresh,
  target: ProfileName,
  confirmation: ApplyConfirmation | undefined,
  caps: Caps,
  release: ReleaseCapability (GENUINĂ),
  semantics?: WriteFlowCapability (GENUINĂ, per-flux — OBLIGATORIE DOAR dacă programul conține acțiuni de CONFIG (`set_env`/`unset_env`); pentru un program FĂRĂ config (doar `start`/`stop`) e ABSENTĂ. Emisă DOAR după proba fluxului ales + write-fence dovedit (§9.5.3); forma veche cu enum `path:APPLY_CHANGESET|STAGE_COMMIT` e RETRASĂ),
):
  snapshot = readFresh()                              // citirea de PREPARE (completă, cu valori) — NU reader-ul de progres §9.5.5
  { RawState, ObservedWriteEvidence } ← snapshot      // AMBELE din ACEEAȘI citire; RawState (cu valori) rămâne PRIVAT în capabilitatea opacă
  plan     = planFromRaw(RawState, target, caps)      // AdmissiblePlan | BlockedPlan
  applyPr  = planApply(plan, confirmation)            // ApplyProgram (2c-1)
  program  = compiler(applyPr, ObservedWriteEvidence, release, semantics)  // RailwayWriteProgram
  → PreparedWriteBundle (SIGILAT + înregistrat; păstrează target+confirmation+caps+release+semantics pentru re-execuția din binding)
```
Astfel programul și evidence-ul au **proveniență COMUNĂ** (aceeași citire, același lanț PUR) — imposibil să perechezi program(A) cu evidence(B); acțiunile LIPSĂ sunt prinse fiindcă planul se RE-derivă din ACELAȘI `RawState` COMPLET, nu dintr-un rezumat. `pinnedCommitSha` **NU e observație live** → vine din `ReleaseCapability` GENUINĂ (post-CI, §9.4 pct.12), separat de `ObservedWriteEvidence`. Capabilitatea de semantică de flux (`WriteFlowCapability`, formă NOUĂ per-flux) e **emisă+înregistrată DOAR de rezultatul ACCEPTAT al probei fluxului ales + write-fence dovedit** (§9.0/§9.5.3); forma veche `WriteSemanticsCapability{path:APPLY_CHANGESET|STAGE_COMMIT}` e RETRASĂ. **DOUĂ RAMURI explicite în bundle/binding (P1):** (a) program cu acțiuni de CONFIG → `semantics` OBLIGATORIE; cât timp config-WRITE e BLOCAT (nu există capabilitatea), compilarea config e REFUZATĂ (fail-closed); (b) program FĂRĂ config (doar `start`/`stop`) → `semantics` ABSENTĂ, se compilează și se leagă NORMAL. Deci independența `start`/`stop` e reală DOAR pe ramura (b), nu o afirmație globală peste o semnătură care ar cere mereu capabilitatea.

**`PreparedWriteBundle` — obiect SIGILAT + înregistrat.** `prepareWrite` construiește ATOMIC un singur obiect deep-frozen = { `railwayWriteProgram`, `observedEvidenceSnapshot`, `release`, `semantics`, `digestVersion`, `semanticsVersion` } și înregistrează **bundle-ul ÎNTREG** în `BUNDLE_REGISTRY`. **Reprezentare canonică a AMBELOR ramuri (P1 — ca digestul/claim-ul să NU varieze implicit):** câmpurile `semantics`/`semanticsVersion` sunt ÎNTOTDEAUNA prezente în formă canonică — pe ramura CU config = capabilitatea genuină + versiunea ei; pe ramura FĂRĂ config = `semantics: null` și `semanticsVersion: "none"` (sentinel fix). Serializarea canonical-JSON e identică ca set de chei pe ambele ramuri (ordine fixă de chei, fără câmpuri omise condițional) → `bundleDigest` determinist per ramură. Un SINGUR **`bundleDigest` = SHA-256 peste canonical-JSON al ÎNTREGULUI bundle** (acțiuni + args + `evidenceDigest` + `release.pinnedCommitSha` + `semanticsVersion` + `digestVersion`) = token comun la binding ȘI la claim.
- **BINDING la observația-mamă prin RE-EXECUȚIA lanțului (P1):** `evidenceDigest` = SHA-256 canonical peste `ObservedWriteEvidence` (proiect/env/configEtag + per rol canonic `serviceId`+`gitBacked`+`running`+`activeDeploymentId`). ÎNAINTE de prima mutație: `readFresh()` din nou → (a) `evidenceDigest` recalculat == cel din bundle → altfel `evidence_drift`; ȘI (b) **re-rulează `prepareWrite` PUR** pe citirea proaspătă cu EXACT aceleași `target`+`confirmation`+`caps`+`release`+`semantics` (păstrate în bundle) și cere ca `railwayWriteProgram` să fie IDENTIC (canonical-equal) cu cel din bundle → altfel `derivation_mismatch` (abort). Fiindcă re-rularea pleacă din `RawState` COMPLET, o acțiune apărută/dispărută între timp schimbă programul → prinsă.
- **Lifecycle ONE-SHOT RECUPERABIL — FĂRĂ quiescență inferată (P1):** cheia claim-ului = `bundleDigest` (digestul ÎNTREGULUI bundle — acțiuni+args+evidence+versiuni, NU doar evidence; fără valori brute în cheie/loguri). Record DURABIL în Redis { `state ∈ {CLAIMED, DONE, FAILED}`, `ownerTokenHash` (fencing value), `phaseProgress`+`correlationIds` (patchId/deploymentId/SHA per fază aterizată) }. Claim atomic (CAS create-if-absent): al doilea runner → `program_already_claimed`.
  - **`ownerToken` — proveniență + persistență (P2):** generat de runner (aleatoriu, entropie suficientă), salvat într-un **artefact LOCAL privat crash-safe** (fișier fsync-uit, nu în env/loguri); în Redis se stochează DOAR `ownerTokenHash` (hash-ul), niciodată token-ul lizibil în record-ul pe care-l protejează. Reluarea cere runner-ul să PREZINTE token-ul al cărui hash se potrivește cu `ownerTokenHash`.
  - **Recuperare: DOAR deținătorul reia, prin reconciliere** — re-citește, corelează `correlationIds` cu starea LIVE, continuă de la faza nealterată; o mutație cu rezultat incert NU se repetă decât pe **dovadă TERMINALĂ de neaplicare** (stare terminală non-aplicată, corelată pe identificator) — ABSENȚA momentană la re-read NU exclude o mutație încă in-flight, deci NU licențiază retry (§9.4 pct.10); fără dovadă terminală → `MANUAL_RECONCILIATION_REQUIRED`. **NICIODATĂ preluare automată** pe bază de „quiescență" inferată (un deploy/commit in-flight NU e observabil sigur ca terminat). Token local PIERDUT (crash fără artefact) SAU claim blocat fără deținător → **`MANUAL_RECONCILIATION_REQUIRED`** (reconciliere umană pe starea live), niciodată takeover automat. `DONE`/`FAILED` terminale → `program_already_consumed`.

#### 9.5.3 Reguli de compilare (fail-closed pe fiecare)

**Reguli GLOBALE (independente de path — plane de deploy/stop, identice în ambele compilere):**
- `unset_env(svc,key)` → **REFUZ DUR** (`unset_env_unproven`) până la proba §9.6 (§9.4 pct. 6).
- `start(svc)` → refuz dacă `evidence.services[svc].running === true` (P2, deja pornit — nimic de făcut / stare divergentă). Altfel (necesită `gitBacked`) → `serviceInstanceDeployV2({ environmentId, serviceId, commitSha: pinnedCommitSha })` → captează `deploymentId`. `!gitBacked` cu `start` → refuz (managed → altă cale, în afara scopului 2c curent).
- `stop(svc)` → refuz dacă `evidence.services[svc].running === false` (P2, deja oprit) → altfel `deploymentStop({ id: activeDeploymentId })`; `activeDeploymentId === null` → refuz.
- **`redeploy` ELIMINAT (reconw3) — restart pe serviciu activ = `deployV2(pinnedCommitSha)`:** fiindcă nu există sursă tipizată pentru `activeCommitSha` (nu putem verifica dacă serviciul activ e pe SHA-ul dorit), NU folosim `serviceInstanceRedeploy` (care ar reutiliza un commit necunoscut). Pentru un serviciu `running === true` cu ≥1 `set_env` → `serviceInstanceDeployV2({ environmentId, serviceId, commitSha: pinnedCommitSha })` (deploy nou la SHA-ul pinned, reproductibil). ⚠️ Ramura „write-ul redeployează singur ⇒ niciun deploy explicit" e BLOCATĂ până la o dovadă tipizată că auto-deploy-ul rulează SHA-ul pinned (inexistentă — reconw3); default = suprimăm auto-deploy-ul și folosim `deployV2(pinned)` controlat (§9.5.4). (Decizia vine din capabilitatea de flux per-flux, NU din câmpul retras `commitDeploysAffected`.)
- **COMPILAREA WRITE DE CONFIG = BLOCATĂ până la proba fluxului ales (corecție §9.0 — path-A/B retras).** Modelul vechi cu DOUĂ compilere (`compileApplyChangeSet` / `compileStageCommit`) și o `WriteSemanticsCapability { path: "APPLY_CHANGESET" | "STAGE_COMMIT", patchOwnershipProvable, … }` este **RETRAS**: se baza pe compunerea invalidă (`variableUpsert ×N → environmentPatchCommitStaged` nu se compune; `environmentApplyChangeSet` nu ia `variableUpsert`-uri, ci un ChangeSet `{version:1,changes}` din plan CLI). Cele trei fluxuri reale (§9.0) sunt:
  1. **variabile directe** — `variableUpsert`/`variableDelete` (aplicare imediată; fără OCC, fără commit);
  2. **patch staged explicit** — `environmentStageChanges`(`EnvironmentConfig`)→`environmentPatchCommitStaged`;
  3. **IaC ChangeSet** — `environmentApplyChangeSet(input: {version:1,changes:[…]} DIN PLAN CLI, baseConfigEtag)`.
  Emiterea `WriteFlowCapability` cere **DOUĂ dovezi SEPARATE (P1)**: (1) **proba semantică a fluxului** (cum aplică/stagează/deployează — §9.6) ȘI (2) un **write-fence DEMONSTRAT** (sau o alternativă sigură documentată). Re-read+re-plan NU e un write-fence (§9.4 pct.8); deci proba semantică SINGURĂ NU e suficientă pentru capabilitate. Până când UN flux are AMBELE, pe environment dispensabil, compilarea `set_env` rămâne PROVIZORIE și **NU se emite nicio capabilitate de semantică** (nici cea veche cu enum `path`). `set_env`/`unset_env` NU pot ajunge la WRITE în prod. ⚠️ Pentru fluxul 3, payload-ul ChangeSet se obține dintr-un **plan produs de CLI** (referință canonică), **niciodată construit manual** din lista de câmpuri — forma/efectul unui payload hand-built sunt [NEDOVEDITE]. Corelarea rămâne pe identificatori (§9.5.4), niciodată pe numărătoare de deploy-uri.

  🔒 **Lock 2c-2b (genuinitate cross-proces), re-derivat:** când un flux va fi dovedit, capabilitatea lui de semantică (formă NOUĂ, per-flux — NU enum-ul retras `APPLY_CHANGESET|STAGE_COMMIT`) se va emite de o **FABRICĂ DE ÎNCREDERE** dintr-un **semantics-lock VERSIONAT + COMIS** (fișier în repo, ca acest doc), validat strict la load; înregistrarea în registry se face DOAR de fabrică, niciodată prin `JSON.parse` al unui payload extern. Până atunci, fabrica NU emite nimic pentru config-WRITE.

#### 9.5.4 Ordine + postcondiții CORELATE (nu numărătoare — P2)
Ordine (**CANDIDATĂ — fixată de proba fluxului ales**): CONFIG-WRITE (prin fluxul ales la §9.0/§9.6 — NU „calea A/B" veche, retrasă) → START/RESTART (`deployV2(pinned)` pentru parcate ȘI pentru active-cu-config) → STOP (`deploymentStop`). ⚠️ Auto-redeploy-ul declanșat de scrierea de config **NU elimină `deployV2(pinned)`**: `deploymentId` nu dovedește SHA-ul pinned (§9.5.4 regula auto-redeploy+SHA). Dacă fluxul NU poate suprima auto-deploy-ul ȘI nu poate dovedi tipizat că acel auto-deploy rulează SHA-ul pinned, restartul serviciilor ACTIVE rămâne BLOCAT. Dacă îl poate suprima, se folosește `deployV2(pinned)` controlat. Poarta de CONFIRMARE (2c-1) rămâne pentru `stop`.
Postcondiții = **poll-uri BOUNDED (timeout DUR + cadență fixă, nr. maxim de încercări) corelate prin IDENTIFICATOR** (via reader-ul §9.5.5), NU „numărul de deployment-uri". **Setul exact de postcondiții depinde de fluxul ales (§9.0)** — cele cu `stagedPatchId`/`COMMITTED` de mai jos sunt specifice fluxului 2 (staged explicit) și se confirmă de proba acelui flux; pentru fluxul 1 (variabile directe) postcondiția e că write-ul a aterizat în configul stocat (corelat pe scope+nume), fără `stagedPatchId`:
- **(flux 1, variabile directe)** → write aterizat în configul stocat: corelare pe scope+nume **ȘI** compararea INTERNĂ a VALORII aplicate cu valoarea așteptată (din `ApplyStep`) — nu doar scope+nume (valoarea se compară intern, NU se loghează); **FĂRĂ `stagedPatchId`** (nu există patch); zero/`skipDeploys` conform probei Q-D1;
- **(flux 2, staged explicit)** → staged patch PROPRIU prezent (după `stagedPatchId`), zero deploy; apoi la commit → `COMMITTED` + `configEtag` schimbat;
- **(flux 3, IaC ChangeSet)** → `ChangeSetApplyResult.status` + `operationId`; **`stagedPatchId` OPȚIONAL (NU obligatoriu pe acest flux)**; `configEtag` schimbat; corelarea pe `operationId`/`deploymentId` din rezultat;
- **write MULTI-serviciu (flux 2/3)** → se dovedește asocierea FIECĂRUI deployment declanșat prin identificatorul EMIS/RETURNAT (`deploymentId` per serviciu), NU un singur `deploymentId` global;
- ⚠️ **auto-redeploy + SHA pinned (P1):** `deploymentId` dovedește CARE deployment, NU CE commit rulează — iar SHA-ul activ NU poate fi citit tipizat (reconw3). Deci un auto-redeploy NU poate fi declarat „pe SHA-ul pinned" doar pe baza unui `deploymentId`. Ramura „flux redeployează automat ⇒ SĂRIM `deployV2(pinned)`" e **BLOCATĂ** până există o dovadă tipizată a SHA-ului: acolo unde fluxul permite, **suprimăm** auto-deploy-ul (ex. `skipDeploys` — suprimarea declanșării deploy-ului, [Railway CLI variables](https://docs.railway.com/cli/variable)) și folosim **deploy-ul pinned CONTROLAT** (`deployV2(pinnedCommitSha)`, al cărui `deploymentId` îl EMITEM și-l corelăm). Fără dovadă de SHA pentru un auto-deploy → nu-l declarăm satisfăcut (fail-closed), nu presupunem;
- după START → `deploymentId`-ul EMIS de noi (din `deployV2`) e activ + running (corelare pe id exact);
- după STOP → deployment-ul cu id-ul țintă nu mai e activ.
Depășirea bugetului de poll SAU o postcondiție neîndeplinită → oprire fail-closed (NU continuă la faza următoare). Corelarea e pe identificatori EMIȘI/AȘTEPTAȚI, niciodată pe „a crescut contorul" (Railway poate iniția deploy-uri suplimentare).

#### 9.5.5 Reader INTERMEDIAR staged-aware (P1)
Clientul READ 2b-2 e fail-closed pe staged (REFUZĂ orice snapshot când `status=STAGED`) → NU poate verifica ciclul de write (patch propriu, tranziția STAGED→COMMITTED, corelarea deploy-ului). Deci 2c cere un **reader INTERMEDIAR** separat, staged-aware, care EXPUNE controlat DOAR: **scope-ul exact `projectId`/`environmentId`/`serviceId` (P2)**, `stagedPatchId`+`status`, `deploymentId`-urile per serviciu + statusul lor, `configEtag` (NU `activeCommitSha` — eliminat, reconw3). **Anti-leak strict (P2): NICIODATĂ payload-ul patch-ului, valori de variabile, mesaje Railway sau `diagnostics` JSON** — exclusiv identificatori, statusuri (enum), scope UUID și căi/nume canonice. E o piesă distinctă (candidat **2c-2b-reader**), NU o relaxare a clientului 2b-2.

**DOUĂ CITIRI DISTINCTE (P1 — contract explicit):** (1) citirea de **PREPARE** (§9.5.2) produce `RawState` COMPLET (cu valori `RawService.env`) + `ObservedWriteEvidence`; `RawState` cu valori rămâne **PRIVAT** într-o capabilitate de prepare OPACĂ (valorile nu ies niciodată). (2) reader-ul de **PROGRES** (acesta, §9.5.5) e o citire SEPARATĂ, FĂRĂ valori — doar identificatori/statusuri. Cele două NU se confundă: prepare are nevoie de valori ca să compileze write-ul, progresul NU le expune. (Implementarea actuală respectă asta: capability de prepare opacă + reader de progres value-free.)

⚠️ **Ownership-ul patch-ului depinde de §9.6 Q7 (P1):** reader-ul poate PRETINDE apartenența patch-ului doar dacă proba stabilește că ne putem identifica UNIVOC patch-ul propriu (`stagedPatchId` returnat/creat de mutația NOASTRĂ, captat la write-time și corelat de reader). Ownership-ul e relevant DOAR pentru fluxul 2 (staged explicit, §9.0) — fluxul 1 (variabile directe) aplică imediat, fără patch de deținut; fluxul 3 (IaC ChangeSet) returnează `stagedPatchId`/`operationId` în `ChangeSetApplyResult`. Dacă Q7 NU dovedește identificarea univocă pentru fluxul care o cere, acel flux e indisponibil. **(Notă §9.0: afirmația veche „deci se alege obligatoriu calea A" NU mai e valabilă — „calea A/B" e retrasă; alegerea de flux se face per §9.6, nu ca fallback automat.)** Până la Q7, reader-ul NU afirmă ownership.

*Decompoziție 2c-2b:* (a) **2c-2b-reader** (reader intermediar staged-aware, pur pe transport injectat) → (b) **2c-2b-prepare** (`prepareWrite` + `ObservedWriteEvidence` + `ReleaseCapability`/`WriteFlowCapability` (per-flux, §9.5.3) → `PreparedWriteBundle`, pur) → (c) **2c-2b-client** (execuție I/O: binding-check prin re-execuția lanțului, claim one-shot, mutații, postcondiții). Fiecare frunză gated.

### 9.6 Probă semantică OBLIGATORIE (environment DISPENSABIL) — 2c-2a-ii, ÎNAINTE de a finaliza compile

Introspecția (9.1–9.3) dă FORMELE, nu SEMANTICA. Contractul variabile→runtime (staging vs apply, câte/care deploy-uri, `variableDelete`, atomicitate, ownership de patch) NU e demonstrabil din schemă → probă empirică într-un **environment Railway DISPENSABIL** (proiect/env de unică folosință, serviciu dummy ieftin — NICIODATĂ `production`). Railway: `variableUpsert` aplică la configul stocat (`skipDeploys` oprește doar redeploy-ul); fluxul separat „staged changes" se stagează și se comite; `deployV2` primește SHA specific — [Using Variables](https://docs.railway.com/variables), [CLI Variables](https://docs.railway.com/cli/variable), [Staged Changes](https://docs.railway.com/deployments/staged-changes), [Manage Environments API](https://docs.railway.com/integrations/api/manage-environments), [Manage Services](https://docs.railway.com/integrations/api/manage-services), [railwayapp/cli `src/iac`](https://github.com/railwayapp/cli/blob/master/src/iac/change_set.rs). **Modelul corect = cele TREI fluxuri din §9.0.**

**STARE (2026-10-02, din probă + research — vezi §9.0 pentru legendă):**
- `variableUpsert` aplică la configul stocat; `skipDeploys` suprimă doar redeploy-ul **[CONFIRMAT docs]**; reconw8 dovedește DOAR acceptarea mutației (200, `variableUpsert:true`), NU read-back al valorii **[OBSERVAT reconw8: acceptare]**. NU alimentează `environmentPatchCommitStaged` **[OBSERVAT reconw9]**.
- `environmentPatchCommitStaged` comite patch-ul din `environmentStageChanges` (flux 2, separat) **[CONFIRMAT]**.
- `environmentApplyChangeSet.input` = `{version:1,changes:[…],diagnostics:[]}` din PLAN CLI **[CONFIRMAT CLI]**; payload hand-built **[NEDOVEDIT LIVE]**.
- Modelul vechi path-A/path-B = **INVALID** (§9.0).

**Întrebări RĂMASE, per flux** (fiecare, corelând `configEtag` + `stagedPatchId`/`status` + `deploymentId`-uri specifice — NU numărătoare; fiecare flux ales cere proba lui proprie ÎNAINTE de WRITE prod):
- *(flux 1 — variabile directe)* **Q-D1** `variableUpsert` (cu/fără `skipDeploys`) — efectul în runtime: redeployează serviciul activ sau doar schimbă configul stocat? câte deploy-uri, corelate prin id? **[reconw8: mutație ACCEPTATĂ; aplicarea la configul stocat = din docs; efectul în runtime NEDOVEDIT]**
- *(flux 1)* **Q-D2** `variableDelete` (fără `skipDeploys`) — aplică/stagează? deploy? pe oprit vs activ? comportament PROPRIU, **NU dedus din upsert** → verdict de-refuz `unset_env`. **[NEDOVEDIT]**
- *(flux 2 — staged explicit)* **Q-S1** `environmentStageChanges(EnvironmentConfig)` → `environmentPatchCommitStaged`: stagează fără deploy? `configEtag` se schimbă la stage sau la commit? câte deploy-uri la commit, per serviciu afectat? **[NEDOVEDIT]**
- *(flux 2)* **Q-S2 (fost Q7)** putem identifica UNIVOC patch-ul PROPRIU (`stagedPatchId`) și refuza dacă apar schimbări STRĂINE? **[NEDOVEDIT]**
- *(flux 3 — IaC ChangeSet)* **Q-C1** cu un plan ChangeSet PRODUS DE CLI (nu hand-built): aplică EXACT schimbările noastre? `baseConfigEtag` e **enforced** (respinge pe etag stale)? **[NEDOVEDIT — vezi §9.4 pct.8]**
- *(flux 3)* **Q-C2** ce întoarce `ChangeSetApplyResult` (`stagedPatchId`/`deploymentId`/`operationId`) și cum corelează fiecare deployment cu SHA-ul pinned? **[NEDOVEDIT]**
- *(oricare flux)* **Q-R1 (fost Q8)** ce rămâne după eșecul parțial al unui write multi-pas și cum se recuperează FĂRĂ a șterge schimbări străine? **[NEDOVEDIT]**

**Guard de siguranță POZITIV (P1) — dovadă INDEPENDENTĂ, nu co-introdusă:** un „allowlist dat de operator" pasat ODATĂ cu rularea NU e dovadă independentă (aceeași mână greșită introduce și ținta, și aprobarea). Deci:
- (a) aprobarea vine dintr-un **fișier de aprobare creat SEPARAT** (înainte, din altă sesiune) SAU din **două variabile de token SEPARATE** + **confirmare interactivă EXACTĂ** (operatorul tastează numele env-ului dispensabil, nu doar „yes");
- (b) **verificare POZITIVĂ de topologie** înainte de orice scriere: exact serviciul dummy allowlisted, **fără volume, fără domenii publice, fără referințe către servicii/resurse de producție, fără variabile cu prefixuri de producție** — altfel un env numit `throwaway-*` ar putea încă folosi resurse reale → REFUZ;
- (c) `environment.name` conține markerul dispensabil OBLIGATORIU ȘI `projectId`/`environmentId` ≠ UUID-urile de prod (manifest).
TOATE afirmativ → rulează; orice lipsă/nepotrivire → REFUZ (fail-closed), ca `isApprovedStagingSupabaseUrl` (2a).

**Cleanup (P2):** preferă **DISTRUGEREA întregului environment/proiect dispensabil** (tear-down de către Marco), NU `variableDelete` — `variableDelete` e chiar operația cu semantică NEDOVEDITĂ (Q4) și NU trebuie prezentată drept cleanup sigur.

**Guard-ul pozitiv — acum EXECUTABIL (reconul de topologie COMPLET).** Verificarea de topologie (fără volume/domenii/referințe prod/prefixuri prod) cerea câmpuri care NU sunt în §1 (queries READ locked): volume, domenii de serviciu, referințe între servicii (`source`/`upstreamUrl`), listarea variabilelor pentru check-ul de prefix. Acestea au fost LOCK-ate de reconul (ii) de mai jos (reconw5/w6) → **guard-ul e executabil și a rulat efectiv în proba §9.6** pe env-ul dispensabil (a trecut de verificarea de topologie). (Istoric: inițial guard-ul nu era executabil din §1 singur — de aici reconurile read-only dedicate.)

*Reconuri read-only necesare ÎNAINTE de scriptul cu mutații (ambele DOAR introspecție/citire, zero mutație):*
- **(i) sursă `activeCommitSha`** — ✅ RULAT `reconRailwayWrite3.mjs` (2026-09-22, rc=0, `complete:true`): NICIUN câmp de commit tipizat ACCEPTAT în suprafața lock-uită (Deployment/DeploymentMeta/DeploymentSnapshot); SHA doar în `meta:JSON` opac, IGNORAT deliberat → decizie `NO_TYPED_SOURCE__DROP_REDEPLOY_USE_DEPLOYV2`. Aplicat în §9.5.1/§9.5.3/§9.4. *(Formulare conservatoare: nu afirmăm că Railway nu va avea NICIODATĂ un câmp tipizat, doar că suprafața lock-uită acum nu conține unul acceptat.)*
- **(ii) topologie pentru guard** — ✅ COMPLET: sub-shape-urile de topologie LOCK-ate live verde de `reconRailwayWrite5.mjs` (reconw4 rev4, `complete:true`): `domains`→`AllDomains{customDomains[].domain, serviceDomains[].domain}`, `source`→`ServiceSource{image,repo}`, `upstreamUrl`→String, plus volume (`environment.volumeInstances`) și variabile (root `variablesForServiceDeployment`). Enumerarea serviciilor env-ului = `reconRailwayWrite6.mjs` (reconw4 rev5), folded în guard-ul probei. Guard-ul de topologie e deci executabil (câmpurile necesare sunt lock-ate). *(Observație: guard-ul a și RULAT efectiv în proba §9.6 — a trecut de verificarea de topologie pe env-ul dispensabil.)*

**Blocaj:** compile-ul pentru config-WRITE (`set_env`) + re-activarea `unset_env` rămân PROVIZORII și BLOCATE până când UN flux (dintre cele trei, §9.0) e ales ȘI are proba lui proprie; NU se emite nicio capabilitate de semantică până atunci (§9.5.3). Modelul vechi „proba alege o cale staged/OCC între A și B" e retras — alegerea e între cele trei fluxuri reale, iar OCC-enforcement e el însuși un RESIDUAL de dovedit (§9.4 pct.8). `start`/`stop` (deployV2/deploymentStop) + binding/one-shot/reader pot fi finalizate independent DOAR pe **ramura FĂRĂ config** (§9.5.2 ramura (b), `semantics` absentă); un program cu acțiuni de config rămâne blocat până la capabilitatea de flux + write-fence.

---
*Salvat în repo DOAR după: (READ 2b-2a) verificare manuală staged + patch 2b-1 verde (WSL) + verdict cgpt; (WRITE 2c-2a) verdict cgpt pe secțiunea 9 (contract evidence + schema-lock semantic staged changes). Versiunea de repo NU conține UUID-uri (doar „manifest matched"). Reconul WRITE (9.1–9.3 + reconw3/w4) = introspecție `__type` + citiri LIVE read-only VETATE (latestDeployment, volume, variabile) — ZERO mutație pe prod. Proba semantică §9.6 (cu mutații) rulează DOAR pe un environment dispensabil, niciodată pe `production`.*
