import { istDateISO, releaseDateInIST, releaseTimestamp } from './networkReleaseTiming.js'

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
  const fromDate = new Date(fy, fm - 1, fd)
  const toDate = new Date(ty, tm - 1, td)
  return Math.round((toDate - fromDate) / 86400000)
}

// Days from today until an air date. Returns null when there's no date to
// compute against.
export function daysUntil(airDate) {
  const releaseDate = releaseDateInIST(airDate)
  if (!releaseDate || !ISO_DATE_RE.test(airDate)) return null
  return daysBetween(localTodayISO(), releaseDate)
}

// Bug fix: "today" used to come from new Date().toISOString(), which converts
// to UTC first — for IST (UTC+5:30) that's a different calendar day than the
// user's local "today" for the ~5.5 hours after local midnight, and air_date
// was never validated as a full YYYY-MM-DD before the comparison, so a
// partial/malformed date (e.g. "2026-07") could sort as "already aired"
// against a full date even when the real day hadn't happened yet.
//
// A show only becomes available at its 14:00-IST release instant; this protects
// every "Up next" path from a date-only midnight flip.
export function hasAired(episode) {
  const airDate = episode.air_date
  if (!airDate || !ISO_DATE_RE.test(airDate)) return false
  const timestamp = releaseTimestamp(airDate)
  return timestamp !== null && Date.now() >= timestamp
}

export function formatDate(dateString) {
  const releaseDate = releaseDateInIST(dateString)
  if (!releaseDate) return null
  const date = new Date(releaseDate + 'T00:00:00')
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// First unwatched episode that has already aired, scanning seasons in order.
export function computeNextUp(episodesBySeason, watched) {
  const seasonNumbers = Object.keys(episodesBySeason)
    .map(Number)
    .sort((a, b) => a - b)

  for (const seasonNumber of seasonNumbers) {
    for (const ep of episodesBySeason[seasonNumber]) {
      const key = episodeKey(seasonNumber, ep.episode_number)
      if (!watched.has(key) && hasAired(ep)) {
        return {
          season_number: seasonNumber,
          episode_number: ep.episode_number,
          name: ep.name,
          air_date: releaseDateInIST(ep.air_date),
        }
      }
    }
  }
  return null
}

// A release counts as "soon" strictly under 12 real hours out — measured from
// the 14:00-IST release instant. So the label flips to "soon" at 2 AM IST on
// air_date and back to normal up-next display the moment 2 PM IST passes.
const AIRS_SOON_WINDOW_MS = 12 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

// Every already-aired episode across all seasons, oldest first, carrying its
// release instant — the raw material for weekly-cadence detection below.
function airedEpisodesByRelease(episodesBySeason) {
  const aired = []
  const now = Date.now()
  for (const episodes of Object.values(episodesBySeason ?? {})) {
    for (const ep of episodes ?? []) {
      const ts = releaseTimestamp(ep.air_date)
      if (ts !== null && ts <= now) aired.push({ air_date: ep.air_date, ts })
    }
  }
  return aired.sort((a, b) => a.ts - b.ts)
}

// Fix D: when TMDB's next_episode_to_air is missing or stale/past and the show
// has a steady weekly cadence (its two most recent aired episodes are ~7 days
// apart), predict the next air_date as last_aired + 7 days. This is an internal
// countdown hint ONLY — never persisted, never written back to a TMDB field,
// and always superseded by the next real next_episode_to_air. No prediction is
// attempted with fewer than 2 aired episodes (new/irregular shows). Returns a
// predicted air_date string, or null when cadence can't be established.
function predictWeeklyNextAirDate(episodesBySeason) {
  const aired = airedEpisodesByRelease(episodesBySeason)
  if (aired.length < 2) return null

  const last = aired[aired.length - 1]
  const prev = aired[aired.length - 2]
  // ~7 days apart, with a day of slack for scheduling jitter. A wider gap means
  // a mid-season break or irregular schedule — don't guess those.
  if (Math.abs(last.ts - prev.ts - WEEK_MS) > DAY_MS) return null

  const [y, m, d] = last.air_date.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d) + WEEK_MS)
  const yyyy = next.getUTCFullYear()
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(next.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
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
  // today or in the past. Only surface a countdown when the 14:00-IST release
  // instant is still ahead of now — a stale/past date means the episode already
  // aired and we should fall through rather than count down to a passed moment.
  const nextAirDate = details?.next_episode_to_air?.air_date
  const releaseTs = releaseTimestamp(nextAirDate)
  if (releaseTs !== null && releaseTs > Date.now()) {
    return {
      type: 'countdown',
      subtype: details.next_episode_to_air.episode_number === 1 ? 'premiere' : 'episode',
      air_date: releaseDateInIST(nextAirDate),
      daysUntil: daysUntil(nextAirDate),
      airsSoon: releaseTs - Date.now() < AIRS_SOON_WINDOW_MS,
    }
  }

  // Fix D: the real pointer is missing or stale. If the show is on a weekly
  // cadence, count down to a predicted date one week past the last aired episode
  // so the UI shows "airs in N days" instead of going blank for the week. The
  // next real fetch overrides this automatically via the branch above.
  const predictedAirDate = predictWeeklyNextAirDate(episodesBySeason)
  const predictedTs = releaseTimestamp(predictedAirDate)
  if (predictedTs !== null && predictedTs > Date.now()) {
    return {
      type: 'countdown',
      subtype: 'episode',
      air_date: predictedAirDate,
      daysUntil: daysUntil(predictedAirDate),
      airsSoon: predictedTs - Date.now() < AIRS_SOON_WINDOW_MS,
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
  if (status.type === 'completed') return true
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
