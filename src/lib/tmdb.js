import { normalizeSeasonEpisodes, normalizeShowDetails } from './tmdbNormalize.js'

export { normalizeSeasonEpisodes, normalizeShowDetails }

const BASE_URL = '/api/tmdb'
const CACHE_PREFIX = 'tmdb_cache:'
const CACHE_TIME_PREFIX = 'tmdb_cache_time:'
const DYNAMIC_TMDB_MAX_AGE_MS = 6 * 60 * 60 * 1000

export const POSTER_BASE = 'https://image.tmdb.org/t/p/w342'

// Bump this whenever a cached shape changes OR a data-correctness fix means
// previously-cached values may now be wrong. This is the important one: the
// TMDB cache below lives in localStorage with no expiry, so a show cached
// before a new field was captured holds the old shape forever. A hard refresh
// reloads the JS bundle but NOT localStorage, so a correct code fix cannot
// dislodge a stale cached value. Bumping this version wipes the stale entries
// on next load so they refetch.
// v4: getShowDetails() now also trims in `next_episode_to_air` — shows
// cached before this holds it undefined forever, which would silently fall
// back to "Caught up" instead of a premiere countdown.
const CACHE_SCHEMA_VERSION = '5'
const SCHEMA_KEY = 'tmdb_cache_schema_version'

function pruneCacheIfSchemaChanged() {
  try {
    if (localStorage.getItem(SCHEMA_KEY) === CACHE_SCHEMA_VERSION) return
    let removed = 0
    // Iterate downward so removeItem doesn't shift indexes we haven't seen.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && key.startsWith(CACHE_PREFIX)) {
        localStorage.removeItem(key)
        removed++
      }
    }
    localStorage.setItem(SCHEMA_KEY, CACHE_SCHEMA_VERSION)
    if (removed > 0) {
      console.warn(
        `tmdb cache: schema v${CACHE_SCHEMA_VERSION} → cleared ${removed} stale cached entr${removed === 1 ? 'y' : 'ies'}`,
      )
    }
  } catch {
    // localStorage unavailable — nothing to prune
  }
}

pruneCacheIfSchemaChanged()

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

async function tmdbFetch(path, params = {}, options = {}) {
  const cacheKey = path + '?' + new URLSearchParams(params).toString()
  if (!options.bypassCache) {
    const cached = readCache(cacheKey)
    if (cached) return cached
  }

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

function readCacheTime(cacheKey) {
  try {
    const value = Number(localStorage.getItem(CACHE_TIME_PREFIX + cacheKey))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function cacheTimedResult(cacheKey, value) {
  writeCache(cacheKey, value)
  try {
    localStorage.setItem(CACHE_TIME_PREFIX + cacheKey, String(Date.now()))
  } catch {
    // value caching is still useful when timestamp storage is unavailable
  }
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

// Full show details including season list (not individual episodes — see
// getSeasonEpisodes) and original network names. The release engine derives its
// platform threshold from this already-fetched metadata. See tmdbNormalize.js
// for the shared trimming logic and its cache-schema version history.
export async function getShowDetails(tmdbId, options = {}) {
  const cacheKey = `/tv/${tmdbId}:v4`
  const cached = readCache(cacheKey)
  if (cached && !options.refreshDynamic) return cached
  const cachedAt = readCacheTime(cacheKey)
  if (cached && cachedAt && Date.now() - cachedAt < DYNAMIC_TMDB_MAX_AGE_MS) return cached

  let data
  try {
    // Show status and next_episode_to_air change over time. Refresh this small
    // response periodically so archived shows can discover a newly dated return.
    data = await tmdbFetch(`/tv/${tmdbId}`, {}, { bypassCache: true })
  } catch (error) {
    if (cached) return cached
    throw error
  }
  const trimmed = normalizeShowDetails(data)
  return cacheTimedResult(cacheKey, trimmed)
}

// Episode list for a single season, including per-episode runtime.
export async function getSeasonEpisodes(tmdbId, seasonNumber, options = {}) {
  const cacheKey = `/tv/${tmdbId}/season/${seasonNumber}`
  const cached = readCache(cacheKey)
  if (cached && !options.refreshDynamic) return cached
  const cachedAt = readCacheTime(cacheKey)
  if (cached && cachedAt && Date.now() - cachedAt < DYNAMIC_TMDB_MAX_AGE_MS) return cached

  let data
  try {
    // Episode lists change while a season is approaching/airing. This request
    // is only reached for shows already selected for Watching.
    data = await tmdbFetch(`/tv/${tmdbId}/season/${seasonNumber}`, {}, { bypassCache: true })
  } catch (error) {
    if (cached) return cached
    throw error
  }
  const trimmed = normalizeSeasonEpisodes(data)
  return cacheTimedResult(cacheKey, trimmed)
}

// TMDB external IDs (imdb_id, tvdb_id, …) for a show. Used to bridge a TMDB
// show to its TVmaze entry (TVmaze keys /lookup/shows on imdb=). External IDs
// never change, so this is cached long-lived (no TTL) like search results — the
// TVmaze bridge only needs to resolve once per show. Returns { imdb_id }, where
// imdb_id may be null when TMDB has none (→ no TVmaze match, silent fallback).
export async function getExternalIds(tmdbId) {
  const cacheKey = `/tv/${tmdbId}/external_ids`
  const cached = readCache(cacheKey)
  if (cached) return cached
  const data = await tmdbFetch(`/tv/${tmdbId}/external_ids`)
  return cacheResult(cacheKey, { imdb_id: data.imdb_id ?? null })
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
