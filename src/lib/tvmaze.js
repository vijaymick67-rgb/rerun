// TVmaze release-timestamp source.
//
// TMDB gives only a calendar air_date; TVmaze's episode `airstamp` is a full
// ISO 8601 instant with the network's real UTC offset, so it pins the release
// moment timezone-correctly with no arithmetic. This module bridges a TMDB show
// to its TVmaze entry (via the show's IMDb id) and exposes a
// season:episode → airstamp map keyed with Rerun's existing episodeKey scheme.
//
// Everything here degrades silently. Any failure — no IMDb id, no TVmaze match,
// 404, network error, rate limit, malformed JSON — resolves to null / an empty
// map so callers fall straight through to the universal-anchor fallback. It
// never throws and never blocks the UI. A show with no TVmaze data behaves
// exactly as it did before this module existed.
//
// Caching mirrors tmdb.js's stale-while-revalidate pattern (localStorage, JSON,
// a parallel time key). No API key is required by TVmaze, so none is added.

import { episodeKey } from './watchHelpers.js'

const TVMAZE_BASE = 'https://api.tvmaze.com'

// A TVmaze show-id mapping never changes → cached long-lived (no TTL). A
// *negative* result (show absent from TVmaze) is cached with a TTL so a show
// later added to TVmaze is eventually rediscovered instead of written off.
const SHOW_ID_PREFIX = 'tvmaze_showid:v2:'
const NEGATIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000

// Episode airstamps shift while a season is airing → the same 6h staleness
// window getShowDetails/getSeasonEpisodes use, revalidated in the background.
const EPISODES_PREFIX = 'tvmaze_episodes:v2:'
const EPISODES_TIME_PREFIX = 'tvmaze_episodes_time:v2:'
const EPISODES_MAX_AGE_MS = 6 * 60 * 60 * 1000

function readJson(key) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // localStorage full/unavailable — cache is best-effort
  }
}

function readTime(key) {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

// GET → parsed JSON, or null on any non-OK status (404 no-match, 429 rate
// limit, 5xx) or transport/parse error. Callers treat null as "no data".
async function fetchJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url)
  if (!res.ok) return null
  return res.json()
}

// Cache-free network call: TMDB show id → TVmaze show id, via IMDb lookup.
// Exported so the server worker (which has no localStorage) can perform the
// exact same lookup as the cached client version below, instead of a
// separately-written variant that could silently drift from it. `fetchImpl`
// is injected for testability; defaults to the global fetch.
export async function fetchTvmazeShowIdByImdb(imdbId, fetchImpl = fetch) {
  if (!imdbId) return null
  const show = await fetchJson(
    `${TVMAZE_BASE}/lookup/shows?imdb=${encodeURIComponent(imdbId)}`,
    fetchImpl,
  )
  return typeof show?.id === 'number' ? show.id : null
}

// Cache-free network call: TVmaze show id → raw /episodes payload (or null on
// any failure). Exported for server reuse — see fetchTvmazeShowIdByImdb.
export async function fetchTvmazeEpisodes(tvmazeId, fetchImpl = fetch) {
  if (typeof tvmazeId !== 'number') return null
  return fetchJson(`${TVMAZE_BASE}/shows/${tvmazeId}/episodes`, fetchImpl)
}

// Pure transform: raw TVmaze /episodes array → season:episode → release-record
// map, keyed with Rerun's shared episodeKey scheme. The single place this
// shape is built, so the client's cached lookup and the server worker's
// uncached lookup can never subtly disagree on what a "release record" is.
export function buildEpisodeReleaseMap(episodes) {
  const map = {}
  if (!Array.isArray(episodes)) return map
  for (const ep of episodes) {
    if (
      ep &&
      Number.isInteger(ep.season) &&
      Number.isInteger(ep.number)
    ) {
      map[episodeKey(ep.season, ep.number)] = {
        airstamp: typeof ep.airstamp === 'string' ? ep.airstamp : null,
        airdate: typeof ep.airdate === 'string' ? ep.airdate : null,
        airtime: typeof ep.airtime === 'string' ? ep.airtime : null,
        tvmazeEpisodeId: typeof ep.id === 'number' ? ep.id : null,
      }
    }
  }
  return map
}

// Resolve (and cache) the TVmaze show id for a TMDB show, bridging via IMDb.
// `getExternalIds` is injected (the tmdb.js function) so this stays testable
// without a live TMDB proxy. Returns a number, or null when unmatched/failed.
export async function getTvmazeShowId(tmdbId, { getExternalIds }) {
  const cached = readJson(SHOW_ID_PREFIX + tmdbId)
  if (cached) {
    // Positive mappings are immutable → use forever.
    if (typeof cached.id === 'number') return cached.id
    // Fresh negative → don't hammer the lookup; stale negative → retry below.
    if (Date.now() - (cached.at ?? 0) < NEGATIVE_MAX_AGE_MS) return null
  }

  try {
    const external = await getExternalIds(tmdbId)
    const imdbId = external?.imdb_id
    if (!imdbId) {
      writeJson(SHOW_ID_PREFIX + tmdbId, { id: null, at: Date.now() })
      return null
    }
    const id = await fetchTvmazeShowIdByImdb(imdbId)
    writeJson(SHOW_ID_PREFIX + tmdbId, { id, at: Date.now() })
    return id
  } catch {
    // Network/parse error: reuse a stale positive mapping if we have one.
    return typeof cached?.id === 'number' ? cached.id : null
  }
}

// season:episode → release-record map for a TVmaze show. Stale-while-revalidate: a
// fresh cached map is returned as-is; otherwise refetched, falling back to the
// stale map (or an empty map) if the request fails. Never throws.
export async function getEpisodeReleaseMap(tvmazeId) {
  if (typeof tvmazeId !== 'number') return {}

  const cacheKey = EPISODES_PREFIX + tvmazeId
  const cached = readJson(cacheKey)
  const cachedAt = readTime(EPISODES_TIME_PREFIX + tvmazeId)
  if (cached && cachedAt && Date.now() - cachedAt < EPISODES_MAX_AGE_MS) return cached

  try {
    const episodes = await fetchTvmazeEpisodes(tvmazeId)
    if (!Array.isArray(episodes)) return cached ?? {}
    const map = buildEpisodeReleaseMap(episodes)
    writeJson(cacheKey, map)
    writeJson(EPISODES_TIME_PREFIX + tvmazeId, Date.now())
    return map
  } catch {
    return cached ?? {}
  }
}

// High-level convenience: season:episode → release-record map for a TMDB show,
// resolving the TVmaze id and episode list in one call. Returns {} (never
// throws) when the show has no TVmaze match or any step fails, so the caller
// falls through to the universal anchor with no special-casing.
export async function getShowReleaseMap(tmdbId, deps) {
  try {
    const tvmazeId = await getTvmazeShowId(tmdbId, deps)
    if (tvmazeId === null) return {}
    return await getEpisodeReleaseMap(tvmazeId)
  } catch {
    return {}
  }
}

// Backwards-compatible name while callers migrate; values are v2 release objects.
export const getShowAirstamps = getShowReleaseMap
