-- SyncUp Outreach — PostgreSQL / Supabase schema.
-- Run once in the Supabase SQL editor, then add the project URL + anon key in the extension's Settings.

create extension if not exists pgcrypto;

-- Pipeline statuses. Extend with: alter type outreach_status add value 'NEW_STAGE' after 'X';
do $$ begin
  create type outreach_status as enum (
    'NEW', 'REVIEWED', 'APPROVED', 'REQUEST_SUBMITTED', 'CONNECTED', 'MESSAGE_SENT', 'REPLIED',
    'INTERESTED', 'JD_REQUESTED', 'JD_RECEIVED', 'CANDIDATES_SENT', 'INTERVIEW', 'HIRED', 'SKIPPED'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type connection_status as enum ('CONNECTED', 'PENDING', 'CONNECT_AVAILABLE', 'UNAVAILABLE', 'UNKNOWN');
exception when duplicate_object then null; end $$;

do $$ begin
  create type qualification_level as enum ('HIGH', 'MEDIUM', 'LOW');
exception when duplicate_object then null; end $$;

create table if not exists campaigns (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  search_queries   text[] not null default '{}',
  target_roles     text[] not null default '{}',
  target_locations text[] not null default '{India}',
  daily_target     integer not null default 20 check (daily_target between 1 and 200),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists prospects (
  id                    uuid primary key default gen_random_uuid(),
  linkedin_profile_url  text not null unique,           -- primary identity; never duplicated
  profile_aliases       text[] not null default '{}',   -- other URLs seen for the same person
  name                  text not null,
  headline              text not null default '',
  company               text not null default '',
  company_url           text not null default '',
  hiring_role           text not null default '',
  location              text not null default '',
  post_url              text not null default '',
  post_text             text not null default '',
  posted_date           date,
  qualification         qualification_level not null,
  qualification_reasons text[] not null default '{}',
  connection_status     connection_status not null default 'UNKNOWN',
  outreach_status       outreach_status not null default 'NEW',
  message               text not null default '',
  campaign_id           uuid references campaigns(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists prospects_campaign_idx on prospects (campaign_id);
create index if not exists prospects_status_idx on prospects (outreach_status);
create index if not exists prospects_aliases_idx on prospects using gin (profile_aliases);

create table if not exists activity_logs (
  id          uuid primary key default gen_random_uuid(),
  prospect_id uuid references prospects(id) on delete set null,
  campaign_id uuid references campaigns(id) on delete set null,
  action      text not null,
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create index if not exists activity_logs_prospect_idx on activity_logs (prospect_id, created_at desc);

-- Row-level security. The extension uses the anon key; these policies allow it to read/write.
-- For production, put the extension behind Supabase Auth and scope policies to your team
-- (e.g. using (auth.jwt() ->> 'email' like '%@syncup.in')).
alter table campaigns enable row level security;
alter table prospects enable row level security;
alter table activity_logs enable row level security;

do $$ begin
  create policy "extension access" on campaigns for all using (true) with check (true);
  create policy "extension access" on prospects for all using (true) with check (true);
  create policy "extension access" on activity_logs for select using (true);
  create policy "extension insert" on activity_logs for insert with check (true);
exception when duplicate_object then null; end $$;

-- Upgrading an existing database:
-- alter type outreach_status add value if not exists 'MESSAGE_SENT' after 'CONNECTED';
