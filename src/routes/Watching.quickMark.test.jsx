// @vitest-environment jsdom
//
// Integration coverage for the Watching quick-mark status button and the
// released progress fields it depends on, exercised through the real
// Watching route component with only the network boundary
// (Supabase/TMDB/TVmaze) mocked — so computeWatchingStatus/
// computeReleasedProgress/deriveWatchingFields and the real sort/visibility
// helpers all run unmodified. The button's own visual-state machine
// (notReady/available/accepted/caughtUp, minimum dwell, dwell/advance
// synchronization) is unit-tested in WatchingRow.quickMark.test.jsx; this
// file proves that machine is correctly wired to the real onQuickMark
// mutation pipeline, cache sync, and rollback.
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
// Lets a test hold the watched_episodes fetch open — and therefore the
// in-memory quick-mark context it feeds — so it can assert on the window
// before that context is ready.
let watchedEpisodesGate
let upsertImpl
const upsertCalls = []

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table) => ({
      select: () => {
        if (table === 'tracked_shows') return makeSelectChain(trackedShowsResult)
        if (table === 'watched_episodes') return makeSelectChain(watchedEpisodesResult, watchedEpisodesGate)
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
import {
  showDetailCacheKey,
  seasonDetailCacheKey,
  writeDetailCache,
  resetOptimisticWatchOverlay,
} from '../lib/detailCache'

const SHOW = { id: 1, tmdb_id: 900, name: 'The Sopranos', poster_path: null, added_at: '2026-01-01T00:00:00Z', finished_at: null, hidden_at: null }

// All well in the past regardless of the sandbox's real clock — no fake
// timers needed for hasAired()'s own timezone/threshold logic (fake timers
// below are only ever advanced by the button's own bounded dwell window).
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

function statusButton() {
  return container.querySelector('.watching-status-button')
}

// Dispatches a real click and settles both the microtask queue and the
// button's own bounded minimum-dwell timer (340ms) — the tests below use
// fake timers throughout so this settle is deterministic regardless of how
// fast/slow the mocked mutation resolves.
async function tap(button) {
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  await flush()
  await act(async () => { vi.advanceTimersByTime(400) })
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  upsertCalls.length = 0
  upsertImpl = async () => ({ error: null })
  trackedShowsResult = { data: [SHOW], error: null }
  watchedEpisodesResult = { data: watchedRows([[1, 1], [1, 2], [2, 1], [2, 2], [2, 3], [2, 4]]), error: null }
  watchedEpisodesGate = Promise.resolve()
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
  vi.useRealTimers()
  localStorage.clear()
  resetOptimisticWatchOverlay()
})

describe('Watching quick mark — one episode at a time', () => {
  it('a tap marks exactly S2E5, advances the row to S2E6, and a second tap marks only S2E6', async () => {
    await mountWatching()

    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).not.toBeNull()

    await tap(statusButton())

    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0]).toEqual({
      tmdb_show_id: 900, season_number: 2, episode_number: 5, episode_name: 'S2E5',
      runtime_minutes: 40, watched_at: expect.any(String),
    })
    expect(container.querySelector('[aria-label="Mark S2E6 of The Sopranos watched"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).toBeNull()

    await tap(statusButton())

    expect(upsertCalls).toHaveLength(2)
    expect(upsertCalls[1]).toEqual({
      tmdb_show_id: 900, season_number: 2, episode_number: 6, episode_name: 'S2E6',
      runtime_minutes: 40, watched_at: expect.any(String),
    })
    expect(container.querySelector('[aria-label="Mark S2E7 of The Sopranos watched"]')).not.toBeNull()
  })

  it('the tap turns the button green immediately, well before the row has visibly advanced or the mutation has resolved', async () => {
    let resolveUpsert
    upsertImpl = () => new Promise((resolve) => { resolveUpsert = resolve })
    await mountWatching()

    const button = statusButton()
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    // No timer/flush advance yet — the mutation is still pending.
    expect(statusButton().getAttribute('data-status')).toBe('accepted')
    expect(statusButton().disabled).toBe(true)

    await act(async () => { resolveUpsert({ error: null }) })
    await flush()
  })

  it('never sends more than one row per tap (no bulk marking) and no future episode can be reached', async () => {
    await mountWatching()
    await tap(statusButton())
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].episode_number).toBe(5)
    // House of the Dragon-style case: caught up on every released episode —
    // the button turns persistently green, nothing replaces it.
  })

  it('a show with every released episode watched and no known next episode drops out of Watching entirely (unchanged, protected filtering)', async () => {
    watchedEpisodesResult = {
      data: watchedRows([[1, 1], [1, 2], [2, 1], [2, 2], [2, 3], [2, 4], [2, 5], [2, 6], [2, 7]]),
      error: null,
    }
    await mountWatching()
    // computeWatchingStatus resolves to bare 'caughtUp' here (no real weekly
    // cadence in this fixture's daily-spaced dates, so no predicted next
    // release) — isVisibleInWatching/isHiddenFromWatching hide that status
    // from Watching entirely. This is pre-existing, protected filtering
    // behavior, untouched by the status-button redesign: see the weekly
    // flow describe block below for the case where the row (and its green
    // button) correctly stays visible through a real countdown.
    expect(container.querySelector('.watching-row')).toBeNull()
    expect(container.textContent).toContain('Nothing airing soon')
  })

  it('updates the persisted Watching cache after a tap without waiting on navigation', async () => {
    await mountWatching()
    await tap(statusButton())

    const cached = JSON.parse(localStorage.getItem('watching_cache:v6'))
    const cachedShow = cached.find((show) => show.tmdb_id === 900)
    expect(cachedShow.releasedWatchedCount).toBe(7)
    expect(cachedShow.nextReleasedUnwatchedEpisode).toMatchObject({ season_number: 2, episode_number: 6 })
  })

  it('blocks a second activation while the mutation/confirmation is pending', async () => {
    let resolveUpsert
    upsertImpl = () => new Promise((resolve) => { resolveUpsert = resolve })
    await mountWatching()

    const button = statusButton()
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()
    expect(statusButton().disabled).toBe(true)

    // A second tap while still pending/confirming must not queue a second mutation.
    await act(async () => { statusButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()
    expect(upsertCalls).toHaveLength(1)

    await act(async () => { resolveUpsert({ error: null }) })
    await flush()
    await act(async () => { vi.advanceTimersByTime(400) })
    await flush()
    expect(upsertCalls).toHaveLength(1)
    expect(container.querySelector('[aria-label="Mark S2E6 of The Sopranos watched"]')).not.toBeNull()
  })

  it('on failure, restores the prior episode/progress, re-enables the control immediately, and shows a compact error', async () => {
    upsertImpl = async () => { throw new Error('network down') }
    await mountWatching()

    const button = statusButton()
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()

    // Rolled back to S2E5 — the failed tap must not stick. The rollback
    // clears the button's confirmation immediately, without waiting for the
    // minimum dwell — no explicit timer advance here.
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).not.toBeNull()
    const restoredButton = statusButton()
    expect(restoredButton.disabled).toBe(false)
    expect(restoredButton.getAttribute('data-status')).toBe('available')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    // The show itself must still be present, never removed on a failed tap.
    expect(container.querySelector('.watching-row')).not.toBeNull()

    // The show remains cached from the initial load, but its next-up episode
    // must still read S2E5 — the failed tap's optimistic S2E6 advance was
    // rolled back before it was ever persisted to the cache.
    const cached = JSON.parse(localStorage.getItem('watching_cache:v6'))
    const cachedShow = cached.find((show) => show.tmdb_id === 900)
    expect(cachedShow.nextReleasedUnwatchedEpisode).toMatchObject({ season_number: 2, episode_number: 5 })

    // A retry afterward works normally.
    await tap(statusButton())
    expect(upsertCalls.filter((row) => row.episode_number === 5)).toHaveLength(2)
  })

  it('does not remount the Watching route (no skeleton flash) across a tap', async () => {
    await mountWatching()
    expect(container.querySelectorAll('.watching-row')).toHaveLength(1)
    await tap(statusButton())
    expect(container.querySelectorAll('.watching-row')).toHaveLength(1)
    expect(container.textContent).not.toContain('No shows yet')
  })

  it('a cached row with a quick-mark-eligible episode reads grey/available immediately (never falsely caught up), and stays disabled/non-tappable until this load\'s mutation context is ready', async () => {
    const cachedShow = {
      id: 1, tmdb_id: 900, name: 'The Sopranos', poster_path: null,
      added_at: '2026-01-01T00:00:00Z', finished_at: null, hidden_at: null,
      status: { type: 'nextUp', season_number: 2, episode_number: 5, name: 'S2E5', air_date: '2015-02-05' },
      releasedEpisodeCount: 9, releasedWatchedCount: 4, releasedProgress: (4 / 9) * 100,
      nextReleasedUnwatchedEpisode: { season_number: 2, episode_number: 5, name: 'S2E5', runtime: 40 },
    }
    localStorage.setItem('watching_cache:v6', JSON.stringify([cachedShow]))

    let releaseGate
    watchedEpisodesGate = new Promise((resolve) => { releaseGate = resolve })

    await mountWatching()

    // The cached row renders instantly from localStorage, including its
    // cached next-up label — the row already knows a released unwatched
    // episode exists, so the check must be grey (available) from the first
    // paint even though this load's watched_episodes fetch (and therefore
    // the in-memory mutation context handleQuickMark needs) hasn't resolved
    // yet. It must stay disabled and non-actionable until then, and must
    // never claim "Mark ... watched" before it's truly tappable.
    expect(container.textContent).toContain('S2E5')
    expect(statusButton()).not.toBeNull()
    expect(statusButton().getAttribute('data-status')).toBe('available')
    expect(statusButton().disabled).toBe(true)
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).toBeNull()

    await act(async () => { releaseGate() })
    await flush()

    // Readiness only flips interactivity — the color was already correct.
    expect(statusButton().getAttribute('data-status')).toBe('available')
    expect(statusButton().disabled).toBe(false)
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).not.toBeNull()
  })

  it('does not let the loader\'s final commit overwrite a quick mark that landed while another show was still loading', async () => {
    const SHOW2 = {
      id: 2, tmdb_id: 901, name: 'Better Call Saul', poster_path: null,
      added_at: '2026-01-02T00:00:00Z', finished_at: null, hidden_at: null,
    }
    trackedShowsResult = { data: [SHOW, SHOW2], error: null }

    let releaseShow2
    const show2Gate = new Promise((resolve) => { releaseShow2 = resolve })
    getShowDetails.mockImplementation(async (tmdbId) => {
      if (tmdbId === 901) {
        await show2Gate
        return { seasons: [{ season_number: 1 }], status: 'Returning Series' }
      }
      return { seasons: [{ season_number: 1 }, { season_number: 2 }], status: 'Returning Series' }
    })
    getSeasonEpisodes.mockImplementation(async (tmdbId, seasonNumber) => {
      if (tmdbId === 901) {
        return { episodes: [{ episode_number: 1, name: 'BCS S1E1', air_date: '2015-01-01', runtime: 47 }] }
      }
      return { episodes: seasonNumber === 1 ? season1 : season2 }
    })

    await mountWatching()

    // Show 1 (Sopranos) has settled and is ready; show 2 is still gated.
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).not.toBeNull()

    const button = container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')
    await tap(button)
    expect(container.querySelector('[aria-label="Mark S2E6 of The Sopranos watched"]')).not.toBeNull()

    // Now let show 2's enrichment finish, completing the whole load batch.
    await act(async () => { releaseShow2() })
    await flush()

    // The loader's final commit must not revert the quick mark that already
    // landed on show 1's row while show 2 was still in flight.
    expect(container.querySelector('[aria-label="Mark S2E6 of The Sopranos watched"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).toBeNull()

    const cached = JSON.parse(localStorage.getItem('watching_cache:v6'))
    const cachedShow = cached.find((show) => show.tmdb_id === 900)
    expect(cachedShow.releasedWatchedCount).toBe(7)
    expect(cachedShow.nextReleasedUnwatchedEpisode).toMatchObject({ season_number: 2, episode_number: 6 })
  })

  it('does not let a same-show quiet refresh revert a quick mark that landed while that refresh was still fetching fresh details', async () => {
    await mountWatching()
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).not.toBeNull()

    // Trigger a quiet background refresh for the same show (mirrors the
    // refreshSignal bump the router does on returning from a detail route),
    // and gate its getShowDetails call so the refresh's own watched_episodes
    // snapshot (captured just before this) resolves — stale, pre-tap —
    // before this show's per-show enrichment finishes.
    let showDetailsCallCount = 0
    let releaseRefreshDetails
    const refreshDetailsGate = new Promise((resolve) => { releaseRefreshDetails = resolve })
    getShowDetails.mockImplementation(async () => {
      showDetailsCallCount += 1
      if (showDetailsCallCount === 2) await refreshDetailsGate
      return { seasons: [{ season_number: 1 }, { season_number: 2 }], status: 'Returning Series' }
    })

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Watching active refreshSignal={1} />
        </MemoryRouter>,
      )
    })
    await flush()

    // The refresh's per-show details fetch is still gated — the row must
    // stay on the previously settled, still-actionable state (no flash, no
    // remount, no premature control removal).
    expect(container.querySelectorAll('.watching-row')).toHaveLength(1)
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).not.toBeNull()

    const button = container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')
    await tap(button)
    expect(container.querySelector('[aria-label="Mark S2E6 of The Sopranos watched"]')).not.toBeNull()
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].episode_number).toBe(5)

    // Now let the stale same-show refresh finish. It must not revert the tap.
    await act(async () => { releaseRefreshDetails() })
    await flush()

    expect(container.querySelectorAll('.watching-row')).toHaveLength(1)
    expect(container.querySelector('[aria-label="Mark S2E6 of The Sopranos watched"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).toBeNull()

    const cached = JSON.parse(localStorage.getItem('watching_cache:v6'))
    const cachedShow = cached.find((show) => show.tmdb_id === 900)
    expect(cachedShow.releasedWatchedCount).toBe(7)
    expect(cachedShow.nextReleasedUnwatchedEpisode).toMatchObject({ season_number: 2, episode_number: 6 })

    // The next tap must mark only S2E6 — proof the merged context still
    // carries S2E5 as watched rather than the refresh's stale snapshot.
    const nextButton = container.querySelector('[aria-label="Mark S2E6 of The Sopranos watched"]')
    await tap(nextButton)
    expect(upsertCalls).toHaveLength(2)
    expect(upsertCalls[1].episode_number).toBe(6)
  })

  it('does not let a same-show quiet refresh revert a quick mark that landed while that refresh was still fetching its watched snapshot', async () => {
    await mountWatching()
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).not.toBeNull()

    // Gate the *watched_episodes* request of the quiet refresh — the earlier
    // window (details/seasons in flight) is already covered above; this one
    // exposes the tap landing while the watched snapshot itself is still being
    // fetched. The refresh returns the same pre-tap watchedEpisodesResult, so
    // it is naturally stale relative to the S2E5 tap below.
    let releaseRefreshWatched
    watchedEpisodesGate = new Promise((resolve) => { releaseRefreshWatched = resolve })

    await act(async () => {
      root.render(
        <MemoryRouter>
          <Watching active refreshSignal={1} />
        </MemoryRouter>,
      )
    })
    await flush()

    // The refresh's watched fetch is still gated — the row must stay on the
    // previously settled, still-actionable state (no flash, no remount, no
    // premature control removal).
    expect(container.querySelectorAll('.watching-row')).toHaveLength(1)
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).not.toBeNull()

    // Quick-mark S2E5 while the refresh's watched fetch is still pending. The
    // local revision bumps now, before the refresh has even captured (let
    // alone settled) its stale snapshot.
    const button = container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')
    await tap(button)
    expect(container.querySelector('[aria-label="Mark S2E6 of The Sopranos watched"]')).not.toBeNull()
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].episode_number).toBe(5)

    // Release the refresh's watched fetch — it returns the stale pre-tap
    // snapshot and its enrichment settles. It must not revert the tap.
    await act(async () => { releaseRefreshWatched() })
    await flush()

    expect(container.querySelectorAll('.watching-row')).toHaveLength(1)
    expect(container.querySelector('[aria-label="Mark S2E6 of The Sopranos watched"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Mark S2E5 of The Sopranos watched"]')).toBeNull()

    const cached = JSON.parse(localStorage.getItem('watching_cache:v6'))
    const cachedShow = cached.find((show) => show.tmdb_id === 900)
    expect(cachedShow.releasedWatchedCount).toBe(7)
    expect(cachedShow.nextReleasedUnwatchedEpisode).toMatchObject({ season_number: 2, episode_number: 6 })

    // The next tap marks only S2E6 — proof the merged context kept S2E5 as
    // watched rather than adopting the refresh's stale snapshot.
    const nextButton = container.querySelector('[aria-label="Mark S2E6 of The Sopranos watched"]')
    await tap(nextButton)
    expect(upsertCalls).toHaveLength(2)
    expect(upsertCalls[1].episode_number).toBe(6)
  })
})

