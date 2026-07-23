// Trailer cache + baseline/seen-state (Scope L + O). A NEW versioned localStorage
// namespace, separate from announcements and from the legacy news cache.
//
// THE BOOTSTRAP-BASELINE GUARANTEE (the important part):
// On the very first load for a set of tracked shows, TMDB returns the ENTIRE
// back-catalogue of qualifying trailers — often years old. We must not dump all
// of that into the feed, and — just as importantly — we must not let those old
// videos sneak in on the *next* refresh either. To make that airtight we record
// a complete baseline of every qualifying key we observed on first bootstrap:
//
//   * displayed     — only videos inside the recent bootstrap window enter the
//                     feed (state.items) on first load.
//   * knownKeys     — EVERY qualifying key observed (displayed or not, dated or
//                     undated) is recorded as baseline-known. This is the anchor
//                     that makes "new" meaningful.
//   * after bootstrap — a video is admitted ONLY if its key is not already known.
//                     A previously-excluded historical key is in `knownKeys`, so
//                     it can never be mistaken for newly discovered and re-admitted.
//
// This means: an old trailer returned again on the second refresh stays excluded
// (its key is baseline-known), while a genuinely newly published trailer — even
// for a long-finished show — has a key we've never seen and is admitted.
//
// We keep three key-sets that Scope L calls out, persisted separately so display
// semantics never bleed into "new" detection:
//   * knownKeys — baseline: every qualifying key ever observed. Drives admission.
//   * seenKeys  — read-state placeholder: keys already surfaced in the feed. Kept
//                 for a later UI "new" badge; NOT used to gate admission.
//   * items     — currently displayed/cached trailers.

export const TRAILERS_CACHE_KEY = 'rerun_discover_trailers:v1'
// v2: added `knownKeys` baseline. Older-shaped caches are discarded by sanitize
// (they re-bootstrap cleanly) — this engine has never shipped to production, so
// no real data is lost, but the version gate keeps Scope O migration honest.
export const TRAILERS_CACHE_VERSION = 2
export const TRAILERS_MAX_ITEMS = 60
export const DEFAULT_BOOTSTRAP_WINDOW_MS = 150 * 24 * 60 * 60 * 1000
export const TRAILERS_MAX_SEEN_KEYS = 500
export const TRAILERS_MAX_DISMISSED_KEYS = 500
// The baseline must not silently forget old keys, or forgotten historical videos
// would resurface. Keep it generous — the qualifying set for a personal tracked
// library is small (tens of shows x a few trailers each).
export const TRAILERS_MAX_KNOWN_KEYS = 5000

