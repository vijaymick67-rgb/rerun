// @vitest-environment jsdom
//
// Unit coverage for patchEpisodeWatchedCaches — the shared helper that keeps
// the Show Detail and Season Detail localStorage caches coherent with a
// single episode's watched state, synchronously and without touching
// anything else in either cache. See Watching.jsx's handleQuickMark and
// SeasonDetail.jsx's toggleEpisode for the two call sites.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  showDetailCacheKey,
  seasonDetailCacheKey,
  readDetailCache,
  writeDetailCache,
  mergeDetailCache,
  patchEpisodeWatchedCaches,
  setOptimisticWatchOverlay,
  clearOptimisticWatchOverlay,
  resetOptimisticWatchOverlay,
  reconcileWatchedListWithOverlay,
  getOptimisticWatchRevision,
} from './detailCache'

const TMDB_ID = 900

function showCacheFixture(overrides = {}) {
  return {
    show: { id: 1, tmdb_id: TMDB_ID, name: 'The Sopranos' },
    seasons: [{ season_number: 1 }, { season_number: 2 }],
    episodesBySeason: {
      1: [{ episode_number: 1, name: 'S1E1' }],
      2: [{ episode_number: 1, name: 'S2E1' }, { episode_number: 2, name: 'S2E2' }],
    },
    watchedList: ['1:1'],
    synopsis: 'A cached series synopsis.',
    ...overrides,
  }
}

function seasonCacheFixture(overrides = {}) {
  return {
    showName: 'The Sopranos',
    episodes: [{ episode_number: 1, name: 'S2E1' }, { episode_number: 2, name: 'S2E2' }],
    watchedList: ['2:1'],
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  resetOptimisticWatchOverlay()
})

