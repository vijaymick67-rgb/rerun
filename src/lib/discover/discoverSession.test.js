import { afterEach, describe, expect, it } from 'vitest'
import {
  DISCOVER_SESSION_FRESHNESS_MS,
  discoverSession,
  invalidateTrackedSession,
  isTrackedFetchFresh,
  markTrackedFetched,
  readTrackedContent,
  resetDiscoverSession,
  writeTrackedContent,
} from './discoverSession.js'

afterEach(() => {
  resetDiscoverSession()
})

describe('discover session tracked-library snapshot', () => {
  it('starts empty so the first-ever visit has no snapshot to seed from', () => {
    expect(readTrackedContent()).toBeNull()
    expect(isTrackedFetchFresh(Date.now())).toBe(false)
  })

  it('remembers the last snapshot content across reads', () => {
    const content = { shows: [{ tmdb_id: 1 }], ids: new Set([1]), knownIds: new Set([1]) }
    writeTrackedContent(content)
    expect(readTrackedContent()).toBe(content)
  })

  it('treats the fetch clock as fresh only within the window and only after a real read', () => {
    const t0 = 1_000_000
    // Mirroring content must NOT make the clock fresh — only markTrackedFetched does.
    writeTrackedContent({ shows: [], ids: new Set(), knownIds: new Set() })
    expect(isTrackedFetchFresh(t0)).toBe(false)

    markTrackedFetched(t0)
    expect(isTrackedFetchFresh(t0)).toBe(true)
    expect(isTrackedFetchFresh(t0 + DISCOVER_SESSION_FRESHNESS_MS - 1)).toBe(true)
    expect(isTrackedFetchFresh(t0 + DISCOVER_SESSION_FRESHNESS_MS)).toBe(false)
    expect(isTrackedFetchFresh(t0 + DISCOVER_SESSION_FRESHNESS_MS + 5_000)).toBe(false)
  })
})

describe('discover session refresh gate', () => {
  const KEY = '1:The Bear'
  const OTHER = '2:Severance'

  it('reports fresh only for the same identity inside the window', () => {
    const t0 = 5_000_000
    expect(discoverSession.isDiscoverFresh(KEY, t0)).toBe(false)

    discoverSession.markRefreshed(KEY, t0)
    expect(discoverSession.isDiscoverFresh(KEY, t0)).toBe(true)
    expect(discoverSession.isDiscoverFresh(KEY, t0 + DISCOVER_SESSION_FRESHNESS_MS - 1)).toBe(true)
    // Different identity is never fresh off another identity's timestamp.
    expect(discoverSession.isDiscoverFresh(OTHER, t0)).toBe(false)
    // Expires after the window.
    expect(discoverSession.isDiscoverFresh(KEY, t0 + DISCOVER_SESSION_FRESHNESS_MS)).toBe(false)
  })

  it('reuses an in-flight promise per identity and releases only the matching one', () => {
    const promise = Promise.resolve('x')
    expect(discoverSession.getInFlight(KEY)).toBeNull()

    discoverSession.setInFlight(KEY, promise)
    expect(discoverSession.getInFlight(KEY)).toBe(promise)
    expect(discoverSession.getInFlight(OTHER)).toBeNull()

    // A stale clear for the wrong promise is a no-op.
    discoverSession.clearInFlight(KEY, Promise.resolve('other'))
    expect(discoverSession.getInFlight(KEY)).toBe(promise)

    discoverSession.clearInFlight(KEY, promise)
    expect(discoverSession.getInFlight(KEY)).toBeNull()
  })

  it('drops the previous identity when a new one is registered (single-slot)', () => {
    const first = Promise.resolve(1)
    const second = Promise.resolve(2)
    discoverSession.setInFlight(KEY, first)
    discoverSession.setInFlight(OTHER, second)
    expect(discoverSession.getInFlight(KEY)).toBeNull()
    expect(discoverSession.getInFlight(OTHER)).toBe(second)
  })
})

describe('cross-route invalidation', () => {
  const KEY = '1:The Bear'

  it('clears both gates after a mutation elsewhere while keeping snapshot content', () => {
    const now = 9_000_000
    markTrackedFetched(now)
    discoverSession.markRefreshed(KEY, now)
    writeTrackedContent({ shows: [{ tmdb_id: 1 }], ids: new Set([1]), knownIds: new Set([1]) })
    expect(isTrackedFetchFresh(now)).toBe(true)
    expect(discoverSession.isDiscoverFresh(KEY, now)).toBe(true)

    invalidateTrackedSession()

    // Browse will re-read tracked_shows; BrowseDiscover will refresh even for the
    // same identity — neither can trust the pre-mutation snapshot.
    expect(isTrackedFetchFresh(now)).toBe(false)
    expect(discoverSession.isDiscoverFresh(KEY, now)).toBe(false)
    // Content is retained so the return still paints instantly (no skeleton).
    expect(readTrackedContent()).not.toBeNull()
  })
})
