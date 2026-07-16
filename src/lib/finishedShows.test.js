import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  finishTrackedShows,
  isPersonallyFinished,
  isRepresentedInStats,
  isVisibleInWatching,
  restoreTrackedShow,
  shouldFinishedShowReturn,
} from './finishedShows'
import { planBulkMark } from './bulkMarkWatched'
import { computeWatchingStatus, watchingStatusLabel } from './watchHelpers'

function makeSupabase() {
  const finished = new Map()
  const watchedEpisodes = new Map([['1|1|1', { watched_at: 'ORIGINAL' }]])
  return {
    finished,
    watchedEpisodes,
    from(table) {
      return {
        update(values) {
          return {
            eq(_, tmdbId) {
              if (table === 'tracked_shows') finished.set(tmdbId, values.finished_at)
              return Promise.resolve({ error: null })
            },
          }
        },
      }
    },
  }
}

describe('personal finished state', () => {
  const caughtUp = { type: 'caughtUp' }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 12, 12))
  })

  afterEach(() => vi.useRealTimers())

  it('hides caught-up shows while keeping next-up and countdown boundaries visible', () => {
    expect(isVisibleInWatching({ finished_at: null }, caughtUp)).toBe(false)
    expect(isVisibleInWatching({ finished_at: null }, { type: 'nextUp' })).toBe(true)
    expect(isVisibleInWatching({ finished_at: null }, { type: 'countdown', daysUntil: 60 })).toBe(true)
    expect(isVisibleInWatching({ finished_at: null }, { type: 'countdown', daysUntil: 61 })).toBe(false)
  })

  it('does not hide a show when metadata loading fails', () => {
    expect(isVisibleInWatching({ finished_at: null, loadError: true }, caughtUp)).toBe(true)
  })

  it('hides a personally finished active/returning show without changing its Stats eligibility', () => {
    const show = { tmdb_id: 7, finished_at: '2026-07-12T00:00:00Z', name: 'Returning Show' }
    expect(isPersonallyFinished(show)).toBe(true)
    expect(isVisibleInWatching(show, caughtUp)).toBe(false)
    expect(isRepresentedInStats(show, [{ tmdb_show_id: 7 }])).toBe(true)
  })

  it('keeps a finished show hidden without a dated next episode', () => {
    expect(shouldFinishedShowReturn({ finished_at: '2026-01-01' }, { next_episode_to_air: null })).toBe(false)
    expect(isVisibleInWatching({ finished_at: '2026-01-01' }, caughtUp)).toBe(false)
  })

  it('keeps a finished show hidden 61 days away and returns it at the existing 60-day boundary', () => {
    const show = { finished_at: '2026-01-01' }
    expect(shouldFinishedShowReturn(show, { next_episode_to_air: { air_date: '2026-09-11' } })).toBe(false)
    expect(shouldFinishedShowReturn(show, { next_episode_to_air: { air_date: '2026-09-10' } })).toBe(true)
  })

  it('returns a finished show inside 60 days with unchanged countdown wording', () => {
    const premiere = computeWatchingStatus({}, new Set(), {
      next_episode_to_air: { air_date: '2026-08-01', episode_number: 1 },
    })
    const episode = computeWatchingStatus({}, new Set(), {
      next_episode_to_air: { air_date: '2026-08-01', episode_number: 2 },
    })
    expect(shouldFinishedShowReturn(
      { finished_at: '2026-01-01' },
      { next_episode_to_air: { air_date: '2026-08-01' } },
    )).toBe(true)
    expect(isVisibleInWatching({ finished_at: '2026-01-01' }, premiere)).toBe(true)
    expect(watchingStatusLabel(premiere)).toBe('Airs in 20 days')
    expect(watchingStatusLabel(episode)).toBe('New episode in 20 days')
  })

  it('waits for the final platform threshold before returning from last episode metadata', () => {
    const show = { finished_at: '2026-07-01T00:00:00Z' }
    const details = {
      last_episode_to_air: {
        air_date: '2026-07-19', airstamp: '2026-07-20T01:00:00Z',
        releasePlatform: {
          platform: 'hbo', thresholdHourIST: 8, thresholdMinuteIST: 0,
          confidence: 'mapped',
        },
      },
    }
    vi.setSystemTime(new Date('2026-07-20T02:29:00Z'))
    expect(shouldFinishedShowReturn(show, details)).toBe(false)
    vi.setSystemTime(new Date('2026-07-20T02:30:00Z'))
    expect(shouldFinishedShowReturn(show, details)).toBe(true)
  })

  it('restoring makes a show eligible for Watching again', async () => {
    const supabase = makeSupabase()
    supabase.finished.set(7, '2026-07-12T00:00:00Z')
    await restoreTrackedShow(supabase, 7)
    expect(supabase.finished.get(7)).toBeNull()
    expect(isVisibleInWatching({ finished_at: supabase.finished.get(7) }, { type: 'nextUp' })).toBe(true)
  })

  it('repair excludes every exception and never changes watched rows', async () => {
    const supabase = makeSupabase()
    const before = new Map(supabase.watchedEpisodes)
    const plan = planBulkMark([
      { tmdb_id: 1, name: 'Adults' },
      { tmdb_id: 2, name: 'Sugar' },
      { tmdb_id: 3, name: 'Finished Show', finished_at: null },
    ])
    await finishTrackedShows(plan.affected, { supabase, now: '2026-07-12T00:00:00Z' })
    expect(supabase.finished.has(1)).toBe(false)
    expect(supabase.finished.has(2)).toBe(false)
    expect(supabase.finished.get(3)).toBe('2026-07-12T00:00:00Z')
    expect(supabase.watchedEpisodes).toEqual(before)
  })
})
