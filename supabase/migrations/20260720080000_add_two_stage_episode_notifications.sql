-- Two-stage automatic episode notifications: an "airtime" alert shortly
-- after an episode becomes available, plus the existing preferred-hour
-- alert repurposed as an evening "reminder" for whatever's still unwatched.
-- Two additions, both forward-only and safe to apply exactly once:
--
-- 1. A second, independent rollout watermark for the airtime stage
--    (airtime_notifications_enabled_at), separate from the existing
--    automatic_notifications_enabled_at activation watermark. This is the
--    critical rollout-safety piece: without it, introducing the brand-new
--    episode_airtime identity would make every unwatched episode released
--    since a subscription's *original* activation instantly airtime-eligible
--    the moment this ships — days of backlog, all at once. Backfilling
--    airtime_notifications_enabled_at to "now" (minus the same grace window
--    api/push/subscribe.js already uses for activation) instead means only
--    episodes airing after this deploy ever trigger an airtime alert for an
--    already-active subscription. `greatest(...)` never lets the airtime
--    watermark land *before* the subscription's own original activation
--    watermark either, so it can never be more permissive than the existing
--    no-backfill guarantee already gave that subscription.
--
--    `now()` is evaluated once for the single UPDATE statement below (not
--    per row), so every pre-existing subscription gets the same rollout
--    instant — a real timestamp fixed at migration-apply time, not a
--    hard-coded date baked into application code.
--
-- 2. A one-time reclassification of already-delivered legacy
--    episode_available rows to episode_reminder, so an episode that was
--    already successfully notified under the old single-notification system
--    is never resent as a "new" reminder after this ships. Only delivered
--    rows are touched — undelivered/stale episode_available claims are left
--    as-is (dead type going forward, harmless: the composite unique
--    constraint is scoped by notification_type, so a leftover
--    episode_available row can never block or collide with a fresh
--    episode_airtime/episode_reminder claim for the same episode). No
--    episode_airtime rows are ever synthesized from legacy history — the
--    airtime alert is a new opportunity, not something legacy delivery
--    history can stand in for.

alter table public.push_subscriptions
  add column if not exists airtime_notifications_enabled_at timestamptz null;

comment on column public.push_subscriptions.airtime_notifications_enabled_at is
  'Rollout/activation watermark for the airtime notification stage, independent of automatic_notifications_enabled_at. Only episodes whose resolved release instant is strictly after this timestamp are ever eligible for an episode_airtime push, so introducing this feature (or re-enabling a subscription) can never backfill old unwatched episodes. Initialized identically to automatic_notifications_enabled_at for a fresh activation (api/push/subscribe.js); backfilled below for subscriptions that were already active when this migration was applied.';

update public.push_subscriptions
set airtime_notifications_enabled_at = greatest(
  automatic_notifications_enabled_at,
  now() - interval '30 minutes'
)
where automatic_notifications_enabled_at is not null
  and airtime_notifications_enabled_at is null;

-- Legacy episode_available deliveries that already succeeded are completed
-- episode_reminder deliveries now, not new work. Both the composite unique
-- key (push_subscription_id, tmdb_show_id, season_number, episode_number,
-- notification_type) and the manually-maintained `identity` text column
-- encode notification_type, so both must be rewritten together to keep them
-- consistent with what claim_episode_notification_deliveries builds
-- server-side. episode_reminder never previously existed, so there is no
-- possible conflict with an existing row.
update public.notification_deliveries
set
  notification_type = 'episode_reminder',
  identity = push_subscription_id || ':' || tmdb_show_id || ':' || season_number || ':' || episode_number || ':episode_reminder'
where notification_type = 'episode_available'
  and delivered_at is not null;