describe('patchEpisodeWatchedCaches', () => {
  it('adds the exact episode key to a matching Show Detail cache', () => {
    writeDetailCache(showDetailCacheKey(TMDB_ID), showCacheFixture())

    const result = patchEpisodeWatchedCaches({
      tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 2, watched: true,
    })

    expect(result.showPatched).toBe(true)
    const cached = readDetailCache(showDetailCacheKey(TMDB_ID))
    expect(cached.watchedList.sort()).toEqual(['1:1', '2:2'])
  })

  it('adds the exact episode key to a matching Season Detail cache', () => {
    writeDetailCache(seasonDetailCacheKey(TMDB_ID, 2), seasonCacheFixture())

    const result = patchEpisodeWatchedCaches({
      tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 2, watched: true,
    })

    expect(result.seasonPatched).toBe(true)
    const cached = readDetailCache(seasonDetailCacheKey(TMDB_ID, 2))
    expect(cached.watchedList.sort()).toEqual(['2:1', '2:2'])
  })

  it('marking unwatched removes only the exact episode key', () => {
    writeDetailCache(showDetailCacheKey(TMDB_ID), showCacheFixture({ watchedList: ['1:1', '2:1', '2:2'] }))
    writeDetailCache(seasonDetailCacheKey(TMDB_ID, 2), seasonCacheFixture({ watchedList: ['2:1', '2:2'] }))

    patchEpisodeWatchedCaches({
      tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 2, watched: false,
    })

    expect(readDetailCache(showDetailCacheKey(TMDB_ID)).watchedList.sort()).toEqual(['1:1', '2:1'])
    expect(readDetailCache(seasonDetailCacheKey(TMDB_ID, 2)).watchedList.sort()).toEqual(['2:1'])
  })

  it('leaves other seasons in the Show Detail cache untouched', () => {
    writeDetailCache(showDetailCacheKey(TMDB_ID), showCacheFixture({ watchedList: ['1:1'] }))

    patchEpisodeWatchedCaches({
      tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 1, watched: true,
    })

    const cached = readDetailCache(showDetailCacheKey(TMDB_ID))
    expect(cached.watchedList).toContain('1:1')
    expect(cached.seasons).toEqual([{ season_number: 1 }, { season_number: 2 }])
    expect(cached.episodesBySeason).toEqual(showCacheFixture().episodesBySeason)
  })

  it('leaves other episodes in the affected Season Detail cache untouched', () => {
    writeDetailCache(seasonDetailCacheKey(TMDB_ID, 2), seasonCacheFixture({ watchedList: ['2:1'] }))

    patchEpisodeWatchedCaches({
      tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 2, watched: true,
    })

    const cached = readDetailCache(seasonDetailCacheKey(TMDB_ID, 2))
    expect(cached.watchedList.sort()).toEqual(['2:1', '2:2'])
    expect(cached.episodes).toEqual(seasonCacheFixture().episodes)
    expect(cached.showName).toBe('The Sopranos')
  })

  it('does not touch caches for other shows or unrelated localStorage keys', () => {
    const otherShowKey = showDetailCacheKey(555)
    writeDetailCache(showDetailCacheKey(TMDB_ID), showCacheFixture())
    writeDetailCache(otherShowKey, showCacheFixture({ show: { id: 2, tmdb_id: 555, name: 'Other Show' } }))
    localStorage.setItem('watching_cache:v6', JSON.stringify([{ id: 1 }]))

    patchEpisodeWatchedCaches({
      tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 2, watched: true,
    })

    expect(readDetailCache(otherShowKey)).toEqual(showCacheFixture({ show: { id: 2, tmdb_id: 555, name: 'Other Show' } }))
    expect(JSON.parse(localStorage.getItem('watching_cache:v6'))).toEqual([{ id: 1 }])
  })

  it('is a safe no-op when neither cache exists — it does not fabricate an incomplete entry', () => {
    const result = patchEpisodeWatchedCaches({
      tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 2, watched: true,
    })

    expect(result).toEqual({ showPatched: false, seasonPatched: false })
    expect(readDetailCache(showDetailCacheKey(TMDB_ID))).toBeNull()
    expect(readDetailCache(seasonDetailCacheKey(TMDB_ID, 2))).toBeNull()
  })

  it('fails safely on malformed cache JSON, leaving the raw value untouched', () => {
    localStorage.setItem(showDetailCacheKey(TMDB_ID), '{not valid json')
    localStorage.setItem(seasonDetailCacheKey(TMDB_ID, 2), '{not valid json')

    const result = patchEpisodeWatchedCaches({
      tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 2, watched: true,
    })

    expect(result).toEqual({ showPatched: false, seasonPatched: false })
    expect(localStorage.getItem(showDetailCacheKey(TMDB_ID))).toBe('{not valid json')
    expect(localStorage.getItem(seasonDetailCacheKey(TMDB_ID, 2))).toBe('{not valid json')
  })

  it('does not patch a cache entry that lacks the expected shape (no fabricated show/episodes)', () => {
    writeDetailCache(showDetailCacheKey(TMDB_ID), { seasons: [] }) // no `show`
    writeDetailCache(seasonDetailCacheKey(TMDB_ID, 2), { showName: 'x' }) // no `episodes` array

    const result = patchEpisodeWatchedCaches({
      tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 2, watched: true,
    })

    expect(result).toEqual({ showPatched: false, seasonPatched: false })
  })

  it('preserves valid non-watched fields on both caches after a patch', () => {
    writeDetailCache(showDetailCacheKey(TMDB_ID), showCacheFixture())
    writeDetailCache(seasonDetailCacheKey(TMDB_ID, 2), seasonCacheFixture())

    patchEpisodeWatchedCaches({
      tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 2, watched: true,
    })

    const showCached = readDetailCache(showDetailCacheKey(TMDB_ID))
    expect(showCached.show).toEqual({ id: 1, tmdb_id: TMDB_ID, name: 'The Sopranos' })
    expect(showCached.synopsis).toBe('A cached series synopsis.')
    const seasonCached = readDetailCache(seasonDetailCacheKey(TMDB_ID, 2))
    expect(seasonCached.showName).toBe('The Sopranos')
  })

  it('never duplicates a watched key when patched twice with watched: true', () => {
    writeDetailCache(showDetailCacheKey(TMDB_ID), showCacheFixture())

    patchEpisodeWatchedCaches({ tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 2, watched: true })
    patchEpisodeWatchedCaches({ tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 2, watched: true })

    const cached = readDetailCache(showDetailCacheKey(TMDB_ID))
    expect(cached.watchedList.filter((key) => key === '2:2')).toHaveLength(1)
  })

  it('normalizes a malformed non-array watchedList to empty instead of spreading characters', () => {
    // A cache whose watchedList somehow became a string must not turn into a
    // set of single-character keys — the patch should start from empty.
    writeDetailCache(showDetailCacheKey(TMDB_ID), showCacheFixture({ watchedList: 'oops' }))

    patchEpisodeWatchedCaches({ tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 2, watched: true })

    const cached = readDetailCache(showDetailCacheKey(TMDB_ID))
    expect(cached.watchedList).toEqual(['2:2'])
  })
})

