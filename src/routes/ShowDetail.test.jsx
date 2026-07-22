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
import { computeReleasedProgress } from '../lib/watchHelpers'
import {
  setOptimisticWatchOverlay,
  clearOptimisticWatchOverlay,
  resetOptimisticWatchOverlay,
  showDetailCacheKey,
  readDetailCache,
  writeDetailCache,
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
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function cachedShow(tmdbId, synopsis) {
  return {
    show: { id: tmdbId, tmdb_id: tmdbId, name: `Show ${tmdbId}` },
    synopsis,
    seasons: [{ season_number: 1 }],
    episodesBySeason: { 1: [] },
    watchedList: [],
  }
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

describe('ShowDetail - cached show-level synopsis hero', () => {
  it('renders cached synopsis immediately while the existing details refresh is pending', async () => {
    trackedShowResult = { data: { id: 9, tmdb_id: 509, name: 'Pending Refresh' }, error: null }
    watchedRowsResult = { data: [], error: null }
    writeDetailCache(showDetailCacheKey(509), cachedShow(509, 'Visible before refresh settles.'))
    getShowDetails.mockReturnValue(new Promise(() => {}))

    await renderShowDetail(509)

    expect(container.querySelector('.show-detail-hero__synopsis').textContent)
      .toBe('Visible before refresh settles.')
  })

  it('renders the existing TMDB show overview and removes progress presentation', async () => {
    trackedShowResult = { data: { id: 1, tmdb_id: 501, name: 'Example Show' }, error: null }
    watchedRowsResult = { data: [{ season_number: 1, episode_number: 1 }], error: null }
    getShowDetails.mockResolvedValue({
      overview: 'A family confronts the cost of an extraordinary legacy.',
      seasons: [{ season_number: 1 }, { season_number: 2 }],
    })
    getSeasonEpisodes.mockResolvedValue({
      episodes: [{ episode_number: 1, overview: 'Episode-specific copy.', air_date: '2026-01-01' }],
    })

    await renderShowDetail(501)

    const hero = container.querySelector('.show-detail-hero')
    expect(hero.querySelector('.show-detail-hero__synopsis').textContent)
      .toBe('A family confronts the cost of an extraordinary legacy.')
    expect(hero.textContent).not.toMatch(/Viewing progress|episodes watched|season count/i)
    expect(hero.querySelector('[role="progressbar"]')).toBeNull()
    expect(container.querySelector('.detail-seasons-heading h2').textContent).toBe('Seasons (2)')
    expect(getShowDetails).toHaveBeenCalledTimes(1)
    expect(readDetailCache(showDetailCacheKey(501)).synopsis)
      .toBe('A family confronts the cost of an extraordinary legacy.')
  })

  it('keeps a valid cached synopsis when refresh returns an empty overview', async () => {
    trackedShowResult = { data: { id: 2, tmdb_id: 502, name: 'Finished Run' }, error: null }
    watchedRowsResult = { data: [], error: null }
    writeDetailCache(showDetailCacheKey(502), cachedShow(502, 'The durable cached series synopsis.'))
    getShowDetails.mockResolvedValue({ overview: '   ', seasons: [{ season_number: 1 }] })
    getSeasonEpisodes.mockResolvedValue({ episodes: [] })

    await renderShowDetail(502)

    expect(container.querySelector('.show-detail-hero__synopsis').textContent)
      .toBe('The durable cached series synopsis.')
    expect(readDetailCache(showDetailCacheKey(502)).synopsis)
      .toBe('The durable cached series synopsis.')
  })

  it('replaces an older cached synopsis with a fresh non-empty TMDB overview', async () => {
    trackedShowResult = { data: { id: 6, tmdb_id: 506, name: 'Fresh Copy' }, error: null }
    watchedRowsResult = { data: [], error: null }
    writeDetailCache(showDetailCacheKey(506), cachedShow(506, 'Older cached synopsis.'))
    getShowDetails.mockResolvedValue({
      overview: 'Fresh show-level TMDB synopsis.',
      seasons: [{ season_number: 1 }],
    })
    getSeasonEpisodes.mockResolvedValue({ episodes: [] })

    await renderShowDetail(506)

    expect(container.querySelector('.show-detail-hero__synopsis').textContent)
      .toBe('Fresh show-level TMDB synopsis.')
    expect(readDetailCache(showDetailCacheKey(506)).synopsis)
      .toBe('Fresh show-level TMDB synopsis.')
  })

  it('does not substitute season or episode overviews when show overview is missing', async () => {
    trackedShowResult = { data: { id: 3, tmdb_id: 503, name: 'No Overview' }, error: null }
    watchedRowsResult = { data: [], error: null }
    getShowDetails.mockResolvedValue({
      overview: null,
      seasons: [{ season_number: 1, overview: 'Season copy must not appear.' }],
    })
    getSeasonEpisodes.mockResolvedValue({
      episodes: [{ episode_number: 1, overview: 'Episode copy must not appear.' }],
    })

    await renderShowDetail(503)

    expect(container.querySelector('.show-detail-hero__synopsis').textContent)
      .toBe('Synopsis unavailable.')
    expect(container.textContent).not.toMatch(/Season copy|Episode copy/)
  })

  it('keeps cached synopsis visible when the background TMDB refresh fails', async () => {
    trackedShowResult = { data: { id: 4, tmdb_id: 504, name: 'Cached Failure' }, error: null }
    watchedRowsResult = { data: [], error: null }
    writeDetailCache(showDetailCacheKey(504), cachedShow(504, 'Still available while offline.'))
    getShowDetails.mockRejectedValue(new Error('TMDB unavailable'))

    await renderShowDetail(504)

    expect(container.querySelector('.show-detail-hero__synopsis').textContent)
      .toBe('Still available while offline.')
    expect(readDetailCache(showDetailCacheKey(504)).synopsis)
      .toBe('Still available while offline.')
  })

  it('is backward-compatible with old cache entries lacking synopsis', async () => {
    trackedShowResult = { data: { id: 5, tmdb_id: 505, name: 'Old Cache' }, error: null }
    watchedRowsResult = { data: [], error: null }
    const oldEntry = cachedShow(505, undefined)
    delete oldEntry.synopsis
    writeDetailCache(showDetailCacheKey(505), oldEntry)
    getShowDetails.mockResolvedValue({ overview: '', seasons: [{ season_number: 1 }] })
    getSeasonEpisodes.mockResolvedValue({ episodes: [] })

    await renderShowDetail(505)

    expect(container.querySelector('.show-detail-hero__synopsis').textContent)
      .toBe('Synopsis unavailable.')
  })
})

describe('ShowDetail - cross-route stale-refresh protection', () => {
  it('does not let a stale watched fetch revert an in-flight quick tick from another route', async () => {
    trackedShowResult = { data: { id: 3, tmdb_id: 601, name: 'Race Show' }, error: null }
    watchedRowsResult = { data: [{ season_number: 1, episode_number: 1 }], error: null }
    getShowDetails.mockResolvedValue({ overview: 'Series overview.', seasons: [{ season_number: 1 }] })
    getSeasonEpisodes.mockResolvedValue({
      episodes: [
        { episode_number: 1, name: 'E1', air_date: '2026-01-01', runtime: 40 },
        { episode_number: 2, name: 'E2', air_date: '2026-01-08', runtime: 40 },
      ],
    })

    setOptimisticWatchOverlay({ tmdbShowId: 601, seasonNumber: 1, episodeNumber: 2, watched: true })

    await renderShowDetail(601)

    const cached = readDetailCache(showDetailCacheKey(601))
    expect(cached.watchedList.sort()).toEqual(['1:1', '1:2'])
    expect(cached.synopsis).toBe('Series overview.')

    clearOptimisticWatchOverlay({ tmdbShowId: 601, seasonNumber: 1, episodeNumber: 2 })
  })
})

describe('ShowDetail protected released-progress calculation', () => {
  it('still calculates 22/23 from released episodes without future TMDB rows', () => {
    const episodes = [
      ...Array.from({ length: 23 }, (_, index) => ({
        episode_number: index + 1,
        air_date: '2026-01-01',
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        episode_number: index + 24,
        air_date: '2099-01-01',
      })),
    ]
    const watched = new Set(Array.from({ length: 22 }, (_, index) => `1:${index + 1}`))

    const progress = computeReleasedProgress({ 1: episodes }, watched)
    expect(progress.releasedCount).toBe(23)
    expect(progress.watchedCount).toBe(22)
    expect(progress.percent).toBeCloseTo((22 / 23) * 100)
  })
})
