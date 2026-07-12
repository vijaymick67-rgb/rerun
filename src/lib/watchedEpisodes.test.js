import { describe, expect, it } from 'vitest'
import { fetchWatchedEpisodes } from './watchedEpisodes'

function makeSupabase(rows) {
  const calls = []
  return {
    calls,
    from() {
      return {
        select() { return this },
        in() { return this },
        order() { return this },
        range(from, to) {
          calls.push({ from, to })
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
        },
      }
    },
  }
}

describe('fetchWatchedEpisodes', () => {
  it('reads beyond Supabase\'s default 1,000-row response limit', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ episode_number: i + 1 }))
    const supabase = makeSupabase(rows)

    const result = await fetchWatchedEpisodes(supabase, 'episode_number')

    expect(result).toHaveLength(1001)
    expect(supabase.calls).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ])
  })
})
