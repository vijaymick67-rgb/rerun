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

// Days from today until a (possibly network-shifted) air date. Returns null
// when there's no date to compute against.
export function daysUntil(airDate, releaseRule) {
  const releaseDate = releaseDateInIST(airDate, releaseRule)
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
// A show only becomes available after its shared, timezone-aware release
// instant; this protects every "Up next" path from a date-only midnight flip.
export function hasAired(episode, releaseRule) {
  const airDate = episode.air_date
  if (!airDate || !ISO_DATE_RE.test(airDate)) return false
  const timestamp = releaseTimestamp(airDate, releaseRule)
  return timestamp !== null && Date.now() >= timestamp
}

export function formatDate(dateString, releaseRule) {
  const releaseDate = releaseDateInIST(dateString, releaseRule)
  if (!releaseDate) return null
  const date = new Date(releaseDate + 'T00:00:00')
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// First unwatched episode that has already aired, scanning seasons in order.
export function computeNextUp(episodesBySeason, watched, releaseRule) {
  const seasonNumbers = Object.keys(episodesBySeason)
    .map(Number)
    .sort((a, b) => a - b)

  for (const seasonNumber of seasonNumbers) {
    for (const ep of episodesBySeason[seasonNumber]) {
      const key = episodeKey(seasonNumber, ep.episode_number)
      if (!watched.has(key) && hasAired(ep, releaseRule)) {
        return {
          season_number: seasonNumber,
          episode_number: ep.episode_number,
          name: ep.name,
          air_date: releaseDateInIST(ep.air_date, releaseRule),
        }
      }
    }
  }
  return null
}

// A release counts as "soon" strictly under 24 real hours out — measured from
// the timezone-aware release instant, not a calendar-day diff (which spanned
// ~0h–48h and mislabelled everything within a day or two as "soon").
const AIRS_SOON_WINDOW_MS = 24 * 60 * 60 * 1000

// Richer status for a tracked show, covering the cases computeNextUp alone
// can't distinguish: an unaired premiere, a mid-run gap awaiting a renewal
// date, and a show that's finished forever. `details` is the trimmed
// getShowDetails() response (status + next_episode_to_air).
export function computeWatchingStatus(episodesBySeason, watched, releaseRule, details) {
  const nextUp = computeNextUp(episodesBySeason, watched, releaseRule)
  if (nextUp) return { type: 'nextUp', ...nextUp }

  // TMDB's next_episode_to_air lags for hours after an episode actually drops
  // (worsened by the 6h getShowDetails cache), so nextAirDate is frequently
  // today or in the past. Only surface a countdown when the real, timezone-
  // aware release instant is still ahead of now — a stale/past date means the
  // episode already aired and we should fall through to caughtUp rather than
  // count down to a moment that has passed. This must not depend on TMDB
  // freshness.
  const nextAirDate = details?.next_episode_to_air?.air_date
  const releaseTs = releaseTimestamp(nextAirDate, releaseRule)
  const daysUntilAir = daysUntil(nextAirDate, releaseRule)
  if (releaseTs !== null && releaseTs > Date.now() && daysUntilAir !== null) {
    return {
      type: 'countdown',
      subtype: details.next_episode_to_air.episode_number === 1 ? 'premiere' : 'episode',
      air_date: releaseDateInIST(nextAirDate, releaseRule),
      daysUntil: daysUntilAir,
      airsSoon: releaseTs - Date.now() < AIRS_SOON_WINDOW_MS,
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
