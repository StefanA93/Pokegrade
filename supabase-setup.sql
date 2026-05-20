-- ── Cards table (already created) ──────────────────────────────────────────
-- Run this only if you haven't already created the cards table

-- ── Waitlist table ──────────────────────────────────────────────────────────
create table if not exists waitlist (
  id uuid default gen_random_uuid() primary key,
  email text unique not null,
  created_at timestamptz default now()
);

alter table waitlist enable row level security;

create policy "Anyone can join waitlist"
on waitlist for insert
with check (true);

-- ── Storage bucket for card images ─────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('card-images', 'card-images', true)
on conflict do nothing;

create policy "Users can upload their own images"
on storage.objects for insert
with check (auth.uid()::text = (storage.foldername(name))[1]);

create policy "Card images are public"
on storage.objects for select
using (bucket_id = 'card-images');

create policy "Users can delete own images"
on storage.objects for delete
using (auth.uid()::text = (storage.foldername(name))[1]);

-- ── Enable Google OAuth ─────────────────────────────────────────────────────
-- Go to: Supabase Dashboard → Authentication → Providers → Google
-- Enable Google and add your OAuth credentials from console.cloud.google.com
-- Authorized redirect URI: https://yezlcgooutpshqdhvufg.supabase.co/auth/v1/callback


-- ── Add game column to cards table ─────────────────────────────────────────
alter table cards add column if not exists game text default 'pokemon';

-- ── Index for faster game filtering ────────────────────────────────────────
create index if not exists cards_game_idx on cards(game);
create index if not exists cards_user_id_idx on cards(user_id);


-- ── Subscriptions table ─────────────────────────────────────────────────────
create table if not exists subscriptions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade,
  plan text not null default 'free',
  status text not null default 'active',
  started_at timestamptz default now(),
  expires_at timestamptz,
  stripe_subscription_id text,
  created_at timestamptz default now()
);

alter table subscriptions enable row level security;

create policy "Users can view own subscription"
on subscriptions for select
using (auth.uid() = user_id);

create policy "Users can create own subscription"
on subscriptions for insert
with check (auth.uid() = user_id);

create index if not exists subscriptions_user_id_idx on subscriptions(user_id);
create index if not exists subscriptions_status_idx on subscriptions(status);

-- ── Free AI scans tracker ────────────────────────────────────────────────────
create table if not exists free_scans (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade,
  scanned_at timestamptz default now()
);

alter table free_scans enable row level security;

create policy "Users can view own free scans"
on free_scans for select
using (auth.uid() = user_id);

create policy "Users can insert own free scans"
on free_scans for insert
with check (auth.uid() = user_id);

create index if not exists free_scans_user_id_idx on free_scans(user_id);

-- ── Scan logs (rate limiting) ────────────────────────────────────────────────
-- Used by server-side proxy — NOT accessible by frontend
create table if not exists scan_logs (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  scan_date date not null default current_date,
  created_at timestamptz default now()
);

-- Only service role can access scan_logs — not anon key
alter table scan_logs enable row level security;

create policy "Service role only"
on scan_logs for all
using (false); -- frontend cannot read/write — only service key via proxy

create index if not exists scan_logs_user_date_idx on scan_logs(user_id, scan_date);

-- ── Fix subscriptions RLS — only service role can insert ────────────────────
-- Drop the old permissive policy
drop policy if exists "Users can create own subscription" on subscriptions;

-- New policy: users can only READ their own subscriptions
-- INSERT only allowed via service key (Stripe webhook)
create policy "Users can view own subscription"
on subscriptions for select
using (auth.uid() = user_id);

-- Service role insert handled by Stripe webhook — not frontend
