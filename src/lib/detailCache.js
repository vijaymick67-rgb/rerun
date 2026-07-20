// Shared localStorage cache helpers for ShowDetail/SeasonDetail's
// stale-while-revalidate pattern (same shape as Watching.jsx's CACHE_KEY
// pattern). Exposed as read/write/clear on an explicit key rather than
// baked-in constants, since SeasonDetail needs to patch ShowDetail's cache
// (and vice versa) after a watched-toggle mutation, not just its own.

export function showDetailCacheKey(tmdbId) {
  return `showdetail_cache:v1:${tmdbId}`
}

export function seasonDetailCacheKey(tmdbId, seasonNumber) {
  return `seasondetail_cache:v1:${tmdbId}:${seasonNumber}`
}

export function readDetailCache(key) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function writeDetailCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore quota/serialization errors, cache is best-effort
  }
}

export function clearDetailCache(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

const DETAIL_CACHE_PREFIXES = ['showdetail_cache:v1:', 'seasondetail_cache:v1:']

// Clears every show/season detail entry regardless of tmdbId — unlike
// clearDetailCache (one known key), there's no fixed list of keys to name,
// since one exists per show/season ever opened. Used on sign-out so watched
// state cached here can't be read back before the next owner signs in.
export function clearAllDetailCaches() {
  try {
    const keysToRemove = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key && DETAIL_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        keysToRemove.push(key)
      }
    }
    for (const key of keysToRemove) localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export function patchShowDetailState(tmdbId, patch) {
  const key = showDetailCacheKey(tmdbId)
  const cached = readDetailCache(key)
  if (!cached?.show) return
  writeDetailCache(key, {
    ...cached,
    show: { ...cached.show, ...patch },
  })
}
