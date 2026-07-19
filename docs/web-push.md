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

Deleting `20260715100000_schedule_notification_cron.sql` from the repo does
**not** undo it if it was already applied to production — pg_cron jobs are
rows in `cron.job`, independent of migration file history. A follow-up
migration, `supabase/migrations/20260719130000_unschedule_legacy_notification_cron.sql`,
explicitly calls `cron.unschedule()` on the three named jobs
(`rerun-notification-worker-10pm-ist`, `-1005pm-ist`, `-1010pm-ist`). It's
guarded to no-op safely whether or not `pg_cron` was ever installed or the
jobs already gone. It does **not** delete the Vault secrets those jobs
read (`rerun_notification_endpoint_url`, `rerun_notification_cron_secret`) —
that's a manual step in Supabase → Project Settings → Vault, since this app
has no scripted Vault access and a migration deleting secrets felt like the
wrong blast radius for a generated file.

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
  `user_agent`, `management_token_hash` unique, `created_at`/`updated_at`,
  `last_test_sent_at`). RLS is enabled and every privilege is revoked from
  `anon`/`authenticated` — it's reachable only through the service-role key,
  server-side. This is stricter than `tracked_shows`/`watched_episodes`
  because these rows are secret-bearing: reading one would let someone send
  arbitrary push traffic as Rerun.
- `src/lib/push/` — client-side support detection, permission request
  (VAPID key conversion, subscribe/unsubscribe against `PushManager`), local
  storage of the per-installation management token (`managementToken.js`),
  and the three fetch calls to the endpoints below.
- `api/push/subscribe.js`, `api/push/unsubscribe.js`, `api/push/test.js` —
  Vercel serverless endpoints using `web-push` + the Supabase service-role
  key. `api/push/_validation.js`, `api/push/_supabaseAdmin.js`, and
  `api/push/_managementToken.js` are shared helpers (Vercel ignores
  `_`-prefixed files under `api/`, so they aren't routed).
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
3. Apply, in order, `supabase/migrations/20260719120000_add_push_subscriptions.sql`
   and `supabase/migrations/20260719130000_unschedule_legacy_notification_cron.sql`
   in the Supabase SQL Editor (same manual-apply flow as the other
   migrations in this repo — see `docs/finished-state-rollout.md` for the
   pattern). The second one is safe to run even if you never applied the
   old cron-scheduling migration.
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
  (Apple/FCM/Mozilla/Windows). This exists specifically so a forged endpoint
  stored at subscribe time can't later turn a server-side send into an open
  SSRF relay.
- **Per-installation management token.** `/api/push/subscribe` generates a
  random 256-bit opaque token on every successful call, stores only its
  SHA-256 hash (`push_subscriptions.management_token_hash`), and returns the
  raw token to the caller exactly once. The client keeps it in
  `localStorage` (`src/lib/push/managementToken.js`) and must present it on
  every later call: `/api/push/test` looks up a subscription **by token
  hash** — it never reads or broadcasts to every stored row, only to the one
  the caller proved ownership of — and `/api/push/unsubscribe` requires the
  token to match the target endpoint's stored hash before deleting it
  (`403` on mismatch, `404` if the endpoint isn't stored at all). This is
  the actual fix for the earlier design, where both endpoints trusted a
  bare endpoint string / acted on every row with no proof the caller owned
  anything.
- `/api/push/subscribe` caps total stored rows at 20
  (`MAX_PUSH_SUBSCRIPTIONS` in `api/push/subscribe.js`) for genuinely new
  endpoints — re-subscribing an endpoint already on file is never blocked by
  it. This is a coarse safeguard against the public endpoint being used to
  grow the table indefinitely; it is not per-caller rate limiting, which
  would need persistent request-tracking infrastructure this app doesn't
  have.
- `/api/push/test` rate-limits re-sends to the same subscription (30s) and
  self-heals on `404`/`410` by deleting the stale row.

What's still true even with the token: someone with the deployed URL can
still call `/api/push/subscribe` and create their own valid-shaped
subscription row (up to the cap) — nothing stops arbitrary signup, only
arbitrary *management of subscriptions they didn't create*. That's an
accepted limitation consistent with the rest of the app; a real fix would
mean adding auth, which is explicitly out of scope for this personal tool.
Someone else's junk row does **not** let them target your device: your
Settings → Notifications state and management token are local to your own
browser install, and `/api/push/test` only ever sends to the row matching
the token it was given.

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
