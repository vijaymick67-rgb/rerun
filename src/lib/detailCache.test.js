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
  patchEpisodeWatchedCaches,
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
})
