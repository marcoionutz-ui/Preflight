-- ============================================================================
-- 0002_beta_invites_access_expiry.sql — lotul OAuth + onboarding în staging (design rev3, §4, §4.1, §4.3)
--
-- Ce face (ADITIV — nu șterge rânduri, nu schimbă valori existente):
--   1) `beta_invites` — invitații beta: email normalizat + sha256(token), expirare, răscumpărare (o singură dată).
--   2) `account_entitlements.access_expires_at` — expirarea accesului; NULL = fără expirare (rândurile existente
--      rămân neschimbate, deci niciun cont existent nu pierde accesul la aplicarea migrației).
--   3) `oauth_clients.admin_authorized_at` / `admin_authorized_by` — autorizarea explicită de admin a clienților
--      confidențiali legacy (§4.1). NULL pe toate rândurile existente: codul care impune autorizarea (lookupClientById)
--      e o poartă SEPARATĂ — în producție, întâi se autorizează lista M2M, abia apoi se deployează codul.
--   4) `public.redeem_beta_invite(...)` — răscumpărarea ATOMICĂ (o singură tranzacție, rândul invitației blocat).
--   5) Drepturi (§4.3): RLS + revoke pe `beta_invites`; funcția doar pentru `service_role`; `anon`/`authenticated`
--      nu pot scrie nici coloanele noi, nici tabelele lor; la final, un bloc de VERIFICARE care pică migrația dacă
--      starea drepturilor nu e cea așteptată.
--
-- Ca 0001: fără IF NOT EXISTS (un obiect deja existent cu altă formă → migrația EȘUEAZĂ zgomotos, nu-l acceptă
-- tacit); totul în begin/commit (o singură constrângere/verificare picată → rollback la tot).
--
-- ORDINEA DE DEPLOY: migrația ÎNAINTE de codul care citește `access_expires_at`. Codul cere coloana explicit în
-- select; fără ea, citirea entitlement-ului eșuează → `unavailable` (503) pe fluxurile user — fail-closed, nu deschis.
--
-- APLICARE (Marco): SQL editor Supabase, „New query”, tot fișierul, o dată. În acest lot: DOAR staging.
-- Necesită pgcrypto pentru gen_random_uuid() (activă implicit pe Supabase).
-- ============================================================================

begin;

-- ── 1) beta_invites ──────────────────────────────────────────────────────────────
--     Tokenul în clar NU se stochează: doar sha256 hex lowercase (64), unic. Tokenul există o singură dată, în linkul
--     tipărit de `scripts/createBetaInvite.ts`. `arr_clean` (0001) nu e necesar aici — tabelul n-are coloane array.
create table public.beta_invites (
  invite_id        uuid        primary key default gen_random_uuid(),
  email_normalized text        not null,
  token_hash       text        not null,
  expires_at       timestamptz not null,
  redeemed_at      timestamptz null,
  redeemed_by      uuid        null references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint beta_invites_token_hash_uk
    unique (token_hash),
  -- sha256 hex lowercase, exact forma produsă de `hashInviteToken` (lib/oauth/inviteRedeem.ts)
  constraint beta_invites_token_hash_chk
    check (token_hash ~ '^[0-9a-f]{64}$'),
  -- emailul e stocat DEJA normalizat (trim + lowercase), non-gol, cu `@` între două părți ne-goale; comparația la
  -- răscumpărare e pe egalitate exactă cu emailul verificat al sesiunii, normalizat la fel.
  constraint beta_invites_email_normalized_chk
    check (
      email_normalized = lower(btrim(email_normalized))
      and length(email_normalized) between 3 and 320
      and email_normalized like '_%@_%'
    ),
  -- Perechea de răscumpărare: `redeemed_by` NU poate exista fără `redeemed_at`. Funcția le setează MEREU împreună.
  -- De ce nu „ambele sau niciunul” strict: `on delete set null` pe `redeemed_by` ar încălca o egalitate strictă la
  -- ștergerea userului → ștergerea unui cont de test (curățenia probei automate) ar EȘUA. Cu forma de mai jos,
  -- ștergerea lasă `redeemed_at` setat + `redeemed_by` NULL = „răscumpărată de un cont șters” — tot nerăscumpărabilă
  -- din nou (funcția verifică `redeemed_at`). Un rând cu `redeemed_by` setat și `redeemed_at` NULL e imposibil.
  constraint beta_invites_redeemed_pair_chk
    check (redeemed_by is null or redeemed_at is not null),
  constraint beta_invites_expiry_chk
    check (expires_at > created_at)
);
create index beta_invites_email_idx
  on public.beta_invites (email_normalized);

-- RLS activat FĂRĂ politici (ca tabelele PH-2 din 0001): `anon`/`authenticated` nu văd și nu scriu nimic.
-- `service_role` (supabaseAdmin, doar server) ocolește RLS. Plus revoke explicit pe drepturile de tabel (§4.3):
-- Supabase acordă implicit ALL pe tabelele noi din `public` rolurilor `anon`/`authenticated`; TRUNCATE nu e
-- acoperit de RLS, deci revocarea e necesară, nu doar decorativă.
alter table public.beta_invites enable row level security;
revoke all on public.beta_invites from anon, authenticated;

