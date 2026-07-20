-- Fixes a second cross-invocation race left open by
-- 20260720090000_add_collision_safe_reminder_claim.sql: that migration only
-- serialized concurrent callers of claim_episode_reminder_with_airtime_collision
-- against *each other*. Plain airtime-only claims still went through
-- claim_episode_notification_deliveries directly, which takes no advisory
-- lock at all — so a plain airtime claim and a collision claim for the very
-- same episode could still interleave across two overlapping invocations:
--
--   1. Worker A evaluates this episode as airtime-only (its own read of wall
--      clock says the reminder isn't due yet) and calls the plain,
--      lock-free claim_episode_notification_deliveries for episode_airtime.
--   2. Worker B evaluates the same episode moments later, sees the reminder
--      as due too, and enters claim_episode_reminder_with_airtime_collision.
--   3. B's airtime_free check runs before A's plain claim has committed (or
--      simply isn't covered by the same lock), so B sees airtime as free.
--   4. A's plain claim commits and wins the episode_airtime row under A's
--      claim_token.
--   5. B's own INSERT for episode_airtime then no-ops (the row's claimed_at
--      is now fresher than B's threshold) — B never actually owns that row.
--   6. The old function had no step that checked this: it declared
--      combined = true purely because its own INSERT statement ran, without
--      confirming the airtime row actually ended up owned by B's
--      claim_token.
--   7. B sends what it believes is a combined push (airtime-styled content,
--      satisfying both identities) even though it never owned the airtime
--      identity.
--   8. A, unaware of any of this, also sends its own genuine airtime push.
--   9. Two airtime-flavored pushes go out for one episode, and B's later
--      finalize call mismatches against the airtime identity it doesn't
--      actually hold.
--
-- The fix: replace every claim path — airtime-only, reminder-only, and
-- combined — with a single function, claim_episode_notifications, so every
-- caller touching a given (subscription, show, season, episode) always
-- serializes through the exact same advisory lock, regardless of which
-- notification type(s) it's asking for. There is no longer a lock-protected
-- path and a lock-free path that can disagree about live state.
--
-- Per requested episode:
--
--   * One advisory transaction lock, keyed only on
--     (subscription, show, season, episode) — the same key an airtime-only
--     request, a reminder-only request, or a combined request all compute,
--     so whichever caller gets there first for a given episode fully
--     settles that episode (claims + commits + releases the lock) before
--     any other caller asking about that same episode — of any type — can
--     even read its state. This is what makes step 3 above structurally
--     impossible: a later caller's "is X free" checks can never observe a
--     stale, uncommitted, or concurrently-being-decided snapshot again.
--   * If episode_reminder was requested, it must be free (not delivered,
--     not freshly claimed by someone else within the existing 10-minute
--     lease) or nothing is reserved for this episode at all this call —
--     matching the prior collision RPC's behavior exactly.
--   * If episode_airtime was requested (whether alone, or alongside a
--     reminder request), it's attempted only if it's independently free by
--     that same test.
--   * Every attempted reservation is written via the same upsert-with-lease
--     pattern every claim RPC in this project already uses (insert .. on
--     conflict .. do update .. where delivered_at is null and claimed_at is
--     stale), and then — critically — the row is read back and only
--     reported as won if its claim_token now actually equals p_claim_token.
--     Nothing is ever reported as claimed merely because an INSERT
--     statement executed; ownership is always the thing actually checked.
--     Under the shared advisory lock this can never fail in practice (no
--     other caller can be touching the row at the same time), but it's
--     verified explicitly anyway rather than assumed, so a caller can never
--     report a partial or phantom win.
--
-- One row is returned per identity actually won (season_number,
-- episode_number, notification_type) — a caller that requested both types
-- for an episode and won both gets two rows back (its "combined" case); one
-- row back means only that one type was won (a graceful downgrade — e.g.
-- reminder-only when airtime had already gone out, or airtime-only when a
-- concurrent reminder-due request took the reminder itself); no rows back
-- for that episode means nothing was won this call. The caller (see
-- api/notifications/run.js) groups returned rows by episode to decide
-- whether to send a combined push, a single-type push, or nothing.
--
-- No changes to complete_episode_notification_deliveries: a claim-token
-- scoped list of identities is finalized exactly the same way regardless of
-- which types were reserved together.
--
-- claim_episode_notification_deliveries and
-- claim_episode_reminder_with_airtime_collision are no longer called by the
-- worker after this migration, but are left in place (unused, harmless) —
-- consistent with this project's forward-only, additive-only migration
-- convention. Nothing drops or rewrites them.

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
    -- compute for this episode — the one shared serialization point that
    -- replaces the two separate (lock-protected vs lock-free) paths this
    -- migration fixes. Held for the rest of this function's transaction, so
    -- it's released automatically the moment this call returns.
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
        -- Lost the reminder outright — nothing reserved for this episode
        -- this call, even if airtime was also requested alongside it.
        continue;
      end if;
    end if;

    attempt_airtime := false;
    if wants_airtime then
      airtime_identity := p_push_subscription_id || ':' || p_tmdb_show_id || ':' || ep.season_number || ':' || ep.episode_number || ':episode_airtime';
      attempt_airtime := not exists (
        select 1 from public.notification_deliveries
        where identity = airtime_identity
          and (delivered_at is not null or claimed_at >= p_claimed_at - interval '10 minutes')
      );
    end if;

    if not wants_reminder and not attempt_airtime then
      -- Airtime-only request that lost the race for airtime: nothing to
      -- reserve.
      continue;
    end if;

    if wants_reminder then
      insert into public.notification_deliveries (
        identity, push_subscription_id, tmdb_show_id, season_number, episode_number, notification_type, claimed_at, claim_token
      ) values (
        reminder_identity, p_push_subscription_id, p_tmdb_show_id, ep.season_number, ep.episode_number, 'episode_reminder', p_claimed_at, p_claim_token
      )
      on conflict (push_subscription_id, tmdb_show_id, season_number, episode_number, notification_type)
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
      on conflict (push_subscription_id, tmdb_show_id, season_number, episode_number, notification_type)
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
