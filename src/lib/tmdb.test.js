// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SCHEMA_KEY = 'tmdb_cache_schema_version'
const OLD_DETAILS_KEY = 'tmdb_cache:/tv/42:v4'
const NEW_DETAILS_KEY = 'tmdb_cache:/tv/42:v5'
const SEASON_KEY = 'tmdb_cache:/tv/42/season/1'

describe('TMDB genre cache migration', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    localStorage.setItem(SCHEMA_KEY, '5')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('refetches old show details while preserving cached season episodes', async () => {
    const oldDetails = {
      id: 42,
      name: 'Old normalized details',
      networks: ['HBO'],
      seasons: [{ season_number: 1 }],
    }
    const cachedSeason = {
      season_number: 1,
      name: 'Season 1',
      episodes: [{ episode_number: 1, name: 'Pilot', runtime: 52 }],
    }
    localStorage.setItem(OLD_DETAILS_KEY, JSON.stringify(oldDetails))
    localStorage.setItem(SEASON_KEY, JSON.stringify(cachedSeason))

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: 42,
        name: 'Fresh details',
        genres: [
          { id: 18, name: 'Drama' },
          { id: 9648, name: 'Mystery' },
        ],
        networks: [{ id: 49, name: 'HBO' }],
        seasons: [{ season_number: 1, name: 'Season 1', episode_count: 8 }],
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { getSeasonEpisodes, getShowDetails } = await import('./tmdb.js')
    const details = await getShowDetails(42)
    const season = await getSeasonEpisodes(42, 1)

    expect(details.genres).toEqual(['Drama', 'Mystery'])
    expect(season).toEqual(cachedSeason)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/tmdb/tv/42')
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('/season/')
    expect(JSON.parse(localStorage.getItem(OLD_DETAILS_KEY))).toEqual(oldDetails)
    expect(JSON.parse(localStorage.getItem(SEASON_KEY))).toEqual(cachedSeason)
    expect(JSON.parse(localStorage.getItem(NEW_DETAILS_KEY))).toMatchObject({
      id: 42,
      genres: ['Drama', 'Mystery'],
    })
    expect(localStorage.getItem(SCHEMA_KEY)).toBe('5')
  })
})