-- ── 2) account_entitlements.access_expires_at ───────────────────────────────────
--     NULL = fără expirare. Expirat (access_expires_at <= now) = cont INACTIV la toți consumatorii (consimțământ →
--     refuz, refresh user → invalid_grant, apel MCP → 401) — decis într-un singur loc în cod
--     (`lib/db/entitlementLookup.ts`, `classifyEntitlementLookup`). Fără CHECK față de created_at: proba E11 mută
--     expirarea în trecut pe un cont abia creat.
--     Triggerul `account_entitlements_touch_tg` (0001) NU incrementează `entitlement_version` la schimbarea expirării:
--     expirarea se verifică live la fiecare citire, deci o prelungire nu trebuie să invalideze tokenurile emise.
alter table public.account_entitlements
  add column access_expires_at timestamptz null;

-- ── 3) oauth_clients.admin_authorized_* (§4.1) ──────────────────────────────────
--     Consumate de `lookupClientById` / `scripts/adminClientAccess.ts` (alt agent, alt fișier) — numele sunt fixe.
--     Fără CHECK de cuplare at/by: semantica (cine, notă, retragere) e a scriptului de admin; nu o fixăm aici.
alter table public.oauth_clients
  add column admin_authorized_at timestamptz null,
  add column admin_authorized_by text        null;

