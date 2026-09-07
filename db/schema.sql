-- ============================================================
-- SOC Jersey GM Portal — Database Schema
-- Run this in the Supabase SQL editor (Settings → SQL Editor)
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- teams
-- ------------------------------------------------------------
create table if not exists teams (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  division          text not null,
  season            text not null,
  gm_user_id        uuid not null references auth.users(id) on delete cascade,
  gm_email          text,                 -- auto-filled by trigger below, not client-writable
  colour_primary    text not null default '#1a1a1a',
  colour_secondary  text not null default '#ffffff',
  created_at        timestamptz not null default now()
);
-- NOTE: gm_user_id is intentionally NOT unique — one account can run
-- more than one team (common for GMs who manage multiple squads).

create index if not exists idx_teams_gm on teams(gm_user_id);

-- ------------------------------------------------------------
-- players  (permanent roster, soft-delete via `active`)
-- ------------------------------------------------------------
create table if not exists players (
  id             uuid primary key default gen_random_uuid(),
  team_id        uuid not null references teams(id) on delete cascade,
  first_name     text not null,
  last_name      text not null,
  jersey_number  int  not null,
  jersey_size    text not null,           -- e.g. YS, YM, YL, AS, AM, AL, AXL, A2XL
  position       text,                    -- Forward / Defence / Goalie
  notes          text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_players_team on players(team_id);

-- ------------------------------------------------------------
-- jersey_orders  (order headers)
-- ------------------------------------------------------------
create table if not exists jersey_orders (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references teams(id) on delete cascade,
  order_type    text not null default 'initial',   -- initial | reorder
  status        text not null default 'draft',      -- draft | submitted | confirmed | shipped | completed
  notes         text,
  created_at    timestamptz not null default now(),
  submitted_at  timestamptz
);

create index if not exists idx_orders_team on jersey_orders(team_id);

-- ------------------------------------------------------------
-- order_lines  (per-player jersey lines within an order)
-- ------------------------------------------------------------
create table if not exists order_lines (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references jersey_orders(id) on delete cascade,
  player_id        uuid references players(id) on delete set null,
  name_on_jersey   text not null,
  jersey_number    int  not null,
  jersey_size      text not null,
  quantity         int  not null default 1,
  line_type        text not null default 'new',   -- new | replacement
  created_at       timestamptz not null default now()
);

create index if not exists idx_order_lines_order on order_lines(order_id);

-- ------------------------------------------------------------
-- service_requests  (size swaps, replacements, damage, etc.)
-- ------------------------------------------------------------
create table if not exists service_requests (
  id             uuid primary key default gen_random_uuid(),
  team_id        uuid not null references teams(id) on delete cascade,
  player_id      uuid references players(id) on delete set null,
  request_type   text not null,                   -- size_swap | replacement | damage | other
  description    text not null,
  status         text not null default 'open',    -- open | in_progress | resolved
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);

create index if not exists idx_service_requests_team on service_requests(team_id);

-- ------------------------------------------------------------
-- notifications  (outbound log to SOC admin — written by the Worker
-- using the service_role key, so no anon/GM write access is granted)
-- ------------------------------------------------------------
create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid references teams(id) on delete set null,
  type        text not null,          -- order_submitted | service_request | other
  payload     jsonb not null default '{}'::jsonb,
  sent        boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- admins  (SOC admin accounts — bootstrap the first row by hand,
-- see bottom of this file). This is a lightweight oversight role,
-- not a signup gate — GM sign-up is fully open (see Worker /api/signup).
-- ------------------------------------------------------------
create table if not exists admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table teams             enable row level security;
alter table players           enable row level security;
alter table jersey_orders     enable row level security;
alter table order_lines       enable row level security;
alter table service_requests  enable row level security;
alter table notifications     enable row level security;
alter table admins             enable row level security;

-- admins: a user can check ONLY whether they themselves are an admin
-- (never a full list of admins) directly with the anon key.
create policy "admins_select_self" on admins
  for select using (user_id = auth.uid());

-- teams: any signed-in user can create a team for themselves
-- (this is what makes sign-up/onboarding self-serve — no invite
-- code or admin approval required)
create policy "teams_insert_self" on teams
  for insert with check (gm_user_id = auth.uid());

-- teams: a GM can see and update every team they own
create policy "teams_select_own" on teams
  for select using (gm_user_id = auth.uid());

create policy "teams_update_own" on teams
  for update using (gm_user_id = auth.uid());

-- teams: admins can see every team (for the admin dashboard)
create policy "teams_select_admin" on teams
  for select using (
    exists (select 1 from admins where user_id = auth.uid())
  );

-- players: scoped to the GM's team
create policy "players_select_own_team" on players
  for select using (
    team_id in (select id from teams where gm_user_id = auth.uid())
  );

create policy "players_insert_own_team" on players
  for insert with check (
    team_id in (select id from teams where gm_user_id = auth.uid())
  );

create policy "players_update_own_team" on players
  for update using (
    team_id in (select id from teams where gm_user_id = auth.uid())
  );

-- jersey_orders: scoped to the GM's team
create policy "orders_select_own_team" on jersey_orders
  for select using (
    team_id in (select id from teams where gm_user_id = auth.uid())
  );

create policy "orders_insert_own_team" on jersey_orders
  for insert with check (
    team_id in (select id from teams where gm_user_id = auth.uid())
  );

create policy "orders_update_own_team" on jersey_orders
  for update using (
    team_id in (select id from teams where gm_user_id = auth.uid())
  );

-- order_lines: scoped via the parent order's team
create policy "order_lines_select_own_team" on order_lines
  for select using (
    order_id in (
      select id from jersey_orders
      where team_id in (select id from teams where gm_user_id = auth.uid())
    )
  );

create policy "order_lines_insert_own_team" on order_lines
  for insert with check (
    order_id in (
      select id from jersey_orders
      where team_id in (select id from teams where gm_user_id = auth.uid())
    )
  );

-- service_requests: scoped to the GM's team
create policy "service_requests_select_own_team" on service_requests
  for select using (
    team_id in (select id from teams where gm_user_id = auth.uid())
  );

create policy "service_requests_insert_own_team" on service_requests
  for insert with check (
    team_id in (select id from teams where gm_user_id = auth.uid())
  );

-- notifications: GMs get no policy at all (Worker writes via service key).
-- Admins can read the notification log directly in the admin dashboard.
create policy "notifications_select_admin" on notifications
  for select using (
    exists (select 1 from admins where user_id = auth.uid())
  );

-- ============================================================
-- Keep players.updated_at current
-- ============================================================
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_players_updated_at on players;
create trigger trg_players_updated_at
  before update on players
  for each row execute function set_updated_at();

-- ============================================================
-- Auto-fill teams.gm_email from auth.users on insert
-- (security definer so it can read the auth schema; this means
-- the client never has to be trusted to send an accurate email)
-- ============================================================
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

-- ============================================================
-- BOOTSTRAPPING THE FIRST ADMIN
-- ============================================================
-- There's a chicken-and-egg problem: the admin screen is what creates
-- new accounts, but the very first admin has to exist somehow. To
-- create it:
--
--   1. In Supabase → Authentication → Users → Invite user, invite
--      yourself (or whoever runs SOC) and set a password.
--   2. Copy that user's UUID from the Users table.
--   3. Run:
--
--      insert into admins (user_id, email)
--      values ('<paste-uuid-here>', 'admin@example.com');
--
-- After that, this admin can sign in to the portal and land on the
-- Admin screen (all teams + the ability to add other admins the
-- same way). Regular GM sign-up needs none of this — it's open:
-- anyone can create an account and a team straight from the portal.
