// @vitest-environment jsdom
//
// Integration coverage for the Insights All(n) collapse: proves the parent
// Stats route (src/routes/Stats.jsx) stays the single authoritative data
// owner across /stats and /stats/all — no second TMDB/Supabase load on
// entering the expanded page — and that actions (restore/remove) taken on
// /stats/all update the same shared state the main preview count reads.
// Mounted as TabBar + Stats' own nested <Routes>, deliberately without the
// persistent Watching subtree (unrelated to this change, and already
// covered — untouched — by the full regression suite).
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TabBar from '../components/TabBar'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function makeSelectChain(result) {
  const chain = {
    eq: () => chain,
    in: () => chain,
    is: () => chain,
    order: () => chain,
    range: () => chain,
    abortSignal: () => chain,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  }
  return chain
}

let trackedShowsResult
let watchedEpisodesResult
const updateCalls = []

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table) => ({
      select: () => {
        if (table === 'watched_episodes') return makeSelectChain(watchedEpisodesResult)
        if (table === 'tracked_shows') return makeSelectChain(trackedShowsResult)
        throw new Error(`unexpected select on ${table}`)
      },
      update: (patch) => ({
        eq: (_col, tmdbId) => {
          updateCalls.push({ tmdbId, patch })
          const row = trackedShowsResult.data.find((show) => show.tmdb_id === tmdbId)
          if (row) Object.assign(row, patch)
          return Promise.resolve({ error: null })
        },
      }),
    }),
  },
}))

vi.mock('../lib/tmdb', () => ({
  getShowDetails: vi.fn(),
  getSeasonEpisodes: vi.fn(),
  POSTER_BASE: 'https://image.tmdb.org/t/p/w342',
}))

import { getShowDetails, getSeasonEpisodes } from '../lib/tmdb'
import Stats, { clearStatsCache } from './Stats'

function trackedShow(tmdbId, name, extra = {}) {
  return { tmdb_id: tmdbId, name, poster_path: null, finished_at: null, hidden_at: null, ...extra }
}

function watchedRow(tmdbId, season, episode) {
  return { tmdb_show_id: tmdbId, season_number: season, episode_number: episode, watched_at: '2026-01-01T00:00:00Z' }
}

let container = null
let root = null

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

async function mount(initialEntries = ['/stats']) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={initialEntries}>
        <TabBar />
        <Routes>
          <Route path="/stats/*" element={<Stats />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await flush()
}

beforeEach(() => {
  updateCalls.length = 0
  trackedShowsResult = {
    data: [trackedShow(501, 'Alpha Show'), trackedShow(502, 'Beta Show')],
    error: null,
  }
  watchedEpisodesResult = {
    data: [watchedRow(501, 1, 1), watchedRow(502, 1, 1)],
    error: null,
  }
  getShowDetails.mockResolvedValue({
    name: 'Show', poster_path: null, seasons: [{ season_number: 1 }], episode_run_time: [40], networks: [],
  })
  getSeasonEpisodes.mockResolvedValue({ episodes: [{ episode_number: 1, runtime: 40 }] })
  localStorage.clear()
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
  vi.clearAllMocks()
})

function insightsTab() {
  return [...container.querySelectorAll('a')].find((a) => a.getAttribute('aria-label') === 'Insights')
}

