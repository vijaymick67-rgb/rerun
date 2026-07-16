import { describe, expect, it } from 'vitest'
import { removeTrackedShow, upsertTrackedShow } from './finishedShows'

function makeSupabase({ removeError = null } = {}) {
  const tracked = new Map()
  const watched = new Map([['7|1|1', { watched_at: 'original' }]])
  const calls = []
  return {
    tracked,
    watched,
    calls,
    from(table) {
      calls.push(table)
      return {
        upsert(values) {
          return Promise.resolve().then(() => {
            tracked.set(values.tmdb_id, values)
            return { error: null }
          })
        },
        delete() {
          return {
            eq: async (_column, id) => {
              if (removeError) return { error: removeError }
              tracked.delete(id)
              return { error: null }
            },
          }
        },
      }
    },
  }
}

const show = { id: 7, name: 'Lucky', poster_path: '/lucky.jpg' }

describe('Browse tracked-show toggle persistence', () => {
  it('tracks, untracks, and re-tracks without touching watched history', async () => {
    const supabase = makeSupabase()
    await upsertTrackedShow(supabase, show)
    expect(supabase.tracked.has(7)).toBe(true)

    await removeTrackedShow(supabase, 7)
    expect(supabase.tracked.has(7)).toBe(false)
    expect(supabase.watched.get('7|1|1')).toEqual({ watched_at: 'original' })

    await upsertTrackedShow(supabase, show)
    expect(supabase.tracked.has(7)).toBe(true)
    expect(supabase.watched.get('7|1|1')).toEqual({ watched_at: 'original' })
    expect(supabase.calls).toEqual(['tracked_shows', 'tracked_shows', 'tracked_shows'])
  })

  it('removes a tracked row even when watched history exists', async () => {
    const supabase = makeSupabase()
    supabase.tracked.set(7, show)
    await expect(removeTrackedShow(supabase, 7)).resolves.toBeUndefined()
    expect(supabase.tracked.has(7)).toBe(false)
    expect(supabase.watched.size).toBe(1)
  })

  it('keeps the row when removal fails', async () => {
    const supabase = makeSupabase({ removeError: new Error('offline') })
    supabase.tracked.set(7, show)
    await expect(removeTrackedShow(supabase, 7)).rejects.toThrow('offline')
    expect(supabase.tracked.has(7)).toBe(true)
  })
})

