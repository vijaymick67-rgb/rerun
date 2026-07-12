const BASE_URL = '/api/tmdb'
const CACHE_PREFIX = 'tmdb_cache:'

export const POSTER_BASE = 'https://image.tmdb.org/t/p/w342'

// Bump this whenever a cached shape changes OR a data-correctness fix means
// previously-cached values may now be wrong. This is the important one: the
// TMDB cache below lives in localStorage with no expiry, so a show cached
// before its `networks` were captured holds `networks: []` forever, which
// silently disables the IST day-shift (dayShiftForNetworks([]) === 0) and
// leaves the raw US air_date on screen — e.g. Sugar S2E4 stuck on "Jul 9"
// instead of "Jul 10". A hard refresh reloads the JS bundle but NOT
// localStorage, so a correct code fix cannot dislodge a stale cached value.
// Bumping this version wipes the stale entries on next load so they refetch.
// v4: getShowDetails() now also trims in `next_episode_to_air` — shows
// cached before this holds it undefined forever, which would silently fall
// back to "Caught up" instead of a premiere countdown.
const CACHE_SCHEMA_VERSION = '4'
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

// Full show details including season list (not individual episodes — see
// getSeasonEpisodes) and network names (used to correct TMDB's US air_date
// to the IST-effective release day — see lib/networkReleaseTiming.js).
//
// Cache key bumped across versions so shows cached before a field was added
// here get re-trimmed from the underlying tmdbFetch response (already cached
// raw — TMDB's /tv/{id} always includes these fields — so this is not a new
// network call) instead of silently missing the field forever:
//   :v2 added `networks`
//   :v3 added `episode_run_time` (per-show runtime fallback used by Stats
//       when an individual episode's own runtime is null)
export async function getShowDetails(tmdbId) {
  const cacheKey = `/tv/${tmdbId}:v3`
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
    // TMDB's show-level typical runtime(s), in minutes — used as a fallback
    // for episodes whose own `runtime` is null (see Stats time computation).
    episode_run_time: data.episode_run_time ?? [],
    next_episode_to_air: data.next_episode_to_air
      ? {
          air_date: data.next_episode_to_air.air_date,
          season_number: data.next_episode_to_air.season_number,
          episode_number: data.next_episode_to_air.episode_number,
          name: data.next_episode_to_air.name,
        }
      : null,
    networks: (data.networks ?? []).map((network) => network.name),
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
