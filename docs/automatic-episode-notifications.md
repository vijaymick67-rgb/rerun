# Automatic Episode Notifications (Phase 2 + Phase 3)

Phase 2 adds automatic "episode available" push notifications on top of the
Phase 1 native Web Push channel (`docs/web-push.md`). Phase 1 covered
permission/subscription plumbing and one manually-triggered test push;
Phase 2 adds a scheduled worker that finds newly-available episodes of
tracked shows and pushes to every activated subscription.

**Scope of Phase 2, deliberately:** scheduled episode evaluation, automatic
delivery shortly after an episode becomes available (or at a preferred
same-day time), strict deduplication, first-run/backfill protection, and
notification tap navigation. No notification categories/badges beyond the
existing fixed icon, no broad Settings redesign.

**Phase 3 ("Add airtime episode alerts") turns that single notification
into two independent opportunities per episode** — see "Two-stage delivery:
airtime + reminder" below for the full design. The original Phase 2
single-notification behavior described throughout most of this document
(one push per newly-eligible batch, delayed only by the preferred hour) is
now specifically the **reminder** stage; the **airtime** stage is new and
never waits for the preferred hour.

**Follow-up fixes (same PR): two cross-invocation races in the
same-evaluation collision handling.** Vercel Cron can overlap — two worker
invocations can be mid-flight for the same subscription/show/episode at
once.

1. The initial Phase 3 implementation coordinated the "send only the
   airtime alert, satisfy the reminder silently" rule entirely in-process,
   which only worked within a single invocation; two overlapping
   invocations could split ownership (one sends airtime, the other
   independently sends the reminder), producing two pushes. Fixed by
   `claim_episode_reminder_with_airtime_collision`, a DB-backed,
   advisory-lock-protected RPC for every reminder-due claim.
2. That fix only serialized concurrent callers of *that* RPC against each
   other — a plain, lock-free airtime-only claim could still race a
   lock-protected collision claim across two invocations disagreeing (by a
   matter of milliseconds) about whether an episode's reminder was due yet,
   letting the collision RPC report a false `combined: true` for an
   airtime identity it never actually owned. Fixed by replacing every claim
   path — airtime-only, reminder-only, and combined — with one function,
   `claim_episode_notifications`, so every caller of every type shares the
   exact same advisory lock and verifies ownership before ever reporting a
   win.

See "Cross-invocation collision safety" below for both fixes.

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
- `supabase/migrations/20260719170000_add_preferred_notification_hour.sql`
  — adds `push_subscriptions.preferred_notification_hour_ist` (custom
  reminder-time feature; see "Preferred delivery hour" below).
- `supabase/migrations/20260720080000_add_two_stage_episode_notifications.sql`
  (Phase 3) — adds `push_subscriptions.airtime_notifications_enabled_at`
  (the airtime rollout watermark, independent of the Phase 2 activation
  watermark) and reclassifies already-delivered legacy `episode_available`
  rows to `episode_reminder` so they're never resent. See "Two-stage
  delivery: airtime + reminder" and "Rollout safety" below.
- `supabase/migrations/20260720090000_add_collision_safe_reminder_claim.sql`
  (Phase 3 follow-up) — adds `claim_episode_reminder_with_airtime_collision`,
  an RPC that atomically resolved the same-evaluation collision case across
  concurrent worker invocations of the reminder claim path. Superseded by
  the next migration (left in place, unused, per this project's
  additive-only convention). See "Cross-invocation collision safety" below.
