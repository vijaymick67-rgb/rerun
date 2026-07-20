import { describe, expect, it, vi } from 'vitest'
import { createTvmazeServerClient } from './_tvmazeServer.js'

const TVMAZE_EPISODES = [
  { id: 101, season: 1, number: 1, name: 'Winter Is Coming', airdate: '2026-07-19', airtime: '21:00', airstamp: '2026-07-19T21:00:00-04:00' },
]

describe('createTvmazeServerClient', () => {
  it('resolves imdb → tvmaze id → episode release map, matching the client shape', async () => {
    const getExternalIds = vi.fn(async () => ({ imdb_id: 'tt1234567' }))
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/lookup/shows')) return { ok: true, json: async () => ({ id: 42 }) }
      if (String(url).includes('/shows/42/episodes')) return { ok: true, json: async () => TVMAZE_EPISODES }
      throw new Error(`unexpected url ${url}`)
    })
    const client = createTvmazeServerClient({ fetchImpl })
    const map = await client.getShowReleaseMap(1, { getExternalIds })
    expect(map).toEqual({
      '1:1': {
        airstamp: '2026-07-19T21:00:00-04:00', airdate: '2026-07-19', airtime: '21:00',
        tvmazeEpisodeId: 101, tvmazeName: 'Winter Is Coming',
      },
    })
  })

  it('caches the show-id and episode map within one client instance', async () => {
    const getExternalIds = vi.fn(async () => ({ imdb_id: 'tt1234567' }))
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/lookup/shows')) return { ok: true, json: async () => ({ id: 42 }) }
      return { ok: true, json: async () => TVMAZE_EPISODES }
    })
    const client = createTvmazeServerClient({ fetchImpl })
    await client.getShowReleaseMap(1, { getExternalIds })
    await client.getShowReleaseMap(1, { getExternalIds })
    expect(getExternalIds).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes('/lookup/shows'))).toHaveLength(1)
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes('/episodes'))).toHaveLength(1)
  })

  it('returns {} without calling TVmaze when TMDB has no imdb_id', async () => {
    const getExternalIds = vi.fn(async () => ({ imdb_id: null }))
    const fetchImpl = vi.fn()
    const client = createTvmazeServerClient({ fetchImpl })
    await expect(client.getShowReleaseMap(1, { getExternalIds })).resolves.toEqual({})
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns {} on a 404 lookup (no TVmaze match), never throws', async () => {
    const getExternalIds = vi.fn(async () => ({ imdb_id: 'tt0000000' }))
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }))
    const client = createTvmazeServerClient({ fetchImpl })
    await expect(client.getShowReleaseMap(1, { getExternalIds })).resolves.toEqual({})
  })

  it('returns {} when getExternalIds itself rejects', async () => {
    const getExternalIds = vi.fn(async () => { throw new Error('tmdb down') })
    const fetchImpl = vi.fn()
    const client = createTvmazeServerClient({ fetchImpl })
    await expect(client.getShowReleaseMap(1, { getExternalIds })).resolves.toEqual({})
  })

  it('returns {} when the episodes fetch fails after a successful id lookup', async () => {
    const getExternalIds = vi.fn(async () => ({ imdb_id: 'tt1234567' }))
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/lookup/shows')) return { ok: true, json: async () => ({ id: 42 }) }
      throw new Error('network down')
    })
    const client = createTvmazeServerClient({ fetchImpl })
    await expect(client.getShowReleaseMap(1, { getExternalIds })).resolves.toEqual({})
  })
})
