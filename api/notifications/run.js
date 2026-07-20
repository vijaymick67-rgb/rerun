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

    // Claims a batch of one show's episodes under one notification type for
    // one subscription. Returns null (and bumps summary.skipped/failed as
    // appropriate) when nothing was actually won — either every identity was
    // already claimed/delivered elsewhere, or the claim RPC itself errored.
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

    // Finalizes exactly the rows this claim_token owns — see
    // supabase/migrations/20260719160000_add_complete_episode_notification_deliveries.sql
    // for why this must be claim-token-scoped rather than a plain
    // identity-only update.
    async function finalizeEpisodes(subscription, tmdbShowId, claimToken, episodes, notificationType) {
      const identities = episodes.map((episode) => deliveryIdentity(
        subscription.id, tmdbShowId, episode.seasonNumber, episode.episodeNumber, notificationType,
      ))
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
          notificationType,
          expected: identities.length,
          finalized: (finalizedRows ?? []).length,
          message: finalizeError?.message,
        })
        return false
      }
      return true
    }

    // Sends a real push for an already-claimed batch and finalizes it on
    // success. Returns 'sent', 'failed', or 'removed' (subscription was gone
    // — 404/410 from the push service, already deleted). Only a 'sent'
    // outcome (push accepted *and* the finalize RPC durably confirmed every
    // claimed identity) counts as a real delivery — a send that succeeds but
    // fails to finalize is 'failed', exactly like the pre-two-stage worker.
    async function sendClaim(subscription, tmdbShowId, showName, claimToken, episodes, notificationType) {
      const payload = buildEpisodeNotificationPayload(tmdbShowId, showName, episodes, notificationType)
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
        console.error('notification_worker_send_failed', { statusCode, message: err?.message, notificationType })
        return 'failed'
      }
      const finalized = await finalizeEpisodes(subscription, tmdbShowId, claimToken, episodes, notificationType)
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
          // claim its airtime batch immediately (no preferred-hour gate —
          // "never send before availability" is the only timing rule) and
          // stash its reminder batch (still gated by the preferred hour) for
          // pass 2, once we know which episodes airtime actually delivered.
          const reminderPool = new Map() // tmdbShowId -> { showName, candidates }
          const airtimeClaims = []
          // Which episodes actually won the airtime claim this run (i.e.
          // this is genuinely the first time airtime is being attempted for
          // them, not merely "still watermark-eligible" — an already
          // fully-delivered episode stays a watermark-eligible candidate
          // forever, but must never keep suppressing its reminder run after
          // run). Only these episodes can ever be treated as a same-run
          // collision with the reminder stage below, regardless of whether
          // the send that follows in pass 2 actually succeeds.
          const airtimeClaimedKeysByShow = new Map() // tmdbShowId -> Set(episodeKey)
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

            if (reminderCandidates.length > 0) {
              reminderPool.set(tmdbShowId, { showName: entry.showName, candidates: reminderCandidates })
            }
            if (airtimeCandidates.length > 0) {
              const claimed = await claimEpisodes(subscription, tmdbShowId, airtimeCandidates, EPISODE_AIRTIME_NOTIFICATION_TYPE)
              if (claimed) {
                airtimeClaims.push({ tmdbShowId, showName: entry.showName, ...claimed })
                airtimeClaimedKeysByShow.set(
                  tmdbShowId,
                  new Set(claimed.episodes.map((episode) => episodeKey(episode.seasonNumber, episode.episodeNumber))),
                )
              }
            }
          }

          if (dryRun) continue

          // Pass 2: send + finalize every airtime claim, remembering exactly
          // which episodes were *successfully* delivered this run — only
          // those can silently satisfy an overlapping reminder below. A push
          // that fails, or that sends but fails to finalize, must never
          // suppress the reminder (see sendClaim's outcome contract).
          let subscriptionRemoved = false
          const airtimeSentKeysByShow = new Map() // tmdbShowId -> Set(episodeKey)
          for (const claim of airtimeClaims) {
            const outcome = await sendClaim(
              subscription, claim.tmdbShowId, claim.showName, claim.claimToken, claim.episodes, EPISODE_AIRTIME_NOTIFICATION_TYPE,
            )
            if (outcome === 'removed') { subscriptionRemoved = true; break }
            if (outcome === 'sent') {
              airtimeSentKeysByShow.set(
                claim.tmdbShowId,
                new Set(claim.episodes.map((episode) => episodeKey(episode.seasonNumber, episode.episodeNumber))),
              )
            }
          }
          if (subscriptionRemoved) continue

          // Pass 3: split each show's reminder pool into episodes that were
          // *genuinely, newly claimed for airtime this run* (a same-run
          // collision — satisfy silently once pass 2 confirms delivery, no
          // second push) and everything else, which always goes through a
          // real standalone reminder send in pass 4 regardless of airtime's
          // outcome (including a show whose airtime already delivered on an
          // earlier run: airtimeClaimedKeysByShow is empty for it this run,
          // so its now-due reminder is never mistaken for a collision).
          const reminderToSendByShow = new Map()
          for (const [tmdbShowId, { showName, candidates }] of reminderPool) {
            const claimedAirtimeKeys = airtimeClaimedKeysByShow.get(tmdbShowId) ?? new Set()
            const collisionCandidates = candidates.filter(
              (episode) => claimedAirtimeKeys.has(episodeKey(episode.seasonNumber, episode.episodeNumber)),
            )
            const standalone = candidates.filter(
              (episode) => !claimedAirtimeKeys.has(episodeKey(episode.seasonNumber, episode.episodeNumber)),
            )

            // Only an episode whose airtime push in pass 2 actually
            // succeeded may be silently satisfied here. One that failed to
            // send (or send-but-not-finalize) is dropped entirely for this
            // run — not finalized, not sent standalone either — and simply
            // becomes a fresh candidate again (both airtime and reminder)
            // on the next run. This is exactly what keeps "failed airtime
            // delivery finalizes neither type" true: nothing here ever
            // finalizes a reminder off the back of a failed airtime send.
            const justSentKeys = airtimeSentKeysByShow.get(tmdbShowId) ?? new Set()
            const collision = collisionCandidates.filter(
              (episode) => justSentKeys.has(episodeKey(episode.seasonNumber, episode.episodeNumber)),
            )

            if (collision.length > 0) {
              const claimed = await claimEpisodes(subscription, tmdbShowId, collision, EPISODE_REMINDER_NOTIFICATION_TYPE)
              if (claimed) {
                // A failure here (surfaced via summary.failed inside
                // finalizeEpisodes) leaves the reminder claim exactly as
                // reclaimable as any other unfinalized claim — retried by a
                // later run, never silently dropped, and it never unwinds
                // the airtime send that already succeeded.
                await finalizeEpisodes(subscription, tmdbShowId, claimed.claimToken, claimed.episodes, EPISODE_REMINDER_NOTIFICATION_TYPE)
              }
            }

            if (standalone.length > 0) reminderToSendByShow.set(tmdbShowId, { showName, episodes: standalone })
          }

          // Pass 4: claim + send + finalize standalone reminders exactly
          // like airtime in passes 1-2.
          const reminderClaims = []
          for (const [tmdbShowId, { showName, episodes }] of reminderToSendByShow) {
            const claimed = await claimEpisodes(subscription, tmdbShowId, episodes, EPISODE_REMINDER_NOTIFICATION_TYPE)
            if (claimed) reminderClaims.push({ tmdbShowId, showName, ...claimed })
          }
          for (const claim of reminderClaims) {
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
