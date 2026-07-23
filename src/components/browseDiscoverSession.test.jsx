// @vitest-environment jsdom

// Behavioural coverage for the Discover session cache that makes returning to
// Discover feel instant. Each `createRoot` mount/unmount pair models a real tab
// leave + return (Browse lives in the non-persistent route shell, so it truly
// remounts). We assert on rendered DOM and on how many times the Discover load
// actually runs — not on source text — because the whole point is fewer network
// invocations and no skeleton over valid cached content.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BrowseDiscover from './BrowseDiscover.jsx'
import {
  DISCOVER_SESSION_FRESHNESS_MS,
  discoverSession,
  resetDiscoverSession,
} from '../lib/discover/discoverSession.js'
import { writeAnnouncementsCache } from '../lib/discover/announcementStore.js'
import { writeTrailersCache } from '../lib/discover/trailerStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.parse('2026-07-23T12:00:00.000Z')
const bear = { tmdb_id: 1, name: 'The Bear', poster_path: '/bear.jpg' }
const severance = { tmdb_id: 2, name: 'Severance', poster_path: '/sev.jpg' }

const announcement = {
  id: 'ann:1|renewal|5',
  showId: 1,
  showName: 'The Bear',
  eventType: 'renewal',
  seasonNumber: 5,
  articleHeadline: 'The Bear renewed for Season 5 at FX',
  headline: 'The Bear will return for Season 5',
  sourceName: 'Deadline',
  sourceUrl: 'https://deadline.com/the-bear',
  publishedAt: '2026-07-23T08:00:00.000Z',
  posterPath: '/bear.jpg',
}

const trailer = {
  id: 'trailer:bear5',
  mediaType: 'tv',
  mediaId: 1,
  trackedShowId: 1,
  title: 'The Bear',
  posterPath: '/bear.jpg',
  videoKey: 'bear5',
  youtubeUrl: 'https://www.youtube.com/watch?v=bear5',
  videoType: 'Trailer',
  videoName: 'Season 5 Official Trailer',
  official: true,
  publishedAt: '2026-07-22T08:00:00.000Z',
}

function feed(items = [], overrides = {}) {
  return { items, loading: false, refreshing: false, error: null, lastSuccess: NOW, ...overrides }
}

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  }
}

function seedCaches(storage) {
  writeAnnouncementsCache(
    { version: 1, items: [announcement], dismissedIds: [], lastSuccess: NOW },
    storage,
    NOW,
  )
  writeTrailersCache(
    {
      version: 2,
      items: [trailer],
      knownKeys: [trailer.videoKey],
      seenKeys: [trailer.videoKey],
      dismissedKeys: [],
      bootstrapped: true,
      lastSuccess: NOW,
    },
    storage,
  )
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let root = null
let container = null

async function mount(element) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
}

async function unmount() {
  if (root) await act(async () => root.unmount())
  root = null
  container?.remove()
  container = null
}

afterEach(async () => {
  await unmount()
  resetDiscoverSession()
})

