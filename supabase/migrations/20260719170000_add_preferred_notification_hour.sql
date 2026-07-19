-- Custom notification-time feature: one global preferred delivery hour per
-- installation, 6 PM-11 PM IST (Settings -> Notifications -> "Notification
-- time"). Delivery targets are subscription-scoped (see
-- 20260719120000_add_push_subscriptions.sql), so this lives on
-- push_subscriptions rather than a new preferences table.
--
-- Stored as an IST hour-of-day integer (18-23), never as display text like
-- "8 PM" -- see src/lib/notifications/deliverySchedule.js for the scheduling
-- calculation that consumes it and api/push/preferences.js for how it's
-- updated. Every existing subscription (and every new one) defaults to 20
-- (8 PM), matching the product default.
--
-- Forward-only and safe to apply once: adds the column (if not already
-- present) with a table-wide default so existing rows are backfilled by the
-- DEFAULT clause itself, then adds the range check as a separate statement.
-- Does not touch push_subscriptions.automatic_notifications_enabled_at, any
-- notification_deliveries row, or the Supabase Cron schedule.

alter table public.push_subscriptions
  add column if not exists preferred_notification_hour_ist integer not null default 20;

alter table public.push_subscriptions
  drop constraint if exists push_subscriptions_preferred_notification_hour_ist_check;

alter table public.push_subscriptions
  add constraint push_subscriptions_preferred_notification_hour_ist_check
  check (preferred_notification_hour_ist between 18 and 23);

comment on column public.push_subscriptions.preferred_notification_hour_ist is
  'Preferred same-day IST delivery hour (18-23 = 6 PM-11 PM) for automatic episode notifications. Set in Settings -> Notifications and updated via api/push/preferences.js. Defaults to 20 (8 PM) for every existing and new subscription.';
