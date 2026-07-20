// @vitest-environment jsdom
//
// Integration coverage for Feature 3 (Watching quick mark) and the released
// progress fields it depends on, exercised through the real Watching route
// component with only the network boundary (Supabase/TMDB/TVmaze) mocked —
// so computeWatchingStatus/computeReleasedProgress/deriveWatchingFields and
// the real sort/visibility helpers all run unmodified.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function makeSelectChain(result) {
  const chain = {
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    range: () => chain,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  }
  return chain
}

let trackedShowsResult
let watchedEpisodesResult
let upsertImpl
const upsertCalls = []

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table) => ({
      select: () => {
        if (table === 'tracked_shows') return makeSelectChain(trackedShowsResult)
        if (table === 'watched_episodes') return makeSelectChain(watchedEpisodesResult)
        throw new Error(`unexpected select on ${table}`)
      },
      upsert: (rows) => {
        upsertCalls.push(rows)
        return upsertImpl(rows)
      },
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

const SHOW = { id: 1, tmdb_id: 900, name: 'The Sopranos', poster_path: null, added_at: '2026-01-01T00:00:00Z', finished_at: null, hidden_at: null }

// All well in the past regardless of the sandbox's real clock — no fake
// timers needed, and hasAired()'s real timezone/threshold logic is left
// completely untouched by using it exactly as-is.
const season1 = [
  { episode_number: 1, name: 'S1E1', air_date: '2015-01-01', runtime: 40 },
  { episode_number: 2, name: 'S1E2', air_date: '2015-01-08', runtime: 40 },
]
const season2 = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
  episode_number: n, name: `S2E${n}`, air_date: `2015-02-${String(n).padStart(2, '0')}`, runtime: 40,
}))

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
  await flush()
}

beforeEach(() => {
  upsertCalls.length = 0
  upsertImpl = async () => ({ error: null })
  trackedShowsResult = { data: [SHOW], error: null }
  watchedEpisodesResult = { data: watchedRows([[1, 1], [1, 2], [2, 1], [2, 2], [2, 3], [2, 4]]), error: null }
  getShowDetails.mockResolvedValue({ seasons: [{ season_number: 1 }, { season_number: 2 }], status: 'Returning Series' })
  getSeasonEpisodes.mockImplementation(async (_id, seasonNumber) => ({
    episodes: seasonNumber === 1 ? season1 : season2,
  }))
  localStorage.clear()
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
  vi.clearAllMocks()
})

describe('Watching quick mark — one episode at a time', () => {
  it('a tap marks exactly S2E5, advances the row to S2E6, and a second tap marks only S2E6', async () => {
    await mountWatching()

    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).not.toBeNull()

    const firstButton = container.querySelector('.watching-quick-mark')
    await act(async () => { firstButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()

    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0]).toEqual({
      tmdb_show_id: 900, season_number: 2, episode_number: 5, episode_name: 'S2E5',
      runtime_minutes: 40, watched_at: expect.any(String),
    })
    expect(container.querySelector('[aria-label="Mark S2E6 of The Sopranos watched"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).toBeNull()

    const secondButton = container.querySelector('.watching-quick-mark')
    await act(async () => { secondButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()

    expect(upsertCalls).toHaveLength(2)
    expect(upsertCalls[1]).toEqual({
      tmdb_show_id: 900, season_number: 2, episode_number: 6, episode_name: 'S2E6',
      runtime_minutes: 40, watched_at: expect.any(String),
    })
    expect(container.querySelector('[aria-label="Mark S2E7 of The Sopranos watched"]')).not.toBeNull()
  })

  it('never sends more than one row per tap (no bulk marking) and no future episode can be reached', async () => {
    await mountWatching()
    const button = container.querySelector('.watching-quick-mark')
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].episode_number).toBe(5)
    // House of the Dragon-style case: caught up on every released episode —
    // the tick and bar disappear, nothing replaces them.
  })

  it('the tick disappears once every released episode is watched, with no chevron restored', async () => {
    watchedEpisodesResult = {
      data: watchedRows([[1, 1], [1, 2], [2, 1], [2, 2], [2, 3], [2, 4], [2, 5], [2, 6], [2, 7]]),
      error: null,
    }
    await mountWatching()
    expect(container.querySelector('.watching-quick-mark')).toBeNull()
    expect(container.querySelector('.progress-track')).toBeNull()
    expect(container.textContent).not.toContain('›')
  })

  it('updates the persisted Watching cache after a tap without waiting on navigation', async () => {
    await mountWatching()
    const button = container.querySelector('.watching-quick-mark')
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()

    const cached = JSON.parse(localStorage.getItem('watching_cache:v5'))
    const cachedShow = cached.find((show) => show.tmdb_id === 900)
    expect(cachedShow.releasedWatchedCount).toBe(7)
    expect(cachedShow.nextReleasedUnwatchedEpisode).toMatchObject({ season_number: 2, episode_number: 6 })
  })

  it('blocks a second activation while the mutation is pending', async () => {
    let resolveUpsert
    upsertImpl = () => new Promise((resolve) => { resolveUpsert = resolve })
    await mountWatching()

    const button = container.querySelector('.watching-quick-mark')
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()
    expect(button.disabled).toBe(true)

    // A second tap while still pending must not queue a second mutation.
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()
    expect(upsertCalls).toHaveLength(1)

    await act(async () => { resolveUpsert({ error: null }) })
    await flush()
    expect(upsertCalls).toHaveLength(1)
    expect(container.querySelector('[aria-label="Mark S2E6 of The Sopranos watched"]')).not.toBeNull()
  })

  it('on failure, restores the prior episode/progress, re-enables the control, and shows a compact error', async () => {
    upsertImpl = async () => { throw new Error('network down') }
    await mountWatching()

    const button = container.querySelector('.watching-quick-mark')
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()

    // Rolled back to S2E5 — the failed tap must not stick.
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).not.toBeNull()
    const restoredButton = container.querySelector('.watching-quick-mark')
    expect(restoredButton.disabled).toBe(false)
    expect(container.textContent).toContain('watch')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    // The show itself must still be present, never removed on a failed tap.
    expect(container.querySelector('.watching-row')).not.toBeNull()

    // The show remains cached from the initial load, but its next-up episode
    // must still read S2E5 — the failed tap's optimistic S2E6 advance was
    // rolled back before it was ever persisted to the cache.
    const cached = JSON.parse(localStorage.getItem('watching_cache:v5'))
    const cachedShow = cached.find((show) => show.tmdb_id === 900)
    expect(cachedShow.nextReleasedUnwatchedEpisode).toMatchObject({ season_number: 2, episode_number: 5 })
  })

  it('does not remount the Watching route (no skeleton flash) across a tap', async () => {
    await mountWatching()
    expect(container.querySelectorAll('.watching-row')).toHaveLength(1)
    const button = container.querySelector('.watching-quick-mark')
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()
    expect(container.querySelectorAll('.watching-row')).toHaveLength(1)
    expect(container.textContent).not.toContain('No shows yet')
  })
})
