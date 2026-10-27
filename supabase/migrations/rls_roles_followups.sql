-- Follow-ups digest bookkeeping + admin owner assignment.
-- Idempotent. Run after supabase/migrations/rls_roles.sql (filename sorts after it).
-- owner_id columns and is_admin() already exist; they are repeated with
-- IF NOT EXISTS / CREATE OR REPLACE so this file stays ordered: columns, then functions.
-- Does not change existing RLS policies. Does not grant these RPCs to anon.
--
-- The cron job calls the daily-digest Edge Function at 11:30 and 12:30 UTC.
-- The function sends only when America/New_York is in the 7:00 hour, so the
-- mail goes out about 7:30 AM New York year round (EDT and EST). It no-ops
-- until vault secret digest_cron_secret matches the function secret
-- DIGEST_CRON_SECRET. See README.md. Nothing here embeds a secret.

begin;

-- 1. Columns before functions that read them ------------------------------
alter table public.contacts    add column if not exists owner_id uuid default auth.uid();
alter table public.investments add column if not exists owner_id uuid default auth.uid();
alter table public.activities  add column if not exists owner_id uuid default auth.uid();
alter table public.tasks       add column if not exists owner_id uuid default auth.uid();

-- One row per user per New York calendar day. Service role writes it.
-- RLS on, no policies: authenticated and anon cannot read or write.
create table if not exists public.digest_sends (
  user_id uuid not null,
  sent_on date not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, sent_on)
);
alter table public.digest_sends enable row level security;
revoke all on public.digest_sends from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.digest_sends to service_role;
  end if;
end $$;

-- 2. Admin-only user list (auth.users) ------------------------------------
create or replace function public.list_auth_users()
returns table (id uuid, email text, display_name text)
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
    select u.id,
           u.email::text,
           coalesce(
             nullif(u.raw_user_meta_data->>'full_name', ''),
             nullif(u.raw_user_meta_data->>'name', ''),
             split_part(u.email::text, '@', 1)
           )::text
    from auth.users u
    where u.email is not null
    order by u.email;
end $$;

revoke all on function public.list_auth_users() from public, anon;
grant execute on function public.list_auth_users() to authenticated;

-- 3. Admin-only owner change, cascaded to children by data->>'contactId' --
create or replace function public.set_contact_owner(contact_id text, new_owner uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  n_contacts int := 0;
  n_investments int := 0;
  n_activities int := 0;
  n_tasks int := 0;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if new_owner is null or not exists (select 1 from auth.users u where u.id = new_owner) then
    raise exception 'unknown user' using errcode = '22023';
  end if;

  update public.contacts
    set owner_id = new_owner, updated_at = now()
    where id::text = contact_id;
  get diagnostics n_contacts = row_count;
  if n_contacts = 0 then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;

  update public.investments
    set owner_id = new_owner, updated_at = now()
    where data->>'contactId' = contact_id;
  get diagnostics n_investments = row_count;

  update public.activities
    set owner_id = new_owner, updated_at = now()
    where data->>'contactId' = contact_id;
  get diagnostics n_activities = row_count;

  update public.tasks
    set owner_id = new_owner, updated_at = now()
    where data->>'contactId' = contact_id;
  get diagnostics n_tasks = row_count;

  return jsonb_build_object(
    'contacts', n_contacts,
    'investments', n_investments,
    'activities', n_activities,
    'tasks', n_tasks
  );
end $$;

revoke all on function public.set_contact_owner(text, uuid) from public, anon;
grant execute on function public.set_contact_owner(text, uuid) to authenticated;

commit;

-- 4. Schedule the digest. Extensions are enabled on hosted Supabase.
--    If CREATE EXTENSION is rejected, enable pg_cron and pg_net in
--    Database → Extensions and run this file again (it is idempotent).
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare r record;
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    for r in select jobid from cron.job where jobname = 'daily-followup-digest' loop
      perform cron.unschedule(r.jobid);
    end loop;
  end if;
end $$;

select cron.schedule(
  'daily-followup-digest',
  '30 11,12 * * *',
  $cron$
  select net.http_post(
    url := 'https://uivltttwigqejmqqfxuj.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-digest-secret', coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'digest_cron_secret' limit 1),
        ''
      )
    ),
    body := '{"source":"pg_cron"}'::jsonb,
    timeout_milliseconds := 20000
  );
  $cron$
);
