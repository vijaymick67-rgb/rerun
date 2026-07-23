import { describe, it, expect } from 'vitest'
import {
  emptyTrailersState, sanitizeTrailersState, admitTrailers, mergeTrailers,
  newlyDiscoveredKeys, readTrailersCache, dismissTrailer, TRAILERS_CACHE_KEY,
} from './trailerStore.js'
import { DISCOVER_TRAILER_MAX_AGE_MS } from './trailerFreshness.js'

const NOW = Date.parse('2026-07-23T00:00:00.000Z')

function trailer(overrides = {}) {
  return {
    id: 'trailer:k1', videoKey: 'k1', youtubeUrl: 'https://www.youtube.com/watch?v=k1',
    official: true, publishedAt: '2026-07-01T00:00:00.000Z', ...overrides,
  }
}

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  }
}

describe('sanitizeTrailersState', () => {
  it('resets a corrupt/wrong-version value', () => {
    expect(sanitizeTrailersState(null)).toEqual(emptyTrailersState())
    expect(sanitizeTrailersState({ version: 9, items: [] })).toEqual(emptyTrailersState())
  })

  it('dedupes items by video key', () => {
    const state = sanitizeTrailersState(
      { version: 2, items: [trailer(), trailer()], knownKeys: [], seenKeys: [], bootstrapped: true },
      { now: NOW },
    )
    expect(state.items).toHaveLength(1)
  })

  it('discards an older cache-schema version (Scope O migration)', () => {
    expect(sanitizeTrailersState({ version: 1, items: [trailer()], seenKeys: ['k1'], bootstrapped: true }))
      .toEqual(emptyTrailersState())
  })
})

describe('bootstrap window', () => {
  it('admits only recent videos on first bootstrap', () => {
    const state = emptyTrailersState()
    const recent = trailer({ id: 'trailer:new', videoKey: 'new', publishedAt: '2026-07-01T00:00:00.000Z' })
    const old = trailer({ id: 'trailer:old', videoKey: 'old', publishedAt: '2024-01-01T00:00:00.000Z' })
    const admitted = admitTrailers(state, [recent, old], { now: NOW })
    expect(admitted.map((t) => t.videoKey)).toEqual(['new'])
  })

  it('excludes undated videos on bootstrap', () => {
    const admitted = admitTrailers(emptyTrailersState(), [trailer({ publishedAt: null })], { now: NOW })
    expect(admitted).toHaveLength(0)
  })

  it('admits a genuinely new recent trailer after bootstrap, even for a finished show', () => {
    const merged = mergeTrailers(emptyTrailersState(), [trailer({ videoKey: 'seed' })], { now: NOW })
    const brandNew = trailer({
      id: 'trailer:late', videoKey: 'late',
      publishedAt: new Date(NOW - DISCOVER_TRAILER_MAX_AGE_MS + 1000).toISOString(),
    })
    const admitted = admitTrailers(merged, [brandNew], { now: NOW })
    expect(admitted.map((t) => t.videoKey)).toContain('late')
  })

  // The core regression: on first bootstrap TMDB returns [recent, ...many old].
  // Only the recent one is displayed, but ALL of them must be baselined so the
  // old ones stay excluded when they come back on the next refresh.
  it('records every qualifying key as baseline on bootstrap so old videos never resurface', () => {
    const recent = trailer({ id: 'trailer:new', videoKey: 'new', publishedAt: '2026-07-01T00:00:00.000Z' })
    const old1 = trailer({ id: 'trailer:o1', videoKey: 'o1', publishedAt: '2023-01-01T00:00:00.000Z' })
    const old2 = trailer({ id: 'trailer:o2', videoKey: 'o2', publishedAt: '2022-05-01T00:00:00.000Z' })
    const undated = trailer({ id: 'trailer:u', videoKey: 'u', publishedAt: null })

    const bootstrap = mergeTrailers(emptyTrailersState(), [recent, old1, old2, undated], { now: NOW })
    // Only the recent video is displayed on bootstrap...
    expect(bootstrap.items.map((t) => t.videoKey)).toEqual(['new'])
    // ...but every qualifying key (displayed, old, and undated) is baselined.
    expect(new Set(bootstrap.knownKeys)).toEqual(new Set(['new', 'o1', 'o2', 'u']))

    // Second refresh returns the same catalogue again: nothing old is admitted.
    const readmit = admitTrailers(bootstrap, [recent, old1, old2, undated], { now: NOW })
    expect(readmit).toHaveLength(0)
    const second = mergeTrailers(bootstrap, [recent, old1, old2, undated], { now: NOW })
    expect(second.items.map((t) => t.videoKey)).toEqual(['new'])
  })

  it('still admits a genuinely new trailer arriving alongside the old catalogue on a later refresh', () => {
    const recent = trailer({ id: 'trailer:new', videoKey: 'new', publishedAt: '2026-07-01T00:00:00.000Z' })
    const old = trailer({ id: 'trailer:o1', videoKey: 'o1', publishedAt: '2023-01-01T00:00:00.000Z' })
    const bootstrap = mergeTrailers(emptyTrailersState(), [recent, old], { now: NOW })

    // A finished show publishes a brand-new trailer; it arrives next to the old
    // catalogue. Only the never-seen key is admitted.
    const fresh = trailer({ id: 'trailer:fresh', videoKey: 'fresh', publishedAt: '2026-07-20T00:00:00.000Z' })
    const admitted = admitTrailers(bootstrap, [recent, old, fresh], { now: NOW })
    expect(admitted.map((t) => t.videoKey)).toEqual(['fresh'])
  })
})

