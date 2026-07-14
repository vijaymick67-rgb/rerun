const CACHE_KEY = 'watching_cache:v4'

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
