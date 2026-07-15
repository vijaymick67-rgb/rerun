# Episode notifications

## Architecture

The GitHub Actions worker reads `tracked_shows` and `watched_episodes` from Rerun's Supabase project. It runs the same `selectTrackedShowsForWatching`, `loadWatchingShowData`, TVmaze enrichment, `classifyReleasePlatform`, `episodeReleaseInfo`, `hasAired`, and `isVisibleInWatching` helpers used by the application. The worker never searches TMDB by title and has no show list.

TMDB is fetched server-side and normalized by the same pure normalizers used by the browser client. Notification planning is pure; Supabase claims, ntfy publishing, and successful-delivery recording are separate side effects. Only TVmaze/manual release dates are notification-eligible. A raw TMDB date may remain a safe UI fallback, but is not trustworthy enough to trigger a push.

Notifications are a recent-release signal, not a historical backlog feed. The planner uses the timestamp already returned by `episodeReleaseInfo()` and includes it only when `timestamp > now - 24 hours`; an episode exactly 24 hours old is excluded. It does not recalculate dates, time zones, or platform thresholds. Old unwatched catalog episodes therefore remain visible in Rerun without generating pushes.

The notification-only current-airing guard accepts TMDB's normalized `Returning Series` and `In Production` statuses. `Ended`, `Canceled`, missing, and unfamiliar statuses are excluded conservatively with `showNotCurrentlyAiring`. This does not change Watching visibility or any UI behavior.

Do not create a second release-time table or copy thresholds into worker code. Changes to availability belong in Rerun's existing release helpers and their parity tests.

## Required Actions configuration

Repository secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only; never use a `VITE_` prefix)
- `TMDB_API_KEY`
- `NTFY_TOPIC` (topic name only)

Repository variable:

- `RERUN_NOTIFICATIONS_ENABLED`, initially absent or `false`

The service-role key is used only in GitHub Actions. The notification table has RLS enabled and grants no browser roles access.

## Dry-run and enable procedure

1. Apply `supabase/migrations/20260715080000_add_notification_deliveries.sql`.
2. Add the four secrets, keeping `RERUN_NOTIFICATIONS_ENABLED=false` before and after merge.
3. In Actions, open **Episode notifications**, choose **Run workflow**, and leave `mode` as `dry-run`.
4. Confirm old catalog backlogs such as Frasier and The Sopranos produce zero notifications.
5. Confirm only genuinely recent episodes, such as the current Lucky releases, are included and inspect their platform, date source, and formatted IST availability. Dry-run sends nothing and writes no delivery rows.
6. Only after the dry-run is correct, set `RERUN_NOTIFICATIONS_ENABLED=true` and manually run one controlled `live` test. Verify ntfy and the delivery row, then rerun to prove no duplicate.
7. Leave the variable true only after the controlled test is correct. The UTC cron runs every 15 minutes; availability is determined by release timestamps, never cron timezone.

Local deterministic simulation (no Supabase, TMDB, TVmaze, or ntfy network calls):

```sh
npm run notifications:simulate
```

## Message and deduplication

The publisher uses ntfy's UTF-8 JSON API: `POST https://ntfy.sh` with `Content-Type: application/json; charset=utf-8`, carrying the topic, title, and message in JSON. Unicode show names, punctuation, and episode titles are preserved. When a poster exists, it remains a remote attachment using the mobile-sized TMDB URL and `rerun-<tmdb-id>.jpg` filename. Text-only notifications omit attachment fields. No `Click` or `Actions` headers or JSON fields are sent.

`notification_deliveries` has unique episode/type identity. A worker atomically claims undelivered episodes before publishing. A successful ntfy response is followed by `delivered_at`; a failed response removes that worker's claim so a later run can retry. Thirty-minute stale claims recover interrupted runs, and workflow concurrency prevents normal overlap. There is an unavoidable external-system crash window if ntfy accepts a message but the process dies before recording success; no ntfy idempotency guarantee is assumed.