-- ── 4) redeem_beta_invite — răscumpărarea ATOMICĂ ───────────────────────────────
--     Un singur apel = o singură tranzacție (funcția rulează în tranzacția apelului RPC). Pașii:
--       a) rândul invitației blocat `for update` (două răscumpărări concurente ale aceluiași token se serializează;
--          a doua vede `redeemed_at` setat → `already_redeemed`);
--       b) există? → nerăscumpărată? → neexpirată (expires_at > p_now)? → email IDENTIC?
--       c) entitlement NOU, niciodată suprascris: `on conflict (user_id) do nothing` → dacă userul are deja un rând
--          (din orice sursă, inclusiv o răscumpărare concurentă a altei invitații) → `already_entitled`, invitația
--          NU se consumă și entitlement-ul existent rămâne neatins;
--       d) invitația marcată răscumpărată (redeemed_at = p_now, redeemed_by = p_user_id).
--     Întoarce un status ÎNCHIS: 'redeemed' | 'not_found' | 'already_redeemed' | 'expired' | 'email_mismatch' |
--     'already_entitled'. Argumente nule / p_access_days în afara [1, 366] → excepție (bug al apelantului; wrapperul
--     din cod o mapează la `unavailable` = fără acces). Un `p_user_id` inexistent în auth.users → FK violation → la fel.
--     `p_now` vine de la server (singurul apelant, service-role) — un singur ceas pentru expirarea invitației și
--     pentru `access_expires_at = p_now + p_access_days`.
--     SECURITY INVOKER: rulează cu drepturile apelantului (service_role); nu ridică privilegii. search_path fixat
--     (nicio rezolvare de nume prin scheme controlate de altcineva); toate referințele sunt oricum calificate.
create function public.redeem_beta_invite(
  p_token_hash       text,
  p_user_id          uuid,
  p_email_normalized text,
  p_now              timestamptz,
  p_access_days      integer
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_invite public.beta_invites%rowtype;
  v_rows   integer;
begin
  if p_token_hash is null or p_user_id is null or p_email_normalized is null or p_now is null
     or p_access_days is null or p_access_days < 1 or p_access_days > 366 then
    raise exception 'redeem_beta_invite: invalid arguments' using errcode = '22023';
  end if;

  select * into v_invite
    from public.beta_invites
   where token_hash = p_token_hash
   for update;
  if not found then
    return 'not_found';
  end if;

  if v_invite.redeemed_at is not null then
    return 'already_redeemed';
  end if;

  if not (v_invite.expires_at > p_now) then
    return 'expired';
  end if;

  if v_invite.email_normalized <> p_email_normalized then
    return 'email_mismatch';
  end if;

  -- Planul beta (decizia O2): free_trial, read:basic, 10/min, 500/zi, activ, expiră la p_now + p_access_days.
  insert into public.account_entitlements
    (user_id, plan, scopes, rate_limit_per_minute, rate_limit_per_day, status, access_expires_at)
  values
    (p_user_id, 'free_trial', array['read:basic']::text[], 10, 500, 'active',
     p_now + make_interval(days => p_access_days))
  on conflict (user_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return 'already_entitled';
  end if;

  update public.beta_invites
     set redeemed_at = p_now,
         redeemed_by = p_user_id
   where invite_id = v_invite.invite_id;

  return 'redeemed';
end;
$$;

-- Supabase dă implicit EXECUTE pe funcțiile noi din `public` (lui PUBLIC și rolurilor anon/authenticated) și le
-- expune prin PostgREST (/rest/v1/rpc/...). Revocăm explicit; doar service_role (serverul) o poate apela.
revoke execute on function public.redeem_beta_invite(text, uuid, text, timestamptz, integer) from public, anon, authenticated;
grant  execute on function public.redeem_beta_invite(text, uuid, text, timestamptz, integer) to service_role;

-- ── 5) drepturi pe tabelele existente (§4.3) ────────────────────────────────────
-- account_entitlements: RLS e deja activat fără politici (0001) → anon/authenticated sunt deja refuzați la
-- insert/update/delete. Revocarea e belt-and-braces (inclusiv TRUNCATE, pe care RLS nu-l acoperă): coloana nouă
-- `access_expires_at` nu poate fi modificată de un rol de client nici dacă cineva adaugă ulterior o politică.
revoke insert, update, delete, truncate on public.account_entitlements from anon, authenticated;

-- oauth_clients: tabel LEGACY, creat în afara migrațiilor — starea lui RLS/grant e necunoscută, deci o facem
-- explicită. Verificat în cod (6fecb3a, mcp/lib, mcp/app, mcp/scripts, workers): TOATE accesele la `oauth_clients`
-- (și la `account_entitlements`) trec prin `supabaseAdmin` / un client creat cu SUPABASE_SERVICE_ROLE_KEY, care
-- ocolește RLS; clienții de sesiune (`lib/supabase/server.ts`, `lib/supabase/client.ts`) se folosesc doar pentru
-- `auth.*`, iar clientul anon din `lib/db/supabase.ts` nu e importat nicăieri. Deci activarea RLS nu rupe nimic în
-- produs, iar un rol de client (cheia anon publică, sau sesiunea unui user) nu mai poate citi/scrie rânduri prin
-- PostgREST — nici `admin_authorized_*`, nici secretul hash-uit. Politicile existente (dacă există) rămân în vigoare
-- pentru SELECT; scrierile sunt revocate la nivel de tabel (revocarea de tabel revocă și drepturile pe coloane).
alter table public.oauth_clients enable row level security;
revoke insert, update, delete, truncate on public.oauth_clients from anon, authenticated;

-- ── 6) VERIFICARE (pică migrația dacă starea nu e cea așteptată) ────────────────
--     `has_*_privilege` ia în calcul și moștenirea prin PUBLIC / roluri-membru → prinde și un grant pe care revoke-ul
--     de mai sus nu l-a atins (ex. un grant dat lui PUBLIC pe oauth_clients în trecut).
do $$
declare
  r text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.beta_invites'::regclass) then
    raise exception '0002 verify: RLS dezactivat pe beta_invites';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.oauth_clients'::regclass) then
    raise exception '0002 verify: RLS dezactivat pe oauth_clients';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.account_entitlements'::regclass) then
    raise exception '0002 verify: RLS dezactivat pe account_entitlements';
  end if;

  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.beta_invites', 'SELECT')
       or has_any_column_privilege(r, 'public.beta_invites', 'SELECT')
       or has_any_column_privilege(r, 'public.beta_invites', 'INSERT')
       or has_any_column_privilege(r, 'public.beta_invites', 'UPDATE')
       or has_table_privilege(r, 'public.beta_invites', 'DELETE')
       or has_table_privilege(r, 'public.beta_invites', 'TRUNCATE') then
      raise exception '0002 verify: rolul % are încă drepturi pe beta_invites', r;
    end if;

    if has_any_column_privilege(r, 'public.oauth_clients', 'INSERT')
       or has_any_column_privilege(r, 'public.oauth_clients', 'UPDATE')
       or has_table_privilege(r, 'public.oauth_clients', 'DELETE')
       or has_table_privilege(r, 'public.oauth_clients', 'TRUNCATE') then
      raise exception '0002 verify: rolul % poate încă scrie în oauth_clients', r;
    end if;

    if has_any_column_privilege(r, 'public.account_entitlements', 'INSERT')
       or has_any_column_privilege(r, 'public.account_entitlements', 'UPDATE')
       or has_table_privilege(r, 'public.account_entitlements', 'DELETE')
       or has_table_privilege(r, 'public.account_entitlements', 'TRUNCATE') then
      raise exception '0002 verify: rolul % poate încă scrie în account_entitlements', r;
    end if;

    if has_function_privilege(r, 'public.redeem_beta_invite(text, uuid, text, timestamptz, integer)', 'EXECUTE') then
      raise exception '0002 verify: rolul % poate încă executa redeem_beta_invite', r;
    end if;
  end loop;

  if not has_function_privilege('service_role', 'public.redeem_beta_invite(text, uuid, text, timestamptz, integer)', 'EXECUTE') then
    raise exception '0002 verify: service_role nu poate executa redeem_beta_invite';
  end if;
end;
$$;

commit;

-- NB (Marco), după aplicare: proba E14 (§8) verifică același lucru din exterior, prin PostgREST, cu cheia anon și
-- cu sesiunea unui cont de test: citire beta_invites, update pe access_expires_at / admin_authorized_at, RPC
-- redeem_beta_invite → toate refuzate, nimic schimbat.
