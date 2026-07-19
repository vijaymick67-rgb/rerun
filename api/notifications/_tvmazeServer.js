import { withTimeout } from '../../src/lib/dataLoading.js'
import { buildEpisodeReleaseMap, fetchTvmazeEpisodes, fetchTvmazeShowIdByImdb } from '../../src/lib/tvmaze.js'

// Server-side equivalent of src/lib/tvmaze.js's getShowReleaseMap — same
// IMDb-bridge lookup and the same buildEpisodeReleaseMap map shape (both
// imported directly, not reimplemented), no localStorage. Degrades exactly
// like the client version: any failure at any step (no imdb id, no TVmaze
// match, network error, timeout, rate limit) resolves to {}, never throws.
// The per-instance cache (one instance per worker invocation) means N shows
// sharing a TVmaze lookup only ever hit the network once each.
export function createTvmazeServerClient({ fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const showIdCache = new Map()
  const releaseMapCache = new Map()

  function resolveShowId(tmdbId, getExternalIds) {
    if (showIdCache.has(tmdbId)) return showIdCache.get(tmdbId)
    const promise = (async () => {
      try {
        const external = await getExternalIds(tmdbId)
        const imdbId = external?.imdb_id
        if (!imdbId) return null
        return await withTimeout(
          (signal) => fetchTvmazeShowIdByImdb(imdbId, (url) => fetchImpl(url, { signal })),
          { timeoutMs, stage: 'notifications-tvmaze-show-id', source: 'tvmaze' },
        )
      } catch {
        return null
      }
    })()
    showIdCache.set(tmdbId, promise)
    return promise
  }

  function releaseMapForTvmazeId(tvmazeId) {
    if (releaseMapCache.has(tvmazeId)) return releaseMapCache.get(tvmazeId)
    const promise = (async () => {
      try {
        const episodes = await withTimeout(
          (signal) => fetchTvmazeEpisodes(tvmazeId, (url) => fetchImpl(url, { signal })),
          { timeoutMs, stage: 'notifications-tvmaze-episodes', source: 'tvmaze' },
        )
        return buildEpisodeReleaseMap(episodes)
      } catch {
        return {}
      }
    })()
    releaseMapCache.set(tvmazeId, promise)
    return promise
  }

  return {
    async getShowReleaseMap(tmdbId, { getExternalIds }) {
      const tvmazeId = await resolveShowId(tmdbId, getExternalIds)
      if (tvmazeId === null) return {}
      return releaseMapForTvmazeId(tvmazeId)
    },
  }
}
