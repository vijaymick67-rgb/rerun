import { isVisibleInWatching } from '../finishedShows.js'
import { episodeKey, episodeReleaseInfo, hasAiredAt } from '../watchHelpers.js'

export const EPISODE_NOTIFICATION_TYPE = 'episode_available'
export const NOTIFICATION_LOOKBACK_MS = 24 * 60 * 60 * 1000
export const NOTIFICATION_ELIGIBLE_SHOW_STATUSES = Object.freeze(['Returning Series', 'In Production'])
const TRUSTED_DATE_SOURCES = new Set(['manualOverride', 'tvmazeAirstamp', 'tvmazeAirdate'])
const ELIGIBLE_SHOW_STATUSES = new Set(NOTIFICATION_ELIGIBLE_SHOW_STATUSES)
const POSTER_BASE = 'https://image.tmdb.org/t/p/w342'

export function deliveryIdentity(tmdbShowId, seasonNumber, episodeNumber) {
  return `${tmdbShowId}:${seasonNumber}:${episodeNumber}:${EPISODE_NOTIFICATION_TYPE}`
}

export function posterAttachment(posterPath, tmdbShowId) {
  if (typeof posterPath !== 'string' || !/^\/[A-Za-z0-9._/-]+\.jpg$/i.test(posterPath)) return null
  return {
    url: `${POSTER_BASE}${posterPath}`,
    filename: `rerun-${Number(tmdbShowId)}.jpg`,
  }
}

function episodeLine(episode) {
  const prefix = `S${episode.seasonNumber}E${episode.episodeNumber}`
  return episode.name ? `${prefix} · ${episode.name}` : prefix
}

export function isShowCurrentlyAiringForNotifications(show) {
  return ELIGIBLE_SHOW_STATUSES.has(show?.details?.status)
}

export function buildNotificationPlan({ shows = [], delivered = new Set(), now = Date.now() }) {
  const notifications = []
  const decisions = []

  for (const show of shows) {
    if (!isShowCurrentlyAiringForNotifications(show)) {
      decisions.push({ tmdbShowId: show.tmdb_id, showName: show.name, reason: 'showNotCurrentlyAiring' })
      continue
    }
    if (!isVisibleInWatching(show, show.status)) {
      decisions.push({ tmdbShowId: show.tmdb_id, showName: show.name, reason: 'notVisibleInWatching' })
      continue
    }
    if (show.loadError) {
      decisions.push({ tmdbShowId: show.tmdb_id, showName: show.name, reason: 'episodeMetadataLoadFailed' })
      continue
    }

    const episodes = []
    let episodeCount = 0
    for (const [seasonValue, seasonEpisodes] of Object.entries(show.episodesBySeason ?? {})) {
      const seasonNumber = Number(seasonValue)
      if (!Number.isInteger(seasonNumber) || seasonNumber <= 0) continue
      for (const episode of seasonEpisodes ?? []) {
        episodeCount += 1
        const episodeNumber = Number(episode?.episode_number)
        const release = episodeReleaseInfo(episode)
        const base = { tmdbShowId: show.tmdb_id, showName: show.name, seasonNumber, episodeNumber, release }
        if (!Number.isInteger(episodeNumber) || episodeNumber <= 0 || !release) {
          decisions.push({ ...base, reason: 'missingReleaseMetadata' })
          continue
        }
        if (!TRUSTED_DATE_SOURCES.has(release.dateSource)) {
          decisions.push({ ...base, reason: 'untrustedReleaseMetadata' })
          continue
        }
        if (show.watched?.has(episodeKey(seasonNumber, episodeNumber))) {
          decisions.push({ ...base, reason: 'watched' })
          continue
        }
        const identity = deliveryIdentity(show.tmdb_id, seasonNumber, episodeNumber)
        if (delivered.has(identity)) {
          decisions.push({ ...base, identity, reason: 'delivered' })
          continue
        }
        if (!hasAiredAt(episode, now)) {
          decisions.push({ ...base, identity, reason: 'notAvailable' })
          continue
        }
        if (release.timestamp <= now - NOTIFICATION_LOOKBACK_MS) {
          decisions.push({ ...base, identity, reason: 'outsideNotificationWindow' })
          continue
        }
        const planned = {
          identity,
          seasonNumber,
          episodeNumber,
          name: episode.name?.trim() || null,
          release,
        }
        episodes.push(planned)
        decisions.push({ ...base, identity, reason: 'included' })
      }
    }

    if (episodeCount === 0) {
      decisions.push({ tmdbShowId: show.tmdb_id, showName: show.name, reason: 'noEpisodeMetadata' })
    }
    if (episodes.length === 0) continue
    episodes.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
    notifications.push({
      tmdbShowId: show.tmdb_id,
      showName: show.name,
      title: episodes.length === 1
        ? `${show.name} — New episode`
        : `${show.name} — ${episodes.length} new episodes`,
      body: episodes.map(episodeLine).join('\n'),
      episodes,
      attachment: posterAttachment(show.poster_path ?? show.details?.poster_path, show.tmdb_id),
      platform: show.details?.releasePlatform?.platform ?? 'unknown',
    })
  }

  return { notifications, decisions }
}
