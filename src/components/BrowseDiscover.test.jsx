// @vitest-environment jsdom

import { StrictMode } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BrowseDiscover, {
  BrowseDiscoverView,
} from './BrowseDiscover.jsx'
import {
  ANNOUNCEMENTS_CACHE_KEY,
  readAnnouncementsCache,
  writeAnnouncementsCache,
} from '../lib/discover/announcementStore.js'
import {
  readTrailersCache,
  TRAILERS_CACHE_KEY,
  writeTrailersCache,
} from '../lib/discover/trailerStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.parse('2026-07-23T12:00:00.000Z')
const trackedShows = [{ tmdb_id: 1, name: 'The Bear', poster_path: '/bear.jpg' }]

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

const franchiseTrailer = {
  ...trailer,
  id: 'trailer:marvel',
  mediaType: 'movie',
  mediaId: 100,
  trackedShowId: null,
  title: 'Avengers: Secret Wars',
  posterPath: '/secret-wars.jpg',
  videoKey: 'marvel',
  youtubeUrl: 'https://www.youtube.com/watch?v=marvel',
  videoName: 'Official Teaser Trailer',
  franchise: 'marvel',
}

function feed(items = [], overrides = {}) {
  return {
    items,
    loading: false,
    refreshing: false,
    error: null,
    lastSuccess: NOW,
    ...overrides,
  }
}

function state(announcementFeed = feed(), trailerFeed = feed()) {
  return { announcements: announcementFeed, trailers: trailerFeed }
}

function memoryStorage() {
  const values = new Map()
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
    values,
  }
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

let mountedRoot = null
let mountedContainer = null

afterEach(async () => {
  if (mountedRoot) {
    await act(async () => mountedRoot.unmount())
  }
  mountedRoot = null
  mountedContainer?.remove()
  mountedContainer = null
})

describe('Discover Phase 2 feed presentation', () => {
  it('renders Announcements before Trailers with publisher copy and no legacy News feed', () => {
    const html = renderToStaticMarkup(
      <BrowseDiscoverView state={state(feed([announcement]), feed([trailer]))} />,
    )
    expect(html.indexOf('Announcements')).toBeLessThan(html.indexOf('Trailers'))
    expect(html).toContain('The Bear renewed for Season 5 at FX')
    expect(html).toContain('Deadline')
    expect(html).toContain('Season 5 Official Trailer')
    expect(html).toContain('https://www.youtube.com/watch?v=bear5')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).not.toContain('Latest from your shows')
    expect(html).not.toContain('TV headlines')
    expect(html).not.toContain('For you')
  })

  it('keeps cached items visible while updating and after a refresh failure', () => {
    const refreshing = renderToStaticMarkup(
      <BrowseDiscoverView
        state={state(feed([announcement], { refreshing: true }), feed([trailer]))}
      />,
    )
    expect(refreshing).toContain('The Bear renewed for Season 5 at FX')
    expect(refreshing).toContain('Updating')

    const failed = renderToStaticMarkup(
      <BrowseDiscoverView
        state={state(feed([announcement], { error: 'private-error-detail' }), feed([trailer]))}
      />,
    )
    expect(failed).toContain('The Bear renewed for Season 5 at FX')
    expect(failed).toContain('Showing saved announcements')
    expect(failed).not.toContain('private-error-detail')
  })

  it('caps the visible trailer feed at eight cards without reordering it', () => {
    const trailers = Array.from({ length: 10 }, (_, index) => ({
      ...trailer,
      id: `trailer:cap-${index + 1}`,
      videoKey: `cap-${index + 1}`,
      youtubeUrl: `https://www.youtube.com/watch?v=cap-${index + 1}`,
      videoName: `Ranked Trailer ${index + 1}`,
    }))
    const html = renderToStaticMarkup(
      <BrowseDiscoverView state={state(feed(), feed(trailers))} />,
    )
    expect((html.match(/Play trailer/g) ?? [])).toHaveLength(8)
    expect(html).toContain('Ranked Trailer 1')
    expect(html).toContain('Ranked Trailer 8')
    expect(html).not.toContain('Ranked Trailer 9')
    expect(html.indexOf('Ranked Trailer 1')).toBeLessThan(html.indexOf('Ranked Trailer 8'))
  })

  it('uses compact honest loading, empty, and unavailable states without generic News fallback', () => {
    const loading = renderToStaticMarkup(
      <BrowseDiscoverView state={state(
        feed([], { loading: true }),
        feed([], { loading: true }),
      )} />,
    )
    expect(loading).toContain('Loading announcements')
    expect(loading).toContain('Loading trailers')

    const empty = renderToStaticMarkup(<BrowseDiscoverView state={state()} />)
    expect(empty).toContain('No announcements from your shows right now.')
    expect(empty).toContain('No new trailers right now.')

    const error = renderToStaticMarkup(
      <BrowseDiscoverView state={state(
        feed([], { error: 'announcement_api_name' }),
        feed([], { error: 'trailer_debug_id' }),
      )} />,
    )
    expect(error).toContain('Announcements are unavailable right now.')
    expect(error).toContain('Trailers are unavailable right now.')
    expect(error).not.toContain('announcement_api_name')
    expect(error).not.toContain('trailer_debug_id')
    for (const legacy of ['Latest from your shows', 'TV headlines', 'GNews']) {
      expect(`${loading}${empty}${error}`).not.toContain(legacy)
    }
  })

  it('formats useful freshness without exposing technical metadata', () => {
    const html = renderToStaticMarkup(
      <BrowseDiscoverView state={state(feed([
        announcement,
        {
          ...announcement,
          id: 'ann:1|cast_addition|guest',
          articleHeadline: 'A guest joins The Bear',
          publishedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ]), feed())} />,
    )
    expect(html).toMatch(/Today|Yesterday|\d+d ago/)
    expect(html).toContain('5d ago')
  })
})

