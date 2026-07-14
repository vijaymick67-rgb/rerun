import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getShowAirstamps, getTvmazeShowId } from './tvmaze'

// tvmaze.js caches in localStorage (best-effort, wrapped in try/catch). Node has
// no localStorage, so provide a minimal in-memory stub to exercise the caching
// paths; the module still works without it (every call is a cache miss).
function installLocalStorage() {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  return store
}

// A canned TVmaze /episodes payload: HBO-style Sunday-night drop.
const TVMAZE_EPISODES = [
  { season: 1, number: 1, airstamp: '2026-07-19T21:00:00-04:00' },
  { season: 1, number: 2, airstamp: '2026-07-26T21:00:00-04:00' },
  // Malformed rows are skipped, not thrown on.
  { season: 1, number: null, airstamp: '2026-08-02T21:00:00-04:00' },
  { season: 2, number: 1, airstamp: null },
]

afterEach(() => {
  vi.restoreAllMocks()
  delete globalThis.localStorage
})

describe('getShowAirstamps — TMDB→TVmaze bridge (happy path)', () => {
  beforeEach(() => installLocalStorage())

  it('resolves imdb → tvmaze id → episode airstamp map', async () => {
    const getExternalIds = vi.fn(async () => ({ imdb_id: 'tt1234567' }))
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/lookup/shows'))
        return { ok: true, json: async () => ({ id: 42 }) }
      if (String(url).includes('/shows/42/episodes'))
        return { ok: true, json: async () => TVMAZE_EPISODES }
      throw new Error(`unexpected url ${url}`)
    })

    const map = await getShowAirstamps(1, { getExternalIds })

    expect(map).toEqual({
      '1:1': '2026-07-19T21:00:00-04:00',
      '1:2': '2026-07-26T21:00:00-04:00',
    })
    // The IMDb id is passed to TVmaze's lookup endpoint.
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.tvmaze.com/lookup/shows?imdb=tt1234567',
    )
  })

  it('caches the show-id mapping — the lookup runs once per show', async () => {
    const getExternalIds = vi.fn(async () => ({ imdb_id: 'tt1234567' }))
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/lookup/shows'))
        return { ok: true, json: async () => ({ id: 42 }) }
      return { ok: true, json: async () => TVMAZE_EPISODES }
    })

    await getShowAirstamps(1, { getExternalIds })
    await getShowAirstamps(1, { getExternalIds })

    // Second call reuses the cached tvmaze id — no second external-ids fetch,
    // no second /lookup/shows call.
    expect(getExternalIds).toHaveBeenCalledTimes(1)
    const lookupCalls = global.fetch.mock.calls.filter((c) =>
      String(c[0]).includes('/lookup/shows'),
    )
    expect(lookupCalls).toHaveLength(1)
  })
})

describe('getShowAirstamps — graceful degradation', () => {
  beforeEach(() => installLocalStorage())

  // TEST 3 support: a 404 from TVmaze (no IMDb match) yields an empty map, so
  // callers fall through to the universal anchor with no thrown error.
  it('returns {} on a 404 lookup (no TVmaze match)', async () => {
    const getExternalIds = vi.fn(async () => ({ imdb_id: 'tt0000000' }))
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => null }))

    await expect(getShowAirstamps(1, { getExternalIds })).resolves.toEqual({})
  })

  it('returns {} when TMDB has no imdb_id, without calling TVmaze', async () => {
    const getExternalIds = vi.fn(async () => ({ imdb_id: null }))
    global.fetch = vi.fn()

    await expect(getShowAirstamps(1, { getExternalIds })).resolves.toEqual({})
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns {} on a network error (never throws)', async () => {
    const getExternalIds = vi.fn(async () => ({ imdb_id: 'tt1234567' }))
    global.fetch = vi.fn(async () => {
      throw new Error('network down')
    })

    await expect(getShowAirstamps(1, { getExternalIds })).resolves.toEqual({})
  })

  it('returns {} on a rate-limit (429) response', async () => {
    const getExternalIds = vi.fn(async () => ({ imdb_id: 'tt1234567' }))
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/lookup/shows'))
        return { ok: true, json: async () => ({ id: 42 }) }
      return { ok: false, status: 429, json: async () => null }
    })

    await expect(getShowAirstamps(1, { getExternalIds })).resolves.toEqual({})
  })

  it('getTvmazeShowId returns null when the show is absent from TVmaze', async () => {
    installLocalStorage()
    const getExternalIds = vi.fn(async () => ({ imdb_id: 'tt0000000' }))
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => null }))

    await expect(getTvmazeShowId(1, { getExternalIds })).resolves.toBeNull()
  })
})