describe('Discover session cache — quick tab return', () => {
  it('first visit still performs the initial load and renders it', async () => {
    const storage = memoryStorage()
    seedCaches(storage)
    const load = vi.fn(() => Promise.resolve({ announcements: feed([announcement]), trailers: feed([trailer]) }))

    await mount(
      <BrowseDiscover trackedShows={[bear]} trackedShowsReady storage={storage} loadDiscoverImpl={load} session={discoverSession} />,
    )

    expect(load).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain(announcement.articleHeadline)
    expect(container.textContent).toContain(trailer.videoName)
  })

  it('a quick return within the window shows cached cards with no skeleton and no second load', async () => {
    const storage = memoryStorage()
    seedCaches(storage)
    const load = vi.fn(() => Promise.resolve({ announcements: feed([announcement]), trailers: feed([trailer]) }))

    await mount(
      <BrowseDiscover trackedShows={[bear]} trackedShowsReady storage={storage} loadDiscoverImpl={load} session={discoverSession} />,
    )
    expect(load).toHaveBeenCalledTimes(1)
    await unmount()

    // Return immediately (well within the freshness window).
    await mount(
      <BrowseDiscover trackedShows={[bear]} trackedShowsReady storage={storage} loadDiscoverImpl={load} session={discoverSession} />,
    )

    expect(load).toHaveBeenCalledTimes(1) // no duplicate network work
    expect(container.querySelector('[role="status"][aria-label="Loading announcements"]')).toBeNull()
    expect(container.querySelector('[role="status"][aria-label="Loading trailers"]')).toBeNull()
    expect(container.textContent).toContain(announcement.articleHeadline)
    expect(container.textContent).toContain(trailer.videoName)
    expect(container.textContent).not.toContain('Updating') // not spinning — nothing is refreshing
  })

  it('a return after the window expires runs a background refresh with cache still visible', async () => {
    const storage = memoryStorage()
    seedCaches(storage)
    const load = vi.fn(() => Promise.resolve({ announcements: feed([announcement]), trailers: feed([trailer]) }))

    await mount(
      <BrowseDiscover trackedShows={[bear]} trackedShowsReady storage={storage} loadDiscoverImpl={load} session={discoverSession} />,
    )
    expect(load).toHaveBeenCalledTimes(1)
    await unmount()

    // Force the recorded refresh to be older than the freshness window.
    discoverSession.markRefreshed('1:The Bear', Date.now() - (DISCOVER_SESSION_FRESHNESS_MS + 1_000))

    await mount(
      <BrowseDiscover trackedShows={[bear]} trackedShowsReady storage={storage} loadDiscoverImpl={load} session={discoverSession} />,
    )

    expect(load).toHaveBeenCalledTimes(2) // stale → refreshed
    // The cached content stayed visible across the refresh (never blanked to skeleton).
    expect(container.textContent).toContain(announcement.articleHeadline)
    expect(container.textContent).toContain(trailer.videoName)
  })

  it('a return mid-refresh reuses the in-flight request instead of starting a duplicate', async () => {
    const storage = memoryStorage()
    seedCaches(storage)
    const pending = deferred()
    const load = vi.fn(() => pending.promise)

    await mount(
      <BrowseDiscover trackedShows={[bear]} trackedShowsReady storage={storage} loadDiscoverImpl={load} session={discoverSession} />,
    )
    expect(load).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Updating') // refresh genuinely in flight
    await unmount()

    // Return before the first refresh resolved.
    await mount(
      <BrowseDiscover trackedShows={[bear]} trackedShowsReady storage={storage} loadDiscoverImpl={load} session={discoverSession} />,
    )
    expect(load).toHaveBeenCalledTimes(1) // reused the in-flight promise
    expect(container.textContent).toContain(announcement.articleHeadline)

    await act(async () => {
      pending.resolve({ announcements: feed([announcement]), trailers: feed([trailer]) })
      await pending.promise
    })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a tracked-library change refreshes for the new identity even within the window', async () => {
    const storage = memoryStorage()
    seedCaches(storage)
    const load = vi.fn(() => Promise.resolve({ announcements: feed([announcement]), trailers: feed([trailer]) }))

    await mount(
      <BrowseDiscover trackedShows={[bear]} trackedShowsReady storage={storage} loadDiscoverImpl={load} session={discoverSession} />,
    )
    expect(load).toHaveBeenCalledTimes(1)
    await unmount()

    // Same session, new library identity (a show was added).
    await mount(
      <BrowseDiscover trackedShows={[bear, severance]} trackedShowsReady storage={storage} loadDiscoverImpl={load} session={discoverSession} />,
    )
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a refresh failure preserves the last valid cached content', async () => {
    const storage = memoryStorage()
    seedCaches(storage)
    const load = vi.fn(() => Promise.resolve({
      announcements: feed([announcement], { error: 'refresh_failed' }),
      trailers: feed([trailer]),
    }))

    await mount(
      <BrowseDiscover trackedShows={[bear]} trackedShowsReady storage={storage} loadDiscoverImpl={load} session={discoverSession} />,
    )

    expect(container.textContent).toContain(announcement.articleHeadline)
    expect(container.textContent).toContain('Showing saved announcements')
    expect(container.textContent).not.toContain('refresh_failed')
  })

  it('an older identity response cannot overwrite the newer library state', async () => {
    const storage = memoryStorage()
    seedCaches(storage)
    const bearPending = deferred()
    const load = vi.fn((options) => {
      const isBearOnly = options.trackedShows.length === 1
      return isBearOnly
        ? bearPending.promise
        : Promise.resolve({
            announcements: feed([]),
            trailers: feed([]),
          })
    })

    // Mount with identity A (bear), whose refresh is still in flight.
    await mount(
      <BrowseDiscover trackedShows={[bear]} trackedShowsReady storage={storage} loadDiscoverImpl={load} session={discoverSession} />,
    )
    expect(load).toHaveBeenCalledTimes(1)

    // Switch to identity B (bear + severance) before A resolves; B resolves empty.
    await act(async () => {
      root.render(
        <BrowseDiscover trackedShows={[bear, severance]} trackedShowsReady storage={storage} loadDiscoverImpl={load} session={discoverSession} />,
      )
    })

    // Now let the stale A refresh resolve with the OLD single-show announcement.
    await act(async () => {
      bearPending.resolve({ announcements: feed([announcement]), trailers: feed([trailer]) })
      await bearPending.promise
    })

    // The newer identity B (empty) must win — A's late response is discarded.
    expect(container.textContent).not.toContain(announcement.articleHeadline)
    expect(container.textContent).toContain('No announcements from your shows right now.')
  })
})