describe('Discover Phase 2 route ownership and persisted dismissal', () => {
  it('waits for tracked-show eligibility before showing filtered cache and loading once', async () => {
    const storage = memoryStorage()
    const oldAnnouncement = {
      ...announcement,
      id: 'ann:99|renewal|2',
      showId: 99,
      showName: 'Removed Show',
      articleHeadline: 'Removed Show renewed for Season 2',
    }
    const oldTrackedTrailer = {
      ...trailer,
      id: 'trailer:removed',
      mediaId: 99,
      trackedShowId: 99,
      title: 'Removed Show',
      videoKey: 'removed',
      youtubeUrl: 'https://www.youtube.com/watch?v=removed',
      videoName: 'Removed Show Official Trailer',
    }
    writeAnnouncementsCache({
      version: 1,
      items: [oldAnnouncement, announcement],
      dismissedIds: [],
      lastSuccess: NOW,
    }, storage, NOW)
    writeTrailersCache({
      version: 2,
      items: [oldTrackedTrailer, trailer, franchiseTrailer],
      knownKeys: [oldTrackedTrailer.videoKey, trailer.videoKey, franchiseTrailer.videoKey],
      seenKeys: [oldTrackedTrailer.videoKey, trailer.videoKey, franchiseTrailer.videoKey],
      dismissedKeys: [],
      bootstrapped: true,
      lastSuccess: NOW,
    }, storage)

    const pending = deferred()
    const loadDiscoverImpl = vi.fn(() => pending.promise)
    mountedContainer = document.createElement('div')
    document.body.append(mountedContainer)
    mountedRoot = createRoot(mountedContainer)

    await act(async () => {
      mountedRoot.render(
        <StrictMode>
          <BrowseDiscover
            trackedShows={trackedShows}
            trackedShowsReady={false}
            storage={storage}
            loadDiscoverImpl={loadDiscoverImpl}
          />
        </StrictMode>,
      )
    })

    expect(mountedContainer.textContent).not.toContain(oldAnnouncement.articleHeadline)
    expect(mountedContainer.textContent).not.toContain(oldTrackedTrailer.videoName)
    expect(mountedContainer.textContent).not.toContain(announcement.articleHeadline)
    expect(mountedContainer.textContent).not.toContain(trailer.videoName)
    expect(mountedContainer.textContent).not.toContain(franchiseTrailer.videoName)
    expect(mountedContainer.querySelector(
      '[role="status"][aria-label="Loading announcements"]',
    )).not.toBeNull()
    expect(mountedContainer.querySelector(
      '[role="status"][aria-label="Loading trailers"]',
    )).not.toBeNull()
    expect(loadDiscoverImpl).not.toHaveBeenCalled()

    await act(async () => {
      mountedRoot.render(
        <StrictMode>
          <BrowseDiscover
            trackedShows={trackedShows}
            trackedShowsReady
            storage={storage}
            loadDiscoverImpl={loadDiscoverImpl}
          />
        </StrictMode>,
      )
    })

    expect(loadDiscoverImpl).toHaveBeenCalledTimes(1)
    expect(mountedContainer.textContent).not.toContain(oldAnnouncement.articleHeadline)
    expect(mountedContainer.textContent).not.toContain(oldTrackedTrailer.videoName)
    expect(mountedContainer.textContent).toContain(announcement.articleHeadline)
    expect(mountedContainer.textContent).toContain(trailer.videoName)
    expect(mountedContainer.textContent).toContain(franchiseTrailer.videoName)

    await act(async () => {
      pending.resolve({
        announcements: feed([announcement]),
        trailers: feed([trailer, franchiseTrailer]),
      })
      await pending.promise
    })
    expect(loadDiscoverImpl).toHaveBeenCalledTimes(1)
  })

  it('shows cache first, performs one StrictMode-safe route load, and persists both dismissals', async () => {
    const storage = memoryStorage()
    writeAnnouncementsCache({
      version: 1,
      items: [announcement],
      dismissedIds: [],
      lastSuccess: NOW,
    }, storage, NOW)
    writeTrailersCache({
      version: 2,
      items: [trailer],
      knownKeys: [trailer.videoKey],
      seenKeys: [trailer.videoKey],
      dismissedKeys: [],
      bootstrapped: true,
      lastSuccess: NOW,
    }, storage)

    const pending = deferred()
    const loadDiscoverImpl = vi.fn(() => pending.promise)
    mountedContainer = document.createElement('div')
    document.body.append(mountedContainer)
    mountedRoot = createRoot(mountedContainer)

    await act(async () => {
      mountedRoot.render(
        <StrictMode>
          <BrowseDiscover
            trackedShows={trackedShows}
            trackedShowsReady
            storage={storage}
            loadDiscoverImpl={loadDiscoverImpl}
          />
        </StrictMode>,
      )
    })

    expect(loadDiscoverImpl).toHaveBeenCalledTimes(1)
    expect(mountedContainer.textContent).toContain(announcement.articleHeadline)
    expect(mountedContainer.textContent).toContain(trailer.videoName)
    expect(mountedContainer.textContent).toContain('Updating')

    await act(async () => {
      pending.resolve({
        announcements: feed([announcement], { error: 'refresh_failed' }),
        trailers: feed([trailer]),
      })
      await pending.promise
    })
    expect(mountedContainer.textContent).toContain(announcement.articleHeadline)
    expect(mountedContainer.textContent).toContain('Showing saved announcements')

    const announcementDismiss = mountedContainer.querySelector(
      `[aria-label="Dismiss ${announcement.articleHeadline}"]`,
    )
    await act(async () => {
      announcementDismiss.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mountedContainer.textContent).not.toContain(announcement.articleHeadline)
    expect(readAnnouncementsCache(storage, NOW).dismissedIds).toContain(announcement.id)

    const trailerDismiss = mountedContainer.querySelector(
      `[aria-label="Dismiss ${trailer.videoName} for ${trailer.title}"]`,
    )
    await act(async () => {
      trailerDismiss.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mountedContainer.textContent).not.toContain(trailer.videoName)
    expect(readTrailersCache(storage).dismissedKeys).toContain(trailer.videoKey)
    expect(storage.values.has(ANNOUNCEMENTS_CACHE_KEY)).toBe(true)
    expect(storage.values.has(TRAILERS_CACHE_KEY)).toBe(true)
  })
})

describe('Discover Phase 2 static integration contracts', () => {
  const browse = readFileSync(resolve('src/routes/Browse.jsx'), 'utf8')
  const component = readFileSync(resolve('src/components/BrowseDiscover.jsx'), 'utf8')
  const css = readFileSync(resolve('src/index.css'), 'utf8')
  const client = readFileSync(resolve('src/lib/discover/discoverClient.js'), 'utf8')
  const trailerStore = readFileSync(resolve('src/lib/discover/trailerStore.js'), 'utf8')

  it('keeps heading/search order, debounce, tracked filtering, and result navigation behaviour', () => {
    expect(browse.indexOf('>Discover</h1>')).toBeLessThan(browse.indexOf('className="browse-search"'))
    expect(browse.indexOf('className="browse-search"')).toBeLessThan(browse.indexOf('<BrowseDiscover'))
    expect(browse).toContain('const DEBOUNCE_MS = 400')
    expect((browse.match(/searchShows\(/g) ?? [])).toHaveLength(1)
    expect(browse).toContain('active.map((row) => row.tmdb_id)')
    expect(browse).toContain('results.map((show, index) =>')
    expect(browse).toContain(".select('tmdb_id, name, poster_path, hidden_at')")
    expect(browse).toContain('upsertTrackedShowForDiscover(prev, show)')
  })

  it('has one feed owner and delegates classification, ranking, and Marvel/DC to Phase 1', () => {
    expect((component.match(/loadDiscoverImpl\(\{/g) ?? [])).toHaveLength(1)
    expect(component).not.toContain('loadAnnouncements(')
    expect(component).not.toContain('loadTrailers(')
    expect(component).not.toContain('classifyVideo(')
    expect(component).not.toContain('rankTrailers(')
    expect(client).toContain('collected.push(...await franchiseTrailers(fetchOptions))')
    expect(client).toContain('const ranked = rankTrailers(collected, { now })')
    expect(client).toContain('.filter((video) => classifyVideo(video).accepted)')
    expect(component).toContain('const MAX_VISIBLE_TRAILERS = 8')
  })

  it('retains the Phase-1 bootstrap baseline and YouTube watch handoff', () => {
    expect(trailerStore).toContain('knownKeys')
    expect(trailerStore).toContain('if (!current.bootstrapped)')
    expect(trailerStore).toContain('incomingKeys(incoming)')
    expect(component).toContain('trailer.youtubeUrl')
    expect(component).not.toContain('youtube.com/embed')
  })

  it('keeps 44px controls, one-column density, and existing shell safe-area ownership', () => {
    expect(css).toMatch(/\.discover-card__dismiss\s*\{[^}]*width: 2\.75rem;[^}]*height: 2\.75rem;/s)
    expect(css).toMatch(/\.discover-card__play\s*\{[^}]*min-height: 2\.75rem;/s)
    expect(css).toMatch(/\.discover-feed__heading\s*\{[^}]*min-height: 2\.75rem;/s)
    expect(css).toMatch(/\.discover-feed__list\s*\{[^}]*flex-direction: column;/s)
    expect(browse).toContain('<div className="app-page px-4 pb-4">')
    expect(css).toContain('padding-top: max(1rem, var(--safe-area-inset-top))')
    expect(css).toContain('padding-bottom: calc(4rem + var(--safe-area-inset-bottom))')
    expect(css).not.toMatch(/\.discover-feeds\s*\{[^}]*padding-(?:top|bottom)/s)
  })
})
