# Native Web Push (Phase 1)

Phase 1 replaces the ntfy-based notifier with standards-based Web Push, sent
directly by Rerun's own service worker. This phase covers permission +
subscription plumbing and **one manually triggered test notification only**.
Automatic episode-available notifications are a later phase — see
`CLAUDE.md` → Notifications.

## What was removed

The ntfy/GitHub Actions system from PRs #52–#56 is gone:

- `.github/workflows/episode-notifications.yml` (the `*/15 * * * *` scheduler)
- `api/notification-cron.js` (the Vercel worker endpoint it called)
- `scripts/notifications/{worker,simulate,deliveryStore,tmdbServer}.js`
- `src/lib/notifications/{execute,ntfy,plan}.js` and their tests
- `docs/episode-notifications.md`
- `supabase/migrations/20260715100000_schedule_notification_cron.sql`
  (the Supabase Cron jobs that hit the worker endpoint)
- the `notifications:simulate` package.json script

**What intentionally remains:**

- `supabase/migrations/20260715080000_add_notification_deliveries.sql` — the
  `notification_deliveries` table is left in place, unused. Dropping it isn't
  necessary for this phase and a destructive migration wasn't worth the risk;
  a later cleanup can remove it once episode scheduling is rebuilt (or reuse
  it, since its identity/claim shape is scheduler-agnostic).
- Every helper `worker.js` borrowed that's also used by the live app —
  `tvmaze.js`, `watchHelpers.js`, `finishedShows.js`, `watchingShows.js`,
  `watchedEpisodes.js`, `releasePlatforms.js` — none of that is
  notification-specific and all of it stays.

## What was added

- `supabase/migrations/20260719120000_add_push_subscriptions.sql` — a
  `push_subscriptions` table (`endpoint` unique, `p256dh`, `auth`,
  `user_agent`, `created_at`/`updated_at`, `last_test_sent_at`). RLS is
  enabled and every privilege is revoked from `anon`/`authenticated` — it's
  reachable only through the service-role key, server-side. This is stricter
  than `tracked_shows`/`watched_episodes` because these rows are
  secret-bearing: reading one would let someone send arbitrary push traffic
  as Rerun.
- `src/lib/push/` — client-side support detection, permission request
  (VAPID key conversion, subscribe/unsubscribe against `PushManager`), and
  the three fetch calls to the endpoints below.
- `api/push/subscribe.js`, `api/push/unsubscribe.js`, `api/push/test.js` —
  Vercel serverless endpoints using `web-push` + the Supabase service-role
  key. `api/push/_validation.js` and `api/push/_supabaseAdmin.js` are shared
  helpers (Vercel ignores `_`-prefixed files under `api/`, so they aren't
  routed).
- `public/push-sw.js` — pulled into the generated service worker via
  `workbox.importScripts` (`vite/pwa-options.js`) rather than migrating off
  `strategies: 'generateSW'`. It only adds `push`/`notificationclick`
  listeners; it never touches the precaching, navigation-fallback, or update
  lifecycle Workbox owns (see `tests/pwa.test.js`, unchanged).
- The Settings → Notifications section is now interactive (see states below).

## Setup

1. Generate a VAPID key pair once:
   ```sh
   npx web-push generate-vapid-keys
   ```
2. In Vercel → Project → Environment Variables (Production **and** Preview),
   set:
   - `VITE_VAPID_PUBLIC_KEY` — the public key (safe to expose; it's bundled
     into the client).
   - `VAPID_PRIVATE_KEY` — the private key. Server-only, no `VITE_` prefix.
   - `VAPID_SUBJECT` — a contact URI, e.g. `mailto:you@example.com`.
   - `SUPABASE_SERVICE_ROLE_KEY` — from Supabase → Project Settings → API.
     Server-only. This is a new use of that credential in Vercel; it was
     previously only used as a GitHub Actions secret for the removed worker.
     `VITE_SUPABASE_URL` (already configured) is reused as-is for the
     project URL server-side — it's already public in the client bundle, so
     there's no need for a second URL variable.