## Scheduler backup

Supabase Cron is the primary 10:00 PM IST trigger. Migration `20260715100000_schedule_notification_cron.sql` schedules one daily `pg_cron` job at `30 16 * * *` (16:30 UTC; IST is fixed at UTC+05:30). The job calls the protected production `/api/notification-cron` endpoint with `Authorization: Bearer <CRON_SECRET>`. The endpoint only invokes the existing `runNotificationWorker()`; it is an execution target, not a scheduler. GitHub Actions remains the fallback scheduler and continues to run every 15 minutes.

Before applying the migration, create these Supabase Vault entries without committing their values: `rerun_notification_endpoint_url` (the full production HTTPS URL ending in `/api/notification-cron`) and `rerun_notification_cron_secret` (the same value configured as the endpoint's server-only `CRON_SECRET`). The SQL reads only `vault.decrypted_secrets`; it contains no production URL, secret, service-role key, ntfy topic, or other credential. Keep the existing GitHub Actions and Vercel environment variables server-only; never use `VITE_` prefixes. The route fails closed when `CRON_SECRET` is missing and returns only safe operational fields.

Inspect Supabase Cron execution in `cron.job_run_details` (including the HTTP response status recorded by `pg_net`) and inspect endpoint behavior in Vercel Runtime Logs for `/api/notification-cron`. The existing atomic Supabase episode/type claims and durable deliveries handle close scheduler invocations without a new lock or deduplication path.

To roll back the scheduler, unschedule `rerun-notification-worker-10pm-ist` (or revert the migration) and leave the protected endpoint, worker, planner, GitHub Actions workflow, and notification delivery state unchanged. GitHub Actions remains available as fallback.

## Logs, rollback, and migration from tv-notifier

Logs are in the **Episode notifications** Actions run. They include TMDB ID, episode identity, inclusion/exclusion reason, platform classification, date source, and availability formatted in IST. They never include credentials, the topic URL, or the API-key-bearing TMDB URL.

Rollback is immediate: set `RERUN_NOTIFICATIONS_ENABLED=false`. Scheduled runs then exit before pushes or delivery writes. Do not disable or alter `tv-notifier` until the Rerun flow is proven.

Post-merge checklist:

- Apply the notification delivery migration.
- Add the four Rerun repository secrets.
- Run a manual dry-run and inspect expected episodes and IST timestamps.
- Temporarily enable and run one controlled live test.
- Verify the ntfy title, body, and poster.
- Verify the delivery record.
- Rerun to prove there is no duplicate.
- Only then leave the Rerun schedule enabled.
- Only after successful observation, disable the old `tv-notifier` workflow manually.
- Archive `tv-notifier` later as a separate action.

Nothing in this migration copies `shows.txt`, `resolved.json`, `seen.json`, `NETWORK_RELEASE`, `releaseMomentIST`, old title resolution, digests, trailers, or independent release-time calculations.


Each newly available episode can produce two independent notifications. The availability notification uses `episode_available` and retains the existing 24-hour lookback. The second watch reminder uses `episode_watch_reminder` and is evaluated from 10:00 PM through 11:59 PM IST. Its release interval is based on IST calendar cutoffs: strictly after the previous day's 10:00 PM and at or before the current day's 10:00 PM. It only includes episodes still unwatched at planning and claim time, so watching an episode after its availability push prevents the reminder. Each type can be delivered once independently; availability delivery does not block the reminder.

Because the workflow runs every 15 minutes, an ordinary schedule delay may deliver the reminder shortly after 10:00 PM. Outside the bounded 10:00-11:59 PM IST window, dry-run reports `outsideWatchReminderWindow` rather than presenting a reminder as immediately sendable. Dry-run distinguishes `wouldNotifyAvailability` and `wouldNotifyWatchReminder`, while `alreadyDeliveredWatchReminder` and `watchedBeforeWatchReminder` explain exclusions. Historical backlog remains excluded.
