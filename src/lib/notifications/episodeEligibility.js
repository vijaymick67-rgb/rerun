// Phase 2 automatic episode-notification eligibility + payload grouping.
//
// This module intentionally contains no TMDB/TVmaze fetching, no Supabase
// access, and no web-push calls — it's pure, synchronous, and only ever
// consumes the *already-resolved* per-show data the worker assembles via
// src/lib/watchingShows.js (loadWatchingShowData), the same function the
// live Watching tab uses. That's deliberate: tracked/hidden/finished
// filtering (isVisibleInWatching), release-instant resolution (IST
// conversion, platform thresholds, TVmaze-over-TMDB precedence), and
// watched-episode identity all come from the app's existing protected
// logic, not a server-only reimplementation of it.
import { isVisibleInWatching } from '../finishedShows.js'
import { episodeKey, episodeReleaseInfo } from '../watchHelpers.js'

// Legacy single-notification identity. No longer used by new deliveries —
// kept only because migration 20260720080000 references the literal string
// when reclassifying old delivered rows, and so historical call sites/tests
// referring to it keep resolving. New deliveries always use one of the two
// types below.
export const EPISODE_NOTIFICATION_TYPE = 'episode_available'

// Two-stage automatic episode notifications: an airtime alert shortly after
// an episode becomes available, and a separate same-day reminder at the
// subscription's preferred hour if it's still unwatched by then. Each has
// its own delivery identity (see deliveryIdentity below) so they claim and
// finalize completely independently of one another.
export const EPISODE_AIRTIME_NOTIFICATION_TYPE = 'episode_airtime'
export const EPISODE_REMINDER_NOTIFICATION_TYPE = 'episode_reminder'

// Must match exactly what claim_episode_notification_deliveries builds
// server-side in Postgres (p_push_subscription_id || ':' || p_tmdb_show_id ||
// ':' || season_number || ':' || episode_number || ':' || notification_type)
// — this is the only place the worker builds that string, so the two can't
// drift apart.
export function deliveryIdentity(pushSubscriptionId, tmdbShowId, seasonNumber, episodeNumber, notificationType = EPISODE_NOTIFICATION_TYPE) {
  return `${pushSubscriptionId}:${tmdbShowId}:${seasonNumber}:${episodeNumber}:${notificationType}`
}

// Every already-aired, unwatched episode for a show that's currently visible
// in Watching (same rule the live app uses to decide whether a show belongs
// there at all — hidden/finished/tracked filtering all flow through
// isVisibleInWatching). `episodesBySeason` only ever contains season_number
// > 0 rows (see loadWatchingShowData), so specials are already excluded
// before this function ever sees them — nothing special-cased here.
export function collectAiredUnwatchedEpisodes({
  show,
  status,
  episodesBySeason,
  watched,
  evaluationTime = Date.now(),
}) {
  if (!isVisibleInWatching(show, status)) return []

  const out = []
  for (const [seasonValue, episodes] of Object.entries(episodesBySeason ?? {})) {
    const seasonNumber = Number(seasonValue)
    if (!Number.isInteger(seasonNumber) || seasonNumber <= 0) continue
    for (const episode of episodes ?? []) {
      const episodeNumber = Number(episode?.episode_number)
      if (!Number.isInteger(episodeNumber) || episodeNumber <= 0) continue
      // episodeReleaseInfo already prefers a TVmaze airstamp/airdate over the
      // raw TMDB air_date when one is attached — this is the "don't notify
      // from a TMDB date string when a more precise resolution exists" rule,
      // satisfied by construction rather than re-implemented here.
      const release = episodeReleaseInfo(episode)
      if (!release) continue // no real availability timestamp — not eligible
      if (release.timestamp > evaluationTime) continue // not available yet
      if (watched?.has(episodeKey(seasonNumber, episodeNumber))) continue

      out.push({
        seasonNumber,
        episodeNumber,
        name: typeof episode.name === 'string' && episode.name.trim() ? episode.name : null,
        releaseTimestamp: release.timestamp,
      })
    }
  }
  return out.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
}

// First-run flood protection: an episode only counts as "new" for a given
// subscription if it became available strictly after that subscription's
// activation watermark. An episode releasing exactly at (or before) the
// watermark is backlog, not new — this is what keeps activation from ever
// backfilling old unwatched episodes. `watermarkTimestamp` is expected to
// already include any grace-window backdating (applied once, at activation).
export function episodesSinceWatermark(episodes, watermarkTimestamp) {
  if (!Number.isFinite(watermarkTimestamp)) return []
  return (episodes ?? []).filter((episode) => episode.releaseTimestamp > watermarkTimestamp)
}

// Route the notification tap should open. Always /watching/:tmdbId, since a
// numeric tmdbShowId is always available here — the "fall back to /watching"
// case is a defensive guard, not an expected path.
export function episodeNotificationUrl(tmdbShowId) {
  return Number.isInteger(tmdbShowId) && tmdbShowId > 0 ? `/watching/${tmdbShowId}` : '/watching'
}

// A stable tag per show (single-episode notifications are further keyed by
// season/episode) so a redelivered push for the same logical event replaces
// the existing OS notification instead of stacking a visual duplicate.
// `notificationType` — when it's one of the two automatic delivery types —
// is folded into the tag so an airtime alert and its later reminder never
// share a tag: without that, the reminder would silently replace the
// airtime alert in Notification Center instead of appearing alongside it.
// Omitting notificationType (the synthetic verification push, which never
// goes through real delivery identities) keeps the original untyped shape.
export function episodeNotificationTag(tmdbShowId, episodes, notificationType) {
  const kind =
    notificationType === EPISODE_AIRTIME_NOTIFICATION_TYPE ? 'airtime'
    : notificationType === EPISODE_REMINDER_NOTIFICATION_TYPE ? 'reminder'
    : null
  const prefix = kind ? `rerun-episode-${kind}-${tmdbShowId}` : `rerun-episode-${tmdbShowId}`
  if (episodes.length === 1) {
    return `${prefix}-s${episodes[0].seasonNumber}e${episodes[0].episodeNumber}`
  }
  return `${prefix}-batch`
}

// One show's eligible (and already-claimed, by the caller) episodes → one
// notification payload. `episodes` must be non-empty and sorted (as returned
// by collectAiredUnwatchedEpisodes / episodesSinceWatermark). Content is
// deliberately minimal: iOS supplies "from Rerun" on its own for the
// installed PWA, so this payload never generates or duplicates that line —
// the title alone (`${showName} - New Episode`) is the entire visible
// content, regardless of how many episodes are grouped together. There is
// intentionally no separate body; `omitBody` marks that as deliberate (as
// opposed to a malformed/legacy payload that happens to have no body) so
// the service worker's fallback text only ever applies to the latter — see
// public/push-sw.js.
// `notificationType` only affects the tag (see episodeNotificationTag) — the
// visible content is identical for every delivery type, deliberately: an
// airtime alert and its later reminder must be indistinguishable to the
// user, both `${showName} - New Episode` with no body and no mention of
// "Airtime"/"Reminder"/episode metadata.
export function buildEpisodeNotificationPayload(tmdbShowId, showName, episodes, notificationType) {
  return {
    title: `${showName} - New Episode`,
    omitBody: true,
    url: episodeNotificationUrl(tmdbShowId),
    tag: episodeNotificationTag(tmdbShowId, episodes, notificationType),
    episodes,
  }
}
