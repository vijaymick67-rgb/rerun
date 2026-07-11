const BASE_URL = '/api/tmdb'
const CACHE_PREFIX = 'tmdb_cache:'

export const POSTER_BASE = 'https://image.tmdb.org/t/p/w342'

function readCache(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value))
  } catch {
    // localStorage full or unavailable — skip caching silently
  }
}

async function tmdbFetch(path, params = {}) {
  const cacheKey = path + '?' + new URLSearchParams(params).toString()
  const cached = readCache(cacheKey)
  if (cached) return cached

  const url = new URL(BASE_URL + path, window.location.origin)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`TMDB request failed: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

function cacheResult(cacheKey, value) {
  writeCache(cacheKey, value)
  return value
}

// Search TV shows by name. Returns a trimmed list of results.
export async function searchShows(query) {
  const cacheKey = `/search/tv?query=${query}`
  const cached = readCache(cacheKey)
  if (cached) return cached

  const data = await tmdbFetch('/search/tv', { query })
  const trimmed = (data.results ?? []).map((show) => ({
    id: show.id,
    name: show.name,
    poster_path: show.poster_path,
    first_air_date: show.first_air_date,
    overview: show.overview,
  }))
  return cacheResult(cacheKey, trimmed)
}

// Full show details including season list (not individual episodes — see getSeasonEpisodes).
export async function getShowDetails(tmdbId) {
  const cacheKey = `/tv/${tmdbId}`
  const cached = readCache(cacheKey)
  if (cached) return cached

  const data = await tmdbFetch(`/tv/${tmdbId}`)
  const trimmed = {
    id: data.id,
    name: data.name,
    overview: data.overview,
    poster_path: data.poster_path,
    first_air_date: data.first_air_date,
    status: data.status,
    number_of_seasons: data.number_of_seasons,
    number_of_episodes: data.number_of_episodes,
    seasons: (data.seasons ?? []).map((season) => ({
      season_number: season.season_number,
      name: season.name,
      episode_count: season.episode_count,
      air_date: season.air_date,
      poster_path: season.poster_path,
    })),
  }
  return cacheResult(cacheKey, trimmed)
}

// Episode list for a single season, including per-episode runtime.
export async function getSeasonEpisodes(tmdbId, seasonNumber) {
  const cacheKey = `/tv/${tmdbId}/season/${seasonNumber}`
  const cached = readCache(cacheKey)
  if (cached) return cached

  const data = await tmdbFetch(`/tv/${tmdbId}/season/${seasonNumber}`)
  const trimmed = {
    season_number: data.season_number,
    name: data.name,
    episodes: (data.episodes ?? []).map((ep) => ({
      episode_number: ep.episode_number,
      name: ep.name,
      air_date: ep.air_date,
      runtime: ep.runtime,
    })),
  }
  return cacheResult(cacheKey, trimmed)
}

// A single episode's runtime in minutes (real per-episode runtime, not an estimate).
export async function getEpisodeRuntime(tmdbId, seasonNumber, episodeNumber) {
  const cacheKey = `/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}:runtime`
  const cached = readCache(cacheKey)
  if (cached !== null) return cached

  const data = await tmdbFetch(
    `/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}`,
  )
  return cacheResult(cacheKey, data.runtime ?? null)
}
