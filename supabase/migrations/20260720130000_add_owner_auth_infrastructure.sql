-- Migration A of 2 for owner-only auth (see docs/AUTH_SETUP.md). This
-- migration adds ONLY the auth infrastructure — a singleton owner registry
-- and the functions/grants needed to consult it. It does NOT touch
-- tracked_shows or watched_episodes: their existing (public/permissive)
-- policies are untouched here on purpose, so this migration is safe to
-- apply well ahead of the frontend rollout without locking Vijay out of the
-- live app. The actual data lockdown is a separate migration —
-- 20260720140000_owner_only_rls_tracked_watched.sql — applied later in the
-- rollout, once the owner is registered and the auth frontend is verified
-- working in Production (see docs/AUTH_SETUP.md, "Production rollout").
--
-- Design: a `private` schema holds a one-row `owner_config` table (the
-- canonical Supabase Auth UUID) and a SECURITY DEFINER helper,
-- private.is_owner(), that consults it. `private` is never added to
-- Supabase's "Exposed schemas" list, so nothing in it is reachable over
-- PostgREST/supabase.rpc() directly — `authenticated` gets EXECUTE on
-- private.is_owner() only because RLS policy expressions (evaluated at the
-- SQL level, not through the REST API) require it, not because it's
-- browser-callable. `anon` gets no grant on it at all: Migration B's
-- policies are scoped `to authenticated` only, so an anonymous request
-- never evaluates an expression that needs it. The browser's only way to
-- ask "am I the owner?" is the
-- separate public.current_user_is_owner() wrapper below, which returns a
-- boolean and nothing else — never the owner UUID, never the owner_config
-- row. owner_config itself has RLS enabled with NO policies at all, so no
-- role (including authenticated) can read or write it through PostgREST
-- even if `private` were ever accidentally exposed.
--
-- No per-row `user_id` column is introduced anywhere by this migration or
-- the one after it: Rerun stays a single-owner allowlist check, not a
-- multi-tenant ownership model — see CLAUDE.md.

create schema if not exists private;

-- Nothing in `private` is meant to be browser-reachable. Revoking the
-- default PUBLIC create/usage grant is defense-in-depth on top of not
-- listing `private` in Supabase's Exposed schemas.
revoke all on schema private from public;

create table private.owner_config (
  id boolean primary key default true,
  owner_id uuid not null,
  constraint owner_config_singleton check (id)
);

comment on table private.owner_config is
  'Singleton row holding the one canonical Supabase Auth UUID approved to use Rerun. Registered manually via the SQL Editor after this migration — see docs/AUTH_SETUP.md, "Migration A". Never read directly by the client: only private.is_owner() / public.current_user_is_owner() may consult it.';

alter table private.owner_config enable row level security;
-- Intentionally no policies on this table at all — see design note above.
-- No grant of select/insert/update/delete to any role either; the only
-- access path is the SECURITY DEFINER function below.

create or replace function private.is_owner()
returns boolean
language sql
stable
security definer
set search_path = private, pg_temp
as $$
  select auth.uid() is not null
    and auth.uid() = (select owner_id from private.owner_config limit 1)
$$;

comment on function private.is_owner() is
  'Private ownership helper used by RLS policies. SECURITY DEFINER so policy evaluation can consult private.owner_config, which otherwise has no grants of its own. Returns false (never an error) for anonymous callers and for any session once no owner_config row exists. Not meant to be called directly by the client — see public.current_user_is_owner().';

-- Postgres grants EXECUTE on every new function to PUBLIC by default.
-- Revoke that first, then grant only to the role that actually needs it:
-- `authenticated`, for RLS policy evaluation on 20260720140000's policies
-- (which are all scoped `to authenticated`). `anon` never evaluates a
-- policy that calls private.is_owner() — Migration B grants nothing to
-- anon on tracked_shows/watched_episodes, so an anonymous request against
-- either table simply has no applicable policy (implicit deny) and never
-- needs to invoke this function at all. This grant does NOT make the
-- function browser-callable either way: PostgREST only routes RPC calls to
-- functions in schemas listed under "Exposed schemas" (public by default),
-- and `private` must never be added to that list — see
-- docs/AUTH_SETUP.md, "Before preview testing".
grant usage on schema private to authenticated;
revoke execute on function private.is_owner() from public;
grant execute on function private.is_owner() to authenticated;

create or replace function public.current_user_is_owner()
returns boolean
language sql
stable
security definer
set search_path = private, pg_temp
as $$
  select private.is_owner()
$$;

comment on function public.current_user_is_owner() is
  'Public boolean-only ownership check for the frontend auth gate (src/lib/AuthContext.jsx). Returns true only for the single registered owner session; false for every other caller, including anonymous or an authenticated non-owner — never an error, and never the owner UUID/email. This is a UX signal only: the real authorization boundary is the RLS policies in 20260720140000_owner_only_rls_tracked_watched.sql, which call private.is_owner() directly.';

-- Only `authenticated` calls this RPC (AuthContext only invokes it once a
-- session exists); `anon` has nothing to gain from it and PUBLIC's default
-- grant is revoked explicitly rather than left implicit.
revoke execute on function public.current_user_is_owner() from public;
grant execute on function public.current_user_is_owner() to authenticated;