describe('mergeTrailers (stale-while-revalidate + seen-state)', () => {
  it('preserves existing cached items and records seen keys', () => {
    const first = mergeTrailers(emptyTrailersState(), [trailer({ videoKey: 'a' })], { now: NOW })
    expect(first.items.map((t) => t.videoKey)).toEqual(['a'])
    expect(first.seenKeys).toContain('a')
    const second = mergeTrailers(first, [trailer({ id: 'trailer:b', videoKey: 'b', publishedAt: '2026-07-10T00:00:00.000Z' })], { now: NOW })
    expect(second.items.map((t) => t.videoKey).sort()).toEqual(['a', 'b'])
  })

  it('does not resurface a video already seen and evicted', () => {
    const first = mergeTrailers(emptyTrailersState(), [trailer({ videoKey: 'a' })], { now: NOW })
    const admittedAgain = admitTrailers(first, [trailer({ videoKey: 'a' })], { now: NOW })
    expect(admittedAgain).toHaveLength(0) // 'a' already cached/seen
  })

  it('persists a dismissal without weakening the known-key baseline', () => {
    const first = mergeTrailers(emptyTrailersState(), [trailer({ videoKey: 'a' })], { now: NOW })
    const dismissed = dismissTrailer(first, 'a')
    expect(dismissed.items).toEqual([])
    expect(dismissed.dismissedKeys).toContain('a')
    expect(dismissed.knownKeys).toContain('a')
    expect(mergeTrailers(dismissed, [trailer({ videoKey: 'a' })], { now: NOW }).items).toEqual([])
  })
})

describe('newlyDiscoveredKeys', () => {
  it('reports only keys not previously seen', () => {
    const first = mergeTrailers(emptyTrailersState(), [trailer({ videoKey: 'a' })], { now: NOW })
    const keys = newlyDiscoveredKeys(first, [
      trailer({ id: 'trailer:c', videoKey: 'c', publishedAt: '2026-07-15T00:00:00.000Z' }),
    ], { now: NOW })
    expect(keys).toEqual(['c'])
  })
})

describe('cache round-trip', () => {
  it('tolerates malformed JSON', () => {
    const storage = memoryStorage({ [TRAILERS_CACHE_KEY]: '{bad' })
    expect(readTrailersCache(storage, NOW)).toEqual(emptyTrailersState())
  })

  it('prunes expired v2 items while preserving baseline, seen, dismissed, and bootstrap state', () => {
    const expired = trailer({
      id: 'trailer:expired',
      videoKey: 'expired',
      publishedAt: new Date(NOW - DISCOVER_TRAILER_MAX_AGE_MS - 1).toISOString(),
    })
    const recent = trailer({ id: 'trailer:recent', videoKey: 'recent' })
    const storage = memoryStorage({
      [TRAILERS_CACHE_KEY]: JSON.stringify({
        version: 2,
        items: [expired, recent],
        knownKeys: ['historic'],
        seenKeys: ['expired', 'seen-before'],
        dismissedKeys: ['dismissed-before'],
        bootstrapped: true,
        lastSuccess: NOW - 1000,
      }),
    })

    const state = readTrailersCache(storage, NOW)
    expect(state.items.map((item) => item.videoKey)).toEqual(['recent'])
    expect(state.knownKeys).toEqual(expect.arrayContaining(['historic', 'expired', 'recent']))
    expect(state.seenKeys).toEqual(['expired', 'seen-before'])
    expect(state.dismissedKeys).toEqual(['dismissed-before'])
    expect(state.bootstrapped).toBe(true)
  })

  it('never resurrects an expired cached key as newly discovered', () => {
    const expired = trailer({
      id: 'trailer:expired',
      videoKey: 'expired',
      publishedAt: new Date(NOW - DISCOVER_TRAILER_MAX_AGE_MS - 1).toISOString(),
    })
    const sanitized = sanitizeTrailersState({
      version: 2,
      items: [expired],
      knownKeys: [],
      seenKeys: ['expired'],
      dismissedKeys: [],
      bootstrapped: true,
      lastSuccess: NOW,
    }, { now: NOW })
    expect(sanitized.items).toEqual([])
    expect(sanitized.knownKeys).toContain('expired')

    const correctedDate = { ...expired, publishedAt: '2026-07-22T00:00:00.000Z' }
    expect(admitTrailers(sanitized, [correctedDate], { now: NOW })).toEqual([])
    expect(newlyDiscoveredKeys(sanitized, [correctedDate], { now: NOW })).toEqual([])
  })
})
