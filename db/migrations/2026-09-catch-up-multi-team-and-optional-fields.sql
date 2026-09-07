-- ============================================================
-- Catch-up migration — run this once in your LIVE Supabase
-- project's SQL editor. Safe to re-run; every step is guarded.
--
-- Covers:
--   A) Multi-team accounts + fully open sign-up (removes the
--      old invite-code system entirely)
--   B) division/season becoming optional
-- ============================================================

-- A1. Allow one account to own more than one team
alter table teams drop constraint if exists teams_gm_user_id_key;
create index if not exists idx_teams_gm on teams(gm_user_id);

-- A2. Make sure gm_email exists and is auto-filled (never client-set)
alter table teams add column if not exists gm_email text;

create or replace function set_gm_email()
returns trigger as $$
begin
  select email into new.gm_email from auth.users where id = new.gm_user_id;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_teams_set_gm_email on teams;
create trigger trg_teams_set_gm_email
  before insert on teams
  for each row execute function set_gm_email();

-- A3. Let a signed-in user create a team for themselves
-- (this is what makes sign-up + "add another team" self-serve)
drop policy if exists "teams_insert_self" on teams;
create policy "teams_insert_self" on teams
  for insert with check (gm_user_id = auth.uid());

-- A4. Drop the old invite-code system — no longer used
drop table if exists invite_codes cascade;

-- A5. Make sure the admins table + its policy exist
-- (harmless no-op if you already have these)
create table if not exists admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text,
  created_at  timestamptz not null default now()
);
alter table admins enable row level security;
drop policy if exists "admins_select_self" on admins;
create policy "admins_select_self" on admins
  for select using (user_id = auth.uid());

-- B1. division/season are now optional (set later on the Team tab)
alter table teams alter column division drop not null;
alter table teams alter column season   drop not null;
