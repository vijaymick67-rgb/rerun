# Automatic Episode Notifications (Phase 2)

Phase 2 adds automatic "episode available" push notifications on top of the
Phase 1 native Web Push channel (`docs/web-push.md`). Phase 1 covered
permission/subscription plumbing and one manually-triggered test push;
Phase 2 adds a scheduled worker that finds newly-available episodes of
tracked shows and pushes to every activated subscription.

**Scope of this phase, deliberately:** scheduled episode evaluation,
automatic delivery shortly after an episode becomes available, strict
deduplication, first-run/backfill protection, and notification tap
navigation. No evening reminders, no custom times, no notification
categories/badges beyond the existing fixed icon, no broad Settings
redesign.

## What was added

- `supabase/migrations/20260719140000_add_automatic_episode_notifications.sql`
  — adds `push_subscriptions.automatic_notifications_enabled_at` (the
  activation watermark) and replaces the unused Phase 1
  `notification_deliveries` table with a subscription-scoped version (see
  "Deduplication" below).
- `supabase/migrations/20260719150000_schedule_episode_notification_worker.sql`
  — schedules the worker via Supabase Cron + pg_net every 15 minutes.
- `supabase/migrations/20260719160000_add_complete_episode_notification_deliveries.sql`
  — a claim-token-bound finalization RPC, called only after `web-push`
  confirms a send succeeded (see "Deduplication & delivery" below).
- `src/lib/notifications/episodeEligibility.js` — pure, synchronous
  eligibility + payload-grouping logic (no fetching, no Supabase, no
  web-push). Consumes the same `status`/`episodesBySeason` shape
  `src/lib/watchingShows.js` already produces for the live Watching tab, so
  tracked/hidden/finished filtering and release-timestamp resolution are
  reused unchanged, not reimplemented.
- `src/lib/tvmaze.js` — refactored (not behaviorally changed) to expose
  cache-free primitives (`fetchTvmazeShowIdByImdb`, `fetchTvmazeEpisodes`,
  `buildEpisodeReleaseMap`) so the server worker resolves TVmaze releases
  identically to the client, just without `localStorage` caching.
- `src/lib/tmdbNormalize.js` — the TMDB show/season trimming logic, extracted
  out of `src/lib/tmdb.js` (client) so the server worker uses the exact same
  normalization.
