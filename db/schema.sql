-- ============================================================
-- SOC Jersey GM Portal - Supabase Schema
-- Run in Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ── Teams ────────────────────────────────────────────────────
create table if not exists teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  division    text not null,          -- e.g. "Tier 2 Beginner+"
  season      text not null,          -- e.g. "2025-26"
  gm_user_id  uuid references auth.users(id) on delete set null,
  colour_primary   text default '#c0392b',
  colour_secondary text default '#1a1a1a',
  logo_url    text,
  created_at  timestamptz default now()
);

-- ── Players (permanent roster) ───────────────────────────────
create table if not exists players (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid references teams(id) on delete cascade not null,
  first_name  text not null,
  last_name   text not null,
  number      text,                   -- jersey number (nullable until assigned)
  position    text check (position in ('Forward','Defence','Goalie','N/A')),
  email       text,
  phone       text,
  active      boolean default true,
  created_at  timestamptz default now()
);

-- ── Jersey Orders ─────────────────────────────────────────────
create table if not exists jersey_orders (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid references teams(id) on delete cascade not null,
  season      text not null,
  submitted_at timestamptz default now(),
  status      text default 'pending'
              check (status in ('pending','confirmed','in_production','shipped','delivered','cancelled')),
  notes       text,
  total_qty   int generated always as (
                (select count(*) from order_lines ol where ol.order_id = id)
              ) stored
);

-- ── Order Lines ───────────────────────────────────────────────
create table if not exists order_lines (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid references jersey_orders(id) on delete cascade not null,
  player_id   uuid references players(id) on delete set null,
  player_name text not null,          -- snapshot at order time
  number      text,
  size        text not null check (size in ('YS','YM','YL','XS','S','M','L','XL','XXL','XXXL')),
  qty         int not null default 1,
  style       text default 'Home',    -- Home / Away / Practice
  unit_price  numeric(8,2),
  notes       text
);

-- ── Service Requests ─────────────────────────────────────────
create table if not exists service_requests (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid references teams(id) on delete cascade not null,
  type        text not null check (type in ('size_swap','replacement','name_change','number_change','other')),
  player_id   uuid references players(id) on delete set null,
  player_name text,
  details     jsonb default '{}',     -- flexible payload per request type
  status      text default 'open' check (status in ('open','in_review','resolved','denied')),
  submitted_at timestamptz default now(),
  resolved_at  timestamptz,
  soc_notes   text
);

-- ── Notifications (outbound to SOC) ───────────────────────────
create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid references teams(id) on delete cascade,
  type        text,                   -- 'new_order','service_request', etc.
  payload     jsonb,
  sent_at     timestamptz default now(),
  read        boolean default false
);

-- ── Row Level Security ────────────────────────────────────────
alter table teams           enable row level security;
alter table players         enable row level security;
alter table jersey_orders   enable row level security;
alter table order_lines     enable row level security;
alter table service_requests enable row level security;
alter table notifications   enable row level security;

-- GMs can only see/edit their own team
create policy "GM reads own team"
  on teams for select
  using (gm_user_id = auth.uid());

create policy "GM updates own team"
  on teams for update
  using (gm_user_id = auth.uid());

-- Players: full CRUD for GM of that team
create policy "GM manages players"
  on players for all
  using (team_id in (select id from teams where gm_user_id = auth.uid()));

-- Orders: read + insert for GM
create policy "GM manages orders"
  on jersey_orders for all
  using (team_id in (select id from teams where gm_user_id = auth.uid()));

create policy "GM manages order lines"
  on order_lines for all
  using (order_id in (
    select id from jersey_orders
    where team_id in (select id from teams where gm_user_id = auth.uid())
  ));

-- Service requests
create policy "GM manages requests"
  on service_requests for all
  using (team_id in (select id from teams where gm_user_id = auth.uid()));

-- Notifications: GM reads their own
create policy "GM reads notifications"
  on notifications for select
  using (team_id in (select id from teams where gm_user_id = auth.uid()));

-- ── Seed: demo team (replace gm_user_id after first signup) ──
-- insert into teams (name, division, season, gm_user_id)
-- values ('Ice Wolves', 'Tier 2 Beginner+', '2025-26', '<your-auth-uid>');
