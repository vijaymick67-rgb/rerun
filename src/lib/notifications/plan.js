import { isVisibleInWatching } from '../finishedShows.js'
import { episodeKey, episodeReleaseInfo, hasAiredAt } from '../watchHelpers.js'

export const EPISODE_NOTIFICATION_TYPE = 'episode_available'
export const EPISODE_WATCH_REMINDER_TYPE = 'episode_watch_reminder'
export const WATCH_REMINDER_START_HOUR_IST = 22
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
export const NOTIFICATION_LOOKBACK_MS = DAY_MS
const TRUSTED_DATE_SOURCES = new Set(['manualOverride', 'tvmazeAirstamp', 'tvmazeAirdate'])
const ELIGIBLE_SHOW_STATUSES = new Set(['Returning Series', 'In Production'])
const POSTER_BASE = 'https://image.tmdb.org/t/p/w342'

export function deliveryIdentity(tmdbShowId, seasonNumber, episodeNumber, notificationType = EPISODE_NOTIFICATION_TYPE) {
  return `${tmdbShowId}:${seasonNumber}:${episodeNumber}:${notificationType}`
}

export function posterAttachment(posterPath, tmdbShowId) {
  if (typeof posterPath !== 'string' || !/^\/[A-Za-z0-9._/-]+\.jpg$/i.test(posterPath)) return null
  return { url: `${POSTER_BASE}${posterPath}`, filename: `rerun-${Number(tmdbShowId)}.jpg` }
}

function istDayStart(timestamp) {
  return Math.floor((timestamp + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS
}

export function watchReminderCutoffs(now) {
  const current = istDayStart(now) + WATCH_REMINDER_START_HOUR_IST * 60 * 60 * 1000
  return { previous: current - DAY_MS, current }
}

export function isWatchReminderWindow(now) {
  const { current } = watchReminderCutoffs(now)
  return now >= current && now < current + 2 * 60 * 60 * 1000
}

export function isShowCurrentlyAiringForNotifications(show) {
  return ELIGIBLE_SHOW_STATUSES.has(show?.details?.status)
}

function episodeLine(episode) {
  const prefix = `S${episode.seasonNumber}E${episode.episodeNumber}`
  return episode.name ? `${prefix} · ${episode.name}` : prefix
}

function buildNotification(show, episodes, notificationType) {
  episodes.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
  return {
    notificationType,
    tmdbShowId: show.tmdb_id,
    showName: show.name,
    title: episodes.length === 1 ? `${show.name} — New episode` : `${show.name} — ${episodes.length} new episodes`,
    body: episodes.map(episodeLine).join('\n'),
    episodes,
    attachment: posterAttachment(show.poster_path ?? show.details?.poster_path, show.tmdb_id),
    platform: show.details?.releasePlatform?.platform ?? 'unknown',
  }
}

export function buildNotificationPlan({ shows = [], delivered = new Set(), now = Date.now() }) {
  const notifications = []
  const watchReminders = []
  const decisions = []
  const reminderWindow = isWatchReminderWindow(now)
  const reminderCutoffs = watchReminderCutoffs(now)

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
    const reminderEpisodes = []
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
          if (reminderWindow) decisions.push({ ...base, reason: 'watchedBeforeWatchReminder' })
          continue
        }
        const availabilityIdentity = deliveryIdentity(show.tmdb_id, seasonNumber, episodeNumber)
        const availabilityDelivered = delivered.has(availabilityIdentity)
        const aired = hasAiredAt(episode, now)
        if (availabilityDelivered) {
          decisions.push({ ...base, identity: availabilityIdentity, reason: 'delivered' })
        } else if (!aired) {
          decisions.push({ ...base, identity: availabilityIdentity, reason: 'notAvailable' })
        } else if (release.timestamp > now - DAY_MS) {
          episodes.push({ identity: availabilityIdentity, seasonNumber, episodeNumber, name: episode.name?.trim() || null, release })
          decisions.push({ ...base, identity: availabilityIdentity, reason: 'included' })
        } else {
          decisions.push({ ...base, identity: availabilityIdentity, reason: 'outsideNotificationWindow' })
        }

        if (!aired || !reminderWindow || release.timestamp <= reminderCutoffs.previous || release.timestamp > reminderCutoffs.current) {
          decisions.push({ ...base, reason: 'outsideWatchReminderWindow' })
          continue
        }
        const reminderIdentity = deliveryIdentity(show.tmdb_id, seasonNumber, episodeNumber, EPISODE_WATCH_REMINDER_TYPE)
        if (delivered.has(reminderIdentity)) {
          decisions.push({ ...base, identity: reminderIdentity, reason: 'alreadyDeliveredWatchReminder' })
          continue
        }
        reminderEpisodes.push({ identity: reminderIdentity, seasonNumber, episodeNumber, name: episode.name?.trim() || null, release })
        decisions.push({ ...base, identity: reminderIdentity, reason: 'includedWatchReminder' })
      }
    }

    if (episodeCount === 0) decisions.push({ tmdbShowId: show.tmdb_id, showName: show.name, reason: 'noEpisodeMetadata' })
    if (episodes.length > 0) notifications.push(buildNotification(show, episodes, EPISODE_NOTIFICATION_TYPE))
    if (reminderEpisodes.length > 0) watchReminders.push(buildNotification(show, reminderEpisodes, EPISODE_WATCH_REMINDER_TYPE))
  }

  return { notifications, watchReminders, decisions }
}

