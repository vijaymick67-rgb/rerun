// TMDB video + discover fetching for the Trailers engine (Scope J + M).
//
// All requests go through the EXISTING keyed proxy at /api/tmdb/<path> (see
// api/tmdb.js + vercel.json). The TMDB API key stays server-side — this module
// never sees it, so the current key-protection architecture is preserved.
//
// Efficiency (Scope M): responses are cached in a dedicated localStorage
// namespace with a TTL, requests run under a bounded concurrency limit, and a
// failure for one show is isolated (it yields an empty list, never rejecting the
// whole batch). The Marvel/DC discover response gets a longer TTL than
// per-show recent-video refresh.

const VIDEO_CACHE_PREFIX = 'rerun_discover_video_cache:v1:'
const VIDEO_CACHE_TIME_PREFIX = 'rerun_discover_video_time:v1:'
export const VIDEO_TTL_MS = 6 * 60 * 60 * 1000 // per-show videos: 6h
export const DISCOVER_TTL_MS = 24 * 60 * 60 * 1000 // franchise catalogue: 24h
export const DEFAULT_CONCURRENCY = 4

function readTimedCache(key, ttlMs, storage, now) {
  try {
    const at = Number(storage?.getItem(VIDEO_CACHE_TIME_PREFIX + key))
    if (!Number.isFinite(at) || at <= 0 || now - at > ttlMs) return null
    const raw = storage?.getItem(VIDEO_CACHE_PREFIX + key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeTimedCache(key, value, storage, now) {
  try {
    storage?.setItem(VIDEO_CACHE_PREFIX + key, JSON.stringify(value))
    storage?.setItem(VIDEO_CACHE_TIME_PREFIX + key, String(now))
  } catch {
    // best effort
  }
}

function buildUrl(path, params = {}) {
  const query = new URLSearchParams(params).toString()
  return `/api/tmdb${path}${query ? `?${query}` : ''}`
}

// Fetch one JSON resource through the proxy, with timed cache. Returns the parsed
// body or null on any failure (failure isolation — never throws to the caller).
export async function fetchTmdbJson(path, {
  params = {}, ttlMs = VIDEO_TTL_MS, storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch, now = Date.now(), bypassCache = false,
} = {}) {
  const cacheKey = buildUrl(path, params)
  if (!bypassCache) {
    const cached = readTimedCache(cacheKey, ttlMs, storage, now)
    if (cached) return cached
  }
  try {
    const response = await fetchImpl(cacheKey, { headers: { Accept: 'application/json' } })
    if (!response?.ok) return null
    const body = await response.json()
    writeTimedCache(cacheKey, body, storage, now)
    return body
  } catch {
    return null
  }
}

// Run `mapper` over `items` with at most `concurrency` in flight. Each mapper is
// isolated: a rejection becomes null rather than failing the batch.
export async function mapWithConcurrency(items, mapper, concurrency = DEFAULT_CONCURRENCY) {
  const list = Array.isArray(items) ? items : []
  const results = new Array(list.length).fill(null)
  let cursor = 0
  const limit = Math.max(1, concurrency)
  async function worker() {
    while (cursor < list.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = await mapper(list[index], index)
      } catch {
        results[index] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker))
  return results
}

// Fetch the `videos` array for one TV show (or movie). Uses append-free direct
// endpoint. Returns [] on any failure. This is the ONLY TMDB endpoint the
// trailers engine calls — both tracked shows and the explicit Marvel/DC
// media-id allowlist resolve to /{tv|movie}/{id}/videos, so there is no broad
// /discover company query anywhere in the trailer path.
export async function fetchMediaVideos(mediaType, mediaId, options = {}) {
  const type = mediaType === 'movie' ? 'movie' : 'tv'
  const body = await fetchTmdbJson(`/${type}/${mediaId}/videos`, options)
  return Array.isArray(body?.results) ? body.results : []
}
