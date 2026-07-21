// @vitest-environment jsdom
//
// Integration coverage for Feature 2 (advance an expired cached countdown
// before first render), exercised through the real Watching route with only
// the network boundary (Supabase/TMDB/TVmaze) mocked — so the real
// sortWatchingShows/isVisibleInWatching/deriveWatchingFields/hasAired all run
// unmodified, and the pre-render transition (watchingCacheTransition.js) runs
// exactly as Watching.jsx wires it, in the lazy useState initializer.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function makeSelectChain(result, gate = Promise.resolve()) {
  const resolveResult = () => gate.then(() => result)
  const chain = {
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    range: () => chain,
    maybeSingle: () => resolveResult(),
    then: (resolve, reject) => resolveResult().then(resolve, reject),
  }
  return chain
}

let trackedShowsResult
let watchedEpisodesResult
let watchedEpisodesGate

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table) => ({
      select: () => {
        if (table === 'tracked_shows') return makeSelectChain(trackedShowsResult)
        if (table === 'watched_episodes') return makeSelectChain(watchedEpisodesResult, watchedEpisodesGate)
        throw new Error(`unexpected select on ${table}`)
      },
      upsert: () => Promise.resolve({ error: null }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
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
import Watching from './Watching'

const SHOW = {
  id: 1, tmdb_id: 900, name: 'Test Show', poster_path: null,
  added_at: '2026-01-01T00:00:00Z', finished_at: null, hidden_at: null,
}

function watchedRows(pairs) {
  return pairs.map(([season_number, episode_number]) => ({
    tmdb_show_id: 900, season_number, episode_number,
  }))
}

async function flush() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

let container = null
let root = null

async function mountWatching() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Watching active />
      </MemoryRouter>,
    )
  })
}

beforeEach(() => {
  trackedShowsResult = { data: [SHOW], error: null }
  watchedEpisodesResult = { data: watchedRows([[1, 1]]), error: null }
  watchedEpisodesGate = Promise.resolve()
  localStorage.clear()
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
  vi.clearAllMocks()
})

// A resolved release instant safely in the past regardless of the sandbox's
// real clock — no fake timers needed, matching the rest of this suite's
// approach to hasAired()'s real timezone/threshold logic.
const PAST_RELEASE_TIMESTAMP = Date.parse('2015-02-01T00:00:00Z')

function cachedCountdownShow(overrides = {}) {
  return {
    id: 1, tmdb_id: 900, name: 'Test Show', poster_path: null,
    added_at: '2026-01-01T00:00:00Z', finished_at: null, hidden_at: null,
    status: {
      type: 'countdown', subtype: 'episode', season_number: 2, episode_number: 1,
      name: 'Second Season Premiere', air_date: '2015-02-01', daysUntil: 0, airsSoon: false,
    },
    releasedEpisodeCount: 1, releasedWatchedCount: 1, releasedProgress: 100,
    nextReleasedUnwatchedEpisode: null,
    nextScheduledEpisode: {
      season_number: 2, episode_number: 1, name: 'Second Season Premiere', runtime: 40,
      release: { timestamp: PAST_RELEASE_TIMESTAMP, istDate: '2015-02-01' },
    },
    ...overrides,
  }
}