- `supabase/migrations/20260720110000_add_unified_episode_notification_claim.sql`
  (Phase 3 follow-up #2) — adds `claim_episode_notifications`, the RPC the
  worker now calls for every claim of every type (airtime-only,
  reminder-only, combined), replacing both
  `claim_episode_notification_deliveries` and
  `claim_episode_reminder_with_airtime_collision` in `run.js`. See
  "Cross-invocation collision safety" below.
- `src/lib/notifications/episodeEligibility.js` — pure, synchronous
  eligibility + payload-grouping logic (no fetching, no Supabase, no
  web-push). Consumes the same `status`/`episodesBySeason` shape
  `src/lib/watchingShows.js` already produces for the live Watching tab, so
  tracked/hidden/finished filtering and release-timestamp resolution are
  reused unchanged, not reimplemented.
- `src/lib/notifications/deliverySchedule.js` — pure scheduling calculation
  layered on top of eligibility: given an episode's already-resolved release
  instant and a subscription's preferred hour, computes when that episode
  should actually be pushed. Never touches whether an episode is eligible.
- `api/push/preferences.js` — updates the caller's own
  `preferred_notification_hour_ist`, authenticated by management token the
  same way `api/push/test.js` is.
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
  is enabled (see "Activation" below). The existing "Episode notifications —
  Native notifications from Rerun" row is unchanged, with one added status
  line ("Automatic episode alerts — Active") once enabled, plus one added
  compact control — **Reminder time** (renamed from "Notification time" in
  Phase 3, plus one line of supporting copy) — described under "Preferred
  delivery hour" below.

## Two-stage delivery: airtime + reminder

Every eligible episode now has **two independent notification
opportunities**, each with its own delivery identity, tag, and
claim/finalize lifecycle:

- **Airtime alert** (`episode_airtime`) — sent on the first worker
  evaluation after the episode's real availability timestamp. Since the
  worker runs every 15 minutes, "at airtime" normally means within 0-15
  minutes of Rerun considering the episode available. The preferred hour
  (see "Preferred delivery hour" below) never delays this — the only rule
  is "never before availability."
- **Reminder** (`episode_reminder`) — the original Phase 2 same-day
  scheduling behavior, unchanged: sent on the first worker evaluation at or
  after the subscription's preferred IST hour on the episode's release
  date, and only if the episode is still unwatched at that point.

Both use the exact same visible content — `${showName} - New Episode`,
`omitBody: true`, no body — so a user can never tell which stage produced
a given push from its content alone (see "Notification content" below).
Only the OS notification `tag` and the internal `notification_type`
differ.

**Examples** (10 PM IST preferred hour):

- available at 8 AM → airtime alert around 8:00-8:15 AM, reminder around
  10:00-10:15 PM if still unwatched by then.
- available at 9:55 PM → airtime alert shortly after availability; reminder
  at the first worker run at or after 10 PM.
- available at 10:30 PM → airtime alert shortly after availability; the
  preferred-time reminder instant is `max(release, 10 PM IST) = release`,
  the same effective instant as availability itself — see "Same-evaluation
  collision" below for what happens when both become eligible together.

### Same-evaluation collision

An episode releasing at or after the preferred hour makes both stages
eligible in the very same worker evaluation. Sending both would be two
back-to-back identical-looking pushes for one episode, so the worker
applies one rule: **when airtime and reminder become eligible together,
send only the airtime alert, and durably finalize the reminder identity in
the same delivery — silently, with no second push.** A later worker run
then has nothing left to send for it.

This is implemented in `api/notifications/run.js` as four passes per
subscription:

1. Compute each show's airtime candidates (past the airtime watermark) and
   reminder candidates (past the preferred-hour schedule) independently,
   from the same underlying aired/unwatched episode pool
   (`collectAiredUnwatchedEpisodes`, unchanged). Merge the two candidate
   sets into one request per show, each episode tagged with which type(s)
   this run wants for it (`wantsAirtime`/`wantsReminder`), and claim all of
   them **in one call** to `claim_episode_notifications` (see
   "Cross-invocation collision safety" below). That one RPC call, not this
   process, decides atomically — per episode — which of the requested
   type(s) are still genuinely winnable, and returns one row per identity
   actually won; this process only groups those returned rows by episode to
   sort them into airtime-only, combined, or reminder-only buckets.
2. Send every airtime-only claim from step 1.
3. Send every combined claim from step 1 — one push per batch, using the
   airtime payload/tag, but finalizing **both** the airtime and reminder
   delivery identities in one `complete_episode_notification_deliveries`
   call (they share the same `claim_token`, since the claim RPC wrote both
   rows together in the same call). A failed send, or a failed finalize,
   leaves both identities exactly as unfinalized and reclaimable as any
   other claim — nothing is silently lost, nothing is falsely marked
   delivered.
4. Send every remaining reminder-only claim from step 1 (an episode never
   airtime-due this run, one whose airtime already went out on an earlier,
   separate run, or one that lost a same-run race for the airtime identity
   to a concurrent invocation) through a completely ordinary standalone
   claim → send → finalize, identical in shape to the airtime flow in step
   2.

### Cross-invocation collision safety

Two fixes, layered on top of each other, address two different
cross-invocation races. Both are superseded in practice by the final state
described in step 3 below — `claim_episode_notifications` is the only claim
path `run.js` calls today — but both are described here since the second
fix only makes sense in light of what the first one didn't cover.

**Fix 1 — the in-process collision race.** The in-process version of the
combined/reminder-only decision (tracking "which episodes did *this run's*
airtime claim actually win" in a local variable) only coordinated within a
single worker invocation. Vercel Cron invocations can overlap, so two
invocations ("A" and "B") could be mid-flight for the same
subscription/show/episode at once:

1. A wins the plain `episode_airtime` claim.
2. B loses that same claim — but has no way to see A's in-memory state, so
   the reminder looks like an ordinary standalone candidate to B.
3. B claims and sends `episode_reminder` standalone.
4. A sends `episode_airtime`.
5. Two pushes go out for what should have been one.

`claim_episode_reminder_with_airtime_collision`
(`supabase/migrations/20260720090000_add_collision_safe_reminder_claim.sql`)
fixed this by moving the combined/reminder-only decision into the database
via a `pg_advisory_xact_lock` keyed on `(subscription, show, season,
episode)`, held for the rest of that one RPC call — but only for callers of
*that specific function*.

**Fix 2 — the cross-path race Fix 1 left open.** Fix 1's advisory lock only
serialized concurrent callers of `claim_episode_reminder_with_airtime_collision`
against each other. Genuinely non-colliding airtime claims (an episode
whose reminder isn't due yet, from a given invocation's point of view) still
went through the plain, lock-free `claim_episode_notification_deliveries`
directly. Two overlapping invocations could still race across these two
different paths if they disagreed — by a matter of milliseconds — about
whether an episode's reminder had become due yet:

1. Worker A evaluates an episode as airtime-only (its own read of wall
   clock says the reminder isn't due) and calls the plain, lock-free claim
   for `episode_airtime`.
2. Worker B evaluates the same episode moments later, sees the reminder as
   due too, and enters `claim_episode_reminder_with_airtime_collision`.
3. B's `airtime_free` check isn't covered by the same lock A's claim used,
   so it can run either before or concurrently with A's plain claim
   committing.
4. A's plain claim commits and wins the `episode_airtime` row.
5. B's own insert for `episode_airtime` then no-ops (the row's `claimed_at`
   is now fresher than B's staleness threshold) — B never actually owns
   that row.
6. The old function had no step that checked this: it declared
   `combined = true` purely because its own `INSERT` statement ran, without
   confirming the airtime row actually ended up owned by B's `claim_token`.
7. B sends what it believes is a combined push (airtime-styled content,
   satisfying both identities) even though it never owned the airtime
   identity.
8. A, unaware of any of this, also sends its own genuine airtime push.
9. Two airtime-flavored pushes go out for one episode, and B's later
   finalize call mismatches against the airtime identity it doesn't
   actually hold.

`claim_episode_notifications`
(`supabase/migrations/20260720110000_add_unified_episode_notification_claim.sql`)
fixes this by replacing *every* claim path — airtime-only, reminder-only,
and combined — with one function, so an airtime-only request, a
reminder-only request, and a combined request for the same episode all
compute the identical advisory lock key and always serialize against each
other, not just against requests of the same shape. Per requested episode:

1. One `pg_advisory_xact_lock`, keyed only on `(subscription, show, season,
   episode)` — the same key regardless of which type(s) are requested —
   serializes every caller touching that episode. Whichever caller gets
   there first fully settles the episode (claims, verifies, commits,
   releases the lock) before any other caller — of any type — can even read
   its state, which is what makes step 3 above structurally impossible now.
2. If `episode_reminder` was requested, it must be free (not delivered, not
   freshly claimed by someone else within the existing 10-minute lease) or
   nothing is reserved for the episode this call at all — matching Fix 1's
   behavior exactly.
3. If `episode_airtime` was requested (alone, or alongside a reminder
   request), it's attempted only if it's independently free by that same
   test.
4. Every attempted reservation is written via the same upsert-with-lease
   pattern every claim RPC in this project uses, and then — never assumed —
   the row is read back and only reported as won if its `claim_token` now
   actually equals the caller's. Nothing is ever reported as claimed merely
   because an `INSERT` statement executed.

One row comes back per identity actually won. `run.js` groups the returned
rows by episode: both types back means a combined send; one type back means
a graceful single-type send (this is what correctly turns a lost airtime
race, or an episode whose airtime already went out on an earlier run, into
a real standalone reminder rather than a phantom "collision" — a pure
time-based `wantsAirtime`/`wantsReminder` fact from the worker never decides
this alone, the RPC's live-state check does); nothing back means the
episode was lost entirely this call.

No changes were needed to `complete_episode_notification_deliveries` by
either fix: it already finalizes an arbitrary claim-token-scoped list of
identities, so a combined win is finalized by passing both identities
(bound to the one `claim_token` the claim RPC wrote onto both rows) in a
single call.

**A residual, structurally-different case is not "fixed" by this, on
purpose.** If two invocations evaluate at genuinely different instants
straddling the reminder-eligibility boundary — one still believes the
reminder isn't due, the other believes it is — `claim_episode_notifications`
correctly prevents any false/duplicate report, but the two invocations can
still legitimately produce two separate deliveries: the earlier invocation
sends a real, standalone airtime push (it never asked for a reminder at
all), and the later invocation, finding airtime already taken, sends a
real, standalone reminder push. This is not a duplicate — the two pushes
are different types with different content triggers — and it's the exact
same "earlier airtime, later reminder" behavior the product already
guarantees when the two stages are minutes or hours apart (see "Two-stage
delivery" above), just compressed into two overlapping runs instead of two
separate ones. Forcing this into a single combined push would require
letting a later caller silently reassign a still-live, unsent claim away
from the invocation that currently owns it — undermining the exact
lease/ownership guarantee this fix relies on to prevent a real duplicate
send. See the "reminder-eligibility boundary" test in
`tests/notification-worker.test.js` for the concrete, asserted behavior.

### Delivery identity, per type

Every identity stays subscription-scoped and episode-scoped, extended with
notification type (`deliveryIdentity` in `episodeEligibility.js`,
unchanged in shape, just called with a different `notificationType`
argument):

```
{push_subscription_id}:{tmdb_show_id}:{season_number}:{episode_number}:{notification_type}
```

`notification_type` is one of `episode_airtime` or `episode_reminder` for
every new delivery. The legacy `episode_available` type is never written
by new code — see "Legacy delivery migration" below for what happens to
rows that already used it.

### Notification tags, per type

`episodeNotificationTag` (in `episodeEligibility.js`) now takes an optional
`notificationType` argument and folds it into the tag, so an airtime alert
and its later reminder never share an OS notification tag — without that,
the reminder would silently replace the airtime alert in Notification
Center instead of appearing as its own entry.

```
rerun-episode-airtime-{tmdbId}-s{season}e{episode}   (single-episode airtime)
rerun-episode-reminder-{tmdbId}-s{season}e{episode}  (single-episode reminder)
rerun-episode-airtime-{tmdbId}-batch                 (grouped airtime)
rerun-episode-reminder-{tmdbId}-batch                (grouped reminder)
```

Tags are always derived purely from `tmdbId`/season/episode/type — never a
timestamp or random value — so they stay stable and idempotent exactly like
before. The synthetic verification push (`api/notifications/verify.js`)
calls `episodeNotificationTag` with no `notificationType`, which keeps the
original untyped tag shape (`rerun-episode-{tmdbId}-s{season}e{episode}`)
— it was never a real automatic delivery and stays that way.

## Rollout safety: the airtime watermark

Introducing a brand-new `episode_airtime` identity is exactly the same
kind of risk the original Phase 2 activation watermark was built to avoid:
without a watermark of its own, every unwatched episode released since a
subscription's *original* Phase 2 activation — which could be days or
weeks in the past — would become airtime-eligible the instant this ships.

`push_subscriptions.airtime_notifications_enabled_at`
(`supabase/migrations/20260720080000_add_two_stage_episode_notifications.sql`)
is a second, independent watermark that solves this exactly the way
`automatic_notifications_enabled_at` already does for Phase 2 as a whole:

- **New/re-activated subscriptions:** `api/push/subscribe.js` initializes
  `airtime_notifications_enabled_at` to the *same* grace-backdated instant
  as `automatic_notifications_enabled_at` on a fresh activation — same
  30-minute `ACTIVATION_GRACE_WINDOW_MS`, same timestamp, computed once and
  reused for both columns. An already-activated row keeps its existing
  value on re-subscribe, exactly like the automatic watermark. Disabling
  notifications deletes the `push_subscriptions` row entirely (unchanged
  behavior), so a later re-enable is indistinguishable from a brand-new
  subscription — both watermarks reset together, preserving the existing
  no-backlog guarantee.
- **Subscriptions already active when this migration is applied:** the
  migration backfills `airtime_notifications_enabled_at` to
  `greatest(automatic_notifications_enabled_at, now() - interval '30
  minutes')` — a real timestamp computed in SQL at migration-apply time
  (not a hard-coded date in application code), evaluated once for the
  whole `UPDATE` statement so every pre-existing subscription gets the same
  rollout instant. `greatest(...)` guarantees the airtime watermark is
  never *more permissive* than the subscription's own original activation
  watermark, while still being close to "now" so days of accumulated
  backlog can never all become airtime-eligible at once.
- The worker (`api/notifications/run.js`) only ever considers an episode
  airtime-eligible if its release instant is strictly after this
  watermark — a direct reuse of `episodesSinceWatermark`, the exact same
  function the automatic watermark already used, just applied to the
  airtime candidate pool instead. A subscription row with a null airtime
  watermark (defensive fallback only — the migration backfills every
  active row) simply has an empty airtime candidate pool; its reminder
  stage is entirely unaffected.

Note this only ever *withholds* airtime alerts for old backlog — it never
withholds the reminder. An episode that aired long before the airtime
rollout still gets a reminder at the preferred hour if unwatched, exactly
as Phase 2 already behaved; it just never gets an airtime alert for
something that "aired" before airtime alerts existed.

## Legacy delivery migration: `episode_available` → `episode_reminder`

Before Phase 3, every automatic delivery used one shared identity,
`episode_available`. An episode already successfully delivered under that
system must never be resent as a "new" reminder once Phase 3 ships — so
the same migration
(`20260720080000_add_two_stage_episode_notifications.sql`) reclassifies
already-**delivered** `episode_available` rows in place:

```sql
update public.notification_deliveries
set
  notification_type = 'episode_reminder',
  identity = push_subscription_id || ':' || tmdb_show_id || ':' || season_number || ':' || episode_number || ':episode_reminder'
where notification_type = 'episode_available'
  and delivered_at is not null;
```

- Both the composite unique key (`push_subscription_id, tmdb_show_id,
  season_number, episode_number, notification_type`) and the
  manually-maintained `identity` text column encode `notification_type`, so
  both are rewritten together to stay consistent with what
  `claim_episode_notification_deliveries` builds server-side — a
  half-migrated row (new `identity`, stale `notification_type`, or vice
  versa) would silently break the dedup guarantee.
- `episode_reminder` never existed before this migration, so there is no
  possible unique-constraint conflict with an existing row — deterministic,
  no manual conflict resolution needed.
- Only **delivered** rows are touched. Undelivered/stale
  `episode_available` claims (an in-flight or abandoned claim from before
  this shipped) are left exactly as they were — a dead type going forward,
  but harmless: the composite unique key is scoped by `notification_type`,
  so a leftover `episode_available` row can never block or collide with a
  fresh `episode_airtime`/`episode_reminder` claim for the same episode.
- No `episode_airtime` rows are ever synthesized from legacy history — the
  airtime alert is a new opportunity Phase 2 never had, not something
  legacy single-notification delivery history can stand in for.

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
  season_number, episode_number, notification_type)` — this is exactly
  what makes `episode_airtime` and `episode_reminder` (Phase 3) claim and
  finalize completely independently of one another for the same episode,
  with no schema change needed: they're just two different values of the
  existing `notification_type` column.
- **Unchanged throughout:** `complete_episode_notification_deliveries` never
  needed any modification across Phase 3 or either cross-invocation fix — it
  was already generic over `notification_type` and a claim-token-scoped
  identity list, which is all either fix ever needed from it.
  `claim_episode_notification_deliveries` and
  `claim_episode_reminder_with_airtime_collision` are no longer called by
  `run.js` (superseded by `claim_episode_notifications`, see
  "Cross-invocation collision safety" above) but are left in the schema,
  unused and harmless, per this project's additive-only migration
  convention.
- **Claim before send:** `claim_episode_notifications(...)` is a
  `security definer` Postgres function (service-role only) that atomically
  inserts-or-conditionally-updates one row per requested identity, under an
  advisory lock shared by every claim of every type for that episode. A row
  is only returned to the caller (meaning "you own this claim, go ahead and
  send") if it didn't already exist with `delivered_at` set, an existing
  undelivered claim was stale, and — verified explicitly, not assumed — the
  row's `claim_token` actually ended up matching the caller's after the
  write. Two concurrent worker invocations racing on the same episode, for
  any combination of claim types, can never both win the same identity.
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
  "Deduplication" above);
- its **scheduled delivery instant** has arrived (see "Preferred delivery
  hour" below) — this is a *when to send* gate layered on top of the rules
  above, not an eligibility rule; it never turns an otherwise-ineligible
  episode eligible, and never re-applies the activation watermark to
  anything but the raw release instant.

See `src/lib/notifications/episodeEligibility.js` for the exact functions
(`collectAiredUnwatchedEpisodes`, `episodesSinceWatermark`,
`buildEpisodeNotificationPayload`).

## Preferred delivery hour

This section describes the **reminder** stage's scheduling (renamed from
"delivery" in Phase 2, since Phase 3 added a second, unscheduled stage —
see "Two-stage delivery" above). Each installation has one global preferred
reminder hour — Settings → Notifications → **Reminder time** (renamed from
"Notification time" in Phase 3), one of 6:00 PM through 11:00 PM IST
(default **8:00 PM**). It changes *when* an already-eligible reminder is
pushed, never *whether* it's eligible, and it has **no effect whatsoever**
on the airtime stage — airtime never waits for it.

- **Storage:** `push_subscriptions.preferred_notification_hour_ist`
  (`supabase/migrations/20260719170000_add_preferred_notification_hour.sql`)
  — an integer, `18` through `23`, `not null default 20`. Delivery targets
  are subscription-scoped, so this lives on `push_subscriptions` rather than
  a separate preferences table. Every existing subscription is backfilled to
  `20` by the column default; no other row is touched.
- **Scheduling rule** (`src/lib/notifications/deliverySchedule.js`,
  `scheduledDeliveryInstant`): for an episode whose release instant is
  `releaseInstant`, and a subscription's preferred hour `selectedHourIST`:
  1. Compute `selectedDeliveryInstant` — the preferred hour on the **same
     IST calendar date** `releaseInstant` falls on, using the same
     fixed-offset (UTC+5:30, no DST) IST conversion the rest of the release
     pipeline uses (`istDateISO` / `timestampFromISTDate` from
     `src/lib/networkReleaseTiming.js` — not `Intl.DateTimeFormat`, not
     `process.env.TZ`, not server local time).
  2. `scheduledDeliveryInstant = max(releaseInstant, selectedDeliveryInstant)`.
  3. An episode is sendable once the worker's evaluation instant reaches
     `scheduledDeliveryInstant`.
  - Released before the preferred hour (e.g. 9:30 AM, preferred 8 PM): held,
    sent on the first worker run at or after 8 PM IST that same day.
  - Released shortly before the preferred hour (e.g. 7:55 PM, preferred
    8 PM): sent on the first worker run at or after 8 PM IST.
  - Released after the preferred hour (e.g. 9:15 PM, preferred 8 PM): sent
    on the first worker run at or after 9:15 PM — **never** delayed to the
    next day.
- **Interaction with the activation watermark:** step 1 above always reads
  `releaseInstant`, never `scheduledDeliveryInstant`. `episodesSinceWatermark`
  keeps comparing against the raw release instant exactly as before, so a
  later preferred hour can never turn a pre-activation backlog episode
  eligible — it can only delay an already-eligible episode's send time.
- **Grouping stays per show, per sendable batch** (see "Notification
  content" below) — the preferred hour doesn't change how episodes are
  grouped, only which episodes are in the pool the worker groups from on a
  given run.
- **Client:** `POST /api/push/preferences` (`api/push/preferences.js`)
  updates the caller's own row, resolved by management-token hash — the
  same ownership proof `api/push/test.js` uses. It never accepts or returns
  a subscription endpoint or push keys, and never rotates the management
  token. Settings (`src/routes/Settings.jsx`) shows the value from the most
  recent server response (either `/api/push/subscribe`, which now also
  returns `preferredNotificationHourIst`, or a successful preferences save)
  cached locally (`src/lib/push/notificationPreference.js`) so it displays
  correctly without a dedicated read endpoint. A failed save reverts the
  selector to the previous value and shows a compact error — no fake
  success state.

## Notification content

Deliberately minimal — iOS supplies "from Rerun" on its own for the
installed PWA, so this payload never generates or duplicates that line.
**Identical for both delivery types** — an airtime alert and a reminder are
visually indistinguishable to the user, on purpose; only the internal
`notification_type` and the OS `tag` differ (see "Two-stage delivery"
above):

- **Title:** `${showName} - New Episode` (e.g. `House of the Dragon - New
  Episode`) — no season/episode number, episode title, episode count,
  release time, platform/network, or any mention of "Airtime"/"Reminder".
- **Body:** intentionally absent. There is no separate body line; the title
  is the entire visible content besides the OS-supplied "from Rerun".
- Multiple episodes of the same show becoming available in the same
  sendable batch (e.g. all 8 episodes of a season dropping together) still
  produce exactly **one** notification with this same minimal content, per
  type — see "One notification per show per delivery window" below.
- Tap target: `/watching/{tmdbShowId}` (the show-detail route) — always
  producible here since `tmdbShowId` is always a real positive integer;
  `episodeNotificationUrl` falls back to `/watching` only as a defensive
  guard, never actually reached in the real worker.
- `tag`: stable per show *and* delivery type — see "Notification tags, per
  type" above for the exact shapes.

The payload also carries `omitBody: true` — a marker that distinguishes
"this push is intentionally bodyless" from a malformed/legacy payload that
merely happens to be missing a body. `public/push-sw.js` only shows its
generic fallback body ("You have a new notification.") in the latter case;
when `omitBody` is set, the notification shows no body at all instead of
substituting the fallback text.

Sample real-worker payloads (as sent to `web-push`, before the OS renders
the app-supplied "from Rerun" line above them) — an airtime alert and a
later reminder for the same batch, content identical apart from `tag`:

```json
{ "title": "The Bear - New Episode", "url": "/watching/1", "tag": "rerun-episode-airtime-1-batch", "omitBody": true }
{ "title": "The Bear - New Episode", "url": "/watching/1", "tag": "rerun-episode-reminder-1-batch", "omitBody": true }
```

## One notification per show per delivery window

At one worker evaluation, every currently-sendable, unnotified episode for a
given show and subscription is grouped into **one** push — whether that's 1
episode or 8. All of the grouped episodes' delivery identities are still
claimed and finalized individually (see "Deduplication & delivery" above),
so:

- a later worker run never re-sends for an episode already covered by an
  earlier group's push;
- if a *further* episode of the same show becomes available later the same
  day, **after** an earlier notification for that show already went out,
  the worker sends a **new**, separate notification for it — grouping is
  per currently-sendable batch, not a once-per-show-per-calendar-day rule.

Three different shows with new episodes in the same window still get three
separate notifications — episodes are never combined across shows into one
summary push.

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
   `20260719150000_schedule_episode_notification_worker.sql`,
   `20260719160000_add_complete_episode_notification_deliveries.sql`,
   `20260719170000_add_preferred_notification_hour.sql`,
   `20260720080000_add_two_stage_episode_notifications.sql`,
   `20260720090000_add_collision_safe_reminder_claim.sql`, and
   `20260720110000_add_unified_episode_notification_claim.sql` in the
   Supabase SQL Editor. The scheduling migration is safe to run even before
   the Vault secrets above exist — the job just fails (harmlessly, into
   Cron's own run history) until they're set. The 17:00:00 and 08:00:00
   migrations are both additive and safe to apply exactly once in
   production (`add column if not exists`, idempotent backfill `update`s
   scoped by `is null`/specific `notification_type` values) — neither
   recreates or reschedules the Cron job, and the 08:00:00 migration is
   forward-only: see "Rollout safety" and "Legacy delivery migration" above
   for exactly what it backfills and why. The 09:00:00 and 11:00:00
   migrations each only add a new function — they touch no existing rows
   and are safe to apply exactly once, in either order relative to each
   other or to a running worker (the worker simply starts using
   `claim_episode_notifications` as soon as it's deployed and the function
   exists; until then it keeps using whichever claim RPCs are already
   live).
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
by Settings) — and shares that same 30-second resend throttle.

Settings → Notifications has a **Verify automatic episode alert** button
(next to "Send test notification") that reads the stored `managementToken`
and calls this endpoint directly on-device — no need to extract the token
from the iPhone PWA's `localStorage` by hand. The endpoint can still be
triggered manually from any machine (the token, not the request origin, is
what's checked), which is useful off-device:

```sh
curl -X POST https://rerun-nine.vercel.app/api/notifications/verify \
  -H "Content-Type: application/json" \
  -d '{"managementToken": "<paste from your browser devtools / localStorage>"}'
```

Steps:

1. Merge and deploy this branch, and apply every migration listed under
   "Setup" above (including `20260720080000_add_two_stage_episode_notifications.sql`)
   if it hasn't already been applied.
2. Open the installed iPhone Home Screen PWA. Enable notifications (Phase 1
   flow, unchanged) if not already enabled.
3. Go to Settings → Notifications. Confirm **Reminder time** (renamed from
   "Notification time") shows the expected value (8:00 PM by default, or
   whatever was last saved), that the new supporting copy about airtime vs.
   reminder alerts is visible, and that changing the value shows a brief
   "Saving…" state, then reflects the new value.
4. Tap **Verify automatic episode alert** (or run the `curl` above with the
   `managementToken` value read from that installation's `localStorage` key
   `rerun:push:managementToken`).
5. Background Rerun on the iPhone.
6. Confirm delivery: "from Rerun" (supplied by iOS from the installed app,
   not the payload) above the title "Rerun Verification - New Episode",
   with no separate body line — the same minimal content shape a real
   episode notification uses, kept visibly distinct only by the title
   staying "Rerun Verification" instead of a real show name.
7. Tap the notification — it opens `/watching` (a synthetic show has no
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
filtering, specials exclusion, watched-episode exclusion, claim/dedup
including a simulated concurrent-claim race and a same-time worker rerun,
transient-failure isolation (including for a multi-episode grouped batch),
404/410 stale-subscription removal, per-show and per-subscription failure
isolation, malformed subscription rows, worker-secret auth and method
rejection, sanitized error responses, dry run (including determinism across
repeated calls), the Phase 1 manual test push (unchanged, still passing),
and PWA precache/update-lifecycle tests (unchanged, still passing).

Added by this feature: the IST scheduling calculation
(`src/lib/notifications/deliverySchedule.js`) across the release-before/
at/after-preferred-hour cases and the UTC/IST calendar-day boundary; the
scheduling gate combined with the activation watermark at the worker level
(a delayed schedule never resurrects pre-activation backlog); minimal
notification content (title `${showName} - New Episode`, intentionally no
body, no episode metadata, verified for both a single episode and an
8-episode batch); the service worker's `omitBody` marker (an intentionally
bodyless automatic episode push shows no body, while a malformed/legacy
payload without the marker still gets the generic fallback body);
one-notification-per-show grouping across 1, 8, and 3-simultaneous-
show scenarios, with every grouped episode identity claimed and finalized;
a later episode from an already-notified show still notifying separately;
`api/push/preferences.js` validation (18-23 accepted, 17/24/non-integer/
missing rejected, ownership by management-token hash, no token rotation, no
endpoint/keys in the response); and the Settings selector (default display,
exactly six options, save-on-select, pending state, revert-on-failure,
existing enable/disable/test/verify flows unchanged).

Real push delivery, Lock Screen/Notification Center rendering, backgrounded-
app delivery, and the native `<select>`'s on-device wheel-picker rendering
still require the physical-device checklist above — no automated suite can
cover those.

**Added by Phase 3 (two-stage delivery)**, primarily in
`tests/notification-worker.test.js`,
`src/lib/notifications/episodeEligibility.test.js`,
`tests/two-stage-episode-notifications-migration.test.js`, and
`api/push/subscribe.test.js`: airtime eligibility on the first evaluation
after release and never before; the preferred hour never delaying airtime;
`episode_airtime` identity and its distinct stable tag; no resend on a
repeated run; one airtime push per show for a multi-episode batch and
separate pushes per show across multiple shows; the reminder stage's
existing preferred-hour scheduling unaffected by airtime; watched-before-
reminder exclusion (including a partially-watched batch); the
same-evaluation collision (one push, not two, for a late release) with the
reminder identity durably satisfied in the same run; a failed airtime send
finalizing neither type; a failed combined finalize (push already sent)
surfacing as `failed`, not credited as `sent`, and leaving both identities
retryable; the airtime rollout watermark (no retroactive alert for
pre-rollout backlog, still-correct grace-window boundary behavior, backlog
episodes still reminding normally); dry-run previews carrying
`notificationType` per entry; both payload types sharing identical visible
content with only the tag differing; the two-stage migration file's exact
rollout-backfill and legacy-reclassification SQL; and
`api/push/subscribe.js` initializing/preserving both watermarks together
across fresh activation, re-subscribe, and disable-then-re-enable.

**Added by the first cross-invocation collision fix**, in
`tests/notification-worker.test.js` (`notification worker: cross-invocation
collision race`) and `tests/collision-safe-reminder-claim-migration.test.js`:
two genuinely concurrent worker invocations (one deliberately paused
mid-flight after its claim commits but before it sends, using a controllable
gate + a shared, lease-aware in-memory store standing in for
`notification_deliveries`, rather than a plain "delivered or not" flag)
racing the same airtime+reminder collision — the losing invocation sends
nothing, exactly one push goes out in total, and both delivery identities
finalize together in one call; a failed send while a second invocation was
mid-race finalizes neither identity and both remain retryable after the
lease window; and a reminder due after airtime already delivered on an
earlier, separate run still sends for real (as a standalone reminder, not
folded into airtime) even when two invocations race that later claim.

**Added by the second cross-invocation fix (the cross-path race)**, in the
same `notification worker: cross-invocation collision race` block and
`tests/unified-episode-notification-claim-migration.test.js`: the test
double's claim handler was rewritten to a single function mirroring
`claim_episode_notifications` exactly (one shared shape for airtime-only,
reminder-only, and combined requests, rather than two separate handlers for
two separate former RPCs), since a test double with two different handlers
could no longer even represent the bug this fix closes. Two new scenarios:
an invocation racing right at the reminder-eligibility boundary (one worker
requesting airtime-only, the other requesting combined, for the same
episode) never produces a false combined report or a duplicate
airtime-flavored push — airtime and reminder each deliver exactly once,
under their own claim, finalized in two separate single-identity calls, not
one phantom two-identity call; and a claim RPC error for one worker sends
nothing and reports failed without disturbing a second, independently
successful worker's legitimate claim. The migration test asserts the new
function's signature, that every request shape computes the identical
advisory lock key (a single `lock_key := hashtextextended(...)` expression
in the whole function, not one per claim type), the reminder/airtime
freedom checks and the shared 10-minute lease window, that a win is only
ever reported after reading the row back and confirming `claim_token`
ownership (never merely because an `INSERT` ran), and that it leaves
`complete_episode_notification_deliveries` and the two superseded RPCs
untouched.

Real concurrent Vercel Cron invocations, and Postgres's actual
`pg_advisory_xact_lock` behavior under real concurrent connections, are not
something a Vitest suite can exercise directly — the tests above verify the
worker's use of the RPC's contract and the RPC's SQL shape, not genuine
multi-connection Postgres concurrency itself. In particular, the
"reminder-eligibility boundary" test's two legitimate, non-duplicate pushes
(see the residual-case note under "Cross-invocation collision safety"
above) reflect an intentional design tradeoff, not a gap the test suite is
merely failing to catch.