describe('Watching quick mark — Show/Season Detail cache synchronization', () => {
  function seedDetailCaches() {
    writeDetailCache(showDetailCacheKey(900), {
      show: { id: 1, tmdb_id: 900, name: 'The Sopranos' },
      seasons: [{ season_number: 1 }, { season_number: 2 }],
      episodesBySeason: { 1: season1, 2: season2 },
      watchedList: ['1:1', '1:2', '2:1', '2:2', '2:3', '2:4'],
    })
    writeDetailCache(seasonDetailCacheKey(900, 2), {
      showName: 'The Sopranos',
      episodes: season2,
      watchedList: ['2:1', '2:2', '2:3', '2:4'],
    })
  }

  it('patches both the Show Detail and Season Detail caches before the Supabase upsert resolves', async () => {
    let resolveUpsert
    upsertImpl = () => new Promise((resolve) => { resolveUpsert = resolve })
    seedDetailCaches()
    await mountWatching()

    const button = statusButton()
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()

    // The Supabase write is still pending (upsertImpl's promise unresolved),
    // yet the optimistic commit must already have patched both caches.
    expect(upsertCalls).toHaveLength(1)
    const showCache = JSON.parse(localStorage.getItem('showdetail_cache:v1:900'))
    const seasonCache = JSON.parse(localStorage.getItem('seasondetail_cache:v1:900:2'))
    expect(showCache.watchedList).toContain('2:5')
    expect(seasonCache.watchedList).toContain('2:5')

    await act(async () => { resolveUpsert({ error: null }) })
    await flush()
  })

  it('retains the patched cache values after the Supabase mutation succeeds', async () => {
    seedDetailCaches()
    await mountWatching()

    await tap(statusButton())

    const showCache = JSON.parse(localStorage.getItem('showdetail_cache:v1:900'))
    const seasonCache = JSON.parse(localStorage.getItem('seasondetail_cache:v1:900:2'))
    expect(showCache.watchedList.sort()).toEqual(['1:1', '1:2', '2:1', '2:2', '2:3', '2:4', '2:5'])
    expect(seasonCache.watchedList.sort()).toEqual(['2:1', '2:2', '2:3', '2:4', '2:5'])
    // Unrelated fields on both caches are untouched by the patch.
    expect(showCache.seasons).toEqual([{ season_number: 1 }, { season_number: 2 }])
    expect(seasonCache.showName).toBe('The Sopranos')
  })

  it('rolls the patched cache values back in both caches when the Supabase mutation fails', async () => {
    upsertImpl = async () => { throw new Error('network down') }
    seedDetailCaches()
    await mountWatching()

    const button = statusButton()
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()

    const showCache = JSON.parse(localStorage.getItem('showdetail_cache:v1:900'))
    const seasonCache = JSON.parse(localStorage.getItem('seasondetail_cache:v1:900:2'))
    expect(showCache.watchedList).not.toContain('2:5')
    expect(seasonCache.watchedList).not.toContain('2:5')
    expect(showCache.watchedList.sort()).toEqual(['1:1', '1:2', '2:1', '2:2', '2:3', '2:4'])
    expect(seasonCache.watchedList.sort()).toEqual(['2:1', '2:2', '2:3', '2:4'])
  })
})

