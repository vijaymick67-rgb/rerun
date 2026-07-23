// Trailer cache + seen-state (Scope L + O). A NEW versioned localStorage
// namespace, separate from announcements and from the legacy news cache.
//
// First-bootstrap behaviour: the feed must NOT dump every historical trailer for
// old tracked shows on first load. On bootstrap we only admit videos published
// within a configurable recent window (default 150 days). After bootstrap we
// retain seen video keys, admit newly discovered qualifying videos, and preserve
// currently-cached items while a background refresh runs.
//
// We separate three states that Scope L calls out:
//   * fetched  — the video was returned by TMDB (transient, not stored here).
//   * displayed/cached — currently in the feed (state.items).
//   * seen     — keys we have already surfaced at least once (state.seenKeys).
// This PR does not add UI read controls; `seenKeys` exists so a later UI can
// distinguish new from already-shown without re-deriving it.

export const TRAILERS_CACHE_KEY = 'rerun_discover_trailers:v1'
export const TRAILERS_CACHE_VERSION = 1
export const TRAILERS_MAX_ITEMS = 60
export const DEFAULT_BOOTSTRAP_WINDOW_MS = 150 * 24 * 60 * 60 * 1000
export const TRAILERS_MAX_SEEN_KEYS = 500

export function emptyTrailersState() {
  return { version: TRAILERS_CACHE_VERSION, items: [], seenKeys: [], bootstrapped: false, lastSuccess: null }
}

function validItem(item) {
  if (!item || typeof item !== 'object') return null
  if (!item.id || !item.videoKey || !item.youtubeUrl) return null
  return item
}

function publishedMs(item) {
  const value = Date.parse(item.publishedAt)
  return Number.isFinite(value) ? value : null
}

export function sanitizeTrailersState(value) {
  if (!value || value.version !== TRAILERS_CACHE_VERSION || !Array.isArray(value.items)) {
    return emptyTrailersState()
  }
  const seen = new Set()
  const items = []
  for (const raw of value.items) {
    const item = validItem(raw)
    if (!item || seen.has(item.videoKey)) continue
    seen.add(item.videoKey)
    items.push(item)
  }
  const seenKeys = [...new Set((Array.isArray(value.seenKeys) ? value.seenKeys : []).filter(
    (k) => typeof k === 'string' && k))].slice(0, TRAILERS_MAX_SEEN_KEYS)
  return {
    version: TRAILERS_CACHE_VERSION,
    items: items.slice(0, TRAILERS_MAX_ITEMS),
    seenKeys,
    bootstrapped: value.bootstrapped === true,
    lastSuccess: Number.isFinite(value.lastSuccess) ? value.lastSuccess : null,
  }
}

export function readTrailersCache(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(TRAILERS_CACHE_KEY)
    return raw ? sanitizeTrailersState(JSON.parse(raw)) : emptyTrailersState()
  } catch {
    return emptyTrailersState()
  }
}

export function writeTrailersCache(state, storage = globalThis.localStorage) {
  const safe = sanitizeTrailersState(state)
  try { storage?.setItem(TRAILERS_CACHE_KEY, JSON.stringify(safe)) } catch { /* best effort */ }
  return safe
}

// Decide which of a freshly-fetched+ranked set of trailers may enter the feed.
// On the very first bootstrap, only videos inside the recent window are
// admitted (an undated video is conservatively excluded on bootstrap). After
// bootstrap, any qualifying video not already seen is admitted.
export function admitTrailers(state, incoming, { now = Date.now(), bootstrapWindowMs = DEFAULT_BOOTSTRAP_WINDOW_MS } = {}) {
  const current = sanitizeTrailersState(state)
  const seen = new Set(current.seenKeys)
  const cachedKeys = new Set(current.items.map((item) => item.videoKey))
  const admitted = []
  for (const trailer of Array.isArray(incoming) ? incoming : []) {
    const item = validItem(trailer)
    if (!item) continue
    if (cachedKeys.has(item.videoKey)) continue
    if (!current.bootstrapped) {
      const published = publishedMs(item)
      // Undated videos are excluded on bootstrap (conservative policy).
      if (published === null || now - published > bootstrapWindowMs) continue
    }
    // A video already seen in a previous session and since evicted is not
    // resurfaced; currently-cached keys were already skipped above.
    if (seen.has(item.videoKey)) continue
    admitted.push(item)
  }
  return admitted
}

// Merge admitted trailers into the cache. Preserves existing cached items
// (stale-while-revalidate), records newly displayed keys as seen, caps size.
export function mergeTrailers(state, incoming, options = {}) {
  const now = options.now ?? Date.now()
  const current = sanitizeTrailersState(state)
  const admitted = admitTrailers(current, incoming, options)
  const byKey = new Map(current.items.map((item) => [item.videoKey, item]))
  for (const item of admitted) byKey.set(item.videoKey, item)

  const items = [...byKey.values()].sort((a, b) => {
    if (a.official !== b.official) return a.official ? -1 : 1
    return (publishedMs(b) ?? 0) - (publishedMs(a) ?? 0)
  }).slice(0, TRAILERS_MAX_ITEMS)

  const seenKeys = [...new Set([...current.seenKeys, ...items.map((item) => item.videoKey)])]
    .slice(-TRAILERS_MAX_SEEN_KEYS)

  return {
    version: TRAILERS_CACHE_VERSION,
    items,
    seenKeys,
    bootstrapped: true,
    lastSuccess: now,
  }
}

// Which admitted trailers are newly discovered (not previously seen). Lets a
// future UI badge "new" without changing what is displayed.
export function newlyDiscoveredKeys(state, incoming, options = {}) {
  const current = sanitizeTrailersState(state)
  const seen = new Set(current.seenKeys)
  return admitTrailers(current, incoming, options)
    .filter((item) => !seen.has(item.videoKey))
    .map((item) => item.videoKey)
}
