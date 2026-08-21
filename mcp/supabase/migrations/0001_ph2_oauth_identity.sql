-- ============================================================================
-- 0001_ph2_oauth_identity.sql — PH-2a (model de identitate OAuth: entitlement + registration + grant)
--
-- ADITIV ȘI NON-DISTRUCTIV pentru datele existente: creează 3 tabele NOI. NU modifică și NU șterge
-- `oauth_clients` (rămâne pentru secretele confidențiale + entitlement M2M/client_credentials, temporar).
--
-- NU e idempotent la nivel de „ascunde drift”: folosim `create table` simplu (fără IF NOT EXISTS). Dacă un
-- tabel cu același nume există deja cu schemă greșită, migrația EȘUEAZĂ zgomotos (cgpt #7) în loc să-l accepte tacit.
-- Re-rularea pe o bază curată e sigură; re-rularea peste tabele deja create eșuează la `create table` (intenționat —
-- aplici o singură dată, în tranzacție).
--
-- PROTOCOL DE APLICARE (Marco) — inspectorul cere FAZĂ EXPLICITĂ (fără --phase → exit 2):
--   1) INSPECTOR PRE-SCHEMA:
--        `npm run inspect:ph2 -w @preflight/mcp -- --phase=pre-schema`
--        — pe tabelele SURSĂ (`oauth_clients` + `auth.users`), înainte ca schema nouă să existe. Confirmă că
--          backfill-ul recomputat e curat (0 conflicte/invalid/orfani) și că paginarea a acoperit tot.
--   2) APLICĂ SCHEMA:         lipește tot fișierul într-un „New query” în Supabase SQL editor și rulează-l o dată.
--        — e înfășurat în begin/commit; dacă o singură constrângere pică, rollback la tot (atomic).
--   3) INSPECTOR POST-SCHEMA (== pre-backfill):
--        `npm run inspect:ph2 -w @preflight/mcp -- --phase=post-schema`
--        — tabelele țintă TREBUIE să existe; se verifică DOAR coliziunile pe rândurile prezente (rândurile
--          recomputate încă pot lipsi). Verdict CURAT ✅ = poți rula backfill-ul (INSERT-urile, slice separat).
--   4) BACKFILL + CUTOVER:    slice SEPARAT de wiring (feature-gated), ÎNAINTE de a activa gate-ul:
--          a) DUAL-WRITE: fiecare writer care azi atinge `oauth_clients` (createOAuthClient, add/remove redirect,
--             revoke, schimbări de plan/scopes/limite) scrie ȘI în tabelele noi, în ACEEAȘI tranzacție;
--          b) backfill inițial cu COMPARE-ON-CONFLICT (nu `ON CONFLICT DO NOTHING`);
--          c) freeze scurt (sau dual-write activ de la început) la momentul flip-ului.
--   5) INSPECTOR POST-BACKFILL (dovada completitudinii):
--        `npm run inspect:ph2 -w @preflight/mcp -- --phase=post-backfill`
--        — FIECARE entitlement + FIECARE registration recomputată TREBUIE să existe ȘI să fie identică; lipsa = drift.
--          Verdict CURAT ✅ AICI = backfill complet → abia apoi gate ON.
--        NB: fără dual-write, tabelele noi devin STALE imediat după backfill. Nu activa gate-ul până nu e livrat.
--
-- Necesită extensia pgcrypto pentru gen_random_uuid() (activă implicit pe Supabase).
-- ============================================================================

begin;

-- ── 0) helper IMMUTABLE — un array text[] e „curat”: fără NULL și fără element whitespace-only ('' sau '   ') ──
--     Folosit în CHECK-uri (o funcție immutable poate fi apelată din CHECK). `btrim` prinde și '' și spații.
create or replace function public.arr_clean(a text[])
returns boolean
language sql
immutable
as $$
  select a is not null
     and array_position(a, null) is null
     and not exists (select 1 from unnest(a) as e where btrim(e) = '')
$$;

