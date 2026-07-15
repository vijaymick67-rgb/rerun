import { normalizeSeasonEpisodes, normalizeShowDetails } from '../../src/lib/tmdb.js'

const TMDB_BASE = 'https://api.themoviedb.org/3'

export function createServerTmdbClient(apiKey, fetchImpl = fetch) {
  if (!apiKey) throw new Error('TMDB_API_KEY is required')

  async function request(path) {
    const url = new URL(TMDB_BASE + path)
    url.searchParams.set('api_key', apiKey)
    const response = await fetchImpl(url)
    if (!response.ok) throw new Error(`TMDB ${path} failed (${response.status})`)
    return response.json()
  }

  return {
    async getShowDetails(tmdbId) {
      return normalizeShowDetails(await request(`/tv/${Number(tmdbId)}`))
    },
    async getSeasonEpisodes(tmdbId, seasonNumber) {
      return normalizeSeasonEpisodes(
        await request(`/tv/${Number(tmdbId)}/season/${Number(seasonNumber)}`),
      )
    },
    async getExternalIds(tmdbId) {
      const data = await request(`/tv/${Number(tmdbId)}/external_ids`)
      return { imdb_id: data.imdb_id ?? null }
    },
  }
}
