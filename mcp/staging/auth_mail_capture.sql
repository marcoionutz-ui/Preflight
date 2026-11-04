-- =====================================================================================================================
-- mcp/staging/auth_mail_capture.sql — DOAR STAGING. NU SE APLICĂ NICIODATĂ ÎN PRODUCȚIE.
--
-- Ce face: un Send Email Auth Hook implementat ca funcție Postgres. Când hook-ul e activat (Dashboard → Authentication
-- → Hooks → Send Email → Postgres → `public.staging_capture_auth_email`), Supabase Auth NU mai trimite NICIUN email de
-- autentificare (signup, magic link, recovery, schimbare de email…): payload-ul fiecărui email e scris în tabela
-- `public.staging_auth_mail_capture`, iar proba automată Gate 1 (runGate1Live.mjs) citește de acolo linkul de login.
--
-- DE CE NU E ÎN supabase/migrations: în producție ar ÎNLOCUI toate emailurile de auth (nimeni n-ar mai primi linkul
-- de login) și ar ține pe disc token_hash-uri de login. Fișierul se aplică MANUAL, doar pe proiectul Supabase de staging
-- (SQL Editor), iar hook-ul se activează manual, tot doar acolo. Proba refuză oricum proiectul de producție înainte de
-- orice acces (vetStagingProbe).
--
-- Ce se stochează: DOAR ce trebuie pentru link (user_id, email, email_action_type, token_hash, redirect_to, site_url).
-- NU se stochează `token` (OTP-ul de 6 cifre) și nici `token_new` / `token_hash_new`. Proba șterge rândul imediat după
-- folosire și, din nou, la cleanup.
--
-- Drepturi: RLS activat; nimic pentru public/anon/authenticated; `supabase_auth_admin` (rolul cu care rulează hook-ul)
-- poate DOAR insera; `service_role` (proba) poate citi și șterge. Modelul urmează pattern-ul documentat de Supabase
-- pentru hook-uri Postgres (grant usage pe schemă + execute pe funcție pentru supabase_auth_admin, revoke de la rest).
--
-- Dezinstalare (după probă, dacă se dorește): dezactivează hook-ul din Dashboard, apoi
--   drop function if exists public.staging_capture_auth_email(jsonb);
--   drop table if exists public.staging_auth_mail_capture;
-- =====================================================================================================================

begin;

create table if not exists public.staging_auth_mail_capture (
  id                bigserial   primary key,
  user_id           uuid        null,
  email             text        null,
  email_action_type text        null,
  token_hash        text        null,
  redirect_to       text        null,
  site_url          text        null,
  created_at        timestamptz not null default now()
);

create index if not exists staging_auth_mail_capture_email_idx
  on public.staging_auth_mail_capture (email, id);

alter table public.staging_auth_mail_capture enable row level security;

revoke all on table public.staging_auth_mail_capture from public, anon, authenticated;
revoke all on sequence public.staging_auth_mail_capture_id_seq from public, anon, authenticated;

grant usage on schema public to supabase_auth_admin;
grant insert on table public.staging_auth_mail_capture to supabase_auth_admin;
grant usage on sequence public.staging_auth_mail_capture_id_seq to supabase_auth_admin;
grant select, delete on table public.staging_auth_mail_capture to service_role;

-- RLS: supabase_auth_admin nu ocolește RLS → politică explicită DOAR de insert. service_role ocolește RLS.
drop policy if exists staging_auth_mail_capture_auth_admin_insert on public.staging_auth_mail_capture;
create policy staging_auth_mail_capture_auth_admin_insert
  on public.staging_auth_mail_capture
  as permissive
  for insert
  to supabase_auth_admin
  with check (true);

-- Hook-ul: primește evenimentul Send Email ({"user": {...}, "email_data": {...}}) și întoarce {} = „email trimis”.
create or replace function public.staging_capture_auth_email(event jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.staging_auth_mail_capture (user_id, email, email_action_type, token_hash, redirect_to, site_url)
  values (
    nullif(event -> 'user' ->> 'id', '')::uuid,
    lower(event -> 'user' ->> 'email'),
    event -> 'email_data' ->> 'email_action_type',
    event -> 'email_data' ->> 'token_hash',
    event -> 'email_data' ->> 'redirect_to',
    event -> 'email_data' ->> 'site_url'
  );
  return '{}'::jsonb;
end;
$$;

revoke execute on function public.staging_capture_auth_email(jsonb) from public, anon, authenticated;
grant  execute on function public.staging_capture_auth_email(jsonb) to supabase_auth_admin;

-- Verificare (fail-closed): nimic pentru anon/authenticated; auth admin poate executa și insera; service_role citește.
do $$
declare
  r text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.staging_auth_mail_capture'::regclass) then
    raise exception 'auth_mail_capture verify: RLS dezactivat';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.staging_auth_mail_capture', 'SELECT')
       or has_table_privilege(r, 'public.staging_auth_mail_capture', 'INSERT')
       or has_table_privilege(r, 'public.staging_auth_mail_capture', 'UPDATE')
       or has_table_privilege(r, 'public.staging_auth_mail_capture', 'DELETE') then
      raise exception 'auth_mail_capture verify: rolul % are drepturi pe tabelă', r;
    end if;
    if has_function_privilege(r, 'public.staging_capture_auth_email(jsonb)', 'EXECUTE') then
      raise exception 'auth_mail_capture verify: rolul % poate executa hook-ul', r;
    end if;
  end loop;
  if not has_function_privilege('supabase_auth_admin', 'public.staging_capture_auth_email(jsonb)', 'EXECUTE')
     or not has_table_privilege('supabase_auth_admin', 'public.staging_auth_mail_capture', 'INSERT') then
    raise exception 'auth_mail_capture verify: supabase_auth_admin nu poate executa / insera';
  end if;
  if not has_table_privilege('service_role', 'public.staging_auth_mail_capture', 'SELECT')
     or not has_table_privilege('service_role', 'public.staging_auth_mail_capture', 'DELETE') then
    raise exception 'auth_mail_capture verify: service_role nu poate citi / șterge';
  end if;
end;
$$;

commit;
