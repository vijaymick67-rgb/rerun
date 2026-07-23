import { describe, it, expect } from 'vitest'
import {
  emptyTrailersState, sanitizeTrailersState, admitTrailers, mergeTrailers,
  newlyDiscoveredKeys, readTrailersCache, TRAILERS_CACHE_KEY, DEFAULT_BOOTSTRAP_WINDOW_MS,
} from './trailerStore.js'

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
    const state = sanitizeTrailersState({ version: 1, items: [trailer(), trailer()], seenKeys: [], bootstrapped: true })
    expect(state.items).toHaveLength(1)
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

  it('admits older-but-new videos after bootstrap (finished show gets a new trailer)', () => {
    const merged = mergeTrailers(emptyTrailersState(), [trailer({ videoKey: 'seed' })], { now: NOW })
    // bootstrapped now true; an item published just outside the window is still
    // admitted because bootstrap is complete.
    const outsideWindow = trailer({
      id: 'trailer:late', videoKey: 'late',
      publishedAt: new Date(NOW - DEFAULT_BOOTSTRAP_WINDOW_MS - 1000).toISOString(),
    })
    const admitted = admitTrailers(merged, [outsideWindow], { now: NOW })
    expect(admitted.map((t) => t.videoKey)).toContain('late')
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
    expect(readTrailersCache(storage)).toEqual(emptyTrailersState())
  })
})
