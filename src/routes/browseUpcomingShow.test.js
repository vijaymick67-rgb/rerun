import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { removeTrackedShowIfUnwatched } from '../lib/finishedShows'

const browseSource = readFileSync(new URL('./Browse.jsx', import.meta.url), 'utf8')

function makeSupabase({ watchedRows = [], deleteError = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      calls.push({ table })
      return {
        select() {
          return {
            eq() {
              return { limit: async () => ({ data: watchedRows, error: null }) }
            },
          }
        },
        delete() {
          return { eq: async () => ({ error: deleteError }) }
        },
      }
    },
  }
}

describe('Browse upcoming-show corrections', () => {
  it('offers Undo for delayed new additions and removes the row safely', async () => {
    expect(browseSource).toContain('undoable: !wasTracked')
    expect(browseSource).toContain("{undoingId != null ? 'Undoing…' : 'Undo'}")
    expect(browseSource).toContain('setTrackedShows((prev) => prev.filter')

    const supabase = makeSupabase()
    await removeTrackedShowIfUnwatched(supabase, 42)
    expect(supabase.calls.map((call) => call.table)).toEqual(['watched_episodes', 'tracked_shows'])
  })

  it('fails safely when watched history exists', async () => {
    const supabase = makeSupabase({ watchedRows: [{ tmdb_show_id: 42 }] })
    await expect(removeTrackedShowIfUnwatched(supabase, 42)).rejects.toMatchObject({ code: 'WATCHED_HISTORY_EXISTS' })
    expect(supabase.calls.map((call) => call.table)).toEqual(['watched_episodes'])
  })

  it('validates aired rows before tracking or writing watched rows', () => {
    const rowsCheck = browseSource.indexOf('if (rows.length === 0)')
    const trackCall = browseSource.indexOf('await upsertTrackedShow(supabase, show)', rowsCheck)
    const watchedCall = browseSource.indexOf('await upsertWatchedRows(rows)', rowsCheck)
    expect(rowsCheck).toBeGreaterThan(-1)
    expect(trackCall).toBeGreaterThan(rowsCheck)
    expect(watchedCall).toBeGreaterThan(trackCall)
    expect(browseSource).toContain('Not aired yet')
    expect(browseSource).toContain('setLoggedIds((prev) => new Set(prev).add(show.id))')
  })

  it('keeps partial aired logging release-aware through the shared builder', () => {
    expect(browseSource).toContain('const { rows } = await buildAiredEpisodeRows(show.id)')
    expect(browseSource).toContain('await upsertWatchedRows(rows)')
  })
})

