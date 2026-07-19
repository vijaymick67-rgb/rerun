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
  EPISODE_NOTIFICATION_TYPE,
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

    // Dry run is entirely read-only: it never calls the claim RPC (which
    // writes) and never calls sendNotification, so it can be re-run any
    // number of times locally without creating delivery records or sending
    // real pushes — see docs/automatic-episode-notifications.md.
    const dryRun = req.body?.dryRun === true
    if (!dryRun) setVapidDetails(subject, publicKey, privateKey)

    const evaluationInstant = now()
    const evaluationMs = evaluationInstant.getTime()
    const summary = { checkedShows: 0, eligibleEpisodes: 0, sent: 0, skipped: 0, staleRemoved: 0, failed: 0 }
    const preview = dryRun ? [] : undefined

    try {
      const { data: subscriptionRows, error: subsError } = await client
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth, automatic_notifications_enabled_at, preferred_notification_hour_ist')
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
      // subscription, only the activation watermark and dedup claim do. This
      // is what keeps TMDB/TVmaze call volume flat regardless of how many
      // installs are subscribed.
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
          const watermarkMs = new Date(subscription.automatic_notifications_enabled_at).getTime()
          // Falls back to the product default for a row the DB migration
          // hasn't backfilled yet (or a test double that omits the column) —
          // the column itself is `not null default 20`, so this is only ever
          // a defensive fallback, never the primary source of the value.
          const preferredHourIst = Number.isInteger(subscription.preferred_notification_hour_ist)
            ? subscription.preferred_notification_hour_ist
            : DEFAULT_PREFERRED_HOUR_IST

          const claims = []
          for (const [tmdbShowId, entry] of showPool) {
            const sinceWatermark = episodesSinceWatermark(entry.episodes, watermarkMs)
            if (sinceWatermark.length === 0) continue

            // Activation watermark and every eligibility rule above already
            // apply to each episode's raw release instant, not this
            // schedule — this filter only ever delays *when* an
            // already-eligible episode is sent, never turns a
            // pre-activation episode eligible. An episode whose scheduled
            // instant hasn't arrived yet simply isn't claimed this run; it
            // stays in showPool/sinceWatermark for a later run once its
            // scheduled instant passes.
            const sendable = sinceWatermark.filter((episode) =>
              isSendableNow(episode.releaseTimestamp, preferredHourIst, evaluationMs))
            if (sendable.length === 0) continue
            summary.eligibleEpisodes += sendable.length

            if (dryRun) {
              const payload = buildEpisodeNotificationPayload(tmdbShowId, entry.showName, sendable)
              preview.push({ tmdbShowId, title: payload.title, episodeCount: sendable.length })
              continue
            }

            const claimToken = randomUUID()
            const { data: claimedRows, error: claimError } = await client.rpc(
              'claim_episode_notification_deliveries',
              {
                p_push_subscription_id: subscription.id,
                p_tmdb_show_id: tmdbShowId,
                p_episodes: sendable.map((episode) => ({
                  season_number: episode.seasonNumber,
                  episode_number: episode.episodeNumber,
                  notification_type: EPISODE_NOTIFICATION_TYPE,
                })),
                p_claim_token: claimToken,
                p_claimed_at: evaluationInstant.toISOString(),
              },
            )
            if (claimError) {
              summary.failed += 1
              console.error('notification_worker_claim_failed', { tmdbShowId, message: claimError.message })
              continue
            }

            const claimedKeys = new Set(
              (claimedRows ?? []).map((row) => episodeKey(row.season_number, row.episode_number)),
            )
            const claimedEpisodes = sendable.filter(
              (episode) => claimedKeys.has(episodeKey(episode.seasonNumber, episode.episodeNumber)),
            )
            summary.skipped += sendable.length - claimedEpisodes.length
            if (claimedEpisodes.length > 0) {
              claims.push({ tmdbShowId, showName: entry.showName, episodes: claimedEpisodes, claimToken })
            }
          }

          if (dryRun) continue

          for (const claim of claims) {
            const payload = buildEpisodeNotificationPayload(claim.tmdbShowId, claim.showName, claim.episodes)
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
                break
              }
              summary.failed += 1
              console.error('notification_worker_send_failed', { statusCode, message: err?.message })
              continue
            }

            // Web Push confirmed acceptance — now durably finalize, but only
            // the rows this exact claim owns. A plain unscoped update here
            // would let a database-write failure report as "sent" while the
            // claim stays reclaimable (risking a duplicate resend), or let a
            // stale/slow worker finalize rows a newer invocation already
            // reclaimed under a different claim_token. See migration
            // 20260719160000 for the full rationale.
            const identities = claim.episodes.map((episode) => deliveryIdentity(
              subscription.id, claim.tmdbShowId, episode.seasonNumber, episode.episodeNumber,
            ))
            const { data: finalizedRows, error: finalizeError } = await client.rpc(
              'complete_episode_notification_deliveries',
              {
                p_claim_token: claim.claimToken,
                p_identities: identities,
                p_delivered_at: evaluationInstant.toISOString(),
              },
            )
            if (finalizeError || (finalizedRows ?? []).length !== identities.length) {
              summary.failed += 1
              console.error('notification_worker_finalize_mismatch', {
                tmdbShowId: claim.tmdbShowId,
                expected: identities.length,
                finalized: (finalizedRows ?? []).length,
                message: finalizeError?.message,
              })
              continue
            }
            summary.sent += 1
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