3. Apply `supabase/migrations/20260719120000_add_push_subscriptions.sql` in
   the Supabase SQL Editor (same manual-apply flow as the other migrations
   in this repo — see `docs/finished-state-rollout.md` for the pattern).
4. Merge and deploy. Settings → Notifications will show "Unsupported" or
   "Must install Rerun to Home Screen" until you're using the installed
   iPhone Home Screen PWA (see below).

## Settings states

| State | Meaning |
| --- | --- |
| Unsupported | This browser/OS has no Web Push support. |
| Must install Rerun to Home Screen | iOS Safari hides the Push API until Rerun is added to the Home Screen — this is a real platform restriction, not a bug. |
| (Enable notifications button) | Permission hasn't been requested yet, or was granted previously but the subscription was lost. |
| Permission denied | The user (or OS) denied the native prompt. Can't be re-requested from JS — must be changed in system settings. |
| Enabling… | Permission request + subscribe + server upsert in flight. |
| Notifications enabled | Subscribed and stored. |
| Sending test… / Test notification sent | The test-send request was accepted — this is deliberately not phrased as "received", since delivery to the device can't be confirmed from the browser tab. |
| Subscription error / Test delivery error | Surfaced verbatim from the failing step, non-fatal — the row reverts to a retryable state. |

Permission is **only ever** requested from the Enable button's `onClick` —
never automatically on load (see `src/routes/Settings.jsx`).

## No-auth limitation (honest documentation)

Rerun has no auth by design (single-user, public/anon Supabase access — see
`CLAUDE.md`). The push endpoints inherit that: `/api/push/subscribe`,
`/unsubscribe`, and `/test` are reachable by anyone who has the deployed
URL, same as every other endpoint in this app. The mitigations in place are:

- `push_subscriptions` itself is not publicly readable (RLS revokes
  anon/authenticated entirely; only the service-role key server-side can
  read or write it) — the biggest risk (leaking a live subscription so
  someone else can push through it) isn't exposed even though the table
  exists.
- `/api/push/subscribe` only accepts a payload shaped like a real
  `PushSubscription`, with `endpoint` restricted to known push-service hosts
  (Apple/FCM/Mozilla/Windows). This exists specifically so `/api/push/test`
  — which always sends to whatever's already stored, never to a
  caller-supplied target — can't be turned into an open relay via a forged
  endpoint stored earlier.
- `/api/push/test` rate-limits re-sends to the same subscription (30s) and
  self-heals on `404`/`410` by deleting the stale row.

None of this is authentication. Someone with the URL could still write a
garbage (but validly-shaped) subscription row, or force a test push if they
already knew/guessed a real endpoint. That's an accepted limitation
consistent with the rest of the app, not something this phase attempts to
solve — a real fix would mean adding auth, which is explicitly out of scope
for this personal tool.

## Manual iPhone verification (required after merge — Chromium/WebKit can't cover this)

1. Open the installed Rerun PWA on the iPhone Home Screen (not Safari tabs).
2. Settings → **Enable notifications**, accept the native iOS prompt.
3. Tap **Send test notification**.
4. Background Rerun.
5. Confirm the banner / Lock Screen / Notification Center delivery — title
   "Rerun notifications are working", body "You'll be notified when new
   episodes are ready."
6. Tap the notification and confirm Rerun opens/focuses.
7. Settings → **Disable notifications**, then confirm a further test send
   has nothing to target (no delivery, `404` from `/api/push/test`).

## Automated test coverage vs. what still needs a physical device

Chromium (390×844, 375×667) and Playwright WebKit (iPhone-style profile)
cover: Settings layout, no horizontal overflow, the bottom tab bar staying
anchored, all Settings state transitions, console errors, and that service-
worker registration stays healthy. They **cannot** cover real push delivery,
the native iOS permission prompt, Lock Screen/Notification Center rendering,
or backgrounded-app delivery — that's the physical-device checklist above.
