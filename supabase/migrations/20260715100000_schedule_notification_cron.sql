-- Supabase Cron is the primary 10:00 PM IST trigger (16:30 UTC).
-- Configure these Vault secrets before enabling the schedules; values never belong
-- in migrations or source control:
--   rerun_notification_endpoint_url: production URL ending in /api/notification-cron
--   rerun_notification_cron_secret: the endpoint's CRON_SECRET value

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'rerun-notification-worker-10pm-ist',
  '30 16 * * *',
  $job$
  select net.http_get(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'rerun_notification_endpoint_url'
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'rerun_notification_cron_secret'
      )
    ),
    timeout_milliseconds := 120000
  );
  $job$
);

select cron.schedule(
  'rerun-notification-worker-1005pm-ist',
  '35 16 * * *',
  $job$
  select net.http_get(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'rerun_notification_endpoint_url'
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'rerun_notification_cron_secret'
      )
    ),
    timeout_milliseconds := 120000
  );
  $job$
);

select cron.schedule(
  'rerun-notification-worker-1010pm-ist',
  '40 16 * * *',
  $job$
  select net.http_get(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'rerun_notification_endpoint_url'
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'rerun_notification_cron_secret'
      )
    ),
    timeout_milliseconds := 120000
  );
  $job$
);