describe('Watching cache pre-render transition (Feature 2)', () => {
  it('a cache written before threshold and reopened before it still shows the countdown on first render', async () => {
    const future = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000)
    const cachedShow = cachedCountdownShow({
      nextScheduledEpisode: {
        season_number: 2, episode_number: 1, name: 'Second Season Premiere', runtime: 40,
        release: { timestamp: future.getTime(), istDate: future.toISOString().slice(0, 10) },
      },
    })
    localStorage.setItem('watching_cache:v6', JSON.stringify([cachedShow]))

    let releaseGate
    watchedEpisodesGate = new Promise((resolve) => { releaseGate = resolve })
    getShowDetails.mockResolvedValue({ seasons: [{ season_number: 1 }, { season_number: 2 }], status: 'Returning Series' })
    getSeasonEpisodes.mockImplementation(async (_id, seasonNumber) => ({
      episodes: seasonNumber === 1
        ? [{ episode_number: 1, name: 'S1E1', air_date: '2015-01-01', runtime: 40 }]
        : [{ episode_number: 1, name: 'Second Season Premiere', air_date: future.toISOString().slice(0, 10), runtime: 40 }],
    }))

    await mountWatching()

    expect(container.textContent).not.toContain('Up next')
    expect(container.querySelector('.watching-countdown-pill')).not.toBeNull()

    await act(async () => releaseGate())
    await flush()
    expect(container.textContent).not.toContain('Up next')
  })

  it('a cache written before threshold and reopened after it renders Up next on the very first frame, with the bar immediate and the tick delayed', async () => {
    const cachedShow = cachedCountdownShow()
    localStorage.setItem('watching_cache:v6', JSON.stringify([cachedShow]))

    let releaseGate
    watchedEpisodesGate = new Promise((resolve) => { releaseGate = resolve })
    getShowDetails.mockResolvedValue({ seasons: [{ season_number: 1 }, { season_number: 2 }], status: 'Returning Series' })
    getSeasonEpisodes.mockImplementation(async (_id, seasonNumber) => ({
      episodes: seasonNumber === 1
        ? [{ episode_number: 1, name: 'S1E1', air_date: '2015-01-01', runtime: 40 }]
        : [{ episode_number: 1, name: 'Second Season Premiere', air_date: '2015-02-01', runtime: 40 }],
    }))

    await mountWatching()

    // First frame — before the watched_episodes fetch (and therefore the
    // mutation context handleQuickMark needs) has resolved at all.
    expect(container.textContent).toContain('Up next: S2E1')
    expect(container.textContent).not.toContain('New episode soon')
    expect(container.querySelector('.watching-countdown-pill')).toBeNull()
    expect(container.querySelector('.progress-track')).not.toBeNull() // bar immediate
    // The cached row already knows a released unwatched episode exists, so
    // the check must be grey (available) from this very first frame — never
    // a false "not ready" placeholder and never a false green "caught up" —
    // even though this load's mutation context hasn't settled yet. It must
    // stay disabled/non-actionable until then.
    expect(container.querySelector('.watching-status-button').getAttribute('data-status')).toBe('available')
    expect(container.querySelector('.watching-status-button').disabled).toBe(true)

    await act(async () => releaseGate())
    await flush()

    // Background enrichment confirms the same state — no remount, no flash,
    // exactly one row — and the button becomes actionable now that context is
    // ready, with no color change.
    expect(container.querySelectorAll('.watching-row')).toHaveLength(1)
    expect(container.textContent).toContain('Up next: S2E1')
    expect(container.querySelector('.watching-status-button').getAttribute('data-status')).toBe('available')
    expect(container.querySelector('.watching-status-button').disabled).toBe(false)
  })

  it('background enrichment corrects a delayed episode cleanly, reverting the optimistic transition', async () => {
    const cachedShow = cachedCountdownShow()
    localStorage.setItem('watching_cache:v6', JSON.stringify([cachedShow]))

    // The real schedule was delayed: TMDB/TVmaze now say the episode airs
    // several days from now, not on the originally-cached date.
    const delayed = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    getShowDetails.mockResolvedValue({ seasons: [{ season_number: 1 }, { season_number: 2 }], status: 'Returning Series' })
    getSeasonEpisodes.mockImplementation(async (_id, seasonNumber) => ({
      episodes: seasonNumber === 1
        ? [{ episode_number: 1, name: 'S1E1', air_date: '2015-01-01', runtime: 40 }]
        : [{ episode_number: 1, name: 'Second Season Premiere', air_date: delayed, runtime: 40 }],
    }))

    await mountWatching()
    await flush()

    // Corrected: the episode hasn't actually released — countdown, not Up
    // next. The optimistic cache transition rendered "Up next" provisionally
    // (proven by the previous test using the same cached row), but the real
    // background enrichment — the source of truth — cleanly reverts it once
    // it discovers the schedule moved.
    expect(container.textContent).not.toContain('Up next')
    expect(container.querySelector('.watching-countdown-pill')).not.toBeNull()
  })

  it('sorts a cache-transitioned row into its proper rank before first render', async () => {
    const transitioned = cachedCountdownShow({ id: 2, tmdb_id: 901, name: 'Later Show', added_at: '2026-01-02T00:00:00Z' })
    const alreadyNextUp = {
      id: 3, tmdb_id: 902, name: 'Earlier Show', poster_path: null,
      added_at: '2026-01-03T00:00:00Z', finished_at: null, hidden_at: null,
      status: { type: 'nextUp', season_number: 1, episode_number: 1, name: 'Pilot', air_date: '2015-01-01' },
      releasedEpisodeCount: 1, releasedWatchedCount: 0, releasedProgress: 0,
      nextReleasedUnwatchedEpisode: { season_number: 1, episode_number: 1, name: 'Pilot', runtime: 40 },
      nextScheduledEpisode: null,
    }
    localStorage.setItem('watching_cache:v6', JSON.stringify([transitioned, alreadyNextUp]))

    trackedShowsResult = {
      data: [SHOW, { id: 2, tmdb_id: 901, name: 'Later Show', poster_path: null, added_at: '2026-01-02T00:00:00Z', finished_at: null, hidden_at: null }, { id: 3, tmdb_id: 902, name: 'Earlier Show', poster_path: null, added_at: '2026-01-03T00:00:00Z', finished_at: null, hidden_at: null }],
      error: null,
    }
    let releaseGate
    watchedEpisodesGate = new Promise((resolve) => { releaseGate = resolve })
    getShowDetails.mockResolvedValue({ seasons: [{ season_number: 1 }], status: 'Returning Series' })
    getSeasonEpisodes.mockImplementation(async () => ({ episodes: [] }))

    await mountWatching()

    // Both rows are now status 'nextUp' (rank 0): tie-broken by ascending
    // air_date — Earlier Show (2015-01-01) must render before Later Show
    // (2015-02-01), exactly as sortWatchingShows already guarantees.
    const names = [...container.querySelectorAll('.type-show-title')].map((el) => el.textContent)
    expect(names).toEqual(['Earlier Show', 'Later Show'])

    await act(async () => releaseGate())
    await flush()
  })
})
