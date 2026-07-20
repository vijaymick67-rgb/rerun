import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildEpisodeReleaseMap,
  fetchTvmazeEpisodes,
  fetchTvmazeShowIdByImdb,
  getShowAirstamps,
  getTvmazeShowId,
} from './tvmaze'

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
  { id: 101, season: 1, number: 1, name: 'Winter Is Coming', airdate: '2026-07-19', airtime: '21:00', airstamp: '2026-07-19T21:00:00-04:00' },
  { id: 102, season: 1, number: 2, airdate: '2026-07-26', airtime: '21:00', airstamp: '2026-07-26T21:00:00-04:00' },
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
      '1:1': { airstamp: '2026-07-19T21:00:00-04:00', airdate: '2026-07-19', airtime: '21:00', tvmazeEpisodeId: 101, tvmazeName: 'Winter Is Coming' },
      '1:2': { airstamp: '2026-07-26T21:00:00-04:00', airdate: '2026-07-26', airtime: '21:00', tvmazeEpisodeId: 102, tvmazeName: null },
      '2:1': { airstamp: null, airdate: null, airtime: null, tvmazeEpisodeId: null, tvmazeName: null },
    })
    // The IMDb id is passed to TVmaze's lookup endpoint.
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.tvmaze.com/lookup/shows?imdb=tt1234567',
    )
  })

  it('persists the map under the v3 cache namespace, keyed by tvmaze show id', async () => {
    const store = installLocalStorage()
    const getExternalIds = vi.fn(async () => ({ imdb_id: 'tt1234567' }))
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/lookup/shows'))
        return { ok: true, json: async () => ({ id: 42 }) }
      return { ok: true, json: async () => TVMAZE_EPISODES }
    })

    await getShowAirstamps(1, { getExternalIds })

    const cached = JSON.parse(store.get('tvmaze_episodes:v3:42'))
    expect(cached['1:1'].tvmazeName).toBe('Winter Is Coming')
    expect(store.has('tvmaze_episodes:v2:42')).toBe(false)
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

// These are the cache-free primitives the server notification worker calls
// directly (no localStorage in Node) — the same functions the cached client
// path above wraps, so both runtimes are provably resolving releases the
// same way.
describe('cache-free primitives (server worker reuse)', () => {
  it('fetchTvmazeShowIdByImdb resolves an id from a plain injected fetch', async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe('https://api.tvmaze.com/lookup/shows?imdb=tt1234567')
      return { ok: true, json: async () => ({ id: 42 }) }
    })
    await expect(fetchTvmazeShowIdByImdb('tt1234567', fetchImpl)).resolves.toBe(42)
  })

  it('fetchTvmazeShowIdByImdb returns null with no imdbId, without calling fetch', async () => {
    const fetchImpl = vi.fn()
    await expect(fetchTvmazeShowIdByImdb(null, fetchImpl)).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fetchTvmazeShowIdByImdb returns null on a non-OK response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }))
    await expect(fetchTvmazeShowIdByImdb('tt0000000', fetchImpl)).resolves.toBeNull()
  })

  it('fetchTvmazeEpisodes returns the raw payload array', async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe('https://api.tvmaze.com/shows/42/episodes')
      return { ok: true, json: async () => TVMAZE_EPISODES }
    })
    await expect(fetchTvmazeEpisodes(42, fetchImpl)).resolves.toEqual(TVMAZE_EPISODES)
  })

  it('fetchTvmazeEpisodes returns null for a non-numeric id, without calling fetch', async () => {
    const fetchImpl = vi.fn()
    await expect(fetchTvmazeEpisodes(null, fetchImpl)).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('buildEpisodeReleaseMap matches the cached client map for the same payload', () => {
    expect(buildEpisodeReleaseMap(TVMAZE_EPISODES)).toEqual({
      '1:1': { airstamp: '2026-07-19T21:00:00-04:00', airdate: '2026-07-19', airtime: '21:00', tvmazeEpisodeId: 101, tvmazeName: 'Winter Is Coming' },
      '1:2': { airstamp: '2026-07-26T21:00:00-04:00', airdate: '2026-07-26', airtime: '21:00', tvmazeEpisodeId: 102, tvmazeName: null },
      '2:1': { airstamp: null, airdate: null, airtime: null, tvmazeEpisodeId: null, tvmazeName: null },
    })
  })

  it('buildEpisodeReleaseMap tolerates a non-array input', () => {
    expect(buildEpisodeReleaseMap(null)).toEqual({})
    expect(buildEpisodeReleaseMap(undefined)).toEqual({})
  })
})
