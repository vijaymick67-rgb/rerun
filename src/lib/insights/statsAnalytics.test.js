import { describe, expect, it } from 'vitest'
import {
  averageRunTime,
  buildComputedStatsShow,
  buildFallbackStatsShow,
  DEFAULT_EPISODE_RUNTIME_MINUTES,
  episodeRuntimeMinutes,
} from './statsAnalytics.js'

function watched(season, episode, watchedAt = '2026-01-01T00:00:00Z') {
  return {
    tmdb_show_id: 7,
    season_number: season,
    episode_number: episode,
    watched_at: watchedAt,
  }
}

describe('Stats computed analytics', () => {
  it('preserves episode -> show average -> flat default runtime fallback order', () => {
    expect(averageRunTime([30, 50, null])).toBe(40)
    expect(episodeRuntimeMinutes(52, 40)).toBe(52)
    expect(episodeRuntimeMinutes(null, 40)).toBe(40)
    expect(episodeRuntimeMinutes(null, null)).toBe(DEFAULT_EPISODE_RUNTIME_MINUTES)
  })

  it('retains compact per-show analytics without changing total watched minutes', () => {
    const result = buildComputedStatsShow({
      showId: 7,
      tracked: {
        name: 'Orbit Show',
        poster_path: '/poster.jpg',
        finished_at: null,
        hidden_at: null,
      },
      details: {
        name: 'Orbit Show',
        episode_run_time: [40],
        genres: ['Drama', 'Mystery', 'Drama'],
        networks: ['HBO', 'HBO'],
        number_of_seasons: 3,
        status: 'Returning Series',
      },
      watchedRows: [
        watched(1, 1, '2026-01-03T00:00:00Z'),
        watched(2, 1, '2026-01-01T00:00:00Z'),
        watched(2, 2, '2026-01-05T00:00:00Z'),
      ],
      seasons: [{ season_number: 1 }, { season_number: 2 }],
      episodesArrays: [
        { episodes: [{ episode_number: 1, runtime: 30 }] },
        {
          episodes: [
            { episode_number: 1, runtime: null },
            { episode_number: 2, runtime: 60 },
          ],
        },
      ],
    })

    expect(result.watchedEpisodeRuntimes).toEqual([30, 40, 60])
    expect(result.minutes).toBe(130)
    expect(result.averageWatchedEpisodeRuntime).toBeCloseTo(130 / 3)
    expect(result.watchedEpisodeCount).toBe(3)
    expect(result.distinctWatchedSeasons).toBe(2)
    expect(result.genres).toEqual(['Drama', 'Mystery'])
    expect(result.networks).toEqual(['HBO'])
    expect(result.firstWatchedAt).toBe('2026-01-01T00:00:00Z')
    expect(result.latestWatchedAt).toBe('2026-01-05T00:00:00Z')
    expect(result.completionRatio).toBe(1)
    expect(result.metadataComplete).toBe(true)
  })

  it('marks metadata-failure fallbacks as ineligible for completion claims', () => {
    const result = buildFallbackStatsShow({
      showId: 7,
      tracked: { name: 'Offline Show' },
      watchedRows: [watched(1, 1), watched(1, 2)],
    })

    expect(result.minutes).toBe(2 * DEFAULT_EPISODE_RUNTIME_MINUTES)
    expect(result.watchedEpisodeRuntimes).toEqual([45, 45])
    expect(result.completionRatio).toBeNull()
    expect(result.metadataComplete).toBe(false)
    expect(result.genres).toEqual([])
  })
})
