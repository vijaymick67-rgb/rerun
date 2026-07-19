import { describe, expect, it, vi } from 'vitest'
import { createTmdbServerClient } from './_tmdbServer.js'

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, statusText: 'status', json: async () => body }
}

describe('createTmdbServerClient', () => {
  it('getShowDetails fetches with the api key and trims the same fields the client does', async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toContain('/tv/42')
      expect(String(url)).toContain('api_key=test-key')
      return jsonResponse({
        id: 42,
        name: 'Test Show',
        status: 'Returning Series',
        networks: [{ name: 'HBO' }],
        seasons: [{ season_number: 1, name: 'Season 1', episode_count: 8 }],
        next_episode_to_air: null,
        last_episode_to_air: null,
      })
    })
    const client = createTmdbServerClient({ apiKey: 'test-key', fetchImpl })
    const details = await client.getShowDetails(42)
    expect(details).toMatchObject({ id: 42, name: 'Test Show', networks: ['HBO'] })
  })

  it('caches within one client instance — a second call for the same show does not refetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1, name: 'S', seasons: [] }))
    const client = createTmdbServerClient({ apiKey: 'k', fetchImpl })
    await client.getShowDetails(1)
    await client.getShowDetails(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('getSeasonEpisodes trims runtime/name/air_date per episode', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      season_number: 1,
      episodes: [{ episode_number: 1, name: 'Pilot', air_date: '2026-07-19', runtime: 55, extra: 'drop me' }],
    }))
    const client = createTmdbServerClient({ apiKey: 'k', fetchImpl })
    const season = await client.getSeasonEpisodes(1, 1)
    expect(season.episodes).toEqual([{ episode_number: 1, name: 'Pilot', air_date: '2026-07-19', runtime: 55 }])
  })

  it('getExternalIds returns imdb_id or null', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ imdb_id: 'tt1234567' }))
    const client = createTmdbServerClient({ apiKey: 'k', fetchImpl })
    await expect(client.getExternalIds(1)).resolves.toEqual({ imdb_id: 'tt1234567' })
  })

  it('propagates a rejection on a non-OK response, and evicts the cache entry so a retry can succeed', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      return calls === 1 ? jsonResponse(null, false, 500) : jsonResponse({ id: 1, name: 'S', seasons: [] })
    })
    const client = createTmdbServerClient({ apiKey: 'k', fetchImpl })
    await expect(client.getShowDetails(1)).rejects.toThrow()
    await expect(client.getShowDetails(1)).resolves.toMatchObject({ id: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