export function emptyTrailersState() {
  return {
    version: TRAILERS_CACHE_VERSION,
    items: [],
    knownKeys: [],
    seenKeys: [],
    dismissedKeys: [],
    bootstrapped: false,
    lastSuccess: null,
  }
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

function stringKeys(value, cap) {
  return [...new Set((Array.isArray(value) ? value : []).filter((k) => typeof k === 'string' && k))]
    .slice(0, cap)
}

export function sanitizeTrailersState(value) {
  if (!value || value.version !== TRAILERS_CACHE_VERSION || !Array.isArray(value.items)) {
    return emptyTrailersState()
  }
  const dismissedKeys = [...new Set(
    (Array.isArray(value.dismissedKeys) ? value.dismissedKeys : [])
      .filter((key) => typeof key === 'string' && key),
  )].slice(-TRAILERS_MAX_DISMISSED_KEYS)
  const dismissed = new Set(dismissedKeys)
  const seen = new Set()
  const items = []
  for (const raw of value.items) {
    const item = validItem(raw)
    if (!item || seen.has(item.videoKey) || dismissed.has(item.videoKey)) continue
    seen.add(item.videoKey)
    items.push(item)
  }
  const cappedItems = items.slice(0, TRAILERS_MAX_ITEMS)
  return {
    version: TRAILERS_CACHE_VERSION,
    items: cappedItems,
    // Displayed keys are, by definition, part of the baseline.
    knownKeys: stringKeys([...(Array.isArray(value.knownKeys) ? value.knownKeys : []), ...cappedItems.map((i) => i.videoKey)], TRAILERS_MAX_KNOWN_KEYS),
    seenKeys: stringKeys(value.seenKeys, TRAILERS_MAX_SEEN_KEYS),
    dismissedKeys,
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

// Every qualifying key in `incoming`, regardless of whether it is admitted or
// displayed. This is what gets folded into the baseline so nothing that TMDB
// returned can later be mistaken for "new".
function incomingKeys(incoming) {
  const keys = []
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const item = validItem(raw)
    if (item) keys.push(item.videoKey)
  }
  return keys
}

// Decide which of a freshly-fetched+ranked set of trailers may ENTER the feed.
//   * On first bootstrap: only videos inside the recent window (an undated video
//     is conservatively excluded from display — but it is still recorded as
//     baseline-known by mergeTrailers so it can never resurface later).
//   * After bootstrap: a video is admitted only if its key is not already known
//     (genuinely newly discovered) and not already displayed. "New" is decided
//     by the baseline, never by whether an old video happened to be displayed.
export function admitTrailers(state, incoming, { now = Date.now(), bootstrapWindowMs = DEFAULT_BOOTSTRAP_WINDOW_MS } = {}) {
  const current = sanitizeTrailersState(state)
  const known = new Set(current.knownKeys)
  const cachedKeys = new Set(current.items.map((item) => item.videoKey))
  const admitted = []
  for (const trailer of Array.isArray(incoming) ? incoming : []) {
    const item = validItem(trailer)
    if (!item) continue
    if (cachedKeys.has(item.videoKey)) continue
    if (!current.bootstrapped) {
      const published = publishedMs(item)
      if (published === null || now - published > bootstrapWindowMs) continue
    } else if (known.has(item.videoKey)) {
      // Baseline-known historical key — never resurfaced as if it were new.
      continue
    }
    admitted.push(item)
  }
  return admitted
}

// Merge admitted trailers into the cache. Preserves existing cached items
// (stale-while-revalidate), records the FULL incoming qualifying set into the
// baseline (`knownKeys`) so bootstrap is complete, records newly displayed keys
// as seen, flips `bootstrapped`, and caps every collection.
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

  // Baseline = everything we already knew + everything TMDB just returned
  // (whether or not it was displayed) + everything currently displayed.
  const knownKeys = stringKeys(
    [...current.knownKeys, ...incomingKeys(incoming), ...items.map((item) => item.videoKey)],
    TRAILERS_MAX_KNOWN_KEYS,
  )
  const seenKeys = [...new Set([...current.seenKeys, ...items.map((item) => item.videoKey)])]
    .slice(-TRAILERS_MAX_SEEN_KEYS)

  return {
    version: TRAILERS_CACHE_VERSION,
    items,
    knownKeys,
    seenKeys,
    dismissedKeys: current.dismissedKeys,
    bootstrapped: true,
    lastSuccess: now,
  }
}

// Which admitted trailers are genuinely newly discovered (not in the baseline).
// Lets a future UI badge "new" without changing what is displayed, and without
// inferring "new" from mere non-display of an old historical key.
export function newlyDiscoveredKeys(state, incoming, options = {}) {
  const current = sanitizeTrailersState(state)
  const known = new Set(current.knownKeys)
  return admitTrailers(current, incoming, options)
    .filter((item) => !known.has(item.videoKey))
    .map((item) => item.videoKey)
}

export function dismissTrailer(state, videoKey) {
  const current = sanitizeTrailersState(state)
  if (typeof videoKey !== 'string' || !videoKey) return current
  return sanitizeTrailersState({
    ...current,
    items: current.items.filter((item) => item.videoKey !== videoKey),
    dismissedKeys: [...current.dismissedKeys, videoKey],
  })
}
