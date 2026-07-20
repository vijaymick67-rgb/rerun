import webpush from 'web-push'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createSupabaseAdmin } from '../push/_supabaseAdmin.js'
import { createTmdbServerClient } from './_tmdbServer.js'
import { createTvmazeServerClient } from './_tvmazeServer.js'
import { fetchWatchedEpisodes } from '../../src/lib/watchedEpisodes.js'
import { loadWatchingShowData, selectTrackedShowsForWatching } from '../../src/lib/watchingShows.js'
import { episodeKey } from '../../src/lib/watchHelpers.js'
import {
  buildEpisodeNotificationPayload,
  collectAiredUnwatchedEpisodes,
  deliveryIdentity,
  episodesSinceWatermark,
  EPISODE_AIRTIME_NOTIFICATION_TYPE,
  EPISODE_REMINDER_NOTIFICATION_TYPE,
} from '../../src/lib/notifications/episodeEligibility.js'
import { DEFAULT_PREFERRED_HOUR_IST, isSendableNow } from '../../src/lib/notifications/deliverySchedule.js'

export const config = { runtime: 'nodejs' }

// Bounded parallelism for per-show TMDB/TVmaze fetching — a personal tracker
// realistically has a handful to a few dozen tracked shows, but this keeps a
// pathological tracked-show count from opening dozens of simultaneous
// requests against TMDB/TVmaze in one worker tick.
const DEFAULT_CONCURRENCY = 4

function json(res, status, body) {
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.json(body)
}

function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function extractBearerToken(req) {
  const header = req.headers?.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer (.+)$/.exec(header)
  return match ? match[1] : null
}

