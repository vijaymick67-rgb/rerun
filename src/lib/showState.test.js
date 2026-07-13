import { describe, expect, it, vi } from 'vitest'
import {
  hideTrackedShow,
  isRepresentedInStats,
  isVisibleInWatching,
  restoreTrackedShow,
  upsertTrackedShow,
} from './finishedShows'
import { selectTrackedShowsForWatching } from './watchingShows'
import {
  filterVisibleStatsRows,
  isStatsShowBusy,
  removeShowFromStatsState,
  statsActionItems,
  toggleStatsActionSheet,
} from './showState'

function makeSupabase({ error = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      return {
        update(values) {
          calls.push({ table, operation: 'update', values })
          return {
            eq() {
              return Promise.resolve({ error })
            },
          }
        },
        upsert(rows, options) {
          calls.push({ table, operation: 'upsert', rows, options })
          return Promise.resolve({ error })
        },
      }
    },
  }
}

describe('preserved-history show state', () => {
  it('excludes hidden shows from Stats while retaining active and archived history', () => {
    const tracked = [
      { tmdb_id: 1, hidden_at: null, finished_at: null },
      { tmdb_id: 2, hidden_at: null, finished_at: '2026-07-12T00:00:00Z' },
      { tmdb_id: 3, hidden_at: '2026-07-13T00:00:00Z', finished_at: null },
    ]
    const rows = [1, 2, 3].map((tmdb_show_id) => ({ tmdb_show_id, watched_at: 'ORIGINAL' }))

    expect(filterVisibleStatsRows(tracked, rows).map((row) => row.tmdb_show_id)).toEqual([1, 2])
    expect(isRepresentedInStats(tracked[0], [rows[0]])).toBe(true)
    expect(isRepresentedInStats(tracked[1], [rows[1]])).toBe(true)
    expect(isRepresentedInStats(tracked[2], [rows[2]])).toBe(false)
    expect(isRepresentedInStats(tracked[0], [])).toBe(false)
  })

  it('excludes hidden shows from Watching before any archived return checks', async () => {
    const getShowDetails = vi.fn()
    const hidden = { tmdb_id: 7, hidden_at: '2026-07-13T00:00:00Z', finished_at: '2026-07-12T00:00:00Z' }
    const result = await selectTrackedShowsForWatching([hidden], getShowDetails)

    expect(result.candidates).toEqual([])
    expect(getShowDetails).not.toHaveBeenCalled()
    expect(isVisibleInWatching(hidden, { type: 'nextUp' })).toBe(false)
  })

  it('restores an archived show without touching watched history', async () => {
    const supabase = makeSupabase()
    await restoreTrackedShow(supabase, 2)

    expect(supabase.calls).toEqual([
      {
        table: 'tracked_shows',
        operation: 'update',
        values: { finished_at: null, hidden_at: null },
      },
    ])
    expect(supabase.calls.some((call) => call.table === 'watched_episodes')).toBe(false)
    expect(JSON.stringify(supabase.calls)).not.toContain('watched_at')
  })

  it('hides a show by updating only tracked_shows and removes it from visible state', async () => {
    const supabase = makeSupabase()
    const hiddenAt = '2026-07-13T12:00:00.000Z'
    await hideTrackedShow(supabase, 3, hiddenAt)

    expect(supabase.calls).toEqual([
      {
        table: 'tracked_shows',
        operation: 'update',
        values: { hidden_at: hiddenAt },
      },
    ])
    expect(supabase.calls.some((call) => call.table === 'watched_episodes')).toBe(false)
    expect(JSON.stringify(supabase.calls)).not.toContain('watched_at')

    const next = removeShowFromStatsState(
      [{ tmdb_id: 1 }, { tmdb_id: 3 }],
      [{ tmdb_show_id: 1, watched_at: 'ORIGINAL' }, { tmdb_show_id: 3, watched_at: 'ORIGINAL' }],
      3,
    )
    expect(next.shows).toEqual([{ tmdb_id: 1 }])
    expect(next.watchedRows).toEqual([{ tmdb_show_id: 1, watched_at: 'ORIGINAL' }])
  })

  it('re-adds a hidden show by clearing both visibility flags without writing episodes', async () => {
    const supabase = makeSupabase()
    await upsertTrackedShow(supabase, { id: 3, name: 'Restored', poster_path: '/new.jpg' }, 'NOW')

    expect(supabase.calls).toEqual([
      {
        table: 'tracked_shows',
        operation: 'upsert',
        rows: {
          tmdb_id: 3,
          name: 'Restored',
          poster_path: '/new.jpg',
          added_at: 'NOW',
          finished_at: null,
          hidden_at: null,
        },
        options: { onConflict: 'tmdb_id' },
      },
    ])
    expect(supabase.calls.some((call) => call.table === 'watched_episodes')).toBe(false)
    expect(JSON.stringify(supabase.calls)).not.toContain('watched_at')
  })

  it('leaves local state unchanged when hide or restore writes fail', async () => {
    const supabase = makeSupabase({ error: new Error('write failed') })
    const before = [{ tmdb_id: 4, watched: 2 }]

    await expect(hideTrackedShow(supabase, 4, 'NOW')).rejects.toThrow('write failed')
    await expect(restoreTrackedShow(supabase, 4)).rejects.toThrow('write failed')
    expect(before).toEqual([{ tmdb_id: 4, watched: 2 }])
  })

  it('models action-sheet options for active and archived shows', () => {
    expect(statsActionItems({ tmdb_id: 1, finished_at: null }).map((item) => item.id)).toEqual([
      'details',
      'remove',
      'cancel',
    ])
    expect(statsActionItems({ tmdb_id: 2, finished_at: '2026-07-12T00:00:00Z' }).map((item) => item.id)).toEqual([
      'details',
      'restore',
      'remove',
      'cancel',
    ])
  })

  it('opens the selected show action sheet, closes it on cancel, and scopes busy state', () => {
    expect(toggleStatsActionSheet(null, 2)).toBe(2)
    expect(toggleStatsActionSheet(2, 2)).toBeNull()
    expect(toggleStatsActionSheet(2, 3)).toBe(3)

    const busyIds = new Set([2])
    expect(isStatsShowBusy(busyIds, 2)).toBe(true)
    expect(isStatsShowBusy(busyIds, 3)).toBe(false)
    expect(isStatsShowBusy(busyIds, 4)).toBe(false)
  })
})