describe('mergeDetailCache', () => {
  it('adds synopsis to an old entry without erasing the existing cache shape', () => {
    const key = showDetailCacheKey(TMDB_ID)
    const oldEntry = showCacheFixture()
    delete oldEntry.synopsis
    writeDetailCache(key, oldEntry)

    mergeDetailCache(key, { synopsis: 'Fresh TMDB overview.' })

    expect(readDetailCache(key)).toEqual({
      ...oldEntry,
      synopsis: 'Fresh TMDB overview.',
    })
  })

  it('lets watched-state rewrites preserve a valid synopsis', () => {
    const key = showDetailCacheKey(TMDB_ID)
    writeDetailCache(key, showCacheFixture())

    mergeDetailCache(key, { watchedList: ['1:1', '2:1'] })

    expect(readDetailCache(key).synopsis).toBe('A cached series synopsis.')
    expect(readDetailCache(key).watchedList).toEqual(['1:1', '2:1'])
  })
})

describe('cross-route optimistic watch overlay', () => {
  it('reconciles a fetched watched list against a still-pending overlay (adds the unsettled key)', () => {
    setOptimisticWatchOverlay({ tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: true })

    // A stale ShowDetail fetch that missed the in-flight upsert.
    const reconciled = reconcileWatchedListWithOverlay(TMDB_ID, ['1:1'])

    expect(reconciled.sort()).toEqual(['1:1', '2:5'])
  })

  it('reconciles an unwatch overlay by removing the key from a stale fetched list', () => {
    setOptimisticWatchOverlay({ tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: false })

    const reconciled = reconcileWatchedListWithOverlay(TMDB_ID, ['1:1', '2:5'])

    expect(reconciled.sort()).toEqual(['1:1'])
  })

  it('only applies overlay entries for the requested show', () => {
    setOptimisticWatchOverlay({ tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: true })
    setOptimisticWatchOverlay({ tmdbShowId: 555, seasonNumber: 1, episodeNumber: 1, watched: true })

    expect(reconcileWatchedListWithOverlay(TMDB_ID, []).sort()).toEqual(['2:5'])
    expect(reconcileWatchedListWithOverlay(555, []).sort()).toEqual(['1:1'])
  })

  it('scopes reconciliation to a single season when asked (Season Detail loader)', () => {
    setOptimisticWatchOverlay({ tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: true })
    setOptimisticWatchOverlay({ tmdbShowId: TMDB_ID, seasonNumber: 3, episodeNumber: 1, watched: true })

    const reconciled = reconcileWatchedListWithOverlay(TMDB_ID, [], { seasonNumber: 2 })

    expect(reconciled).toEqual(['2:5'])
  })

  it('bumps the revision on set and on a clear that removed an entry, but not on a no-op clear', () => {
    const start = getOptimisticWatchRevision(TMDB_ID)
    setOptimisticWatchOverlay({ tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: true })
    const afterSet = getOptimisticWatchRevision(TMDB_ID)
    expect(afterSet).toBe(start + 1)

    clearOptimisticWatchOverlay({ tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5 })
    const afterClear = getOptimisticWatchRevision(TMDB_ID)
    expect(afterClear).toBe(afterSet + 1)

    // Clearing something that was never there must not move the revision.
    clearOptimisticWatchOverlay({ tmdbShowId: TMDB_ID, seasonNumber: 9, episodeNumber: 9 })
    expect(getOptimisticWatchRevision(TMDB_ID)).toBe(afterClear)
  })

  it('scopes the revision counter per show, so an unrelated show cannot move it', () => {
    const OTHER_TMDB_ID = 555
    const startA = getOptimisticWatchRevision(TMDB_ID)
    const startB = getOptimisticWatchRevision(OTHER_TMDB_ID)

    const tokenB = setOptimisticWatchOverlay({
      tmdbShowId: OTHER_TMDB_ID, seasonNumber: 1, episodeNumber: 1, watched: true,
    })
    // Show A's revision must be untouched by Show B's overlay change.
    expect(getOptimisticWatchRevision(TMDB_ID)).toBe(startA)
    expect(getOptimisticWatchRevision(OTHER_TMDB_ID)).toBe(startB + 1)

    clearOptimisticWatchOverlay({
      tmdbShowId: OTHER_TMDB_ID, seasonNumber: 1, episodeNumber: 1, token: tokenB,
    })
    expect(getOptimisticWatchRevision(TMDB_ID)).toBe(startA)
    expect(getOptimisticWatchRevision(OTHER_TMDB_ID)).toBe(startB + 2)

    // Show A's own overlay change still moves its own revision.
    setOptimisticWatchOverlay({ tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: true })
    expect(getOptimisticWatchRevision(TMDB_ID)).toBe(startA + 1)
  })

  it('detail loader isolation: an unrelated show settling mid-fetch does not discard a fresh fetch, but the same show settling does', () => {
    const OTHER_TMDB_ID = 555

    // Simulates ShowDetail/SeasonDetail's loader: capture the revision before
    // the fetch starts, then compare it after the fetch resolves.
    const showARevisionAtFetchStart = getOptimisticWatchRevision(TMDB_ID)

    // While Show A's fetch is in flight, Show B's quick tick commits and
    // settles (set then clear), each in the middle of Show A's request.
    const tokenB = setOptimisticWatchOverlay({
      tmdbShowId: OTHER_TMDB_ID, seasonNumber: 1, episodeNumber: 1, watched: true,
    })
    clearOptimisticWatchOverlay({
      tmdbShowId: OTHER_TMDB_ID, seasonNumber: 1, episodeNumber: 1, token: tokenB,
    })

    // Show A's fetch resolves: its own revision must be unchanged, so its
    // loader accepts the freshly fetched watched rows rather than distrusting
    // them and falling back to watchedRef.current.
    expect(getOptimisticWatchRevision(TMDB_ID)).toBe(showARevisionAtFetchStart)

    // But if Show A's OWN overlay changes mid-fetch, its loader must still
    // detect that and keep the live optimistic state instead of the stale
    // fetch — show-scoping must not weaken that existing protection.
    setOptimisticWatchOverlay({ tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: true })
    expect(getOptimisticWatchRevision(TMDB_ID)).not.toBe(showARevisionAtFetchStart)
  })

  it('leaves the fetched list untouched once the overlay is cleared', () => {
    setOptimisticWatchOverlay({ tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: true })
    clearOptimisticWatchOverlay({ tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5 })

    expect(reconcileWatchedListWithOverlay(TMDB_ID, ['1:1'])).toEqual(['1:1'])
  })

  describe('ownership tokens for queued toggles of the same episode', () => {
    it('an older operation settling does not remove a newer pending overlay', () => {
      // Toggle A marks the episode watched, then a rapid re-toggle B overwrites
      // the same overlay key (say back to unwatched) before A's upsert settles.
      const tokenA = setOptimisticWatchOverlay({
        tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: true,
      })
      const tokenB = setOptimisticWatchOverlay({
        tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: false,
      })
      expect(tokenB).not.toBe(tokenA)

      // A settles first and clears with its now-stale token: must be a no-op.
      clearOptimisticWatchOverlay({
        tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, token: tokenA,
      })

      // B's overlay is still live — a stale detail refresh during B cannot
      // revert it, and B's intended (unwatched) value is what reconciles.
      expect(reconcileWatchedListWithOverlay(TMDB_ID, ['2:5'])).toEqual([])
    })

    it('keeps the latest overlay until its own mutation settles, then clears it', () => {
      setOptimisticWatchOverlay({
        tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: true,
      })
      const tokenB = setOptimisticWatchOverlay({
        tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: false,
      })

      // B settling with its own token removes the entry; later reads win.
      clearOptimisticWatchOverlay({
        tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, token: tokenB,
      })
      expect(reconcileWatchedListWithOverlay(TMDB_ID, ['2:5'])).toEqual(['2:5'])
    })

    it('bumps the revision on a stale-token clear no-op just as little as any no-op clear', () => {
      const tokenA = setOptimisticWatchOverlay({
        tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: true,
      })
      setOptimisticWatchOverlay({
        tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, watched: false,
      })
      const before = getOptimisticWatchRevision(TMDB_ID)

      clearOptimisticWatchOverlay({
        tmdbShowId: TMDB_ID, seasonNumber: 2, episodeNumber: 5, token: tokenA,
      })

      expect(getOptimisticWatchRevision(TMDB_ID)).toBe(before)
    })
  })
})
