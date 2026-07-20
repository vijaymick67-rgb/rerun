import {
  istDateISO,
  releaseDateInIST,
  releaseInfoFromTimestamp,
  resolveReleaseInfo,
} from './networkReleaseTiming.js'

// Higher-priority release signals an episode object may carry, in the shape the
// priority chain (resolveReleaseTimestamp) expects. `airstamp` comes from
// TVmaze; `releaseOverride` is reserved for an explicit human correction. Absent
// on plain TMDB episodes, in which case resolution falls to the anchor.
export function releaseSources(episode) {
  return {
    manualOverride: episode?.releaseOverride,
    newsOverride: episode?.newsOverride,
    airstamp: episode?.airstamp,
    airdate: episode?.airdate,
  }
}

// "1 day" not "1 days" — TMDB countdowns routinely land on 1.
function pluralizeDays(n) {
  return n === 1 ? '1 day' : `${n} days`
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function episodeKey(seasonNumber, episodeNumber) {
  return `${seasonNumber}:${episodeNumber}`
}

// Local calendar date, e.g. "2026-07-15" — see hasAired() below for why this
// can't be derived from toISOString().
export function localTodayISO() {
  return istDateISO()
}

// Calendar-day difference between two YYYY-MM-DD dates (toISO - fromISO).
function daysBetween(fromISO, toISO) {
  const [fy, fm, fd] = fromISO.split('-').map(Number)
  const [ty, tm, td] = toISO.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000)
}

// Days from today until an air date. Returns null when there's no date to
// compute against.
export function daysUntil(airDate) {
  const releaseDate = releaseDateInIST(airDate)
  if (!releaseDate || !ISO_DATE_RE.test(airDate)) return null
  return daysBetween(localTodayISO(), releaseDate)
}

// Days from today (IST) until a resolved release instant — used for countdowns
// whose moment may come from a TVmaze airstamp rather than an air_date, where
// the IST calendar day is read off the instant itself. Returns null for no ts.
export function daysUntilRelease(airDate, sources = {}, platformInfo = {}) {
  const info = resolveReleaseInfo(airDate, sources, platformInfo)
  return info ? daysBetween(localTodayISO(), info.istDate) : null
}

// Bug fix: "today" used to come from new Date().toISOString(), which converts
// to UTC first — for IST (UTC+5:30) that's a different calendar day than the
// user's local "today" for the ~5.5 hours after local midnight, and air_date
// was never validated as a full YYYY-MM-DD before the comparison, so a
// partial/malformed date (e.g. "2026-07") could sort as "already aired"
// against a full date even when the real day hadn't happened yet.
//
// A show only becomes available at its platform threshold; this protects every
// Up Next path from a date-only midnight flip.
export function hasAiredAt(episode, now) {
  const release = episodeReleaseInfo(episode)
  return release !== null && Number(now) >= release.timestamp
}

export function hasAired(episode) {
  return hasAiredAt(episode, Date.now())
}

