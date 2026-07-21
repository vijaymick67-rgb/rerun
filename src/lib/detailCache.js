// Shared localStorage cache helpers for ShowDetail/SeasonDetail's
// stale-while-revalidate pattern (same shape as Watching.jsx's CACHE_KEY
// pattern). Exposed as read/write/clear on an explicit key rather than
// baked-in constants, since SeasonDetail needs to patch ShowDetail's cache
// (and vice versa) after a watched-toggle mutation, not just its own.

import { episodeKey } from './watchHelpers.js'

export function showDetailCacheKey(tmdbId) {
  return `showdetail_cache:v1:${tmdbId}`
}

export function seasonDetailCacheKey(tmdbId, seasonNumber) {
  return `seasondetail_cache:v1:${tmdbId}:${seasonNumber}`
}

export function readDetailCache(key) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function writeDetailCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore quota/serialization errors, cache is best-effort
  }
}

export function clearDetailCache(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

const DETAIL_CACHE_PREFIXES = ['showdetail_cache:v1:', 'seasondetail_cache:v1:']

// Clears every show/season detail entry regardless of tmdbId — unlike
// clearDetailCache (one known key), there's no fixed list of keys to name,
// since one exists per show/season ever opened. Used on sign-out so watched
// state cached here can't be read back before the next owner signs in.
export function clearAllDetailCaches() {
  resetOptimisticWatchOverlay()
  try {
    const keysToRemove = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key && DETAIL_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        keysToRemove.push(key)
      }
    }
    for (const key of keysToRemove) localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

// --- Cross-route optimistic watch overlay ---------------------------------
// A Watching quick tick (or a Season Detail toggle) patches the localStorage
// caches synchronously, but the Supabase upsert behind it is still in flight.
// If the user immediately opens Show/Season Detail, that route mounts, seeds
// its watched set from the just-patched cache, and ALSO kicks off its own
// background watched_episodes read. That read can have captured its snapshot
// before the upsert became visible, so it returns the pre-tick rows — which
// would revert the optimistic state the instant it resolves and rewrite the
// cache stale.
//
// The route's own mutationQueue.version guard can't catch this: the tick ran
// in a different component's queue, before this route even mounted, so the
// captured version already matches. This registry closes that gap. It records
// the exact episodes with an in-flight cross-route optimistic change, plus a
// monotonic revision bumped whenever the registry changes. A detail loader
// (a) reconciles its fetched watched list against any still-pending overlay,
// and (b) if the overlay set changed at all while its fetch was in flight,
// keeps its live optimistic state rather than the possibly-stale snapshot.
// Together those cover an overlay still pending at commit and one that settled
// mid-fetch. Entries clear when the originating mutation settles (success or
// failure) — on failure the cache patch has already rolled back; on success
// the server reflects the change and later reads are authoritative.
const optimisticWatchOverlay = new Map() // `${tmdbShowId}:${season}:${episode}` -> watched(boolean)
let optimisticWatchRevision = 0

function overlayKey(tmdbShowId, seasonNumber, episodeNumber) {
  return `${Number(tmdbShowId)}:${Number(seasonNumber)}:${Number(episodeNumber)}`
}

export function getOptimisticWatchRevision() {
  return optimisticWatchRevision
}

export function setOptimisticWatchOverlay({ tmdbShowId, seasonNumber, episodeNumber, watched }) {
  optimisticWatchOverlay.set(overlayKey(tmdbShowId, seasonNumber, episodeNumber), watched)
  optimisticWatchRevision += 1
}

export function clearOptimisticWatchOverlay({ tmdbShowId, seasonNumber, episodeNumber }) {
  if (optimisticWatchOverlay.delete(overlayKey(tmdbShowId, seasonNumber, episodeNumber))) {
    optimisticWatchRevision += 1
  }
}

export function resetOptimisticWatchOverlay() {
  if (optimisticWatchOverlay.size > 0) {
    optimisticWatchOverlay.clear()
    optimisticWatchRevision += 1
  }
}

// Applies every still-pending overlay entry for this show (optionally scoped
// to a single season, for the Season Detail loader whose watched list only
// ever holds that season's keys) on top of a freshly fetched watched-key
// list, so a detail load that read stale rows can't drop an episode whose
// optimistic mutation hasn't settled yet. Returns a new array; keys not named
// by a pending overlay are carried through untouched.
export function reconcileWatchedListWithOverlay(tmdbShowId, watchedList, { seasonNumber } = {}) {
  const next = new Set(Array.isArray(watchedList) ? watchedList : [])
  for (const [k, watched] of optimisticWatchOverlay) {
    const [showPart, seasonPart, episodePart] = k.split(':')
    if (Number(showPart) !== Number(tmdbShowId)) continue
    const season = Number(seasonPart)
    if (seasonNumber != null && season !== Number(seasonNumber)) continue
    const key = episodeKey(season, Number(episodePart))
    if (watched) next.add(key)
    else next.delete(key)
  }
  return [...next]
}

export function patchShowDetailState(tmdbId, patch) {
  const key = showDetailCacheKey(tmdbId)
  const cached = readDetailCache(key)
  if (!cached?.show) return
  writeDetailCache(key, {
    ...cached,
    show: { ...cached.show, ...patch },
  })
}

function withPatchedWatchedKey(watchedList, key, watched) {
  // Only an array is a valid watched list. A malformed non-array value (e.g. a
  // string) is iterable and would seed the Set with individual characters, so
  // normalise it to empty rather than spreading garbage into the cache.
  const next = new Set(Array.isArray(watchedList) ? watchedList : [])
  if (watched) next.add(key)
  else next.delete(key)
  return [...next]
}

// Patches exactly one episode's watched state into whichever of the Show
// Detail / Season Detail localStorage caches currently exist for it — the
// mechanism that lets Watching's quick-mark tap keep those two
// stale-while-revalidate caches coherent with the optimistic mutation it
// just committed, without waiting on the Supabase round-trip. Called once
// per optimistic commit (see seasonWatchMutations.js's commitWatched
// contract) and once again, with the opposite `watched` value, on rollback —
// so it naturally inherits that mechanism's per-mutation version protection
// instead of needing an independent rollback path.
//
// Each cache is patched only if it already holds a recognizable, validly
// shaped entry (the same `cached?.show` / episodes-array checks the routes
// themselves rely on) — a cache that was never opened, or one that failed to
// parse, is left alone rather than fabricated. Every other field on a
// patched cache (show/seasons/episodesBySeason, or showName/episodes) is
// carried over unchanged, and only the exact `episodeKey` for this episode
// is added to or removed from that cache's own watchedList.
export function patchEpisodeWatchedCaches({ tmdbShowId, seasonNumber, episodeNumber, watched }) {
  const key = episodeKey(seasonNumber, episodeNumber)
  let showPatched = false
  let seasonPatched = false

  const showKey = showDetailCacheKey(tmdbShowId)
  const showCached = readDetailCache(showKey)
  if (showCached?.show) {
    writeDetailCache(showKey, {
      ...showCached,
      watchedList: withPatchedWatchedKey(showCached.watchedList, key, watched),
    })
    showPatched = true
  }

  const seasonKey = seasonDetailCacheKey(tmdbShowId, seasonNumber)
  const seasonCached = readDetailCache(seasonKey)
  if (seasonCached && Array.isArray(seasonCached.episodes)) {
    writeDetailCache(seasonKey, {
      ...seasonCached,
      watchedList: withPatchedWatchedKey(seasonCached.watchedList, key, watched),
    })
    seasonPatched = true
  }

  return { showPatched, seasonPatched }
}
