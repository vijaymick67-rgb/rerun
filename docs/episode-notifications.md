# Episode notifications

## Architecture

The GitHub Actions worker reads `tracked_shows` and `watched_episodes` from Rerun's Supabase project. It runs the same `selectTrackedShowsForWatching`, `loadWatchingShowData`, TVmaze enrichment, `classifyReleasePlatform`, `episodeReleaseInfo`, `hasAired`, and `isVisibleInWatching` helpers used by the application. The worker never searches TMDB by title and has no show list.

TMDB is fetched server-side and normalized by the same pure normalizers used by the browser client. Notification planning is pure; Supabase claims, ntfy publishing, and successful-delivery recording are separate side effects. Only TVmaze/manual release dates are notification-eligible. A raw TMDB date may remain a safe UI fallback, but is not trustworthy enough to trigger a push.

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
2. Add the four secrets, leaving `RERUN_NOTIFICATIONS_ENABLED=false`.
3. In Actions, open **Episode notifications**, choose **Run workflow**, and leave `mode` as `dry-run`.
4. Inspect every `included`/excluded episode, its platform, date source, and formatted IST availability. Dry-run sends nothing and writes no delivery rows.
5. For one controlled live test, set `RERUN_NOTIFICATIONS_ENABLED=true`, manually run with `mode=live`, verify ntfy and the delivery row, then rerun to verify no duplicate.
6. Leave the variable true only after the controlled test is correct. The UTC cron runs every 15 minutes; availability is determined by release timestamps, never cron timezone.

Local deterministic simulation (no Supabase, TMDB, TVmaze, or ntfy network calls):

```sh
npm run notifications:simulate
```

## Message and deduplication

The request is `POST https://ntfy.sh/<topic>` with a UTF-8 text body and `Title`. When a poster exists it also sends `Attach: https://image.tmdb.org/t/p/w342/<path>` and `Filename: rerun-<tmdb-id>.jpg`. It never sends `Click` or `Actions`.

`notification_deliveries` has unique episode/type identity. A worker atomically claims undelivered episodes before publishing. A successful ntfy response is followed by `delivered_at`; a failed response removes that worker's claim so a later run can retry. Thirty-minute stale claims recover interrupted runs, and workflow concurrency prevents normal overlap. There is an unavoidable external-system crash window if ntfy accepts a message but the process dies before recording success; no ntfy idempotency guarantee is assumed.

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
