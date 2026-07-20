-- Fixes a cross-invocation race in the two-stage notification worker
-- (20260720080000_add_two_stage_episode_notifications.sql). Vercel Cron can
-- overlap: two worker invocations ("A" and "B") can both be mid-flight for
-- the same subscription/show/episode at once. When an episode's airtime
-- alert and its reminder become due in the very same evaluation window, the
-- old in-process coordination (api/notifications/run.js's
-- airtimeClaimedKeysByShow) only worked *within* a single invocation:
--
--   1. A wins the plain episode_airtime claim.
--   2. B loses that same claim (the identity is already fresh/claimed) and,
--      having no way to see A's in-memory state, has no reason to believe
--      the reminder is a collision — it looks exactly like a standalone
--      reminder to B.
--   3. B claims and sends episode_reminder standalone.
--   4. A sends episode_airtime.
--   5. Two pushes go out for what should have been one.
--
-- The fix moves the "is this a collision, and who owns resolving it" call
-- into the database, where it can be made atomically against the one shared
-- source of truth (notification_deliveries) instead of a worker's own
-- memory. claim_episode_reminder_with_airtime_collision replaces every
-- *reminder-due* claim (both plain "reminder only" claims and same-run
-- "airtime + reminder together" claims) with a single RPC call per episode:
--
--   * Per requested episode, an advisory transaction lock keyed on
--     (subscription, show, season, episode) serializes every concurrent
--     caller of *this* function for that exact episode — so the "is airtime
--     still winnable too" decision below is always made against a stable,
--     already-settled snapshot, never a snapshot some other concurrent
--     caller of this same function is simultaneously mutating.
--   * If the reminder identity is already delivered, or freshly claimed by
--     someone else (same 10-minute lease used everywhere else), this worker
--     has lost the reminder entirely — move on, nothing to reserve.
--   * Otherwise, the caller also passed whether this episode looks
--     airtime-due this run (a pure time-based fact — see
--     api/notifications/run.js). If it does, *and* the airtime identity
--     itself is not already delivered/freshly-claimed (which is exactly
--     what makes an episode whose airtime already went out on an earlier,
--     separate run correctly fall through to reminder-only here, satisfying
--     requirement 6: those still get a real reminder later) — reserve BOTH
--     the airtime and reminder identities together, under the same
--     claim_token, and report `combined = true`.
--   * Otherwise, reserve only the reminder identity and report
--     `combined = false`.
--
-- Because every reminder-due episode — collision or not — now goes through
-- this one serialized decision point, two overlapping invocations can never
-- split ownership of an airtime/reminder pair between them: whichever one
-- acquires the advisory lock first for a given episode makes the complete,
-- final decision (reminder-only vs combined) for that episode, and the
-- second invocation, once it acquires the lock after the first commits, sees
-- the settled result and reserves nothing further for that episode.
--
-- Genuinely non-colliding airtime claims (an episode whose reminder isn't
-- due yet) are untouched — they keep using the existing, already-atomic
-- plain claim_episode_notification_deliveries call directly, exactly as
-- before this migration.
--
-- No changes to complete_episode_notification_deliveries are needed: it
-- already finalizes an arbitrary claim-token-scoped list of identities, so a
-- combined win is finalized by passing both identities (still bound to the
-- one claim_token this function wrote onto both rows) in a single call —
-- one successful push finalizes both; a failed push or a failed finalize
-- leaves both rows exactly as reclaimable as any other unfinalized claim.

create or replace function public.claim_episode_reminder_with_airtime_collision(
  p_push_subscription_id bigint,
  p_tmdb_show_id bigint,
  p_episodes jsonb, -- [{season_number, episode_number, airtime_also_due}]
  p_claim_token uuid,
  p_claimed_at timestamptz
)
returns table(season_number integer, episode_number integer, combined boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  ep record;
  lock_key bigint;
  reminder_identity text;
  airtime_identity text;
  reminder_free boolean;
  airtime_free boolean;
begin
  for ep in
    select
      (value->>'season_number')::integer as season_number,
      (value->>'episode_number')::integer as episode_number,
      coalesce((value->>'airtime_also_due')::boolean, false) as airtime_also_due
    from jsonb_array_elements(p_episodes) as value
  loop
    lock_key := hashtextextended(
      p_push_subscription_id || ':' || p_tmdb_show_id || ':' || ep.season_number || ':' || ep.episode_number || ':collision',
      0
    );
    -- Held for the rest of this function's transaction (one RPC call), so
    -- it's automatically released the moment this call returns — no
    -- separate unlock step, and nothing to clean up if the connection
    -- drops mid-call.
    perform pg_advisory_xact_lock(lock_key);

    reminder_identity := p_push_subscription_id || ':' || p_tmdb_show_id || ':' || ep.season_number || ':' || ep.episode_number || ':episode_reminder';

    reminder_free := not exists (
      select 1 from public.notification_deliveries
      where identity = reminder_identity
        and (delivered_at is not null or claimed_at >= p_claimed_at - interval '10 minutes')
    );
    if not reminder_free then
      continue;
    end if;

    airtime_free := false;
    if ep.airtime_also_due then
      airtime_identity := p_push_subscription_id || ':' || p_tmdb_show_id || ':' || ep.season_number || ':' || ep.episode_number || ':episode_airtime';
      airtime_free := not exists (
        select 1 from public.notification_deliveries
        where identity = airtime_identity
          and (delivered_at is not null or claimed_at >= p_claimed_at - interval '10 minutes')
      );
    end if;

    if airtime_free then
      insert into public.notification_deliveries (
        identity, push_subscription_id, tmdb_show_id, season_number, episode_number, notification_type, claimed_at, claim_token
      ) values
        (reminder_identity, p_push_subscription_id, p_tmdb_show_id, ep.season_number, ep.episode_number, 'episode_reminder', p_claimed_at, p_claim_token),
        (airtime_identity, p_push_subscription_id, p_tmdb_show_id, ep.season_number, ep.episode_number, 'episode_airtime', p_claimed_at, p_claim_token)
      on conflict (push_subscription_id, tmdb_show_id, season_number, episode_number, notification_type)
      do update set claimed_at = excluded.claimed_at, claim_token = excluded.claim_token
        where notification_deliveries.delivered_at is null
          and notification_deliveries.claimed_at < p_claimed_at - interval '10 minutes';

      season_number := ep.season_number;
      episode_number := ep.episode_number;
      combined := true;
      return next;
    else
      insert into public.notification_deliveries (
        identity, push_subscription_id, tmdb_show_id, season_number, episode_number, notification_type, claimed_at, claim_token
      ) values
        (reminder_identity, p_push_subscription_id, p_tmdb_show_id, ep.season_number, ep.episode_number, 'episode_reminder', p_claimed_at, p_claim_token)
      on conflict (push_subscription_id, tmdb_show_id, season_number, episode_number, notification_type)
      do update set claimed_at = excluded.claimed_at, claim_token = excluded.claim_token
        where notification_deliveries.delivered_at is null
          and notification_deliveries.claimed_at < p_claimed_at - interval '10 minutes';

      season_number := ep.season_number;
      episode_number := ep.episode_number;
      combined := false;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function public.claim_episode_reminder_with_airtime_collision(bigint, bigint, jsonb, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_episode_reminder_with_airtime_collision(bigint, bigint, jsonb, uuid, timestamptz)
  to service_role;
