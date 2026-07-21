// @vitest-environment jsdom
//
// Integration coverage for SeasonDetail's individual episode toggle now
// routing its Show/Season Detail cache patching through the shared
// patchEpisodeWatchedCaches helper (see detailCache.js) instead of its own
// ad hoc dual-cache write.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  showDetailCacheKey,
  seasonDetailCacheKey,
  writeDetailCache,
  readDetailCache,
  setOptimisticWatchOverlay,
  clearOptimisticWatchOverlay,
  resetOptimisticWatchOverlay,
} from '../lib/detailCache'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function makeReadChain(result) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  }
  return chain
}

function makeDeleteChain() {
  const chain = {
    eq: () => chain,
    then: (resolve, reject) => Promise.resolve({ error: null }).then(resolve, reject),
  }
  return chain
}

let watchedRowsResult
let upsertImpl
const upsertCalls = []

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table) => {
      if (table !== 'watched_episodes') throw new Error(`unexpected table ${table}`)
      return {
        select: () => makeReadChain(watchedRowsResult),
        upsert: (rows) => {
          upsertCalls.push(rows)
          return upsertImpl(rows)
        },
        delete: () => makeDeleteChain(),
      }
    },
  },
}))

vi.mock('../lib/tmdb', () => ({
  getShowDetails: vi.fn(),
  getSeasonEpisodes: vi.fn(),
  getExternalIds: vi.fn(),
}))

vi.mock('../lib/tvmaze', () => ({
  getShowReleaseMap: vi.fn(async () => ({})),
}))

import { getSeasonEpisodes, getShowDetails } from '../lib/tmdb'
import SeasonDetail from './SeasonDetail'

const EPISODES = [
  { episode_number: 1, name: 'S2E1', air_date: '2015-02-01', runtime: 40 },
  { episode_number: 2, name: 'S2E2', air_date: '2015-02-08', runtime: 40 },
]

let container = null
let root = null

async function renderSeasonDetail() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/watching/900/season/2']}>
        <Routes>
          <Route path="/watching/:tmdbId/season/:seasonNumber" element={<SeasonDetail />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))
  upsertCalls.length = 0
  upsertImpl = async () => ({ error: null })
  watchedRowsResult = { data: [{ episode_number: 1 }], error: null }
  getShowDetails.mockResolvedValue({ name: 'The Sopranos', seasons: [{ season_number: 2 }] })
  getSeasonEpisodes.mockResolvedValue({ episodes: EPISODES })
  localStorage.clear()
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
  vi.useRealTimers()
  vi.clearAllMocks()
  localStorage.clear()
  resetOptimisticWatchOverlay()
})

describe('SeasonDetail — individual episode toggle syncs the shared cache helper', () => {
  it("patches this season's own cache and the parent Show Detail cache on a watch tap", async () => {
    writeDetailCache(showDetailCacheKey(900), {
      show: { id: 1, tmdb_id: 900, name: 'The Sopranos' },
      seasons: [{ season_number: 1 }, { season_number: 2 }],
      episodesBySeason: { 1: [], 2: EPISODES },
      watchedList: ['1:1', '2:1'],
    })

    await renderSeasonDetail()

    const button = container.querySelector('[aria-label="Mark episode 2 watched"]')
    expect(button).not.toBeNull()
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const seasonCache = readDetailCache(seasonDetailCacheKey(900, 2))
    expect(seasonCache.watchedList.sort()).toEqual(['2:1', '2:2'])

    const showCache = readDetailCache(showDetailCacheKey(900))
    expect(showCache.watchedList.sort()).toEqual(['1:1', '2:1', '2:2'])
    // Unrelated fields (including the other season) are untouched.
    expect(showCache.seasons).toEqual([{ season_number: 1 }, { season_number: 2 }])
  })

  it('rolls both caches back to the prior watched key when the toggle fails', async () => {
    upsertImpl = async () => { throw new Error('nope') }
    writeDetailCache(showDetailCacheKey(900), {
      show: { id: 1, tmdb_id: 900, name: 'The Sopranos' },
      seasons: [{ season_number: 2 }],
      episodesBySeason: { 2: EPISODES },
      watchedList: ['2:1'],
    })

    await renderSeasonDetail()

    const button = container.querySelector('[aria-label="Mark episode 2 watched"]')
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const seasonCache = readDetailCache(seasonDetailCacheKey(900, 2))
    expect(seasonCache.watchedList).toEqual(['2:1'])

    const showCache = readDetailCache(showDetailCacheKey(900))
    expect(showCache.watchedList).toEqual(['2:1'])
  })

  it('does not let a stale watched fetch revert an in-flight quick tick for this season', async () => {
    // The season's background read is missing episode 2 (its snapshot predates
    // the quick tick's upsert), while the cross-route overlay marks it watched.
    watchedRowsResult = { data: [{ episode_number: 1 }], error: null }
    setOptimisticWatchOverlay({ tmdbShowId: 900, seasonNumber: 2, episodeNumber: 2, watched: true })

    await renderSeasonDetail()

    // Episode 2 must render watched (reconciled), not reverted to unwatched.
    expect(container.querySelector('[aria-label="Mark episode 2 unwatched"]')).not.toBeNull()
    const seasonCache = readDetailCache(seasonDetailCacheKey(900, 2))
    expect(seasonCache.watchedList.sort()).toEqual(['2:1', '2:2'])

    clearOptimisticWatchOverlay({ tmdbShowId: 900, seasonNumber: 2, episodeNumber: 2 })
  })
})
