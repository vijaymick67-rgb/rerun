const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function episodeKey(seasonNumber, episodeNumber) {
  return `${seasonNumber}:${episodeNumber}`
}

// Local calendar date, e.g. "2026-07-15" — see hasAired() below for why this
// can't be derived from toISOString().
function localTodayISO() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

// Bug fix: "today" used to come from new Date().toISOString(), which converts
// to UTC first — for IST (UTC+5:30) that's a different calendar day than the
// user's local "today" for the ~5.5 hours after local midnight, and air_date
// was never validated as a full YYYY-MM-DD before the comparison, so a
// partial/malformed date (e.g. "2026-07") could sort as "already aired"
// against a full date even when the real day hadn't happened yet.
export function hasAired(episode) {
  const airDate = episode.air_date
  return Boolean(airDate && ISO_DATE_RE.test(airDate) && airDate <= localTodayISO())
}

export function formatDate(dateString) {
  if (!dateString) return null
  const date = new Date(dateString + 'T00:00:00')
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
          air_date: ep.air_date,
        }
      }
    }
  }
  return null
}
