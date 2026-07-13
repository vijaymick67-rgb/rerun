import { describe, expect, it, vi } from 'vitest'
import {
  buildUnwatchedAiredRows,
  markSeasonWatchedMutation,
  toggleEpisodeMutation,
} from './seasonWatchMutations'

const RELEASE_RULE = { timeZone: 'UTC', hour: 0 }
const NOW = '2026-07-12T00:00:00.000Z'

function episode(number, airDate) {
  return { episode_number: number, name: `Episode ${number}`, air_date: airDate, runtime: 42 }
}

function makeSupabase({ upsertError = null, upsertDelay = 0 } = {}) {
  const calls = []
  return {
    calls,
    from() {
      return {
        upsert(rows, options) {
          calls.push({ type: 'upsert', rows, options })
          return new Promise((resolve) => {
            setTimeout(() => resolve({ error: upsertError }), upsertDelay)
          })
        },
        delete() {
          return {
            eq() {
              return this
            },
          }
        },
      }
    },
  }
}

describe('season watch mutations', () => {
  it('builds rows only for aired episodes that are currently unwatched', () => {
    const rows = buildUnwatchedAiredRows({
      episodes: [episode(1, '2020-01-01'), episode(2, '2020-01-02'), episode(3, '2999-01-01')],
      watched: new Set(['1:1']),
      tmdbShowId: 7,
      seasonNumber: 1,
      releaseRule: RELEASE_RULE,
      watchedAt: NOW,
    })

    expect(rows).toEqual([
      {
        tmdb_show_id: 7,
        season_number: 1,
        episode_number: 2,
        episode_name: 'Episode 2',
        runtime_minutes: 42,
        watched_at: NOW,
      },
    ])
  })

  it('does not write or replace existing watched episodes when all aired episodes are watched', async () => {
    const supabase = makeSupabase()
    const commitWatched = vi.fn()

    await markSeasonWatchedMutation({
      supabase,
      episodes: [episode(1, '2020-01-01'), episode(2, '2020-01-02')],
      tmdbShowId: 7,
      seasonNumber: 1,
      releaseRule: RELEASE_RULE,
      getWatched: () => new Set(['1:1', '1:2']),
      commitWatched,
    })

    expect(supabase.calls).toEqual([])
    expect(commitWatched).not.toHaveBeenCalled()
  })

  it('uses duplicate-safe insertion and excludes already watched rows from the payload', async () => {
    const supabase = makeSupabase()
    const commitWatched = vi.fn()

    await markSeasonWatchedMutation({
      supabase,
      episodes: [episode(1, '2020-01-01'), episode(2, '2020-01-02')],
      tmdbShowId: 7,
      seasonNumber: 1,
      releaseRule: RELEASE_RULE,
      getWatched: () => new Set(['1:1']),
      commitWatched,
    })

    expect(supabase.calls[0]).toMatchObject({
      options: {
        onConflict: 'tmdb_show_id,season_number,episode_number',
        ignoreDuplicates: true,
      },
    })
    expect(supabase.calls[0].rows.map((row) => row.episode_number)).toEqual([2])
    expect(supabase.calls[0].rows).not.toContainEqual(
      expect.objectContaining({ episode_number: 1, watched_at: 'ORIGINAL' }),
    )
    expect(commitWatched).toHaveBeenCalledWith(new Set(['1:1', '1:2']))
  })

  it('does not update local state when an individual toggle fails', async () => {
    const supabase = makeSupabase({ upsertError: new Error('write failed') })
    const commitWatched = vi.fn()

    await expect(
      toggleEpisodeMutation({
        supabase,
        tmdbShowId: 7,
        seasonNumber: 1,
        episode: episode(1, '2020-01-01'),
        getWatched: () => new Set(),
        commitWatched,
      }),
    ).rejects.toThrow('write failed')

    expect(commitWatched).not.toHaveBeenCalled()
  })

  it('does not update local state when marking a season fails', async () => {
    const supabase = makeSupabase({ upsertError: new Error('season write failed') })
    const commitWatched = vi.fn()

    await expect(
      markSeasonWatchedMutation({
        supabase,
        episodes: [episode(1, '2020-01-01')],
        tmdbShowId: 7,
        seasonNumber: 1,
        releaseRule: RELEASE_RULE,
        getWatched: () => new Set(),
        commitWatched,
      }),
    ).rejects.toThrow('season write failed')

    expect(commitWatched).not.toHaveBeenCalled()
  })

  it('merges concurrent successful toggles into the final local state and cache', async () => {
    const supabase = makeSupabase({ upsertDelay: 10 })
    let current = new Set()
    let cached = new Set()
    const commitWatched = vi.fn((next) => {
      current = new Set(next)
      cached = new Set(next)
    })
    const getWatched = () => new Set(current)

    await Promise.all([
      toggleEpisodeMutation({
        supabase,
        tmdbShowId: 7,
        seasonNumber: 1,
        episode: episode(1, '2020-01-01'),
        getWatched,
        commitWatched,
      }),
      toggleEpisodeMutation({
        supabase,
        tmdbShowId: 7,
        seasonNumber: 1,
        episode: episode(2, '2020-01-02'),
        getWatched,
        commitWatched,
      }),
    ])

    expect(current).toEqual(new Set(['1:1', '1:2']))
    expect(cached).toEqual(new Set(['1:1', '1:2']))
  })
})
