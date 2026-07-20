-- Production incident (20 July 2026, ~10:00 PM IST and 10:15 PM IST cron
-- runs): the Supabase Cron worker invoked /api/notifications/run on schedule,
-- reached the House of the Dragon (tmdb_show_id 94997) reminder candidate for
-- S3E5, and called claim_episode_notifications — which raised:
--
--   ERROR:  column reference "season_number" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--
-- Root cause (reproduced locally against a real Postgres 16 instance loaded
-- with this project's actual migrations, not guessed): the function declares
--
--   returns table(season_number integer, episode_number integer, notification_type text)
--
-- which makes season_number/episode_number/notification_type PL/pgSQL output
-- variables in scope for the rest of the function body. Both the
-- reminder-identity insert and the airtime-identity insert in
-- 20260720120000_distinguish_in_flight_airtime_claim.sql then use a bare
-- conflict-target column list:
--
--   on conflict [push_subscription_id, tmdb_show_id, season_number, episode_number, notification_type]
-- (a bare column-list conflict target, written here with square brackets so
-- this comment itself doesn't reproduce the exact ambiguous SQL syntax)
--
-- Because that list names columns that are simultaneously valid as the
-- function's own output variables, Postgres cannot resolve them and raises
-- "column reference is ambiguous" at the moment either INSERT runs — so no
-- reminder (and no airtime alert) can ever be claimed, and every affected
-- worker invocation for that episode silently sends nothing.
--
-- Fix: reference the table's actual named unique constraint instead of a
-- bare column list, which sidesteps output-variable resolution entirely.
-- notification_deliveries has exactly one relevant unique constraint,
-- declared inline (unnamed) in
-- 20260719140000_add_automatic_episode_notifications.sql:
--
--   unique (push_subscription_id, tmdb_show_id, season_number, episode_number, notification_type)
--
-- Its Postgres-assigned name was not guessed: it was read directly off a
-- Postgres 16 instance built from this repository's actual migrations
-- (push_subscriptions + notification_deliveries, in order), via
-- `\d public.notification_deliveries` and independently confirmed against
-- `pg_constraint`:
--
--   notification_deliveries_push_subscription_id_tmdb_show_id_s_key
--
-- Postgres's constraint-naming algorithm (table + column prefixes, truncated
-- to fit NAMEDATALEN, plus a `_key` suffix) is deterministic and has been
-- stable across Postgres versions for a very long time, so a name derived
-- from this project's own unmodified `create table` statement reproduces
-- reliably. `on conflict on constraint <name>` was verified against that same
-- local instance to no longer raise the ambiguity error, for both a
-- reminder-only claim and a combined airtime+reminder claim (see
-- tests/fix-ambiguous-unified-episode-notification-claim-migration.test.js
-- for the shipped structural regression coverage; this repo's JS test suite
-- has no live-Postgres harness — see that file's header comment for the
-- explicit limitation this migration's tests operate under).
--
-- Full audit of every other place season_number/episode_number/
-- notification_type appear in this function, to confirm nothing else needed
-- the same fix:
--
--   * The `for ep in select (value->>'season_number')::integer as
--     season_number, ...` loop query only *assigns* an alias to an expression
--     pulled from p_episodes (jsonb) — it never resolves an existing bare
--     column/variable reference, so it was never ambiguous and is unchanged.
--   * Every later use is `ep.season_number` / `ep.episode_number`, already
--     qualified to the loop record — unchanged.
--   * The `do update set ... where notification_deliveries.delivered_at is
--     null and notification_deliveries.claimed_at < ...` clauses reference
--     delivered_at/claimed_at, neither of which is an output variable name —
--     unchanged.
--   * The two `select claim_token into owner_token from
--     public.notification_deliveries where identity = ...` ownership
--     read-backs reference identity/claim_token only — unchanged.
--   * The `exists (select 1 from public.notification_deliveries where
--     identity = ... and (delivered_at is not null or claimed_at >= ...))`
--     freedom/in-flight/delivered checks reference identity/delivered_at/
--     claimed_at only — unchanged.
--   * The two `return next` blocks assign directly into the output variables
--     (season_number := ep.season_number; ...) — an assignment target, not an
--     ambiguous read — unchanged.
--
-- So the only ambiguity in the whole function was the two bare ON CONFLICT
-- column lists; both are fixed here and nothing else changes.
--
-- Everything else is preserved verbatim from 20260720120000: the exact same
-- five-argument signature and return shape, the one shared advisory lock key
-- per (subscription, show, season, episode), the 10-minute stale-claim lease,
-- the delivered/in-flight/free three-way airtime classification (and its
-- reminder-request back-off when airtime is in-flight), the read-back
-- claim_token ownership check before ever reporting a win, one returned row
-- per identity actually won, SECURITY DEFINER, the fixed search_path, and the
-- existing revoke/grant to service_role only.
--
-- Forward-only and idempotent: this only create-or-replaces
-- claim_episode_notifications in place (identical signature). No table is
-- altered, no row is inserted, updated, or deleted, and no cron definition is
-- touched. Safe to apply while the worker is active — the next cron
-- invocation after this is applied will simply succeed instead of erroring,
-- and since tonight's runs never actually claimed HOTD S3E5 (the error
-- happened before any row could be won), that reminder remains genuinely
-- unclaimed and eligible for the very next run, with no identity reset or
-- backfill needed.

create or replace function public.claim_episode_notifications(
  p_push_subscription_id bigint,
  p_tmdb_show_id bigint,
  p_episodes jsonb, -- [{season_number, episode_number, notification_types: text[]}]
  p_claim_token uuid,
  p_claimed_at timestamptz
)
returns table(season_number integer, episode_number integer, notification_type text)
language plpgsql
security definer
set search_path = public
as $$
declare
  ep record;
  lock_key bigint;
  wants_reminder boolean;
  wants_airtime boolean;
  reminder_identity text;
  airtime_identity text;
  reminder_free boolean;
  airtime_delivered boolean;
  airtime_in_flight boolean;
  attempt_airtime boolean;
  owner_token uuid;
begin
  for ep in
    select
      (value->>'season_number')::integer as season_number,
      (value->>'episode_number')::integer as episode_number,
      coalesce(value->'notification_types', '[]'::jsonb) as notification_types
    from jsonb_array_elements(p_episodes) as value
  loop
    -- Same lock key an airtime-only, reminder-only, or combined request all
    -- compute for this episode. Held for the rest of this function's
    -- transaction; released automatically the moment this call returns — which
    -- is exactly why the send (which happens after the return) needs the
    -- in-flight classification below rather than relying on the lock alone.
    lock_key := hashtextextended(
      p_push_subscription_id || ':' || p_tmdb_show_id || ':' || ep.season_number || ':' || ep.episode_number,
      0
    );
    perform pg_advisory_xact_lock(lock_key);

    wants_reminder := ep.notification_types ? 'episode_reminder';
    wants_airtime := ep.notification_types ? 'episode_airtime';

    if wants_reminder then
      reminder_identity := p_push_subscription_id || ':' || p_tmdb_show_id || ':' || ep.season_number || ':' || ep.episode_number || ':episode_reminder';
      reminder_free := not exists (
        select 1 from public.notification_deliveries
        where identity = reminder_identity
          and (delivered_at is not null or claimed_at >= p_claimed_at - interval '10 minutes')
      );
      if not reminder_free then
        -- Reminder already delivered or freshly claimed by someone else —
        -- nothing reserved for this episode this call, even if airtime was
        -- also requested.
        continue;
      end if;
    end if;

    attempt_airtime := false;
    if wants_airtime then
      airtime_identity := p_push_subscription_id || ':' || p_tmdb_show_id || ':' || ep.season_number || ':' || ep.episode_number || ':episode_airtime';

      -- Distinguish the two states the freedom check used to collapse:
      -- genuinely delivered vs. claimed-but-unsent within the lease window.
      airtime_delivered := exists (
        select 1 from public.notification_deliveries
        where identity = airtime_identity
          and delivered_at is not null
      );
      airtime_in_flight := exists (
        select 1 from public.notification_deliveries
        where identity = airtime_identity
          and delivered_at is null
          and claimed_at >= p_claimed_at - interval '10 minutes'
      );

      if wants_reminder and airtime_in_flight then
        -- Another worker holds a fresh, unsent airtime claim and is about to
        -- send airtime for this episode. Claiming reminder-only now would put
        -- a second push next to that imminent airtime send. Back off entirely;
        -- a later run claims reminder-only once airtime is actually delivered,
        -- or reclaims both if this in-flight claim goes stale.
        continue;
      end if;

      -- Free (no row) or stale (delivered_at null, lease expired) -> (re)claim.
      -- Delivered -> leave airtime alone; any reminder claim still proceeds.
      attempt_airtime := not airtime_delivered and not airtime_in_flight;
    end if;

    if not wants_reminder and not attempt_airtime then
      -- Airtime-only request that lost the race for airtime (delivered or
      -- in-flight): nothing to reserve.
      continue;
    end if;

    if wants_reminder then
      insert into public.notification_deliveries (
        identity, push_subscription_id, tmdb_show_id, season_number, episode_number, notification_type, claimed_at, claim_token
      ) values (
        reminder_identity, p_push_subscription_id, p_tmdb_show_id, ep.season_number, ep.episode_number, 'episode_reminder', p_claimed_at, p_claim_token
      )
      on conflict on constraint notification_deliveries_push_subscription_id_tmdb_show_id_s_key
      do update set claimed_at = excluded.claimed_at, claim_token = excluded.claim_token
        where notification_deliveries.delivered_at is null
          and notification_deliveries.claimed_at < p_claimed_at - interval '10 minutes';

      -- Never report a win the DB didn't actually grant: read the row back
      -- and only emit it if this call's claim_token is the one that stuck.
      select claim_token into owner_token from public.notification_deliveries where identity = reminder_identity;
      if owner_token = p_claim_token then
        season_number := ep.season_number;
        episode_number := ep.episode_number;
        notification_type := 'episode_reminder';
        return next;
      end if;
    end if;

    if attempt_airtime then
      insert into public.notification_deliveries (
        identity, push_subscription_id, tmdb_show_id, season_number, episode_number, notification_type, claimed_at, claim_token
      ) values (
        airtime_identity, p_push_subscription_id, p_tmdb_show_id, ep.season_number, ep.episode_number, 'episode_airtime', p_claimed_at, p_claim_token
      )
      on conflict on constraint notification_deliveries_push_subscription_id_tmdb_show_id_s_key
      do update set claimed_at = excluded.claimed_at, claim_token = excluded.claim_token
        where notification_deliveries.delivered_at is null
          and notification_deliveries.claimed_at < p_claimed_at - interval '10 minutes';

      select claim_token into owner_token from public.notification_deliveries where identity = airtime_identity;
      if owner_token = p_claim_token then
        season_number := ep.season_number;
        episode_number := ep.episode_number;
        notification_type := 'episode_airtime';
        return next;
      end if;
    end if;
  end loop;
end;
$$;

revoke all on function public.claim_episode_notifications(bigint, bigint, jsonb, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_episode_notifications(bigint, bigint, jsonb, uuid, timestamptz)
  to service_role;
