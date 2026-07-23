import { describe, it, expect } from 'vitest'
import { loadAnnouncements, loadTrailers, loadDiscover, emptyDiscoverState } from './discoverClient.js'
import { ANNOUNCEMENTS_CACHE_KEY } from './announcementStore.js'
import { TRAILERS_CACHE_KEY } from './trailerStore.js'
import { fetchMediaVideos, mapWithConcurrency } from './tmdbVideos.js'

const NOW = Date.parse('2026-07-23T00:00:00.000Z')

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    _dump: () => Object.fromEntries(store),
  }
}

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body }
}

const TRACKED = [
  { tmdb_id: 1, name: 'From', poster_path: '/from.jpg' },
  { tmdb_id: 7, name: 'The Bear', poster_path: '/bear.jpg' },
]

describe('loadAnnouncements', () => {
  it('classifies only tracked-show announcements from the news feed', async () => {
    const fetchImpl = async () => jsonResponse({
      articles: [
        { title: 'From renewed for Season 4', publishedAt: '2026-07-20T00:00:00.000Z', sourceName: 'Deadline', url: 'https://deadline.com/a' },
        { title: 'Some Untracked Show renewed for Season 2', publishedAt: '2026-07-20T00:00:00.000Z', sourceName: 'Deadline', url: 'https://deadline.com/b' },
        { title: '10 best dramas to stream this weekend', publishedAt: '2026-07-20T00:00:00.000Z', sourceName: 'Deadline', url: 'https://deadline.com/c' },
      ],
    })
    const storage = memoryStorage()
    const state = await loadAnnouncements({ trackedShows: TRACKED, storage, fetchImpl, now: NOW })
    expect(state.error).toBe(null)
    expect(state.items).toHaveLength(1)
    expect(state.items[0].showId).toBe(1)
    expect(state.items[0].eventType).toBe('renewal')
    // Written to the dedicated announcements namespace only.
    expect(storage._dump()[ANNOUNCEMENTS_CACHE_KEY]).toBeTruthy()
  })

  it('preserves cached items when the source fails (failure isolation)', async () => {
    const storage = memoryStorage()
    await loadAnnouncements({
      trackedShows: TRACKED, storage, now: NOW,
      fetchImpl: async () => jsonResponse({ articles: [{ title: 'From renewed for Season 4', publishedAt: '2026-07-20T00:00:00.000Z', sourceName: 'Deadline', url: 'https://deadline.com/a' }] }),
    })
    const failed = await loadAnnouncements({ trackedShows: TRACKED, storage, now: NOW, fetchImpl: async () => jsonResponse(null, false) })
    expect(failed.error).toBeTruthy()
    expect(failed.items).toHaveLength(1) // cached renewal preserved
  })

  it('never populates announcements from a legacy news cache', async () => {
    const storage = memoryStorage({ 'rerun_news_cache:v1': JSON.stringify({ version: 1, articles: { x: { id: 'x', title: 'Old generic', publishedAt: '2026-07-20', url: 'https://e.com' } } }) })
    const state = await loadAnnouncements({ trackedShows: TRACKED, storage, now: NOW, fetchImpl: async () => jsonResponse({ articles: [] }) })
    expect(state.items).toHaveLength(0)
  })
})

describe('loadTrailers', () => {
  const videosByShow = {
    1: { results: [
      { key: 'good1', site: 'YouTube', type: 'Trailer', name: 'Season 4 Official Trailer', official: true, iso_639_1: 'en', published_at: '2026-07-10T00:00:00.000Z' },
      { key: 'clip1', site: 'YouTube', type: 'Trailer', name: 'Official Clip', official: true, published_at: '2026-07-10T00:00:00.000Z' },
    ] },
    7: { results: [
      { key: 'good7', site: 'YouTube', type: 'Teaser', name: 'Official Teaser', official: true, iso_639_1: 'en', published_at: '2026-07-12T00:00:00.000Z' },
    ] },
  }

  function tmdbFetch(url) {
    const match = url.match(/\/tv\/(\d+)\/videos/)
    if (match) return jsonResponse(videosByShow[match[1]] ?? { results: [] })
    return jsonResponse({ results: [] })
  }

  it('builds trailers only for tracked shows, filtering out clips', async () => {
    const storage = memoryStorage()
    const state = await loadTrailers({ trackedShows: TRACKED, storage, now: NOW, fetchImpl: async (u) => tmdbFetch(u) })
    expect(state.error).toBe(null)
    const keys = state.items.map((t) => t.videoKey).sort()
    expect(keys).toEqual(['good1', 'good7'])
    expect(state.items.every((t) => t.youtubeUrl.startsWith('https://www.youtube.com/watch?v='))).toBe(true)
    expect(storage._dump()[TRAILERS_CACHE_KEY]).toBeTruthy()
  })

  it('isolates a single show failure without dropping the whole feed', async () => {
    const storage = memoryStorage()
    const state = await loadTrailers({
      trackedShows: TRACKED, storage, now: NOW,
      fetchImpl: async (u) => (u.includes('/tv/1/') ? Promise.reject(new Error('boom')) : tmdbFetch(u)),
    })
    expect(state.items.map((t) => t.videoKey)).toEqual(['good7'])
  })
})

describe('mapWithConcurrency', () => {
  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    const mapper = async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight -= 1
      return true
    }
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], mapper, 3)
    expect(peak).toBeLessThanOrEqual(3)
  })
})

describe('loadDiscover — independent feeds', () => {
  it('one feed can fail while the other succeeds', async () => {
    const storage = memoryStorage()
    const fetchImpl = async (url) => {
      if (url.startsWith('/api/discover/announcements')) return jsonResponse(null, false) // announcements down
      return jsonResponse({ results: [{ key: 'k7', site: 'YouTube', type: 'Trailer', name: 'Official Trailer', official: true, iso_639_1: 'en', published_at: '2026-07-12T00:00:00.000Z' }] })
    }
    const state = await loadDiscover({ trackedShows: TRACKED, storage, now: NOW, fetchImpl })
    expect(state.announcements.error).toBeTruthy()
    expect(state.trailers.error).toBe(null)
    expect(state.trailers.items.length).toBeGreaterThan(0)
  })

  it('emptyDiscoverState has isolated feed slots', () => {
    const s = emptyDiscoverState()
    expect(s.announcements.items).toEqual([])
    expect(s.trailers.items).toEqual([])
  })
})

describe('fetchMediaVideos', () => {
  it('returns [] on a non-ok response rather than throwing', async () => {
    const storage = memoryStorage()
    const result = await fetchMediaVideos('tv', 1, { storage, now: NOW, fetchImpl: async () => jsonResponse(null, false) })
    expect(result).toEqual([])
  })
})
