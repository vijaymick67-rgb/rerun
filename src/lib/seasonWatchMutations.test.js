import { describe, expect, it, vi } from 'vitest'
import {
  createWatchMutationQueue,
  toggleEpisodeOptimistically,
  toggleSeasonOptimistically,
} from './seasonWatchMutations'

function episode(number, airDate = '2020-01-01') {
  return { episode_number: number, name: `Episode ${number}`, air_date: airDate, runtime: 42 }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function makeSupabase(results = []) {
  const calls = []
  let index = 0
  const result = () => results[index++] ?? Promise.resolve({ error: null })
  return {
    calls,
    from(table) {
      return {
        upsert(rows, options) {
          calls.push({ type: 'upsert', table, rows, options })
          return result()
        },
        delete() {
          const call = { type: 'delete', table, filters: [] }
          calls.push(call)
          const pending = result()
          const builder = {
            eq(column, value) { call.filters.push([column, value]); return builder },
            then(resolve, reject) { return pending.then(resolve, reject) },
          }
          return builder
        },
      }
    },
  }
}

function harness(initial = []) {
  let watched = new Set(initial)
  const caches = { show: new Set(initial), season: new Set(initial) }
  const commitWatched = vi.fn((next) => {
    watched = new Set(next)
    caches.show = new Set(next)
    caches.season = new Set(next)
  })
  return { getWatched: () => watched, commitWatched, caches }
}

function episodeToggle(supabase, state, ep = episode(1)) {
  return toggleEpisodeOptimistically({
    queue: state.queue ??= createWatchMutationQueue(), supabase, tmdbShowId: 7,
    seasonNumber: 1, episode: ep, getWatched: state.getWatched,
    commitWatched: state.commitWatched,
  })
}

describe('optimistic watch mutations', () => {
  it('checks an episode before Supabase resolves', async () => {
    const write = deferred()
    const state = harness()
    const pending = episodeToggle(makeSupabase([write.promise]), state)
    expect(state.getWatched()).toEqual(new Set(['1:1']))
    write.resolve({ error: null })
    await pending
  })

  it('unchecks an episode before Supabase resolves', async () => {
    const write = deferred()
    const state = harness(['1:1'])
    const pending = episodeToggle(makeSupabase([write.promise]), state)
    expect(state.getWatched()).toEqual(new Set())
    write.resolve({ error: null })
    await pending
  })

  it('rolls state and both caches back when an episode write fails', async () => {
    const state = harness()
    const pending = episodeToggle(makeSupabase([Promise.resolve({ error: new Error('nope') })]), state)
    expect(state.caches.show).toEqual(new Set(['1:1']))
    await expect(pending).rejects.toThrow('nope')
    expect(state.getWatched()).toEqual(new Set())
    expect(state.caches).toEqual({ show: new Set(), season: new Set() })
  })

  it('serializes rapid episode taps and keeps the newest intent', async () => {
    const first = deferred()
    const state = harness()
    const supabase = makeSupabase([first.promise, Promise.resolve({ error: null })])
    const one = episodeToggle(supabase, state)
    const two = episodeToggle(supabase, state)
    expect(state.getWatched()).toEqual(new Set())
    await Promise.resolve()
    expect(supabase.calls).toHaveLength(1)
    first.resolve({ error: null })
    await Promise.all([one, two])
    expect(supabase.calls.map((call) => call.type)).toEqual(['upsert', 'delete'])
    expect(state.getWatched()).toEqual(new Set())
  })

  it('marks an aired season with one bulk upsert and updates progress immediately', async () => {
    const write = deferred()
    const state = harness()
    const supabase = makeSupabase([write.promise])
    const pending = toggleSeasonOptimistically({
      queue: createWatchMutationQueue(), supabase,
      episodes: [episode(1), episode(2)], tmdbShowId: 7, seasonNumber: 1,
      getWatched: state.getWatched, commitWatched: state.commitWatched,
    })
    expect(state.getWatched().size).toBe(2)
    await Promise.resolve()
    expect(supabase.calls).toHaveLength(1)
    expect(supabase.calls[0].rows).toHaveLength(2)
    write.resolve({ error: null })
    await pending
  })

  it('unwatches a season with one season-scoped delete', async () => {
    const state = harness(['1:1', '1:2', '2:1'])
    const supabase = makeSupabase()
    await toggleSeasonOptimistically({
      queue: createWatchMutationQueue(), supabase,
      episodes: [episode(1), episode(2)], tmdbShowId: 7, seasonNumber: 1,
      getWatched: state.getWatched, commitWatched: state.commitWatched,
    })
    expect(supabase.calls).toHaveLength(1)
    expect(supabase.calls[0]).toMatchObject({
      type: 'delete', filters: [['tmdb_show_id', 7], ['season_number', 1]],
    })
    expect(state.getWatched()).toEqual(new Set(['2:1']))
  })

  it('rolls all season state and caches back on failure', async () => {
    const state = harness(['2:1'])
    const pending = toggleSeasonOptimistically({
      queue: createWatchMutationQueue(),
      supabase: makeSupabase([Promise.resolve({ error: new Error('failed') })]),
      episodes: [episode(1), episode(2)], tmdbShowId: 7, seasonNumber: 1,
      getWatched: state.getWatched, commitWatched: state.commitWatched,
    })
    expect(state.getWatched()).toEqual(new Set(['2:1', '1:1', '1:2']))
    await expect(pending).rejects.toThrow('failed')
    expect(state.caches).toEqual({ show: new Set(['2:1']), season: new Set(['2:1']) })
  })

  it('never inserts future episodes', async () => {
    const state = harness()
    const supabase = makeSupabase()
    await toggleSeasonOptimistically({
      queue: createWatchMutationQueue(), supabase,
      episodes: [episode(1), episode(2, '2999-01-01')], tmdbShowId: 7, seasonNumber: 1,
      getWatched: state.getWatched, commitWatched: state.commitWatched,
    })
    expect(supabase.calls[0].rows.map((row) => row.episode_number)).toEqual([1])
    expect(state.getWatched()).toEqual(new Set(['1:1']))
  })
})
