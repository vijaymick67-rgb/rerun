-- Schedules the Phase 2 automatic episode-notification worker
-- (api/notifications/run.js) via Supabase Cron + pg_net, calling it every 15
-- minutes. One clearly named job — unlike the removed Phase-1-era cron
-- migration (20260715100000, unscheduled by 20260719130000), this is not a
-- fixed daily reminder, so there's no need for the old three-staggered-
-- retries shape.
--
-- Configure these Vault secrets before this job can succeed — values never
-- belong in a migration or source control:
--   rerun_notification_worker_endpoint_url: production URL ending in
--     /api/notifications/run
--   rerun_notification_worker_secret: the endpoint's NOTIFICATION_WORKER_SECRET
--     value (Vercel env var, server-only)
-- These are deliberately new Vault entry names, distinct from the removed
-- Phase-1-era rerun_notification_endpoint_url / rerun_notification_cron_secret
-- (see 20260719130000's note on deleting those manually) — this is a
-- different system calling a different endpoint.
--
-- Idempotent: safe to run whether or not pg_cron/pg_net are already
-- installed, and whether or not this job already exists (cron.schedule
-- upserts by job name).

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'rerun-episode-notification-worker',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'rerun_notification_worker_endpoint_url'
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'rerun_notification_worker_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$
);
