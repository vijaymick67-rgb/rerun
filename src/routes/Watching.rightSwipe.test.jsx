// @vitest-environment jsdom
//
// Proves the mobile right-swipe gesture drives the exact same onQuickMark
// path, mutation queue, optimistic commit, cache sync, and rollback as the
// tick button (see Watching.quickMark.test.jsx) — through the real, mounted
// Watching route, not a mocked WatchingRow. WatchingRow itself never touches
// Supabase/mutation logic; it only calls onQuickMark(show) on a recognized
// swipe, exactly like the tick button's onClick does.
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
import { resetOptimisticWatchOverlay } from '../lib/detailCache'

const SHOW = { id: 1, tmdb_id: 900, name: 'The Sopranos', poster_path: null, added_at: '2026-01-01T00:00:00Z', finished_at: null, hidden_at: null }

const season1 = [
  { episode_number: 1, name: 'S1E1', air_date: '2015-01-01', runtime: 40 },
  { episode_number: 2, name: 'S1E2', air_date: '2015-01-08', runtime: 40 },
]
const season2 = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
  episode_number: n, name: `S2E${n}`, air_date: `2015-02-${String(n).padStart(2, '0')}`, runtime: 40,
}))

function watchedRows(pairs) {
  return pairs.map(([season_number, episode_number]) => ({ tmdb_show_id: 900, season_number, episode_number }))
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

function touchEvent(type, x, y) {
  return new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }],
  })
}

async function rightSwipe(front, { x0 = 40, dx = 100, steps = 5 } = {}) {
  await act(async () => { front.dispatchEvent(touchEvent('touchstart', x0, 40)) })
  for (let i = 1; i <= steps; i += 1) {
    const x = x0 + (dx * i) / steps
    await act(async () => { front.dispatchEvent(touchEvent('touchmove', x, 40)) })
  }
  await act(async () => { front.dispatchEvent(touchEvent('touchend', x0 + dx, 40)) })
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
  localStorage.clear()
  resetOptimisticWatchOverlay()
})

describe('Watching — mobile right-swipe quick mark (real route, real gesture)', () => {
  it('a real right-swipe touch sequence marks S2E5 through the same onQuickMark path as the tick, and advances the row', async () => {
    await mountWatching()
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).not.toBeNull()

    const front = container.querySelector('.touch-pan-y')
    await rightSwipe(front)
    await flush()

    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0]).toEqual({
      tmdb_show_id: 900, season_number: 2, episode_number: 5, episode_name: 'S2E5',
      runtime_minutes: 40, watched_at: expect.any(String),
    })
    expect(container.querySelector('[aria-label="Mark S2E6 of The Sopranos watched"]')).not.toBeNull()
  })

  it('a swipe short of the activation distance does not mutate anything', async () => {
    await mountWatching()
    const front = container.querySelector('.touch-pan-y')
    await rightSwipe(front, { dx: 20 })
    await flush()
    expect(upsertCalls).toHaveLength(0)
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).not.toBeNull()
  })

  it('on Supabase failure via swipe, still rolls back the row and shows the existing error banner', async () => {
    upsertImpl = async () => { throw new Error('network down') }
    await mountWatching()
    const front = container.querySelector('.touch-pan-y')
    await rightSwipe(front)
    await flush()

    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    const button = container.querySelector('.watching-quick-mark')
    expect(button.disabled).toBe(false)
  })

  it('success feedback is "gesture accepted" feedback: it fires immediately and self-clears on a fixed schedule, independent of the mutation eventually failing', async () => {
    vi.useFakeTimers()
    let rejectUpsert
    upsertImpl = () => new Promise((_resolve, reject) => { rejectUpsert = reject })
    await mountWatching()
    const front = container.querySelector('.touch-pan-y')
    const row = () => container.querySelector('.watching-row-front')

    await rightSwipe(front)
    await flush()
    // Fires the instant the swipe is recognized — well before the mutation
    // (still pending) has resolved either way.
    expect(row().getAttribute('data-success-flash')).toBe('true')

    // Clears itself on its own fixed timer, not tied to the mutation result.
    await act(async () => { vi.advanceTimersByTime(450) })
    expect(row().getAttribute('data-success-flash')).toBeNull()

    // Only now does the mutation actually fail. Rollback — not the flash,
    // which is already long gone — is what's authoritative for the row.
    await act(async () => { rejectUpsert(new Error('network down')) })
    await flush()
    expect(row().getAttribute('data-success-flash')).toBeNull()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()

    vi.useRealTimers()
  })

  it('a swipe cannot double-mutate while the row is pending (blocked exactly like a second tick tap)', async () => {
    let resolveUpsert
    upsertImpl = () => new Promise((resolve) => { resolveUpsert = resolve })
    await mountWatching()
    const front = container.querySelector('.touch-pan-y')

    await rightSwipe(front)
    await flush()
    expect(upsertCalls).toHaveLength(1)

    // A second swipe while still pending must not queue a second mutation —
    // the row is ineligible (isQuickMarking) so it never even displaces.
    await rightSwipe(front)
    await flush()
    expect(upsertCalls).toHaveLength(1)

    await act(async () => { resolveUpsert({ error: null }) })
    await flush()
    expect(upsertCalls).toHaveLength(1)
  })
})
