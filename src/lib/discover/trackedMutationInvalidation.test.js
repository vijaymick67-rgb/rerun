import { afterEach, describe, expect, it } from 'vitest'
import {
  hideTrackedShow,
  removeTrackedShow,
  removeTrackedShowIfUnwatched,
  restoreTrackedShow,
  upsertTrackedShow,
} from '../finishedShows.js'
import {
  isTrackedFetchFresh,
  markTrackedFetched,
  resetDiscoverSession,
} from './discoverSession.js'

// The blocking review case: a tracked-library mutation made through the shared
// helpers (from Browse, Stats, or anywhere) must invalidate the Discover session
// so the freshness window cannot keep showing a stale library. These call the
// REAL helpers against a chainable fake Supabase and assert the real gate flips.

afterEach(() => {
  resetDiscoverSession()
})

// Minimal chainable Supabase stub: every builder method returns the same
// thenable chain, terminal reads resolve to an empty successful result.
function okSupabase() {
  const result = () => Promise.resolve({ data: [], error: null })
  const chain = {
    from: () => chain,
    select: () => chain,
    upsert: () => chain,
    update: () => chain,
    delete: () => chain,
    insert: () => chain,
    eq: () => chain,
    order: () => chain,
    range: () => chain,
    limit: () => result(),
    maybeSingle: () => result(),
    then: (onFulfilled, onRejected) => result().then(onFulfilled, onRejected),
  }
  return chain
}

const cases = [
  ['upsertTrackedShow (add / reactivate)', (s) => upsertTrackedShow(s, { id: 1, name: 'The Bear', poster_path: '/b.jpg' })],
  ['removeTrackedShow', (s) => removeTrackedShow(s, 1)],
  ['removeTrackedShowIfUnwatched', (s) => removeTrackedShowIfUnwatched(s, 1)],
  ['hideTrackedShow', (s) => hideTrackedShow(s, 1)],
  ['restoreTrackedShow', (s) => restoreTrackedShow(s, 1)],
]

describe('shared tracked-show mutations invalidate the Discover session', () => {
  for (const [name, run] of cases) {
    it(`${name} clears the tracked freshness so the next Browse visit re-reads`, async () => {
      const now = 1_000_000
      markTrackedFetched(now)
      expect(isTrackedFetchFresh(now)).toBe(true)

      await run(okSupabase())

      expect(isTrackedFetchFresh(now)).toBe(false)
    })
  }
})
