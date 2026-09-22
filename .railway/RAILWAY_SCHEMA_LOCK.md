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

### 9.1 Maparea `ApplyStep` (2c-1) → mutație Railway

| ApplyStep | Mutație canonică | Semnătură (args) | Retur |
|---|---|---|---|
| `set_env` | **PATH-DEPENDENT (§9.5.3)** — `variableUpsert` DOAR sub `STAGE_COMMIT`; sub `APPLY_CHANGESET` intră în `input`-ul changeset-ului, FĂRĂ `variableUpsert` | `variableUpsert(input: VariableUpsertInput!)` (doar path B) | `Boolean!` |
| `unset_env` | `variableDelete` — REFUZAT până la proba §9.6 | `variableDelete(input: VariableDeleteInput!)` | `Boolean!` |
| `start` (serviciu parcat) — **CANONIC, UNIC** | `serviceInstanceDeployV2` | `(environmentId: String!, serviceId: String!, commitSha: String)` | `String!` (**deploymentId** — tracking/after-read OBLIGATORIU) |
| `redeploy` — **ELIMINAT (reconw3)**; restart activ = `deployV2(pinned)` | ~~`serviceInstanceRedeploy`~~ (nefolosit) | `(environmentId: String!, serviceId: String!)` | `Boolean!` |
| `stop` — **CANONIC** | `deploymentStop` | `(id: String!)` — **deploymentId, NU serviceId** | `Boolean!` |
| (eliminare din ISTORIC — **NU** e operația de stop, exclus din apply) | `deploymentRemove` | `(id: String!)` — deploymentId | `Boolean!` |
| (**NEFOLOSIT** — fără id ⇒ rupe tracking-ul; exclus) | `serviceInstanceDeploy` | `(environmentId: String!, serviceId: String!, commitSha: String, latestCommit: Boolean)` | `Boolean!` |
| launch/IaC | `environmentApplyChangeSet` | `(environmentId: String!, input: JSON!, baseConfigEtag: String, commitMessage: String, waitForCompletion: Boolean)` | `ChangeSetApplyResult!` |
| launch/IaC (2 pași) | `environmentStageChanges` + `environmentPatchCommitStaged` | stage: `(environmentId!, input: EnvironmentConfig!, merge)` → `EnvironmentPatch`; commit: `(environmentId!, commitMessage, skipDeploys)` → `String!` | |

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
4. **Config→runtime pe serviciu ACTIV — `deployV2(pinned)`, CONDIȚIONAT de Q3/Q9 (reconw3: redeploy ELIMINAT).** `variableUpsert(skipDeploys:true)` modifică DOAR configul stocat. Fiindcă `activeCommitSha` nu are sursă tipizată (reconw3), NU folosim `serviceInstanceRedeploy` (ar reutiliza un commit necunoscut). DACĂ proba (Q3/Q9) arată că commit-ul staged NU deployează singur → `serviceInstanceDeployV2(commitSha: pinned)` (deploy nou la SHA reproductibil, preia configul); dacă commit-ul deployează singur → niciun deploy explicit. Serviciile PARCATE pornesc oricum cu `deployV2` din `start`.
5. **Fazare cost-aware prin `skipDeploys`**: în faza `configure` (`set_env`) → `skipDeploys: true` (zero deploy prematur, zero deploy per-variabilă); deploy-ul controlat (`deployV2(pinned)`) vine o singură dată, la punctul 4 (serviciu activ) sau prin `start` (serviciu parcat).
6. **`unset_env` — REFUZ DUR NECONDIȚIONAT până la proba semantică (§9.6).** `variableDelete` NU are `skipDeploys` → efectul lui asupra staging-ului/deploy-ului NU e dovedit de introspecție, nici pe serviciu activ, nici pe serviciu oprit. Până când proba din environmentul dispensabil (§9.6) demonstrează comportamentul sigur, compilarea (§9.5) **REFUZĂ ÎNTREGUL program** (`unset_env_unproven`) la ORICE `unset_env`. Profilurile `parked`→`auth-canary`/`base-canary`/`launch` nu au nevoie de `unset_env` la deblocarea inițială (sunt tranziții de tip start+config), deci refuzul nu blochează calea de lansare. Se re-activează (posibil doar pe servicii oprite) DOAR după verdictul probei.
7. **Politica `commitSha` — PINNED, niciodată „latest" flotant.** `serviceInstanceDeployV2` acceptă `commitSha: String`. Apply-ul pasează un `commitSha` PINNED (SHA-ul known-good din capabilitatea de release, §9.4 pct.12), NU `latestCommit:true` și NU un „latest" flotant → deploy REPRODUCTIBIL (aceeași revizie pe care planul a fost construit; fără moving-target între plan și apply). `serviceInstanceRedeploy` (care reutilizează commit-ul existent, [Manage Services](https://docs.railway.com/integrations/api/manage-services)) NU e folosit — reconw3 a dovedit că nu putem verifica SHA-ul activ, deci restartul e mereu `deployV2(pinned)`.
8. **OCC pe frontiera de WRITE**: `environmentApplyChangeSet(baseConfigEtag)` + `Environment.configEtag` = ancoră optimistic-concurrency. Clientul citește `configEtag` în fence-ul de READ (2b-2), îl transportă în `FreshWriteEvidence` și îl pasează la commit/apply; serverul respinge dacă a driftat → prospețime GARANTATĂ pe write (complement la re-read+re-plan, nu înlocuitor).
9. **SCALAR JSON = secret-bearing** (`EnvironmentConfig`/`EnvironmentVariables`) → clientul WRITE e VALUE-BLIND: nu construiește, nu reflectă, nu loghează conținutul lor. `set_env` individual (`variableUpsert` cu `name`+`value` declarate-de-profil) e PREFERAT față de `variableCollectionUpsert` tocmai ca valorile să fie punct-cu-punct, niciodată un blob JSON opac.
10. **Retry PRIN RE-READ pe rezultat incert — FĂRĂ afirmații de idempotență.** Introspecția NU dovedește idempotența, iar API-ul public Railway spune explicit să NU presupui semantică exactly-once pentru mutații. Deci pentru ORICE mutație cu rezultat incert (timeout, eroare de rețea, răspuns ambiguu), clientul WRITE NU re-încearcă orbește: face un RE-READ **via reader-ul staged-aware §9.5.5** (NU clientul 2b-2, care refuză tocmai starea `STAGED` în care ne aflăm după un `variableUpsert`) care stabilește dacă efectul a aterizat și re-încearcă DOAR dacă nu. Nicio mutație nu e declarată idempotentă a priori; claim/retry (lock 2c-1) = re-read-then-retry.
11. **Doar programe GENUINE + allowlist de mutații.** Doar programele `isGenuineProgram` (2c-1) ajung la etapa de compilare; fiecare `ApplyStep` se traduce într-o mutație CANONICĂ din tabelul 9.1; nicio mutație în afara acestui allowlist (analog allowlist-ului de query din 2b-2) nu e permisă — orice alt nume → refuz fără request.
12. **SHA-ul dorit vine dintr-o CAPABILITATE DE RELEASE (post-CI), nu dintr-un string liber.** `pinnedCommitSha` NU se ia dintr-un env/manifest arbitrar → provine dintr-o capabilitate de release emisă DUPĂ ce CI a trecut (leagă „Wait for CI" 2c-4) și e validat STRICT ca SHA Git COMPLET (40 hex). Un SHA neînsoțit de dovada de release → refuz (fail-closed). Astfel `deployV2(pinned)` fixează exact revizia known-good. `serviceInstanceRedeploy` NU e folosit nicăieri (reconw3: fără sursă tipizată pentru SHA-ul activ → orice restart = `deployV2(pinned)`).

### 9.5 `FreshWriteEvidence` + COMPILAREA `ApplyProgram → RailwayWriteProgram` (binding atomic, one-shot)

**Problema:** `RawState` (mapper-ul READ 2b-1) e ABSTRACT și VALUE-BLIND — poartă starea logică (running/config per rol), NU identificatorii concreți de care mutațiile GraphQL au nevoie ca argumente (UUID project/env/service, `deploymentId`-ul activ, `configEtag`-ul OCC, SHA-ul). Deci `RawState` **NU poate alimenta compilarea de WRITE**.

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
  semantics: WriteSemanticsCapability (GENUINĂ, emisă de probă),
):
  snapshot = readFresh()                              // O SINGURĂ citire (reader §9.5.5)
  { RawState, ObservedWriteEvidence } ← snapshot      // AMBELE derivate din ACEEAȘI citire
  plan     = planFromRaw(RawState, target, caps)      // AdmissiblePlan | BlockedPlan
  applyPr  = planApply(plan, confirmation)            // ApplyProgram (2c-1)
  program  = compiler(applyPr, ObservedWriteEvidence, release, semantics)  // RailwayWriteProgram
  → PreparedWriteBundle (SIGILAT + înregistrat; păstrează target+confirmation+caps+release+semantics pentru re-execuția din binding)
```
Astfel programul și evidence-ul au **proveniență COMUNĂ** (aceeași citire, același lanț PUR) — imposibil să perechezi program(A) cu evidence(B); acțiunile LIPSĂ sunt prinse fiindcă planul se RE-derivă din ACELAȘI `RawState` COMPLET, nu dintr-un rezumat. `pinnedCommitSha` **NU e observație live** → vine din `ReleaseCapability` GENUINĂ (post-CI, §9.4 pct.12), separat de `ObservedWriteEvidence`. `WriteSemanticsCapability` e **emisă+înregistrată de rezultatul ACCEPTAT al probei §9.6** (nu doar „numită capability"); un `path` fără capabilitate genuină → refuz.

**`PreparedWriteBundle` — obiect SIGILAT + înregistrat.** `prepareWrite` construiește ATOMIC un singur obiect deep-frozen = { `railwayWriteProgram`, `observedEvidenceSnapshot`, `release`, `semantics`, `digestVersion`, `semanticsVersion` } și înregistrează **bundle-ul ÎNTREG** în `BUNDLE_REGISTRY` (doar `prepareWrite` scrie). Clientul primește DOAR `PreparedWriteBundle` genuin (niciodată program „gol"); bundle neînregistrat → refuz. Un SINGUR **`bundleDigest` = SHA-256 peste canonical-JSON al ÎNTREGULUI bundle** (acțiuni + args + `evidenceDigest` + `release.pinnedCommitSha` + `semanticsVersion` + `digestVersion`) = token comun la binding ȘI la claim.
- **BINDING la observația-mamă prin RE-EXECUȚIA lanțului (P1):** `evidenceDigest` = SHA-256 canonical peste `ObservedWriteEvidence` (proiect/env/configEtag + per rol canonic `serviceId`+`gitBacked`+`running`+`activeDeploymentId`). ÎNAINTE de prima mutație: `readFresh()` din nou → (a) `evidenceDigest` recalculat == cel din bundle → altfel `evidence_drift`; ȘI (b) **re-rulează `prepareWrite` PUR** pe citirea proaspătă cu EXACT aceleași `target`+`confirmation`+`caps`+`release`+`semantics` (păstrate în bundle) și cere ca `railwayWriteProgram` să fie IDENTIC (canonical-equal) cu cel din bundle → altfel `derivation_mismatch` (abort). Fiindcă re-rularea pleacă din `RawState` COMPLET, o acțiune apărută/dispărută între timp schimbă programul → prinsă.
- **Lifecycle ONE-SHOT RECUPERABIL — FĂRĂ quiescență inferată (P1):** cheia claim-ului = `bundleDigest` (digestul ÎNTREGULUI bundle — acțiuni+args+evidence+versiuni, NU doar evidence; fără valori brute în cheie/loguri). Record DURABIL în Redis { `state ∈ {CLAIMED, DONE, FAILED}`, `ownerTokenHash` (fencing value), `phaseProgress`+`correlationIds` (patchId/deploymentId/SHA per fază aterizată) }. Claim atomic (CAS create-if-absent): al doilea runner → `program_already_claimed`.
  - **`ownerToken` — proveniență + persistență (P2):** generat de runner (aleatoriu, entropie suficientă), salvat într-un **artefact LOCAL privat crash-safe** (fișier fsync-uit, nu în env/loguri); în Redis se stochează DOAR `ownerTokenHash` (hash-ul), niciodată token-ul lizibil în record-ul pe care-l protejează. Reluarea cere runner-ul să PREZINTE token-ul al cărui hash se potrivește cu `ownerTokenHash`.
  - **Recuperare: DOAR deținătorul reia, prin reconciliere** — re-citește, corelează `correlationIds` cu starea LIVE, continuă de la faza nealterată; o mutație cu rezultat incert NU se repetă până când re-read-ul confirmă că n-a aterizat (§9.4 pct.10). **NICIODATĂ preluare automată** pe bază de „quiescență" inferată (un deploy/commit in-flight NU e observabil sigur ca terminat). Token local PIERDUT (crash fără artefact) SAU claim blocat fără deținător → **`MANUAL_RECONCILIATION_REQUIRED`** (reconciliere umană pe starea live), niciodată takeover automat. `DONE`/`FAILED` terminale → `program_already_consumed`.

#### 9.5.3 Reguli de compilare (fail-closed pe fiecare)

**Reguli GLOBALE (independente de path — plane de deploy/stop, identice în ambele compilere):**
- `unset_env(svc,key)` → **REFUZ DUR** (`unset_env_unproven`) până la proba §9.6 (§9.4 pct. 6).
- `start(svc)` → refuz dacă `evidence.services[svc].running === true` (P2, deja pornit — nimic de făcut / stare divergentă). Altfel (necesită `gitBacked`) → `serviceInstanceDeployV2({ environmentId, serviceId, commitSha: pinnedCommitSha })` → captează `deploymentId`. `!gitBacked` cu `start` → refuz (managed → altă cale, în afara scopului 2c curent).
- `stop(svc)` → refuz dacă `evidence.services[svc].running === false` (P2, deja oprit) → altfel `deploymentStop({ id: activeDeploymentId })`; `activeDeploymentId === null` → refuz.
- **`redeploy` ELIMINAT (reconw3) — restart pe serviciu activ = `deployV2(pinnedCommitSha)`:** fiindcă nu există sursă tipizată pentru `activeCommitSha` (nu putem verifica dacă serviciul activ e pe SHA-ul dorit), NU folosim `serviceInstanceRedeploy` (care ar reutiliza un commit necunoscut). Pentru un serviciu `running === true` cu ≥1 `set_env`, DOAR dacă `semantics.commitDeploysAffected === false` → `serviceInstanceDeployV2({ environmentId, serviceId, commitSha: pinnedCommitSha })` (deploy nou la SHA-ul pinned, care preia și configul → reproductibil). Dacă `commitDeploysAffected === true`, niciun deploy explicit (commit-ul deployează singur).
- **COMMIT staged prin `WriteSemanticsCapability` (P1 — A și B NU coexistă în reguli):** regulile de compilare NU descriu ambele căi; consumă o **`WriteSemanticsCapability`** — capabilitate emisă DUPĂ proba §9.6, care declară EXACT UNA dintre semantici + faptele dovedite:
  ```
  WriteSemanticsCapability {
    semanticsVersion: string
    path: "APPLY_CHANGESET" | "STAGE_COMMIT"     // EXACT una; niciodată ambele
    commitDeploysAffected: boolean                // Q3/Q9 — decide dacă un `deployV2(pinned)` explicit post-config e necesar
    patchOwnershipProvable: boolean               // Q7 — dacă false, path === APPLY_CHANGESET obligatoriu
  }
  ```
  **Separare EFECTIVĂ, nu ramură runtime (P1) — `set_env` e PATH-DEPENDENT, deci trăiește ÎN fiecare compiler, NU ca regulă globală:**
  - **`compileApplyChangeSet`** (path `APPLY_CHANGESET`) — TOATE `set_env`-urile devin intrări în `input`-ul UNUI SINGUR `environmentApplyChangeSet(baseConfigEtag: configEtag, input: DOAR schimbările noastre)` (atomic + OCC). NU emite `variableUpsert` individual, NU cunoaște stage/commit. (De aceea maparea `set_env → variableUpsert` NU poate fi globală — sub calea A nu există `variableUpsert`.)
  - **`compileStageCommit`** (path `STAGE_COMMIT`, permis DOAR dacă `patchOwnershipProvable`) — fiecare `set_env` → `variableUpsert({ projectId, environmentId, serviceId, name, value, skipDeploys: true })`, apoi UN commit cu ownership de `stagedPatchId`. NU cunoaște `environmentApplyChangeSet`.
  `prepareWrite` alege compilerul DUPĂ `semantics.path` O SINGURĂ dată, la construcția bundle-ului; bundle-ul rezultat poate conține FIZIC doar mutațiile căii alese (celălalt compiler nici nu e invocat). Un `path` necunoscut / capabilitate ne-genuină → refuz. **`2c-2b-prepare` NU începe până când proba emite capabilitatea cu `path` fixat** (și implementează UN compiler, nu ambele). Numărătoarea de deploy-uri NU dovedește nimic → corelare pe identificatori (§9.5.4).

  🔒 **Lock 2c-2b (genuinitate cross-proces):** rezultatul probei §9.6 PERSISTĂ între procese, dar un obiect DESERIALIZAT nu devine genuin singur. Deci `WriteSemanticsCapability` (și `ReleaseCapability`) runtime se emit de o **FABRICĂ DE ÎNCREDERE** dintr-un **semantics-lock VERSIONAT + COMIS** (fișier în repo, ca acest doc), validat strict la load; înregistrarea în registry se face DOAR de fabrică, niciodată prin `JSON.parse` al unui payload extern.

#### 9.5.4 Ordine + postcondiții CORELATE (nu numărătoare — P2)
Ordine (**CANDIDATĂ — fixată de proba §9.6; Q3/Q9 pot ELIMINA complet faza de deploy explicit post-config**): CONFIG-APPLY (calea A = un `environmentApplyChangeSet` atomic; calea B = `variableUpsert skipDeploys:true` × N → commit owned) → START/RESTART (`deployV2(pinned)` pentru parcate ȘI pentru active-cu-config, DOAR dacă commit-ul nu deployează singur) → STOP (`deploymentStop`). Poarta de CONFIRMARE (2c-1) rămâne pentru `stop`.
Postcondiții = **poll-uri BOUNDED (timeout DUR + cadență fixă, nr. maxim de încercări) corelate prin IDENTIFICATOR** (via reader-ul §9.5.5), NU „numărul de deployment-uri":
- după CONFIGURE → staged patch PROPRIU prezent (după `stagedPatchId`), zero deploy;
- după COMMIT → patch-ul nostru `COMMITTED`, `configEtag` schimbat; **pentru commit MULTI-serviciu, se dovedește asocierea FIECĂRUI deployment declanșat** (fiecare serviciu afectat → `deploymentId`-ul lui corelat prin patchId/SHA), NU un singur `deploymentId` global;
- după START → `deploymentId`-ul EMIS de noi (din `deployV2`) e activ + running (corelare pe id exact);
- după STOP → deployment-ul cu id-ul țintă nu mai e activ.
Depășirea bugetului de poll SAU o postcondiție neîndeplinită → oprire fail-closed (NU continuă la faza următoare). Corelarea e pe identificatori EMIȘI/AȘTEPTAȚI, niciodată pe „a crescut contorul" (Railway poate iniția deploy-uri suplimentare).

#### 9.5.5 Reader INTERMEDIAR staged-aware (P1)
Clientul READ 2b-2 e fail-closed pe staged (REFUZĂ orice snapshot când `status=STAGED`) → NU poate verifica ciclul de write (patch propriu, tranziția STAGED→COMMITTED, corelarea deploy-ului). Deci 2c cere un **reader INTERMEDIAR** separat, staged-aware, care EXPUNE controlat DOAR: **scope-ul exact `projectId`/`environmentId`/`serviceId` (P2)**, `stagedPatchId`+`status`, `deploymentId`-urile per serviciu + statusul lor, `configEtag` (NU `activeCommitSha` — eliminat, reconw3). **Anti-leak strict (P2): NICIODATĂ payload-ul patch-ului, valori de variabile, mesaje Railway sau `diagnostics` JSON** — exclusiv identificatori, statusuri (enum), scope UUID și căi/nume canonice. E o piesă distinctă (candidat **2c-2b-reader**), NU o relaxare a clientului 2b-2.

⚠️ **Ownership-ul patch-ului depinde de §9.6 Q7 (P1):** reader-ul poate PRETINDE apartenența patch-ului doar dacă proba stabilește că ne putem identifica UNIVOC patch-ul propriu (`stagedPatchId` returnat/creat de mutația NOASTRĂ, captat la write-time și corelat de reader). Dacă Q7 NU dovedește identificarea univocă, calea B (stage→commit cu ownership) devine imposibilă → se alege obligatoriu calea A (`environmentApplyChangeSet` atomic, care nu depinde de staged state partajat). Până la Q7, reader-ul NU afirmă ownership.

*Decompoziție 2c-2b:* (a) **2c-2b-reader** (reader intermediar staged-aware, pur pe transport injectat) → (b) **2c-2b-prepare** (`prepareWrite` + `ObservedWriteEvidence` + `ReleaseCapability`/`WriteSemanticsCapability` → `PreparedWriteBundle`, pur) → (c) **2c-2b-client** (execuție I/O: binding-check prin re-execuția lanțului, claim one-shot, mutații, postcondiții). Fiecare frunză gated.

### 9.6 Probă semantică OBLIGATORIE (environment DISPENSABIL) — 2c-2a-ii, ÎNAINTE de a finaliza compile

Introspecția (9.1–9.3) dă FORMELE, nu SEMANTICA. Contractul variabile→runtime (staging vs apply, câte/care deploy-uri, `variableDelete`, atomicitate, ownership de patch) NU e demonstrabil din schemă → probă empirică într-un **environment Railway DISPENSABIL** (proiect/env de unică folosință, serviciu dummy ieftin — NICIODATĂ `production`). Railway: schimbările de variabile sunt staged și trebuie aplicate; deploy-ul staged poate redeploya TOATE serviciile afectate; există și commit fără redeploy — [Using Variables](https://docs.railway.com/variables), [Staged Changes](https://docs.railway.com/deployments/staged-changes), [Manage Environments API](https://docs.railway.com/integrations/api/manage-environments); `deployV2` primește SHA specific, `redeploy` reutilizează commit-ul existent — [Manage Services](https://docs.railway.com/integrations/api/manage-services).

**Întrebări de dovedit** (fiecare, corelând `configEtag` + `stagedPatchId`/`status` + `deploymentId`-uri specifice — NU simplă numărătoare):
- **Q1** `variableUpsert(skipDeploys:true)` — STAGEAZĂ (status→STAGED) fără deploy? `configEtag` se schimbă la stage sau la commit?
- **Q2** `variableUpsert` FĂRĂ `skipDeploys` — aplică+deployează imediat, sau tot stagează?
- **Q3** commit staged — câte deploy-uri, corelate prin id? unul global sau unul per serviciu afectat?
- **Q4** `variableDelete` (fără `skipDeploys`) — stagează sau aplică? deploy? pe oprit vs activ? → verdict de-refuz `unset_env`.
- **Q5** OCC — `environmentApplyChangeSet(baseConfigEtag)` respinge pe etag stale? `configEtag` se schimbă la fiecare commit?
- **Q6** poate `environmentApplyChangeSet` aplica ATOMIC EXACT schimbările noastre, cu `baseConfigEtag`?
- **Q7** putem identifica UNIVOC patch-ul PROPRIU (`stagedPatchId`) și refuza dacă apar schimbări STRĂINE?
- **Q8** ce rămâne după eșecul celei de-a doua mutații dintr-un batch și cum se recuperează FĂRĂ a șterge schimbări străine?
- **Q9** commit cu `skipDeploys` → ZERO deployment-uri, urmat de EXACT un `deployV2(pinned)` explicit?
- **Q10** ce identificatori corelează fiecare deployment cu patch-ul și cu SHA-ul pinned?

**Guard de siguranță POZITIV (P1) — dovadă INDEPENDENTĂ, nu co-introdusă:** un „allowlist dat de operator" pasat ODATĂ cu rularea NU e dovadă independentă (aceeași mână greșită introduce și ținta, și aprobarea). Deci:
- (a) aprobarea vine dintr-un **fișier de aprobare creat SEPARAT** (înainte, din altă sesiune) SAU din **două variabile de token SEPARATE** + **confirmare interactivă EXACTĂ** (operatorul tastează numele env-ului dispensabil, nu doar „yes");
- (b) **verificare POZITIVĂ de topologie** înainte de orice scriere: exact serviciul dummy allowlisted, **fără volume, fără domenii publice, fără referințe către servicii/resurse de producție, fără variabile cu prefixuri de producție** — altfel un env numit `throwaway-*` ar putea încă folosi resurse reale → REFUZ;
- (c) `environment.name` conține markerul dispensabil OBLIGATORIU ȘI `projectId`/`environmentId` ≠ UUID-urile de prod (manifest).
TOATE afirmativ → rulează; orice lipsă/nepotrivire → REFUZ (fail-closed), ca `isApprovedStagingSupabaseUrl` (2a).

**Cleanup (P2):** preferă **DISTRUGEREA întregului environment/proiect dispensabil** (tear-down de către Marco), NU `variableDelete` — `variableDelete` e chiar operația cu semantică NEDOVEDITĂ (Q4) și NU trebuie prezentată drept cleanup sigur.

**Guard-ul pozitiv NU e încă executabil din schema LOCK-ată (P1).** Verificarea de topologie (fără volume/domenii/referințe prod/prefixuri prod) cere câmpuri care NU sunt în §1 (queries READ locked): listarea volumelor, a domeniilor de serviciu, a referințelor între servicii, listarea variabilelor pentru check-ul de prefix. Deci ÎNAINTE de probă trebuie un **recon read-only** care să LOCK-eze exact aceste câmpuri de topologie → altfel guard-ul nu poate rula (fail-closed).

*Reconuri read-only necesare ÎNAINTE de scriptul cu mutații (ambele DOAR introspecție/citire, zero mutație):*
- **(i) sursă `activeCommitSha`** — ✅ RULAT `reconRailwayWrite3.mjs` (2026-09-22, rc=0, `complete:true`): NICIUN câmp de commit tipizat ACCEPTAT în suprafața lock-uită (Deployment/DeploymentMeta/DeploymentSnapshot); SHA doar în `meta:JSON` opac, IGNORAT deliberat → decizie `NO_TYPED_SOURCE__DROP_REDEPLOY_USE_DEPLOYV2`. Aplicat în §9.5.1/§9.5.3/§9.4. *(Formulare conservatoare: nu afirmăm că Railway nu va avea NICIODATĂ un câmp tipizat, doar că suprafața lock-uită acum nu conține unul acceptat.)*
- **(ii) topologie pentru guard** — ⏳ `reconRailwayWrite4.mjs` trecerea 1 (rc=2): volume (`environment.volumeInstances`) ȘI variabile (root `variablesForServiceDeployment`) LOCK-ate live; domenii = `ServiceInstance.domains`, referințe = `ServiceInstance.source` + `ServiceInstance.upstreamUrl` (nume descoperite). Trecerea 2: docuri fixe de probă pentru sub-shape-urile `domains`/`source`/`upstreamUrl` → guard executabil complet.

**Blocaj:** compile-ul pentru variabile→runtime + COMMIT-ul (calea atomică/owned) + re-activarea `unset_env` rămân PROVIZORII până la verdictul probei; proba alege O SINGURĂ cale canonică staged/OCC. `start`/`stop` (deployV2/deploymentStop) + binding/one-shot/reader NU depind de probă și pot fi finalizate independent.

---
*Salvat în repo DOAR după: (READ 2b-2a) verificare manuală staged + patch 2b-1 verde (WSL) + verdict cgpt; (WRITE 2c-2a) verdict cgpt pe secțiunea 9 (contract evidence + schema-lock semantic staged changes). Versiunea de repo NU conține UUID-uri (doar „manifest matched"). Reconul WRITE (9.1–9.3 + reconw3/w4) = introspecție `__type` + citiri LIVE read-only VETATE (latestDeployment, volume, variabile) — ZERO mutație pe prod. Proba semantică §9.6 (cu mutații) rulează DOAR pe un environment dispensabil, niciodată pe `production`.*
