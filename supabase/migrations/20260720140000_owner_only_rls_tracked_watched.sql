-- Migration B of 2 for owner-only auth (see docs/AUTH_SETUP.md). Applies
-- the actual data lockdown: replaces tracked_shows' and watched_episodes'
-- existing public/permissive policies (per CLAUDE.md: "RLS enabled on both
-- tables, policy set to public" — these were created in the Supabase
-- dashboard, not in a prior migration, so their exact names are not known
-- to this repository) with explicit, operation-specific, owner-only
-- policies targeted at `authenticated`.
--
-- Do NOT apply this before Migration A (20260720130000) has been applied
-- AND the owner UUID has been registered in private.owner_config AND the
-- auth frontend has been verified working — applying this first would lock
-- Vijay out with no way back in short of dashboard/service-role access. See
-- docs/AUTH_SETUP.md, "Production rollout" for the exact required order.
--
-- The existing policies are dropped programmatically (by querying
-- pg_policies for these two tables) rather than by guessing/hardcoding
-- names, since this repository has no record of what they're actually
-- called. This also makes the migration safe to re-run.
--
-- push_subscriptions, notification_deliveries, and every notification RPC
-- (see 20260719120000 onward) are untouched by this migration — they are
-- already server-only (RLS enabled, all privileges revoked from
-- anon/authenticated, functions granted only to service_role) and are
-- unaffected by owner-only RLS on these two tables either way.

do $$
declare
  pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'tracked_shows'
  loop
    execute format('drop policy %I on public.tracked_shows', pol.policyname);
  end loop;

  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'watched_episodes'
  loop
    execute format('drop policy %I on public.watched_episodes', pol.policyname);
  end loop;
end
$$;

-- Defensive no-op if already enabled (it already is, per CLAUDE.md).
alter table public.tracked_shows enable row level security;
alter table public.watched_episodes enable row level security;

create policy "Owner select - tracked_shows" on public.tracked_shows
  for select to authenticated using (private.is_owner());

create policy "Owner insert - tracked_shows" on public.tracked_shows
  for insert to authenticated with check (private.is_owner());

create policy "Owner update - tracked_shows" on public.tracked_shows
  for update to authenticated using (private.is_owner()) with check (private.is_owner());

create policy "Owner delete - tracked_shows" on public.tracked_shows
  for delete to authenticated using (private.is_owner());

create policy "Owner select - watched_episodes" on public.watched_episodes
  for select to authenticated using (private.is_owner());

create policy "Owner insert - watched_episodes" on public.watched_episodes
  for insert to authenticated with check (private.is_owner());

create policy "Owner update - watched_episodes" on public.watched_episodes
  for update to authenticated using (private.is_owner()) with check (private.is_owner());

create policy "Owner delete - watched_episodes" on public.watched_episodes
  for delete to authenticated using (private.is_owner());

-- Anonymous requests are intentionally granted nothing here: with no policy
-- naming the `anon` role on either table, PostgREST requests made with the
-- anon key see zero rows and can write nothing, regardless of any
-- application-level check. This is the real security boundary — see
-- docs/AUTH_SETUP.md, "Preview verification" for how to prove it with a
-- direct curl request.
