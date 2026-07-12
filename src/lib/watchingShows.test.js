import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enrichTrackedShowsForWatching,
  selectTrackedShowsForWatching,
} from './watchingShows'
import { episodeKey } from './watchHelpers'
import { isRepresentedInStats, isVisibleInWatching } from './finishedShows'

describe('Watching archived-show loading', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 12, 12))
  })

  afterEach(() => vi.useRealTimers())

  it('does not fetch seasons for ineligible archived shows', async () => {
    const shows = [
      { tmdb_id: 1, name: 'Active', finished_at: null },
      { tmdb_id: 2, name: 'No return', finished_at: '2026-01-01' },
      { tmdb_id: 3, name: 'Far return', finished_at: '2026-01-01' },
    ]
    const getShowDetails = vi.fn(async (id) => ({
      networks: [],
      seasons: [{ season_number: 1 }],
      next_episode_to_air:
        id === 2 ? null : id === 3 ? { air_date: '2026-09-11', episode_number: 1 } : null,
    }))
    const getSeasonEpisodes = vi.fn(async () => ({ episodes: [] }))

    const { candidates, preloadedById } = await selectTrackedShowsForWatching(shows, getShowDetails)
    const enriched = await enrichTrackedShowsForWatching(
      candidates,
      new Map(),
      preloadedById,
      { getShowDetails, getSeasonEpisodes },
    )

    expect(candidates.map((show) => show.tmdb_id)).toEqual([1])
    expect(enriched[0].status.type).toBe('caughtUp')
    expect(getSeasonEpisodes).toHaveBeenCalledTimes(1)
    expect(getSeasonEpisodes).toHaveBeenCalledWith(1, 1, { refreshDynamic: true })
  })

  it('keeps a returned show eligible after TMDB clears next_episode_to_air on air day', async () => {
    const show = { tmdb_id: 9, name: 'Returning', finished_at: '2026-01-01T00:00:00Z' }
    const upcomingDetails = {
      networks: [],
      seasons: [{ season_number: 2 }],
      next_episode_to_air: { air_date: '2026-08-01', episode_number: 1 },
    }
    const initialDetails = vi.fn(async () => upcomingDetails)

    const initial = await selectTrackedShowsForWatching([show], initialDetails)
    expect(initial.candidates.map((candidate) => candidate.tmdb_id)).toEqual([9])

    vi.setSystemTime(new Date(2026, 7, 2, 12))
    const freshDetails = {
      networks: [],
      seasons: [{ season_number: 2 }],
      next_episode_to_air: null,
      last_episode_to_air: { air_date: '2026-08-01', season_number: 2, episode_number: 1 },
    }
    const getShowDetails = vi.fn(async () => freshDetails)
    const getSeasonEpisodes = vi.fn(async () => ({
      episodes: [{ episode_number: 1, name: 'Premiere', air_date: '2026-08-01' }],
    }))

    const { candidates, preloadedById } = await selectTrackedShowsForWatching([show], getShowDetails)
    expect(candidates.map((candidate) => candidate.tmdb_id)).toEqual([9])
    const enriched = await enrichTrackedShowsForWatching(
      candidates,
      new Map([[9, new Set()]]),
      preloadedById,
      { getShowDetails, getSeasonEpisodes },
    )

    expect(enriched[0].status).toMatchObject({ type: 'nextUp', season_number: 2, episode_number: 1 })
    expect(isVisibleInWatching(enriched[0], enriched[0].status)).toBe(true)
    expect(enriched[0].finished_at).toBe(show.finished_at)
    expect(isRepresentedInStats(enriched[0], [{ tmdb_show_id: 9, key: episodeKey(1, 1) }])).toBe(true)
  })
})
