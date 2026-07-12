import { describe, expect, it } from 'vitest'
import {
  finishTrackedShows,
  isPersonallyFinished,
  isRepresentedInStats,
  isVisibleInWatching,
  restoreTrackedShow,
} from './finishedShows'
import { planBulkMark } from './bulkMarkWatched'

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

  it('keeps an active caught-up show visible', () => {
    expect(isVisibleInWatching({ finished_at: null }, caughtUp)).toBe(true)
  })

  it('hides a personally finished active/returning show without changing its Stats eligibility', () => {
    const show = { tmdb_id: 7, finished_at: '2026-07-12T00:00:00Z', name: 'Returning Show' }
    expect(isPersonallyFinished(show)).toBe(true)
    expect(isVisibleInWatching(show, caughtUp)).toBe(false)
    expect(isRepresentedInStats(show, [{ tmdb_show_id: 7 }])).toBe(true)
  })

  it('restoring makes a show eligible for Watching again', async () => {
    const supabase = makeSupabase()
    supabase.finished.set(7, '2026-07-12T00:00:00Z')
    await restoreTrackedShow(supabase, 7)
    expect(supabase.finished.get(7)).toBeNull()
    expect(isVisibleInWatching({ finished_at: supabase.finished.get(7) }, caughtUp)).toBe(true)
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