describe('Stats + StatsAllShows integration — shared state, no second loader', () => {
  it('loads once, renders All(4) on the main page, and does not refetch TMDB/Supabase when entering /stats/all', async () => {
    // The preview's chevron/more-link only renders once a history actually
    // clips (4+ shows) — bump past the 2-show default fixture so there's a
    // link to click at all.
    trackedShowsResult.data.push(trackedShow(503, 'Gamma Show'), trackedShow(504, 'Delta Show'))
    watchedEpisodesResult.data.push(watchedRow(503, 1, 1), watchedRow(504, 1, 1))

    await mount(['/stats'])
    expect(container.textContent).toContain('All(4)')
    const callsBeforeNav = getShowDetails.mock.calls.length
    expect(callsBeforeNav).toBeGreaterThan(0)

    const previewLink = container.querySelector('a[href="/stats/all"]')
    await act(async () => { previewLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()

    expect(container.querySelector('h1').textContent).toBe('All Shows')
    expect(container.textContent).toContain('Alpha Show')
    expect(container.textContent).toContain('Beta Show')
    // Same data, no second load triggered purely by the route change.
    expect(getShowDetails.mock.calls.length).toBe(callsBeforeNav)
  })

  it('keeps the Insights tab active on /stats/all and returns to /stats without a broken route on tap', async () => {
    await mount(['/stats/all'])
    await flush()
    expect(insightsTab().getAttribute('aria-current')).toBe('page')
    expect(container.querySelector('h1').textContent).toBe('All Shows')

    await act(async () => {
      insightsTab().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await flush()
    expect(container.textContent).toContain('All(2)')
    expect(container.querySelector('.nested-header')).toBeNull()
  })

  it('direct entry at /stats/all renders immediately (no NotFound) and the back control returns to /stats', async () => {
    await mount(['/stats/all'])
    expect(container.querySelector('h1').textContent).toBe('All Shows')
    expect(container.textContent).not.toContain('Page not found')

    const back = container.querySelector('.nested-header__back')
    expect(back.getAttribute('aria-label')).toBe('Back to Insights')
    await act(async () => { back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()
    expect(container.textContent).toContain('All(2)')
  })

  it('direct reload at /stats/all paints instantly from the Stats cache — no skeleton, no blank screen', async () => {
    // Seed the same cache Stats itself writes, simulating a prior /stats visit.
    localStorage.setItem('stats_cache:v3', JSON.stringify({
      shows: [
        { tmdb_id: 501, name: 'Alpha Show', poster_path: null, finished_at: null, hidden_at: null, watched: 1, total: 1, networks: [], minutes: 40 },
        { tmdb_id: 502, name: 'Beta Show', poster_path: null, finished_at: null, hidden_at: null, watched: 1, total: 1, networks: [], minutes: 40 },
      ],
      watchedRows: [watchedRow(501, 1, 1), watchedRow(502, 1, 1)],
      totalMinutes: 80,
      insights: [],
    }))

    await mount(['/stats/all'])
    expect(container.querySelectorAll('.skeleton-block').length).toBe(0)
    expect(container.textContent).toContain('Alpha Show')
    expect(container.textContent).toContain('Beta Show')
  })
})

describe('Stats + StatsAllShows integration — actions update shared state', () => {
  it('restoring a finished show from /stats/all updates the shared show and shows a success banner', async () => {
    trackedShowsResult.data[1].finished_at = '2026-01-01T00:00:00Z'
    await mount(['/stats/all'])

    const actionButton = container.querySelector('[aria-label="Actions for Beta Show"]')
    await act(async () => { actionButton.click() })
    const restoreButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Restore to Watching')
    await act(async () => { restoreButton.click() })
    await flush()

    expect(updateCalls).toContainEqual({ tmdbId: 502, patch: { finished_at: null, hidden_at: null } })
    expect(container.textContent).toContain('Beta Show is active in Watching again.')
  })

  it('removing one of two shows updates the grid and the main-page count reflects it on return — no redirect yet', async () => {
    await mount(['/stats/all'])

    const actionButton = container.querySelector('[aria-label="Actions for Beta Show"]')
    await act(async () => { actionButton.click() })
    const removeButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove from Insights')
    await act(async () => { removeButton.click() })
    await flush()

    const confirmButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove from Insights')
    await act(async () => { confirmButton.click() })
    await flush()

    expect(container.querySelector('h1').textContent).toBe('All Shows')
    expect(container.textContent).toContain('Alpha Show')
    expect(container.textContent).not.toContain('Beta Show')

    const back = container.querySelector('.nested-header__back')
    await act(async () => { back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()
    expect(container.textContent).toContain('All(1)')
  })

  it('removing the last remaining show redirects cleanly to the main empty state instead of leaving a stale /stats/all screen', async () => {
    trackedShowsResult.data = [trackedShow(501, 'Alpha Show')]
    watchedEpisodesResult.data = [watchedRow(501, 1, 1)]
    await mount(['/stats/all'])
    expect(container.textContent).toContain('Alpha Show')

    const actionButton = container.querySelector('[aria-label="Actions for Alpha Show"]')
    await act(async () => { actionButton.click() })
    const removeButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove from Insights')
    await act(async () => { removeButton.click() })
    await flush()
    const confirmButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove from Insights')
    await act(async () => { confirmButton.click() })
    await flush()

    // Back on the main Insights route, showing the empty state — not a
    // stale, count-less /stats/all grid.
    expect(container.querySelector('.nested-header')).toBeNull()
    expect(container.textContent).toContain('Your viewing journal is empty')
    expect(container.textContent).not.toContain('All(0)')
  })
})

describe('Stats cache export is unaffected by the routing refactor', () => {
  it('clearStatsCache still clears the same cache key', async () => {
    await mount(['/stats'])
    expect(localStorage.getItem('stats_cache:v3')).not.toBeNull()
    clearStatsCache()
    expect(localStorage.getItem('stats_cache:v3')).toBeNull()
  })
})
