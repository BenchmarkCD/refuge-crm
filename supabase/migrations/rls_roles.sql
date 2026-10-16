-- Refuge CRM: per-user RLS (admins see all; fundraisers see only their own)
-- Idempotent. Contacts link to children via data->>'contactId' (camelCase, text id).
-- info@benchmarkcd.com is Julie Durkin's sign-in. There is no separate Julie address.
begin;

-- 1. Admin list + helper -------------------------------------------------
create table if not exists public.app_admins (
  email text primary key check (email = lower(email))
);
insert into public.app_admins(email) values
  ('dana@refuge-homes.com'),('blake@refuge-homes.com'),('info@benchmarkcd.com')
on conflict (email) do nothing;

alter table public.app_admins enable row level security;
revoke all on public.app_admins from anon, authenticated;
grant select on public.app_admins to authenticated;
drop policy if exists app_admins_self_read on public.app_admins;
create policy app_admins_self_read on public.app_admins
  for select to authenticated
  using (email = lower(coalesce(auth.jwt()->>'email','')));

create or replace function public.is_admin()
returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.app_admins
    where email = lower(coalesce(auth.jwt()->>'email',''))
  );
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Owner of a contact (security definer so child policies don't depend on contacts RLS)
create or replace function public.contact_owner(cid text)
returns uuid language sql stable security definer
set search_path = public, pg_temp as $$
  select owner_id from public.contacts where id::text = cid limit 1;
$$;
revoke all on function public.contact_owner(text) from public, anon;
grant execute on function public.contact_owner(text) to authenticated;

-- 2. owner_id columns (existing rows stay NULL = admin-only) -------------
alter table public.contacts    add column if not exists owner_id uuid default auth.uid();
alter table public.investments add column if not exists owner_id uuid default auth.uid();
alter table public.activities  add column if not exists owner_id uuid default auth.uid();
alter table public.tasks       add column if not exists owner_id uuid default auth.uid();
create index if not exists contacts_owner_idx    on public.contacts(owner_id);
create index if not exists investments_owner_idx on public.investments(owner_id);
create index if not exists activities_owner_idx  on public.activities(owner_id);
create index if not exists tasks_owner_idx       on public.tasks(owner_id);
create index if not exists investments_contact_idx on public.investments((data->>'contactId'));
create index if not exists activities_contact_idx  on public.activities((data->>'contactId'));
create index if not exists tasks_contact_idx       on public.tasks((data->>'contactId'));

-- 3. Guard: non-admins can't set/steal owner_id ---------------------------
create or replace function public.enforce_owner_id()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    new.owner_id := auth.uid();                 -- always the inserting user
  elsif new.owner_id is distinct from old.owner_id then
    raise exception 'owner_id cannot be changed';
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['contacts','investments','activities','tasks'] loop
    execute format('drop trigger if exists trg_enforce_owner_id on public.%I', t);
    execute format('create trigger trg_enforce_owner_id before insert or update on public.%I
                    for each row execute function public.enforce_owner_id()', t);
  end loop;
end $$;

-- 4. Policies ------------------------------------------------------------
do $$ declare t text; p record; begin
  foreach t in array array['contacts','investments','activities','tasks','templates','app_settings','backups'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', p.policyname, t);  -- drops team_authenticated_all & any leftovers
    end loop;
    execute format('create policy admin_all on public.%I for all to authenticated
                    using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- contacts: own rows only
create policy owner_rw on public.contacts for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- children: own rows, or rows on a contact I own; writes must point at my contact (or none)
do $$ declare t text; begin
  foreach t in array array['investments','activities','tasks'] loop
    execute format($f$create policy owner_rw on public.%I for all to authenticated
      using (owner_id = auth.uid() or public.contact_owner(data->>'contactId') = auth.uid())
      with check (
        (owner_id = auth.uid() or public.contact_owner(data->>'contactId') = auth.uid())
        and (coalesce(data->>'contactId','') = '' or public.contact_owner(data->>'contactId') = auth.uid())
      )$f$, t);
  end loop;
end $$;

-- templates / app_settings: everyone logged in can read; admins write (admin_all)
create policy read_all on public.templates    for select to authenticated using (true);
create policy read_all on public.app_settings for select to authenticated using (true);
-- backups: admin_all only

-- 5. Grants --------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['contacts','investments','activities','tasks','templates','app_settings','backups'] loop
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke truncate, trigger, references on public.%I from authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

commit;