-- ── 1) account_entitlements — plan/scopes/limite per UTILIZATOR (sursa de entitlement pt. fluxurile auth-code) ──
--     scopes: FĂRĂ default gol — un entitlement trebuie să aibă minimum un scope utilizabil (insert explicit).
create table public.account_entitlements (
  user_id               uuid        primary key references auth.users(id) on delete cascade,
  plan                  text        not null,
  scopes                text[]      not null,
  rate_limit_per_minute integer     not null,
  rate_limit_per_day    integer     not null,
  status                text        not null default 'active',
  entitlement_version   integer     not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- invarianți DB (cgpt #6) — fail-closed la orice rând corupt
  constraint account_entitlements_status_chk
    check (status in ('active','suspended','revoked')),
  constraint account_entitlements_plan_nonempty_chk
    check (length(btrim(plan)) > 0),
  -- scopes: non-gol + curat (fără NULL, fără whitespace-only)
  constraint account_entitlements_scopes_chk
    check (cardinality(scopes) > 0 and public.arr_clean(scopes)),
  -- rate-limit: -1 = nelimitat (santinelă), altfel >= 0
  constraint account_entitlements_rlm_chk
    check (rate_limit_per_minute >= -1),
  constraint account_entitlements_rld_chk
    check (rate_limit_per_day >= -1),
  constraint account_entitlements_version_chk
    check (entitlement_version >= 1)
);

-- ── 2) oauth_client_registrations — identitate de protocol COMUNĂ (public DCR + confidențial) ──
--     Zero coloane de entitlement. Secretul confidențial NU stă aici (rămâne în oauth_clients).
create table public.oauth_client_registrations (
  registration_id            uuid        primary key default gen_random_uuid(),
  client_id                  text        not null,
  client_type                text        not null,
  token_endpoint_auth_method text        not null,
  grant_types                text[]      not null default '{}',
  redirect_uris              text[]      not null default '{}',
  client_name                text,
  status                     text        not null default 'active',
  created_at                 timestamptz not null default now(),
  last_used_at               timestamptz,
  expires_at                 timestamptz,  -- setat DOAR pentru shell-uri publice nefolosite; NULL = nu expiră automat
  constraint oauth_client_registrations_client_id_uk
    unique (client_id),
  -- (cgpt #2) cheie compusă țintă pentru FK-ul din oauth_grants — leagă grant-ul de EXACT această identitate
  constraint oauth_client_registrations_reg_client_uk
    unique (registration_id, client_id),
  constraint oauth_client_registrations_client_id_nonempty_chk
    check (length(btrim(client_id)) > 0),
  constraint oauth_client_registrations_status_chk
    check (status in ('active','revoked','suspended')),
  -- redirect_uris: curat (fără NULL/whitespace-only); array gol e permis DOAR pentru confidențial fără redirect
  -- (ex. doar client_credentials). Un public are mereu authorization_code → constraint-ul de shape îi cere ≥1 redirect.
  constraint oauth_client_registrations_redirects_chk
    check (public.arr_clean(redirect_uris)),
  -- grant_types: subset non-gol al setului cunoscut
  constraint oauth_client_registrations_grant_types_valid_chk
    check (
      cardinality(grant_types) > 0
      and grant_types <@ array['authorization_code','refresh_token','client_credentials']::text[]
    ),
  -- (cgpt #1 + slice2 #5) invariantă CORELATĂ tip ↔ auth_method ↔ grant_types ↔ redirect
  constraint oauth_client_registrations_type_shape_chk
    check (
      (
        client_type = 'public'
        and token_endpoint_auth_method = 'none'
        -- decizia PH-2: un public are EXACT {authorization_code, refresh_token} (ambele obligatorii, fără M2M)
        and grant_types @> array['authorization_code','refresh_token']::text[]
        and not ('client_credentials' = any (grant_types))
        -- public are mereu authorization_code → TREBUIE cel puțin un redirect
        and cardinality(redirect_uris) > 0
      )
      or
      (
        client_type = 'confidential'
        and token_endpoint_auth_method = 'client_secret_post'
      )
    )
);
create index oauth_client_registrations_status_idx
  on public.oauth_client_registrations (status);
create index oauth_client_registrations_expires_idx
  on public.oauth_client_registrations (expires_at) where expires_at is not null;

-- ── 3) oauth_grants — (registration + user + resource + scopes). FK COMPUS către registrations (cgpt #2) ──
--     client_id e denormalizat (snapshot pt. token/audit) DAR e legat prin FK compus, deci nu poate „aluneca”
--     la un alt registration decât cel real.
create table public.oauth_grants (
  grant_id            uuid        primary key default gen_random_uuid(),
  registration_id     uuid        not null,
  client_id           text        not null,
  user_id             uuid        not null references auth.users(id) on delete cascade,
  resource            text        not null,
  scopes              text[]      not null,
  entitlement_version integer     not null,
  status              text        not null default 'active',
  created_at          timestamptz not null default now(),
  constraint oauth_grants_reg_client_fk
    foreign key (registration_id, client_id)
    references public.oauth_client_registrations (registration_id, client_id)
    on delete cascade,
  constraint oauth_grants_status_chk
    check (status in ('active','revoked')),
  constraint oauth_grants_resource_nonempty_chk
    check (length(btrim(resource)) > 0),
  -- scopes: non-gol + curat (fără NULL/whitespace-only)
  constraint oauth_grants_scopes_chk
    check (cardinality(scopes) > 0 and public.arr_clean(scopes)),
  constraint oauth_grants_version_chk
    check (entitlement_version >= 1)
);
create index oauth_grants_reg_user_resource_idx
  on public.oauth_grants (registration_id, user_id, resource);
create index oauth_grants_user_idx
  on public.oauth_grants (user_id);

-- ── 4) triggere (cgpt #6) — updated_at auto + entitlement_version auto-increment pe UPDATE ──
create or replace function public.tg_account_entitlements_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  -- bump versiune DOAR dacă se schimbă entitlement-ul efectiv (plan/scopes/limite/status), nu la orice UPDATE.
  if (
    new.plan                  is distinct from old.plan
    or new.scopes             is distinct from old.scopes
    or new.rate_limit_per_minute is distinct from old.rate_limit_per_minute
    or new.rate_limit_per_day is distinct from old.rate_limit_per_day
    or new.status             is distinct from old.status
  ) then
    -- nu lăsăm clientul să „înghețe” versiunea: o luăm mereu de la old + 1
    new.entitlement_version := old.entitlement_version + 1;
  else
    new.entitlement_version := old.entitlement_version;
  end if;
  return new;
end;
$$;

create trigger account_entitlements_touch_tg
  before update on public.account_entitlements
  for each row
  execute function public.tg_account_entitlements_touch();

-- ── RLS: service-role-only. supabaseAdmin (service role) ocolește RLS; RLS activat FĂRĂ policies = deny pentru
--     rolurile anon/authenticated → nimeni din browser nu poate citi/scrie aceste tabele. Fail-closed. ──
alter table public.account_entitlements        enable row level security;
alter table public.oauth_client_registrations  enable row level security;
alter table public.oauth_grants                 enable row level security;

commit;

-- NB (Marco): FK-urile user_id → auth.users(id) presupun că oauth_clients.user_id sunt deja uuid-uri de auth.users
-- (ca la crearea din dashboard, session-gated). Inspectorul (`inspect:ph2`) verifică EXPLICIT că fiecare user_id
-- non-null există în auth.users ÎNAINTE de backfill (orphan check), ca migrația să nu pice la FK.