function isWellFormedSubscriptionRow(row) {
  return Boolean(
    row &&
      Number.isFinite(row.id) &&
      typeof row.endpoint === 'string' && row.endpoint.length > 0 &&
      typeof row.p256dh === 'string' && row.p256dh.length > 0 &&
      typeof row.auth === 'string' && row.auth.length > 0 &&
      typeof row.automatic_notifications_enabled_at === 'string' &&
      Number.isFinite(new Date(row.automatic_notifications_enabled_at).getTime()),
  )
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const current = cursor++
      results[current] = await fn(items[current], current)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

export function createNotificationWorkerHandler({
  env = process.env,
  supabase,
  sendNotification = (subscription, payload) => webpush.sendNotification(subscription, payload),
  setVapidDetails = (...args) => webpush.setVapidDetails(...args),
  now = () => new Date(),
  createTmdbClient = createTmdbServerClient,
  createTvmazeClient = createTvmazeServerClient,
  fetchImpl = fetch,
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  return async function notificationWorkerHandler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      json(res, 405, { error: 'Method not allowed' })
      return
    }

    const secret = env.NOTIFICATION_WORKER_SECRET
    if (!secret) {
      json(res, 500, { error: 'Notification worker is not configured' })
      return
    }
    if (!timingSafeEqualStrings(extractBearerToken(req), secret)) {
      json(res, 401, { error: 'Unauthorized' })
      return
    }

    const publicKey = env.VITE_VAPID_PUBLIC_KEY
    const privateKey = env.VAPID_PRIVATE_KEY
    const subject = env.VAPID_SUBJECT
    const tmdbApiKey = env.TMDB_API_KEY
    if (!publicKey || !privateKey || !subject || !tmdbApiKey) {
      json(res, 500, { error: 'Push notifications are not configured' })
      return
    }

    let client
    try {
      client = supabase ?? createSupabaseAdmin(env)
    } catch {
      json(res, 500, { error: 'Push notifications are not configured' })
      return
    }

    // Dry run is entirely read-only: it never calls a claim RPC (which
    // writes) and never calls sendNotification, so it can be re-run any
    // number of times locally without creating delivery records or sending
    // real pushes — see docs/automatic-episode-notifications.md.
    const dryRun = req.body?.dryRun === true
    if (!dryRun) setVapidDetails(subject, publicKey, privateKey)

    const evaluationInstant = now()
    const evaluationMs = evaluationInstant.getTime()
    const summary = { checkedShows: 0, eligibleEpisodes: 0, sent: 0, skipped: 0, staleRemoved: 0, failed: 0 }
    const preview = dryRun ? [] : undefined

    // Claims a batch of one show's episodes under one notification type for
    // one subscription. Returns null (and bumps summary.skipped/failed as
    // appropriate) when nothing was actually won — either every identity was
    // already claimed/delivered elsewhere, or the claim RPC itself errored.
    // Only ever used for episodes that are *not* reminder-due this run — an
    // episode whose reminder is also due always goes through
    // claimReminderWithCollision below instead, so this can never race a
    // concurrent invocation over the same identity pair.
    async function claimEpisodes(subscription, tmdbShowId, episodes, notificationType) {
      const claimToken = randomUUID()
      const { data: claimedRows, error: claimError } = await client.rpc(
        'claim_episode_notification_deliveries',
        {
          p_push_subscription_id: subscription.id,
          p_tmdb_show_id: tmdbShowId,
          p_episodes: episodes.map((episode) => ({
            season_number: episode.seasonNumber,
            episode_number: episode.episodeNumber,
            notification_type: notificationType,
          })),
          p_claim_token: claimToken,
          p_claimed_at: evaluationInstant.toISOString(),
        },
      )
      if (claimError) {
        summary.failed += 1
        console.error('notification_worker_claim_failed', { tmdbShowId, notificationType, message: claimError.message })
        return null
      }
      const claimedKeys = new Set(
        (claimedRows ?? []).map((row) => episodeKey(row.season_number, row.episode_number)),
      )
      const claimedEpisodes = episodes.filter(
        (episode) => claimedKeys.has(episodeKey(episode.seasonNumber, episode.episodeNumber)),
      )
      summary.skipped += episodes.length - claimedEpisodes.length
      if (claimedEpisodes.length === 0) return null
      return { claimToken, episodes: claimedEpisodes }
    }

    // Every episode whose reminder is due this run — whether or not it also
    // looks airtime-due — goes through this single RPC instead of a plain
    // claim. See
    // supabase/migrations/20260720090000_add_collision_safe_reminder_claim.sql
    // for why: two overlapping worker invocations evaluating the same
    // subscription/show/episode at once must never be able to split
    // ownership of an airtime+reminder pair between them (one sending
    // airtime, the other independently sending the "collision" reminder).
    // The database, not this process, is the one place both invocations
    // actually share, so it's the only place that decision can be made
    // atomically. `episodes` here each carry `airtimeAlsoDue` — a pure,
    // time-based fact this worker already knows; the RPC itself checks live
    // delivery state to decide whether airtime is genuinely still winnable
    // too (never merely time-eligible), which is what correctly routes an
    // episode whose airtime already went out on an earlier, separate run
    // through the plain reminder-only path here rather than a phantom
    // "collision".
    async function claimReminderWithCollision(subscription, tmdbShowId, episodes) {
      const claimToken = randomUUID()
      const { data: rows, error } = await client.rpc(
        'claim_episode_reminder_with_airtime_collision',
        {
          p_push_subscription_id: subscription.id,
          p_tmdb_show_id: tmdbShowId,
          p_episodes: episodes.map((episode) => ({
            season_number: episode.seasonNumber,
            episode_number: episode.episodeNumber,
            airtime_also_due: episode.airtimeAlsoDue,
          })),
          p_claim_token: claimToken,
          p_claimed_at: evaluationInstant.toISOString(),
        },
      )
      if (error) {
        summary.failed += 1
        console.error('notification_worker_collision_claim_failed', { tmdbShowId, message: error.message })
        return { claimToken, combined: [], reminderOnly: [] }
      }
      const byKey = new Map(
        episodes.map((episode) => [episodeKey(episode.seasonNumber, episode.episodeNumber), episode]),
      )
      const combined = []
      const reminderOnly = []
      for (const row of rows ?? []) {
        const episode = byKey.get(episodeKey(row.season_number, row.episode_number))
        if (!episode) continue
        if (row.combined) combined.push(episode)
        else reminderOnly.push(episode)
      }
      summary.skipped += episodes.length - combined.length - reminderOnly.length
      return { claimToken, combined, reminderOnly }
    }

    // Finalizes exactly the identities this claim_token owns — see
    // supabase/migrations/20260719160000_add_complete_episode_notification_deliveries.sql
    // for why this must be claim-token-scoped rather than a plain
    // identity-only update.
    async function finalizeIdentities(tmdbShowId, notificationTypeLabel, claimToken, identities) {
      const { data: finalizedRows, error: finalizeError } = await client.rpc(
        'complete_episode_notification_deliveries',
        {
          p_claim_token: claimToken,
          p_identities: identities,
          p_delivered_at: evaluationInstant.toISOString(),
        },
      )
      if (finalizeError || (finalizedRows ?? []).length !== identities.length) {
        summary.failed += 1
        console.error('notification_worker_finalize_mismatch', {
          tmdbShowId,
          notificationType: notificationTypeLabel,
          expected: identities.length,
          finalized: (finalizedRows ?? []).length,
          message: finalizeError?.message,
        })
        return false
      }
      return true
    }

    async function finalizeEpisodes(subscription, tmdbShowId, claimToken, episodes, notificationType) {
      const identities = episodes.map((episode) => deliveryIdentity(
        subscription.id, tmdbShowId, episode.seasonNumber, episode.episodeNumber, notificationType,
      ))
      return finalizeIdentities(tmdbShowId, notificationType, claimToken, identities)
    }

    // Sends one push for an already-claimed batch. Returns 'ok', 'failed', or
    // 'removed' (subscription was gone — 404/410 from the push service,
    // already deleted). Never finalizes — callers finalize only after this
    // returns 'ok', so a send failure can never leave a partially-finalized
    // claim.
    async function pushPayload(subscription, payload) {
      const target = { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }
      try {
        await sendNotification(target, JSON.stringify({
          title: payload.title, url: payload.url, tag: payload.tag, omitBody: payload.omitBody,
        }))
      } catch (err) {
        const statusCode = err?.statusCode
        if (statusCode === 404 || statusCode === 410) {
          await client.from('push_subscriptions').delete().eq('id', subscription.id)
          summary.staleRemoved += 1
          return 'removed'
        }
        summary.failed += 1
        console.error('notification_worker_send_failed', { statusCode, message: err?.message })
        return 'failed'
      }
      return 'ok'
    }

    // Sends + finalizes a single-type claim (airtime-only, or reminder-only).
    // Only a 'sent' outcome (push accepted *and* the finalize RPC durably
    // confirmed every claimed identity) counts as a real delivery — a send
    // that succeeds but fails to finalize is 'failed'.
    async function sendClaim(subscription, tmdbShowId, showName, claimToken, episodes, notificationType) {
      const payload = buildEpisodeNotificationPayload(tmdbShowId, showName, episodes, notificationType)
      const outcome = await pushPayload(subscription, payload)
      if (outcome !== 'ok') return outcome
      const finalized = await finalizeEpisodes(subscription, tmdbShowId, claimToken, episodes, notificationType)
      if (!finalized) return 'failed'
      summary.sent += 1
      return 'sent'
    }

    // Sends one push for a batch of episodes whose airtime and reminder were
    // reserved *together* by claimReminderWithCollision (row.combined ===
    // true). Content is identical to an airtime alert (per spec: "send only
    // the airtime alert"), but a single successful send finalizes *both*
    // delivery identities in one call — the reminder is satisfied without a
    // second push. A failed send, or a failed finalize, leaves both
    // identities exactly as unfinalized/reclaimable as sendClaim's contract.
    async function sendCombinedClaim(subscription, tmdbShowId, showName, claimToken, episodes) {
      const payload = buildEpisodeNotificationPayload(tmdbShowId, showName, episodes, EPISODE_AIRTIME_NOTIFICATION_TYPE)
      const outcome = await pushPayload(subscription, payload)
      if (outcome !== 'ok') return outcome
      const identities = episodes.flatMap((episode) => [
        deliveryIdentity(subscription.id, tmdbShowId, episode.seasonNumber, episode.episodeNumber, EPISODE_AIRTIME_NOTIFICATION_TYPE),
        deliveryIdentity(subscription.id, tmdbShowId, episode.seasonNumber, episode.episodeNumber, EPISODE_REMINDER_NOTIFICATION_TYPE),
      ])
      const finalized = await finalizeIdentities(tmdbShowId, 'episode_airtime+episode_reminder', claimToken, identities)
      if (!finalized) return 'failed'
      summary.sent += 1
      return 'sent'
    }

    try {
      const { data: subscriptionRows, error: subsError } = await client
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth, automatic_notifications_enabled_at, airtime_notifications_enabled_at, preferred_notification_hour_ist')
        .not('automatic_notifications_enabled_at', 'is', null)
      if (subsError) throw subsError

      const subscriptions = []
      for (const row of subscriptionRows ?? []) {
        if (isWellFormedSubscriptionRow(row)) {
          subscriptions.push(row)
        } else {
          console.warn('notification_worker_malformed_subscription', { id: row?.id })
        }
      }

      if (subscriptions.length === 0) {
        json(res, 200, dryRun ? { ...summary, preview } : summary)
        return
      }

      const { data: trackedShows, error: showsError } = await client.from('tracked_shows').select('*')
      if (showsError) throw showsError

      const tmdbShowIds = (trackedShows ?? []).map((show) => show.tmdb_id)
      const watchedRows = tmdbShowIds.length
        ? await fetchWatchedEpisodes(client, 'tmdb_show_id, season_number, episode_number', tmdbShowIds)
        : []
      const watchedByShowId = new Map()
      for (const row of watchedRows) {
        if (!watchedByShowId.has(row.tmdb_show_id)) watchedByShowId.set(row.tmdb_show_id, new Set())
        watchedByShowId.get(row.tmdb_show_id).add(episodeKey(row.season_number, row.episode_number))
      }

      const tmdbClient = createTmdbClient({ apiKey: tmdbApiKey, fetchImpl })
      const tvmazeClient = createTvmazeClient({ fetchImpl })
      const getShowReleaseMap = (tmdbId) =>
        tvmazeClient.getShowReleaseMap(tmdbId, { getExternalIds: tmdbClient.getExternalIds })

      const { candidates, preloadedById, failures: selectFailures } = await selectTrackedShowsForWatching(
        trackedShows ?? [], tmdbClient.getShowDetails, getShowReleaseMap,
      )
      summary.checkedShows = candidates.length
      for (const failure of selectFailures ?? []) {
        console.warn('notification_worker_show_select_failed', { code: failure.code, tmdbShowId: failure.tmdbShowId })
      }

      // Computed once and shared across every subscription below — the
      // release/watched data behind eligibility doesn't vary per
      // subscription, only the two activation/rollout watermarks and the
      // claim/dedup step vary per subscription. This is what keeps
      // TMDB/TVmaze call volume flat regardless of how many installs are
      // subscribed. Note this pool is intentionally *not* watermark-filtered
      // — it's every already-aired, unwatched episode; each subscription
      // below applies its own airtime and reminder watermarks/schedules on
      // top of it independently.
      const showPool = new Map()
      await mapWithConcurrency(candidates, concurrency, async (show) => {
        try {
          const watched = watchedByShowId.get(show.tmdb_id) ?? new Set()
          const loaded = await loadWatchingShowData(show, watched, preloadedById.get(show.tmdb_id), {
            getShowDetails: tmdbClient.getShowDetails,
            getSeasonEpisodes: tmdbClient.getSeasonEpisodes,
            getShowReleaseMap,
          })
          const eligible = collectAiredUnwatchedEpisodes({
            show, status: loaded.status, episodesBySeason: loaded.episodesBySeason, watched, evaluationTime: evaluationMs,
          })
          if (eligible.length > 0) showPool.set(show.tmdb_id, { showName: show.name, episodes: eligible })
        } catch (err) {
          summary.failed += 1
          console.error('notification_worker_show_failed', { tmdbShowId: show.tmdb_id, message: err?.message })
        }
      })

      for (const subscription of subscriptions) {
        try {
          const automaticWatermarkMs = new Date(subscription.automatic_notifications_enabled_at).getTime()
          const airtimeWatermarkMs = subscription.airtime_notifications_enabled_at
            ? new Date(subscription.airtime_notifications_enabled_at).getTime()
            : null
          // Falls back to the product default for a row the DB migration
          // hasn't backfilled yet (or a test double that omits the column) —
          // the column itself is `not null default 20`, so this is only ever
          // a defensive fallback, never the primary source of the value.
          const preferredHourIst = Number.isInteger(subscription.preferred_notification_hour_ist)
            ? subscription.preferred_notification_hour_ist
            : DEFAULT_PREFERRED_HOUR_IST

          // Pass 1: for every show with a candidate under either stage,
          // split airtime candidates into "reminder isn't due yet" (claimed
          // immediately, the same uncontested plain claim as before this
          // migration — no collision is possible) and everything else. Every
          // reminder-due episode — whether or not it also looks airtime-due
          // — is claimed via claimReminderWithCollision, which is what makes
          // the combined/reminder-only decision atomic and DB-coordinated
          // rather than something this process decides on its own.
          const airtimeClaims = []
          const combinedClaims = []
          const reminderOnlyClaims = []
          for (const [tmdbShowId, entry] of showPool) {
            const airtimeCandidates = Number.isFinite(airtimeWatermarkMs)
              ? episodesSinceWatermark(entry.episodes, airtimeWatermarkMs)
              : []
            const reminderCandidates = episodesSinceWatermark(entry.episodes, automaticWatermarkMs)
              .filter((episode) => isSendableNow(episode.releaseTimestamp, preferredHourIst, evaluationMs))

            if (airtimeCandidates.length === 0 && reminderCandidates.length === 0) continue
            summary.eligibleEpisodes += airtimeCandidates.length + reminderCandidates.length

            if (dryRun) {
              if (airtimeCandidates.length > 0) {
                const payload = buildEpisodeNotificationPayload(
                  tmdbShowId, entry.showName, airtimeCandidates, EPISODE_AIRTIME_NOTIFICATION_TYPE,
                )
                preview.push({
                  tmdbShowId, title: payload.title, episodeCount: airtimeCandidates.length,
                  notificationType: EPISODE_AIRTIME_NOTIFICATION_TYPE,
                })
              }
              if (reminderCandidates.length > 0) {
                const payload = buildEpisodeNotificationPayload(
                  tmdbShowId, entry.showName, reminderCandidates, EPISODE_REMINDER_NOTIFICATION_TYPE,
                )
                preview.push({
                  tmdbShowId, title: payload.title, episodeCount: reminderCandidates.length,
                  notificationType: EPISODE_REMINDER_NOTIFICATION_TYPE,
                })
              }
              continue
            }

            const airtimeKeys = new Set(
              airtimeCandidates.map((episode) => episodeKey(episode.seasonNumber, episode.episodeNumber)),
            )
            const reminderKeys = new Set(
              reminderCandidates.map((episode) => episodeKey(episode.seasonNumber, episode.episodeNumber)),
            )
            const airtimeOnlyCandidates = airtimeCandidates.filter(
              (episode) => !reminderKeys.has(episodeKey(episode.seasonNumber, episode.episodeNumber)),
            )

            if (airtimeOnlyCandidates.length > 0) {
              const claimed = await claimEpisodes(subscription, tmdbShowId, airtimeOnlyCandidates, EPISODE_AIRTIME_NOTIFICATION_TYPE)
              if (claimed) airtimeClaims.push({ tmdbShowId, showName: entry.showName, ...claimed })
            }

            if (reminderCandidates.length > 0) {
              const episodesWithFlag = reminderCandidates.map((episode) => ({
                ...episode,
                airtimeAlsoDue: airtimeKeys.has(episodeKey(episode.seasonNumber, episode.episodeNumber)),
              }))
              const { claimToken, combined, reminderOnly } = await claimReminderWithCollision(
                subscription, tmdbShowId, episodesWithFlag,
              )
              if (combined.length > 0) {
                combinedClaims.push({ tmdbShowId, showName: entry.showName, claimToken, episodes: combined })
              }
              if (reminderOnly.length > 0) {
                reminderOnlyClaims.push({ tmdbShowId, showName: entry.showName, claimToken, episodes: reminderOnly })
              }
            }
          }

          if (dryRun) continue

          // Pass 2: airtime-only sends. A stale-subscription removal stops
          // this subscription's run entirely — nothing left to send to.
          let subscriptionRemoved = false
          for (const claim of airtimeClaims) {
            const outcome = await sendClaim(
              subscription, claim.tmdbShowId, claim.showName, claim.claimToken, claim.episodes, EPISODE_AIRTIME_NOTIFICATION_TYPE,
            )
            if (outcome === 'removed') { subscriptionRemoved = true; break }
          }
          if (subscriptionRemoved) continue

          // Pass 3: combined (same-evaluation collision) sends — one push,
          // both identities finalized together.
          for (const claim of combinedClaims) {
            const outcome = await sendCombinedClaim(
              subscription, claim.tmdbShowId, claim.showName, claim.claimToken, claim.episodes,
            )
            if (outcome === 'removed') { subscriptionRemoved = true; break }
          }
          if (subscriptionRemoved) continue

          // Pass 4: standalone reminder sends — episodes whose reminder is
          // due but whose airtime either isn't due this run or was already
          // delivered on an earlier run.
          for (const claim of reminderOnlyClaims) {
            const outcome = await sendClaim(
              subscription, claim.tmdbShowId, claim.showName, claim.claimToken, claim.episodes, EPISODE_REMINDER_NOTIFICATION_TYPE,
            )
            if (outcome === 'removed') break
          }
        } catch (err) {
          summary.failed += 1
          console.error('notification_worker_subscription_failed', { subscriptionId: subscription?.id, message: err?.message })
        }
      }

      json(res, 200, dryRun ? { ...summary, preview } : summary)
    } catch (err) {
      console.error('notification_worker_run_failed', { message: err?.message })
      json(res, 500, { error: 'Notification worker run failed' })
    }
  }
}

export default createNotificationWorkerHandler()