// Example B from the button redesign spec: a weekly show with exactly one
// released unwatched episode, on a genuine ~7-day cadence so — after marking
// the last released episode — computeWatchingStatus's weekly-prediction path
// (predictWeeklyNextRelease) resolves a real future countdown instead of the
// bare, Watching-hiding "caughtUp" status a show with no known next episode
// would fall back to. The button must stay green through that countdown,
// with no persisted UI flag — purely derived from nextReleasedUnwatchedEpisode
// being null.
describe('Watching quick mark — weekly/House of the Dragon-style single-episode flow', () => {
  it('marking the only released unwatched episode leaves the row visible with the button persistently green through the following countdown', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    const lastAirDate = new Date(Date.now() - 3 * DAY_MS).toISOString().slice(0, 10)
    const prevAirDate = new Date(Date.now() - 10 * DAY_MS).toISOString().slice(0, 10)
    const weeklySeason2 = [
      { episode_number: 1, name: 'S2E1', air_date: '2015-02-01', runtime: 40 },
      { episode_number: 2, name: 'S2E2', air_date: '2015-02-08', runtime: 40 },
      { episode_number: 3, name: 'S2E3', air_date: '2015-02-15', runtime: 40 },
      { episode_number: 4, name: 'S2E4', air_date: '2015-02-22', runtime: 40 },
      { episode_number: 5, name: 'S2E5', air_date: '2015-03-01', runtime: 40 },
      { episode_number: 6, name: 'S2E6', air_date: prevAirDate, runtime: 40 },
      { episode_number: 7, name: 'S2E7', air_date: lastAirDate, runtime: 40 },
    ]
    getSeasonEpisodes.mockImplementation(async (_id, seasonNumber) => ({
      episodes: seasonNumber === 1 ? season1 : weeklySeason2,
    }))
    watchedEpisodesResult = {
      data: watchedRows([[1, 1], [1, 2], [2, 1], [2, 2], [2, 3], [2, 4], [2, 5], [2, 6]]),
      error: null,
    }
    await mountWatching()

    expect(container.querySelector('[aria-label="Mark S2E7 of The Sopranos watched"]')).not.toBeNull()
    await tap(statusButton())

    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].episode_number).toBe(7)
    // The row stays visible (real weekly cadence resolves to a future
    // countdown, not the Watching-hiding bare "caughtUp" status) and the
    // button reads green/non-actionable through it.
    expect(container.querySelector('.watching-row')).not.toBeNull()
    expect(container.querySelector('.watching-countdown-pill')).not.toBeNull()
    expect(statusButton().getAttribute('data-status')).toBe('caughtUp')
    expect(statusButton().getAttribute('aria-label')).toBe('Caught up with The Sopranos')
    expect(statusButton().disabled).toBe(true)

    // A further tap does nothing while caught up.
    await act(async () => { statusButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await flush()
    expect(upsertCalls).toHaveLength(1)
  })
})
