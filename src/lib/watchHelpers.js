import { shiftAirDate } from './networkReleaseTiming.js'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function episodeKey(seasonNumber, episodeNumber) {
  return `${seasonNumber}:${episodeNumber}`
}

// Local calendar date, e.g. "2026-07-15" — see hasAired() below for why this
// can't be derived from toISOString().
export function localTodayISO() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
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
export function daysUntil(airDate, dayShift = 0) {
  if (!airDate || !ISO_DATE_RE.test(airDate)) return null
  return daysBetween(localTodayISO(), shiftAirDate(airDate, dayShift))
}

// Bug fix: "today" used to come from new Date().toISOString(), which converts
// to UTC first — for IST (UTC+5:30) that's a different calendar day than the
// user's local "today" for the ~5.5 hours after local midnight, and air_date
// was never validated as a full YYYY-MM-DD before the comparison, so a
// partial/malformed date (e.g. "2026-07") could sort as "already aired"
// against a full date even when the real day hadn't happened yet.
//
// dayShift (from networkReleaseTiming.js) corrects TMDB's US air_date to the
// IST-effective release day for networks/platforms where those differ.
export function hasAired(episode, dayShift = 0) {
  const airDate = episode.air_date
  if (!airDate || !ISO_DATE_RE.test(airDate)) return false
  return shiftAirDate(airDate, dayShift) <= localTodayISO()
}

export function formatDate(dateString, dayShift = 0) {
  if (!dateString) return null
  const date = new Date(shiftAirDate(dateString, dayShift) + 'T00:00:00')
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// First unwatched episode that has already aired, scanning seasons in order.
export function computeNextUp(episodesBySeason, watched, dayShift = 0) {
  const seasonNumbers = Object.keys(episodesBySeason)
    .map(Number)
    .sort((a, b) => a - b)

  for (const seasonNumber of seasonNumbers) {
    for (const ep of episodesBySeason[seasonNumber]) {
      const key = episodeKey(seasonNumber, ep.episode_number)
      if (!watched.has(key) && hasAired(ep, dayShift)) {
        return {
          season_number: seasonNumber,
          episode_number: ep.episode_number,
          name: ep.name,
          air_date: shiftAirDate(ep.air_date, dayShift),
        }
      }
    }
  }
  return null
}

// Airs today/tomorrow renders as "Airs soon" instead of a day count.
const AIRS_SOON_THRESHOLD_DAYS = 1

// Richer status for a tracked show, covering the cases computeNextUp alone
// can't distinguish: an unaired premiere, a mid-run gap awaiting a renewal
// date, and a show that's finished forever. `details` is the trimmed
// getShowDetails() response (status + next_episode_to_air).
export function computeWatchingStatus(episodesBySeason, watched, dayShift, details) {
  const nextUp = computeNextUp(episodesBySeason, watched, dayShift)
  if (nextUp) return { type: 'nextUp', ...nextUp }

  const nextAirDate = details?.next_episode_to_air?.air_date
  const daysUntilAir = daysUntil(nextAirDate, dayShift)
  if (nextAirDate && daysUntilAir !== null) {
    return {
      type: 'countdown',
      subtype: details.next_episode_to_air.episode_number === 1 ? 'premiere' : 'episode',
      air_date: shiftAirDate(nextAirDate, dayShift),
      daysUntil: daysUntilAir,
      airsSoon: daysUntilAir <= AIRS_SOON_THRESHOLD_DAYS,
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
    ? `Airs in ${status.daysUntil} days`
    : `New episode in ${status.daysUntil} days`
}