export function formatDate(dateString) {
  const releaseDate = releaseDateInIST(dateString)
  if (!releaseDate) return null
  const [year, month, day] = releaseDate.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

// Episode lists intentionally expose only the resolved IST calendar date.
// Platform thresholds remain internal availability guards.
export function formatReleaseDisplay(release) {
  if (!release?.istDate) return null
  return formatDate(release.istDate)
}

// The IST calendar day an episode actually releases on, honoring a TVmaze
// airstamp or manual override when present and otherwise falling back to the
// air_date anchor. This is what should be *displayed*: the raw TMDB air_date is
// a US calendar day, so for an evening/night US drop it sits one IST day early
// (an HBO Sunday-night episode lands Monday in IST). Callers that only have a
// plain air_date get exactly releaseDateInIST(air_date) back.
export function episodeReleaseDateInIST(episode) {
  return episodeReleaseInfo(episode)?.istDate ?? null
}

export function episodeReleaseInfo(episode) {
  return resolveReleaseInfo(
    episode?.air_date,
    releaseSources(episode),
    episode?.releasePlatform,
  )
}

// First unwatched episode that has already aired, scanning seasons in order.
export function computeNextUp(episodesBySeason, watched) {
  const seasonNumbers = Object.keys(episodesBySeason)
    .map(Number)
    .sort((a, b) => a - b)

  for (const seasonNumber of seasonNumbers) {
    const episodes = [...(episodesBySeason[seasonNumber] ?? [])]
      .sort((a, b) => a.episode_number - b.episode_number)
    for (const ep of episodes) {
      const key = episodeKey(seasonNumber, ep.episode_number)
      if (!watched.has(key) && hasAired(ep)) {
        const release = episodeReleaseInfo(ep)
        return {
          season_number: seasonNumber,
          episode_number: ep.episode_number,
          name: ep.name,
          air_date: release?.istDate ?? null,
          release,
        }
      }
    }
  }
  return null
}

// Released-only progress for a show: numerator/denominator built exclusively
// from hasAired() (the same authoritative release/timezone check computeNextUp
// uses above), so a show with future TMDB episodes already listed never
// counts them in the denominator. watchedCount only ever increments while
// iterating actual released episodes, so it structurally cannot exceed
// releasedCount — the percent clamp below is pure defensive belt-and-braces
// against stale/corrupt watched rows, not something the loop can produce.
export function computeReleasedProgress(episodesBySeason, watched) {
  let releasedCount = 0
  let watchedCount = 0
  for (const [seasonNumber, episodes] of Object.entries(episodesBySeason ?? {})) {
    for (const episode of episodes ?? []) {
      if (!hasAired(episode)) continue
      releasedCount += 1
      if (watched.has(episodeKey(seasonNumber, episode.episode_number))) watchedCount += 1
    }
  }
  const percent = releasedCount > 0 ? Math.min(100, (watchedCount / releasedCount) * 100) : 0
  return { releasedCount, watchedCount, percent }
}

// A release counts as soon strictly under 12 real hours from its mapped
// platform threshold.
const AIRS_SOON_WINDOW_MS = 12 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

// Every already-aired episode across all seasons, oldest first, carrying its
// release instant — the raw material for weekly-cadence detection below.
function distinctReleaseWindows(episodesBySeason) {
  const byTimestamp = new Map()
  for (const episodes of Object.values(episodesBySeason ?? {})) {
    for (const episode of episodes ?? []) {
      const release = episodeReleaseInfo(episode)
      if (release && release.timestamp <= Date.now()) byTimestamp.set(release.timestamp, release)
    }
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp)
}

// Fix D: when TMDB's next_episode_to_air is missing or stale/past and the show
// has a steady weekly cadence (its two most recent aired episodes are ~7 days
// apart), predict the next air_date as last_aired + 7 days. This is an internal
// countdown hint ONLY — never persisted, never written back to a TMDB field,
// and always superseded by the next real next_episode_to_air. No prediction is
// attempted with fewer than 2 aired episodes (new/irregular shows). Returns a
// predicted air_date string, or null when cadence can't be established.
export function predictWeeklyNextRelease(episodesBySeason, details = {}) {
  if (details.status === 'Ended' || details.status === 'Canceled') return null
  const aired = distinctReleaseWindows(episodesBySeason)
  if (aired.length < 2) return null

  const last = aired[aired.length - 1]
  const prev = aired[aired.length - 2]
  // ~7 days apart, with a day of slack for scheduling jitter. A wider gap means
  // a mid-season break or irregular schedule — don't guess those.
  if (Math.abs(last.timestamp - prev.timestamp - WEEK_MS) > DAY_MS) return null
  const lastSeason = Math.max(...Object.keys(episodesBySeason ?? {}).map(Number))
  const seasonEpisodes = episodesBySeason?.[lastSeason] ?? []
  const knownCount = details.seasons?.find((season) => season.season_number === lastSeason)?.episode_count
  const highestKnown = Math.max(0, ...seasonEpisodes.map((episode) => episode.episode_number ?? 0))
  if (knownCount && highestKnown >= knownCount) return null
  return releaseInfoFromTimestamp(last.timestamp + WEEK_MS, 'prediction', {
    platform: last.platform,
    dateSource: 'prediction',
    confidence: last.confidence,
  })
}

function futureEpisodesByRelease(episodesBySeason) {
  const future = []
  for (const [seasonNumber, episodes] of Object.entries(episodesBySeason ?? {})) {
    for (const episode of episodes ?? []) {
      const release = episodeReleaseInfo(episode)
      if (release && release.timestamp > Date.now()) {
        future.push({ ...episode, season_number: Number(seasonNumber), release })
      }
    }
  }
  return future.sort((a, b) => a.release.timestamp - b.release.timestamp ||
    a.season_number - b.season_number || a.episode_number - b.episode_number)
}

function isSeasonPremiere(episode, watched) {
  if (episode?.episode_number !== 1) return false
  const watchedSeasons = [...watched].map((key) => Number(String(key).split(':')[0]))
  if (watchedSeasons.length === 0) return true
  return episode.season_number > Math.max(...watchedSeasons)
}

// Richer status for a tracked show, covering the cases computeNextUp alone
// can't distinguish: an unaired premiere, a mid-run gap awaiting the next
// episode, and a show that's finished forever. `details` is the trimmed
// getShowDetails() response (status + next_episode_to_air).
export function computeWatchingStatus(episodesBySeason, watched, details) {
  const nextUp = computeNextUp(episodesBySeason, watched)
  if (nextUp) return { type: 'nextUp', ...nextUp }

  // Fix B: TMDB's next_episode_to_air lags for hours after an episode actually
  // drops (worsened by the 6h getShowDetails cache), so nextAirDate is often
  // today or in the past. Prefer a real future season episode; otherwise only
  // use a pointer whose final platform-threshold instant is still ahead.
  const listFuture = futureEpisodesByRelease(episodesBySeason)[0]
  const pointer = details?.next_episode_to_air
  const pointerRelease = episodeReleaseInfo(pointer)
  const nextEp = listFuture ?? (pointerRelease?.timestamp > Date.now()
    ? { ...pointer, release: pointerRelease }
    : null)
  if (nextEp) {
    const release = nextEp.release
    return {
      type: 'countdown',
      subtype: isSeasonPremiere(nextEp, watched) ? 'premiere' : 'episode',
      air_date: release.istDate,
      source: release.source,
      release,
      daysUntil: daysBetween(localTodayISO(), release.istDate),
      airsSoon: release.timestamp - Date.now() < AIRS_SOON_WINDOW_MS,
    }
  }

  // Fix D: the real pointer is missing or stale. If the show is on a weekly
  // cadence, count down to a predicted date one week past the last aired episode
  // so the UI shows "airs in N days" instead of going blank for the week. The
  // next real fetch overrides this automatically via the branch above.
  const prediction = predictWeeklyNextRelease(episodesBySeason, details)
  if (prediction && prediction.timestamp > Date.now()) {
    return {
      type: 'countdown',
      subtype: 'episode',
      air_date: prediction.istDate,
      source: prediction.source,
      release: prediction,
      daysUntil: daysBetween(localTodayISO(), prediction.istDate),
      airsSoon: prediction.timestamp - Date.now() < AIRS_SOON_WINDOW_MS,
      predicted: true,
    }
  }

  if (details?.status === 'Ended' || details?.status === 'Canceled') {
    return { type: 'completed' }
  }

  return { type: 'caughtUp' }
}

// Combined Watching-tab visibility rule: hide a show once there's nothing
// unwatched already aired, and either it's finished forever or its next
// known episode is too far out to be worth showing yet.
export const WATCHING_COUNTDOWN_WINDOW_DAYS = 60

export function isHiddenFromWatching(status) {
  if (!status) return false
  if (status.type === 'completed' || status.type === 'caughtUp') return true
  if (status.type === 'countdown' && status.daysUntil > WATCHING_COUNTDOWN_WINDOW_DAYS) return true
  return false
}

// Kept separate from the row component so countdown wording is covered by the
// same unit tests as the status subtype that drives it.
export function watchingStatusLabel(status) {
  const isPremiere = status.subtype === 'premiere'
  if (status.airsSoon) return isPremiere ? 'Airs soon' : 'New episode soon'
  return isPremiere
    ? `Airs in ${pluralizeDays(status.daysUntil)}`
    : `New episode in ${pluralizeDays(status.daysUntil)}`
}
