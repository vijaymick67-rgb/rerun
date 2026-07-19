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

export const EPISODE_NOTIFICATION_TYPE = 'episode_available'

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
export function episodeNotificationTag(tmdbShowId, episodes) {
  if (episodes.length === 1) {
    return `rerun-episode-${tmdbShowId}-s${episodes[0].seasonNumber}e${episodes[0].episodeNumber}`
  }
  return `rerun-episode-${tmdbShowId}-batch`
}

// One show's eligible (and already-claimed, by the caller) episodes → one
// notification payload. `episodes` must be non-empty and sorted (as returned
// by collectAiredUnwatchedEpisodes / episodesSinceWatermark). Content is
// deliberately minimal: the iOS/app heading ("Rerun") is supplied by the
// installed app identity, not this payload, so the title is the show name
// alone and the body carries no episode metadata (season/episode/title/
// count/release time) regardless of how many episodes are grouped together —
// one notification always means "go check the show", not a status report.
export function buildEpisodeNotificationPayload(tmdbShowId, showName, episodes) {
  return {
    title: showName,
    body: 'New Episode',
    url: episodeNotificationUrl(tmdbShowId),
    tag: episodeNotificationTag(tmdbShowId, episodes),
    episodes,
  }
}
