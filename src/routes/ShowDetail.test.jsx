// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function makeQuery(result) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  }
  return builder
}

let trackedShowResult
let watchedRowsResult

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table) => {
      if (table === 'tracked_shows') return makeQuery(trackedShowResult)
      if (table === 'watched_episodes') return makeQuery(watchedRowsResult)
      throw new Error(`Unexpected table ${table}`)
    },
  },
}))

vi.mock('../lib/tmdb', () => ({
  getShowDetails: vi.fn(),
  getSeasonEpisodes: vi.fn(),
  getExternalIds: vi.fn(),
  POSTER_BASE: 'https://image.tmdb.org/t/p/w200',
}))

vi.mock('../lib/tvmaze', () => ({
  getShowReleaseMap: vi.fn(async () => ({})),
}))

import { getSeasonEpisodes, getShowDetails } from '../lib/tmdb'
import {
  setOptimisticWatchOverlay,
  clearOptimisticWatchOverlay,
  resetOptimisticWatchOverlay,
  showDetailCacheKey,
  readDetailCache,
} from '../lib/detailCache'
import ShowDetail from './ShowDetail'

let container = null
let root = null

async function renderShowDetail(tmdbId) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/watching/${tmdbId}`]}>
        <Routes>
          <Route path="/watching/:tmdbId" element={<ShowDetail />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  // Flush the data-load effect's pending microtasks (mocked Supabase/TMDB/TVmaze
  // calls all resolve on the microtask queue, no real timers involved).
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))
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

describe('ShowDetail — released-only hero progress', () => {
  it('shows 22/23 (released-only), not 22/26 (raw TMDB total), with 3 future episodes listed', async () => {
    trackedShowResult = { data: { id: 1, tmdb_id: 501, name: 'Example Show' }, error: null }
    watchedRowsResult = {
      data: Array.from({ length: 22 }, (_, i) => ({ season_number: 1, episode_number: i + 1 })),
      error: null,
    }
    getShowDetails.mockResolvedValue({ seasons: [{ season_number: 1 }] })
    getSeasonEpisodes.mockResolvedValue({
      episodes: [
        ...Array.from({ length: 23 }, (_, i) => ({
          episode_number: i + 1, name: `E${i + 1}`, air_date: '2026-01-01', runtime: 40,
        })),
        // 3 future TMDB rows already listed — must not inflate the denominator.
        ...Array.from({ length: 3 }, (_, i) => ({
          episode_number: 24 + i, name: `Future ${i}`, air_date: '2099-01-01', runtime: 40,
        })),
      ],
    })

    await renderShowDetail(501)

    // The hero count is released-only (22/23). The season row below it
    // intentionally keeps its own established raw-total semantics (22/26)
    // per spec — so this asserts the hero text specifically, not the whole
    // page, to avoid a false negative against that legitimate season row.
    const hero = container.querySelector('.content-surface')
    expect(hero.textContent).toContain('22/23 episodes watched')
    expect(hero.textContent).not.toContain('22/26')
  })

  it('clamps the progress bar width at 100% even if watched somehow reaches every released episode', async () => {
    trackedShowResult = { data: { id: 2, tmdb_id: 502, name: 'Finished Run' }, error: null }
    watchedRowsResult = {
      data: [{ season_number: 1, episode_number: 1 }, { season_number: 1, episode_number: 2 }],
      error: null,
    }
    getShowDetails.mockResolvedValue({ seasons: [{ season_number: 1 }] })
    getSeasonEpisodes.mockResolvedValue({
      episodes: [
        { episode_number: 1, name: 'E1', air_date: '2026-01-01', runtime: 40 },
        { episode_number: 2, name: 'E2', air_date: '2026-01-08', runtime: 40 },
      ],
    })

    await renderShowDetail(502)

    expect(container.textContent).toContain('2/2 episodes watched')
    const fill = container.querySelector('.progress-fill')
    expect(fill.style.width).toBe('100%')
  })
})

describe('ShowDetail — cross-route stale-refresh protection', () => {
  it('does not let a stale watched fetch revert an in-flight quick tick from another route', async () => {
    trackedShowResult = { data: { id: 3, tmdb_id: 601, name: 'Race Show' }, error: null }
    // The background read captured its snapshot before the quick tick's upsert
    // was visible, so it is missing episode 2.
    watchedRowsResult = {
      data: [{ season_number: 1, episode_number: 1 }],
      error: null,
    }
    getShowDetails.mockResolvedValue({ seasons: [{ season_number: 1 }] })
    getSeasonEpisodes.mockResolvedValue({
      episodes: [
        { episode_number: 1, name: 'E1', air_date: '2026-01-01', runtime: 40 },
        { episode_number: 2, name: 'E2', air_date: '2026-01-08', runtime: 40 },
      ],
    })

    // A Watching quick tick just marked S1E2 watched; its upsert is still
    // pending, so the cross-route overlay is live.
    setOptimisticWatchOverlay({ tmdbShowId: 601, seasonNumber: 1, episodeNumber: 2, watched: true })

    await renderShowDetail(601)

    // The stale fetch (1/2) must be reconciled up to the optimistic 2/2, and
    // the cache ShowDetail rewrote must keep the optimistic key rather than the
    // stale server snapshot.
    expect(container.textContent).toContain('2/2 episodes watched')
    const cached = readDetailCache(showDetailCacheKey(601))
    expect(cached.watchedList.sort()).toEqual(['1:1', '1:2'])

    // Once the mutation settles the overlay is dropped; a later fetch is free
    // to be authoritative again.
    clearOptimisticWatchOverlay({ tmdbShowId: 601, seasonNumber: 1, episodeNumber: 2 })
  })
})