- `api/notifications/_tmdbServer.js`, `api/notifications/_tvmazeServer.js` —
  server-side data fetchers built on the shared logic above: bounded request
  timeouts (`src/lib/dataLoading.js`'s `withTimeout`, reused), a per-run
  in-memory cache (no cross-run caching — the worker doesn't run often
  enough to need it, and a stale server cache is worse than an extra
  request).
- `api/notifications/run.js` — the scheduled worker endpoint.
- `api/notifications/verify.js` — a manually-triggered synthetic
  verification endpoint (see "Physical verification" below).
- `public/push-sw.js` — now passes through a `tag` field from the push
  payload when present, so a redelivered push for the same show/episode
  replaces the existing OS notification instead of stacking a duplicate.
  Untagged (Phase 1 manual test) pushes are unaffected.
- Settings: automatic notifications activate themselves once a subscription
  is enabled (see "Activation" below). No new UI controls — the existing
  "Episode notifications — Native notifications from Rerun" row is
  unchanged, with one added status line ("Automatic episode alerts —
  Active") once enabled.

## Activation & first-run backfill protection

This is the most important guarantee in this phase: **shipping Phase 2 must
never send a flood of notifications for old unwatched episodes.**

- `push_subscriptions.automatic_notifications_enabled_at` is the activation
  watermark. It starts `null` for every subscription, including every
  Phase-1-only subscription that already existed before this shipped.
- It is set exactly once per subscription, the first time `api/push/subscribe.js`
  runs for that endpoint while the column is still `null` — backdated by a
  30-minute grace window (`ACTIVATION_GRACE_WINDOW_MS` in that file) so an
  episode that became available moments before activation isn't missed
  purely due to request timing during setup/deployment. A later
  re-subscribe (rotating the management token, as Phase 1 already did)
  never overwrites an already-set watermark — it's read back and passed
  through unchanged.
- The worker (`api/notifications/run.js`) only ever considers a
  subscription whose `automatic_notifications_enabled_at` is non-null, and
  only ever notifies about an episode whose resolved release instant is
  **strictly after** that subscription's watermark
  (`episodesSinceWatermark` in `episodeEligibility.js`). An episode that
  aired before or exactly at the watermark is backlog, not new, and is
  never eligible — there is no code path that can turn activation into a
  backfill.
- **Client-side trigger:** `src/routes/Settings.jsx`'s mount effect
  re-POSTs an already-existing subscription to `/api/push/subscribe` once
  per installation (gated by a local flag,
  `src/lib/push/automaticActivation.js` — not a source of truth, just an
  optimization so this doesn't refire on every app open). This is what
  actually activates a pre-existing Phase 1 subscription once the Phase 2
  client loads. A fresh "Enable notifications" tap activates immediately
  via the same subscribe call. Both paths are the same idempotent upsert
  Phase 1 already used for token rotation — this phase piggybacks on it
  rather than adding a second endpoint.
- Disabling notifications clears the local activation flag
  (`setAutomaticNotificationsActivated(false)`) and deletes the
  `push_subscriptions` row server-side (unchanged Phase 1 behavior) — a
  disabled subscription is gone, so it's trivially excluded from every
  future worker run, and its undelivered delivery claims are removed with
  it (`on delete cascade`, see below).

## Deduplication & delivery

`notification_deliveries` (added in Phase 1, unused until now) is
replaced outright by
`20260719140000_add_automatic_episode_notifications.sql` — the Phase 1
version deduplicated only by show/season/episode/type, which is wrong once
delivery is per-subscription (two installs must each get their own record
for the same episode). Since Phase 1 never wrote to it (its only
notification path, the manual test, doesn't use this table), there was no
production data to migrate, so it's dropped and recreated rather than
patched column-by-column.

- **Identity:** unique on `(push_subscription_id, tmdb_show_id,
  season_number, episode_number, notification_type)`.
- **Claim before send:** `claim_episode_notification_deliveries(...)` is a
  `security definer` Postgres function (service-role only) that atomically
  inserts-or-conditionally-updates one row per requested episode. A row is
  only returned to the caller (meaning "you own this claim, go ahead and
  send") if it didn't already exist with `delivered_at` set, and if an
  existing undelivered claim is either fresh (owned by a concurrent
  in-flight run) or stale. Two concurrent worker invocations racing on the
  same episode can never both win the claim — Postgres's `ON CONFLICT ...
  DO UPDATE ... WHERE` guarantees exactly one of them gets the row back.
- **Stale reclaim window:** 10 minutes, matched to the worker's ~10-15
  minute cron cadence — a transient send failure (row stays claimed, never
  marked delivered) becomes retryable within a run or two, without racing
  an invocation that might still be actively sending.
- **Marked delivered only after `web-push` confirms acceptance, via a
  claim-token-bound finalization RPC:** `run.js` calls `sendNotification`
  first; only on success does it call
  `complete_episode_notification_deliveries(p_claim_token, p_identities,
  p_delivered_at)` (added in
  `20260719160000_add_complete_episode_notification_deliveries.sql`), which
  atomically updates rows matching **both** the identity list **and** the
  exact `claim_token` this worker was issued, and only while
  `delivered_at is null`. The worker checks the RPC's error and the number
  of rows it actually finalized against the number of episodes it expected
  to finalize, and only increments `sent` when they match exactly. A
  thrown/rejected send never calls this RPC at all, leaving the claim
  exactly as the atomic claim left it (undelivered, so retryable per the
  window above). This two-step claim → send → claim-token-scoped-finalize
  sequence closes two gaps a plain post-send `update ... where identity in
  (...)` would leave open:
  - A database write failure *after* a successful push would otherwise
    still report as delivered even though the row stays undelivered and
    becomes reclaimable — risking a duplicate resend of an already-received
    notification, while the run's summary silently overstates `sent`.
  - A claim that outlives the 10-minute staleness window (an unusually slow
    send) can be reclaimed by a newer worker invocation, which replaces
    `claim_token`. Scoping finalization to the exact token a worker was
    handed means a stale, slow worker's finalize call is a no-op instead of
    incorrectly marking a different invocation's claim delivered.
- **`on delete cascade`** from `push_subscriptions` to
  `notification_deliveries.push_subscription_id`: removing a subscription
  (disable, or the worker's own stale-subscription cleanup below) removes
  its undelivered claims with it. Nothing is left behind to error or block
  a fresh subscription from being notified again.

## Eligibility

An episode is eligible for a given subscription only when **all** of:

- its show is currently tracked and visible in Watching under the exact
  same rule the live Watching tab uses (`isVisibleInWatching` from
  `src/lib/finishedShows.js` — hidden shows excluded, personally-finished
  shows only reconsidered the same way the tab reconsiders them);
- it's a real season episode, not a special — `src/lib/watchingShows.js`'s
  `loadWatchingShowData` only ever builds `episodesBySeason` from
  `season_number > 0`, so specials are excluded before eligibility code
  ever sees them, exactly like the live app;
- it has a real resolved release instant (`episodeReleaseInfo`, unchanged —
  this already prefers a TVmaze airstamp/airdate over the raw TMDB
  `air_date` string whenever TVmaze data is attached, so Phase 2 inherits
  that precedence without re-implementing it);
- that instant is `<=` the worker's evaluation time (already available);
- that instant is strictly after the subscription's activation watermark
  (see above);
- it isn't already in `watched_episodes` for that show;
- it wasn't already claimed/delivered for that subscription (see
  "Deduplication" above).

## Notification content

- One newly-available episode of a show:
  `{Show name} — New episode available` / `S{season}E{episode} · {episode
  title}` (or `Season {season}, Episode {episode}` if the title is
  missing).
- Multiple episodes of the same show becoming available together, same
  season: `{Show name} — {count} new episodes available` / `Season
  {season} is ready`.
- Same, spanning seasons: body becomes the truthful generic `New episodes
  are ready to watch`.
- Tap target: `/watching/{tmdbShowId}` (the show-detail route) — always
  producible here since `tmdbShowId` is always a real positive integer;
  `episodeNotificationUrl` falls back to `/watching` only as a defensive
  guard, never actually reached in the real worker.
- `tag`: stable per show (`rerun-episode-{tmdbId}-s{season}e{episode}` for
  a single episode, `rerun-episode-{tmdbId}-batch` for a group) — see
  `public/push-sw.js`.

See `src/lib/notifications/episodeEligibility.js` for the exact functions
(`collectAiredUnwatchedEpisodes`, `episodesSinceWatermark`,
`buildEpisodeNotificationPayload`).

## Scheduler

Supabase Cron (`pg_cron` + `pg_net`) calling the protected Vercel endpoint
— the same mechanism the removed Phase-1-era reminder system used
(`supabase/migrations/20260719130000_unschedule_legacy_notification_cron.sql`
unscheduled those three jobs; this is a new, differently-named job calling a
different endpoint, not a revival of that system).

- Job name: `rerun-episode-notification-worker` (one job, not three — this
  isn't a fixed daily reminder needing staggered retries).
- Cadence: every 15 minutes (`*/15 * * * *`).
- Calls `POST /api/notifications/run` with `Authorization: Bearer <secret>`,
  the secret read from Supabase Vault at call time, never embedded in the
  migration.

### Setup

1. Generate a strong random secret (e.g. `openssl rand -base64 32`) and set
   it as `NOTIFICATION_WORKER_SECRET` in Vercel (Production + Preview,
   server-only, no `VITE_` prefix).
2. In Supabase → Project Settings → Vault, create two secrets:
   - `rerun_notification_worker_endpoint_url` — the production URL ending
     in `/api/notifications/run`.
   - `rerun_notification_worker_secret` — the same value as
     `NOTIFICATION_WORKER_SECRET` above.

   These are new, intentionally distinctly-named entries — not the removed
   Phase-1-era `rerun_notification_endpoint_url` /
   `rerun_notification_cron_secret` (see `docs/web-push.md`'s note on
   deleting those manually).
3. Apply, in order, `20260719140000_add_automatic_episode_notifications.sql`,
   `20260719150000_schedule_episode_notification_worker.sql`, and
   `20260719160000_add_complete_episode_notification_deliveries.sql` in the
   Supabase SQL Editor. The scheduling migration is safe to run even before
   the Vault secrets above exist — the job just fails (harmlessly, into
   Cron's own run history) until they're set.
4. `TMDB_API_KEY` (already configured for `api/tmdb.js`) is reused as-is —
   the worker calls TMDB directly with it, server-side.

## Endpoint security (`api/notifications/run.js`)

- Rejects any method other than `POST`.
- Requires `Authorization: Bearer <NOTIFICATION_WORKER_SECRET>`, compared
  with `crypto.timingSafeEqual` (constant-time).
- Never returns subscriptions, endpoints, auth/p256dh keys, service-role
  credentials, the VAPID private key, or a raw stack trace — the response
  body is always exactly
  `{ checkedShows, eligibleEpisodes, sent, skipped, staleRemoved, failed }`
  (plus `preview` on a dry run — see below). Errors surface as a single
  generic message; details go only to server logs
  (`console.error`/`console.warn`, sanitized — status codes and counts,
  never raw Supabase/web-push error bodies wholesale).

## Data fetching

- Tracked shows and watched-episode state are loaded once per run, not once
  per subscription — the release/watched data behind eligibility is
  subscription-independent, only the activation watermark and the
  claim/dedup step vary per subscription. TMDB/TVmaze call volume is flat
  regardless of how many installs are subscribed (realistically 1-3 for
  this app).
- Per-show TMDB/TVmaze fetching runs with bounded concurrency (4 shows at a
  time — `DEFAULT_CONCURRENCY` in `run.js`) and a request timeout on every
  call (`withTimeout`, reused from `src/lib/dataLoading.js`).
- A failure loading one show (TMDB/TVmaze error, timeout) is caught and
  logged per-show; it increments `failed` and the run continues with every
  other show. Same isolation per-subscription: one subscription's
  unexpected failure (a malformed watermark, a Supabase error) never
  prevents another subscription's notification.

## Dry run

`POST /api/notifications/run` with body `{"dryRun": true}` (still requires
the same `Authorization` header) runs the full eligibility computation —
tracked shows, TMDB/TVmaze fetches, watermark filtering — but never calls
the claim RPC and never calls `sendNotification`. It is entirely read-only:
nothing is written to `notification_deliveries`, so it's safe to run any
number of times, including in rapid succession, without creating delivery
records or affecting a later real run's dedup state. The response adds a
`preview` array: `{ tmdbShowId, title, body, episodeCount }` per
would-be-notified show, still with no endpoint/key data in it.

```sh
curl -X POST https://rerun-nine.vercel.app/api/notifications/run \
  -H "Authorization: Bearer $NOTIFICATION_WORKER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

## Inspecting worker results safely

The real (non-dry-run) response body is already safe to log/inspect as-is
— it's the compact summary shape above, with no secrets in it. Check
Vercel's function logs for the `notification_worker_*` sanitized log lines
(malformed subscriptions, per-show/per-subscription failures, send
failures) if a run reports non-zero `failed`. Supabase Cron's own run
history (Database → Cron) shows whether the scheduled job itself fired and
what HTTP status it got back.

## Physical iPhone verification

Waiting for a real episode to air isn't practical for verifying this
ships correctly. `api/notifications/verify.js` sends one real push through
the exact same content-building code the real worker uses
(`buildEpisodeNotificationPayload`), targeting a synthetic show/episode —
`tmdbShowId: -1` (can never collide with a real TMDB id),
`notification_type` distinct from real automatic deliveries — so it can
never be confused with, or interfere with, a real automatic delivery. It
never reads or writes `tracked_shows` or `watched_episodes`, and it doesn't
go through the claim/`notification_deliveries` table at all (it's a
content + delivery check, not a dedup check) — this is **not** the real
scheduled worker; it never scans tracked shows.

It's authenticated the same way Phase 1's manual test push is — the
installation's own `managementToken` (from `localStorage`, already stored
by Settings) — and shares that same 30-second resend throttle. There's no
Settings UI button for it (out of scope for this phase); trigger it
directly:

```sh
curl -X POST https://rerun-nine.vercel.app/api/notifications/verify \
  -H "Content-Type: application/json" \
  -d '{"managementToken": "<paste from your browser devtools / localStorage>"}'
```

Steps:

1. Enable notifications on the installed iPhone Home Screen PWA (Phase 1
   flow, unchanged) if not already enabled.
2. Run the `curl` above (from any machine — the token, not the request
   origin, is what's checked) with the `managementToken` value read from
   that installation's `localStorage` key
   `rerun:push:managementToken`.
3. Background Rerun on the iPhone.
4. Confirm delivery: title "Rerun Verification — New episode available",
   body "S1E1 · Verification episode".
5. Tap the notification — it opens `/watching` (a synthetic show has no
   real detail page, so this is the correct, intentional fallback, not a
   bug).

Separately, once real tracked shows exist with real upcoming episodes,
confirm the actual scheduled path at least once after merge: wait for the
Supabase Cron job to fire naturally (check Database → Cron → run history
for `rerun-episode-notification-worker`), or invoke `/api/notifications/run`
directly (without `dryRun`) once you're ready to let it send for real.

## Automated test coverage vs. what still needs a physical device

Covered by `npm test`: activation watermark + no-backfill (including the
exact watermark boundary), the aired-episode `evaluationTime` boundary
(including an end-to-end IST platform-threshold boundary from a TMDB-only
`air_date`), TVmaze-over-TMDB precedence, tracked/hidden/finished
filtering, specials exclusion, watched-episode exclusion, single vs. batch
(same-season vs. cross-season) payload content, missing-title fallback,
claim/dedup including a simulated concurrent-claim race and a same-time
worker rerun, transient-failure isolation, 404/410 stale-subscription
removal, per-show and per-subscription failure isolation, malformed
subscription rows, worker-secret auth and method rejection, sanitized
error responses, dry run (including determinism across repeated calls),
the Phase 1 manual test push (unchanged, still passing), and PWA
precache/update-lifecycle tests (unchanged, still passing). Real push
delivery, Lock Screen/Notification Center rendering, and backgrounded-app
delivery still require the physical-device checklist above — no automated
suite can cover those.
