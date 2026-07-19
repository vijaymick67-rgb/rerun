import { withTimeout } from '../../src/lib/dataLoading.js'
import { normalizeSeasonEpisodes, normalizeShowDetails } from '../../src/lib/tmdbNormalize.js'

const TMDB_BASE_URL = 'https://api.themoviedb.org/3'

async function tmdbGet(path, { apiKey, fetchImpl, timeoutMs, stage }) {
  return withTimeout(
    async (signal) => {
      const url = new URL(TMDB_BASE_URL + path)
      url.searchParams.set('api_key', apiKey)
      const res = await fetchImpl(url, { signal })
      if (!res.ok) throw new Error(`TMDB request failed: ${res.status} ${res.statusText}`)
      return res.json()
    },
    { timeoutMs, stage, source: 'tmdb' },
  )
}

// Server-side equivalent of src/lib/tmdb.js's getShowDetails/getSeasonEpisodes/
// getExternalIds — same trimming (tmdbNormalize.js, shared with the client so
// the two runtimes can't drift), no localStorage (Node has none), bounded
// request timeouts, and a per-instance in-flight/result cache so a single
// worker run never issues the same request twice even if two shows happen to
// share a lookup. The cache lives only for one createTmdbServerClient()
// instance — i.e. one worker invocation — never across runs.
export function createTmdbServerClient({ apiKey, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const cache = new Map()

  function cached(key, loader) {
    if (cache.has(key)) return cache.get(key)
    const promise = loader().catch((err) => {
      cache.delete(key)
      throw err
    })
    cache.set(key, promise)
    return promise
  }

  return {
    getShowDetails(tmdbId) {
      return cached(`details:${tmdbId}`, async () => {
        const data = await tmdbGet(`/tv/${tmdbId}`, {
          apiKey, fetchImpl, timeoutMs, stage: 'notifications-show-details',
        })
        return normalizeShowDetails(data)
      })
    },
    getSeasonEpisodes(tmdbId, seasonNumber) {
      return cached(`season:${tmdbId}:${seasonNumber}`, async () => {
        const data = await tmdbGet(`/tv/${tmdbId}/season/${seasonNumber}`, {
          apiKey, fetchImpl, timeoutMs, stage: 'notifications-season-episodes',
        })
        return normalizeSeasonEpisodes(data)
      })
    },
    getExternalIds(tmdbId) {
      return cached(`external:${tmdbId}`, async () => {
        const data = await tmdbGet(`/tv/${tmdbId}/external_ids`, {
          apiKey, fetchImpl, timeoutMs, stage: 'notifications-external-ids',
        })
        return { imdb_id: data.imdb_id ?? null }
      })
    },
  }
}
