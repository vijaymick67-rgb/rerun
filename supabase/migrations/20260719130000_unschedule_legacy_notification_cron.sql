-- Unschedules the three Supabase Cron jobs created by the removed ntfy-based
-- notification worker (PRs #52-#56). Deleting the migration file that
-- created them (20260715100000_schedule_notification_cron.sql) does not
-- undo already-applied database state — pg_cron jobs are rows in cron.job,
-- entirely independent of migration file history. Without this, those jobs
-- would keep firing daily against the now-deleted /api/notification-cron
-- endpoint: repeated failed requests, noisy cron run history, and wasted
-- Vercel invocations.
--
-- Guarded so this is safe and idempotent regardless of database state: a
-- database that never installed pg_cron, or where these jobs were already
-- removed, just no-ops.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'rerun-notification-worker-10pm-ist') then
      perform cron.unschedule('rerun-notification-worker-10pm-ist');
    end if;
    if exists (select 1 from cron.job where jobname = 'rerun-notification-worker-1005pm-ist') then
      perform cron.unschedule('rerun-notification-worker-1005pm-ist');
    end if;
    if exists (select 1 from cron.job where jobname = 'rerun-notification-worker-1010pm-ist') then
      perform cron.unschedule('rerun-notification-worker-1010pm-ist');
    end if;
  end if;
end $$;

-- Not handled here — Vault secrets aren't part of a migration's normal blast
-- radius and this app has no scripted Vault access. If you applied
-- 20260715100000, delete these manually in Supabase → Project Settings →
-- Vault once you've confirmed the jobs above are gone:
--   rerun_notification_endpoint_url
--   rerun_notification_cron_secret
