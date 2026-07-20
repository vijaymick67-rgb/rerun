-- Fixes a third cross-invocation race left open by
-- 20260720110000_add_unified_episode_notification_claim.sql. That migration
-- put every claim path (airtime-only, reminder-only, combined) behind one
-- shared per-episode advisory lock, so no two callers can disagree about live
-- delivery state *while inside the RPC*. But the advisory lock is a
-- transaction lock (pg_advisory_xact_lock) — it is released the instant the
-- RPC's transaction commits. The Web Push send happens afterwards, back in
-- api/notifications/run.js, entirely outside any database transaction. So a
-- freshly-claimed-but-not-yet-sent airtime row is unprotected against a second
-- invocation between the claim commit and the send:
--
--   1. Worker A, evaluating just before reminder time, requests airtime-only,
--      wins the episode_airtime row, and its RPC returns (lock released).
--   2. A has NOT sent or finalized the airtime push yet — the row is claimed,
--      unsent, delivered_at still null, claimed_at fresh.
--   3. Worker B, evaluating just after reminder time, requests airtime +
--      reminder for the same episode.
--   4. B takes the same advisory lock (A already released it) and checks
--      airtime freedom.
--   5. The 20260720110000 version treated "delivered" and "freshly claimed by
--      someone else" identically — both simply made airtime "not free". So B
--      saw airtime as unavailable, silently downgraded to reminder-only, and
--      claimed + sent a standalone reminder push.
--   6. A then sent its airtime push.
--   7. The user got two near-identical pushes for one episode — exactly the
--      outcome the combined-claim path exists to prevent.
--
-- The distinction the old freedom check collapsed is the whole fix. For a
-- request that wants airtime, the airtime identity is now classified into
-- three states, not two:
--
--   * delivered      — a past run genuinely sent airtime. A reminder now is a
--                       separate, legitimate, later notification, so a
--                       both-types request claims reminder only (this is what
--                       preserves "reminder after a previously completed
--                       airtime").
--   * in-flight      — claimed by someone else within the 10-minute lease and
--                       NOT yet delivered: another worker is about to send
--                       airtime for this episode right now. A both-types
--                       request must claim NOTHING for this episode — sending a
--                       reminder alongside that imminent airtime send is the
--                       double push. It backs off; a later run will claim
--                       reminder-only once airtime has actually been delivered
--                       (or reclaim both if that in-flight claim goes stale).
--   * free or stale  — no live claim (no row, or a delivered_at-null row whose
--                       claim is older than the lease): (re)claim airtime, and
--                       reminder too if requested — the combined case.
--
-- Behavior table for a request wanting BOTH airtime and reminder:
--
--   airtime free / stale ............... claim both (combined)
--   airtime delivered .................. claim reminder only
--   airtime in-flight (fresh, unsent) .. claim nothing this episode
--   reminder delivered or in-flight .... claim nothing this episode
--
-- An airtime-only request is unaffected in behavior: free/stale -> claim,
-- delivered/in-flight -> nothing (it never had a reminder to downgrade to).
-- A reminder-only request is likewise unchanged: its reminder must be free or
-- nothing is reserved. Only the both-types request gains the new in-flight
-- back-off.
--
-- Everything else is preserved verbatim from 20260720110000: the single shared
-- advisory lock key, the 10-minute lease/reclaim window, the read-back
-- ownership verification (a win is only ever reported when the row's
-- claim_token actually equals p_claim_token after the upsert — never merely
-- because an INSERT ran), the one-row-per-identity-won return shape, and the
-- untouched complete_episode_notification_deliveries finalization.
--
-- Forward-only, additive-only: this create-or-replaces claim_episode_notifications
-- in place (same signature). The superseded RPCs from earlier migrations are
-- still left where they are; nothing is dropped or rewritten.

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
