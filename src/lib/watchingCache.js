// v5: rows now carry releasedEpisodeCount/releasedWatchedCount/releasedProgress
// and nextReleasedUnwatchedEpisode (released-only progress bar + Watching
// quick mark). Bumped so a stale v4 entry never renders a bar or a quick-mark
// control from data it doesn't actually have.
//
// v6: rows now also carry `nextScheduledEpisode` — a lightweight candidate
// (season_number, episode_number, name, runtime, and an already-resolved
// `release: { timestamp, istDate }`) used to synchronously advance a stale
// cached countdown to `nextUp` before first render, when the real world has
// already crossed that resolved instant (see watchingCacheTransition.js).
// Bumped so a stale v5 entry — which has no such candidate — is never fed
// into the transition helper as if it were shaped like a v6 row.
const CACHE_KEY = 'watching_cache:v6'

export function loadWatchingCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveWatchingCache(shows) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(shows))
  } catch {
    // best-effort cache
  }
}

export function clearWatchingCache() {
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    // best-effort cache
  }
}

export function removeWatchingShow(tmdbId) {
  const shows = loadWatchingCache()
  if (!shows) return
  saveWatchingCache(shows.filter((show) => show.tmdb_id !== tmdbId && show.id !== tmdbId))
}
