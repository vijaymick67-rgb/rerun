-- Phase 2 follow-up (PR review on "Add automatic episode notifications"):
-- finalize a delivery only after Web Push has actually confirmed acceptance,
-- and only for the exact claim (claim_token) that sent it.
--
-- The worker previously finalized with a plain
-- `update notification_deliveries set delivered_at = ... where identity in (...)`
-- after a successful sendNotification call. That has two problems:
--
-- 1. If the database write itself fails (network blip, statement timeout),
--    the push has already reached the device but the row never records
--    delivered_at. Ten minutes later claim_episode_notification_deliveries
--    treats it as reclaimable and the same episode can be pushed again, while
--    the worker's summary still reports it as sent.
--
-- 2. A claim left undelivered for over 10 minutes (an unusually slow send)
--    can be reclaimed by a second worker invocation, which replaces
--    claim_token with a new value. If the first (slow) worker's send then
--    finally succeeds, a plain `where identity in (...)` update would mark
--    the *second* worker's claim delivered — even though it was the first
--    worker's push that actually fired, and the second worker's own send may
--    not have happened yet. Scoping the update to the exact claim_token the
--    worker was handed makes a stale worker's finalization a no-op instead.
--
-- The worker must check this function's returned row count against the
-- number of episodes it expected to finalize, and only increment its "sent"
-- count when they match — see api/notifications/run.js.

create or replace function public.complete_episode_notification_deliveries(
  p_claim_token uuid,
  p_identities text[],
  p_delivered_at timestamptz
)
returns table(identity text)
language sql
security definer
set search_path = public
as $$
  update public.notification_deliveries
  set delivered_at = p_delivered_at
  where notification_deliveries.identity = any (p_identities)
    and notification_deliveries.claim_token = p_claim_token
    and notification_deliveries.delivered_at is null
  returning notification_deliveries.identity;
$$;

revoke all on function public.complete_episode_notification_deliveries(uuid, text[], timestamptz)
  from public, anon, authenticated;
grant execute on function public.complete_episode_notification_deliveries(uuid, text[], timestamptz)
  to service_role;
