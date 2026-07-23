// Cross-cutting integration proofs (Scope S). These assert the engine-level
// guarantees the individual unit tests do not, using only the public module
// surface and injected fixtures shaped from official TMDB / news response forms.

import { describe, it, expect } from 'vitest'
import { loadAnnouncements, loadTrailers } from './discoverClient.js'
import { buildIdentityRegistry } from './identities.js'
import { classifyAnnouncement } from './announcementClassifier.js'
import { ANNOUNCEMENTS_CACHE_KEY } from './announcementStore.js'
import { TRAILERS_CACHE_KEY } from './trailerStore.js'

const NOW = Date.parse('2026-07-23T00:00:00.000Z')

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    _keys: () => [...store.keys()],
  }
}
const jsonResponse = (body, ok = true) => ({ ok, json: async () => body })

// Every tracked status is represented (watching, watchlist, upcoming, paused,
// finished, hidden). The engine treats them uniformly — nothing filters by
// status.
const ALL_STATUS_SHOWS = [
  { tmdb_id: 1, name: 'From', status: 'watching', hidden_at: null, finished_at: null },
  { tmdb_id: 7, name: 'The Bear', status: 'watchlist', hidden_at: null, finished_at: null },
  { tmdb_id: 14, name: 'The Last of Us', status: 'upcoming', hidden_at: null, finished_at: null },
  { tmdb_id: 16, name: 'The Afterparty', status: 'paused', hidden_at: null, finished_at: null },
  { tmdb_id: 20, name: 'A Man on the Inside', status: 'finished', hidden_at: null, finished_at: '2026-01-01' },
  { tmdb_id: 21, name: 'Shrinking', status: 'hidden', hidden_at: '2026-02-01', finished_at: null },
]

describe('Scope S — tracked coverage across every status', () => {
  it('surfaces announcements for shows in any tracked status, including finished and hidden', async () => {
    const fetchImpl = async () => jsonResponse({
      articles: [
        { title: 'A Man on the Inside renewed for Season 2 by Netflix', publishedAt: '2026-07-20T00:00:00.000Z', sourceName: 'Deadline', url: 'https://deadline.com/a' },
        { title: 'Shrinking renewed for Season 3 at Apple TV', publishedAt: '2026-07-20T00:00:00.000Z', sourceName: 'Variety', url: 'https://variety.com/b' },
      ],
    })
    const state = await loadAnnouncements({ trackedShows: ALL_STATUS_SHOWS, storage: memoryStorage(), fetchImpl, now: NOW })
    const ids = state.items.map((i) => i.showId).sort((a, b) => a - b)
    expect(ids).toContain(20) // finished show
    expect(ids).toContain(21) // hidden show
  })
})

describe('Scope S — no untracked ordinary media leaks into either feed', () => {
  it('rejects an untracked show announcement', async () => {
    const state = await loadAnnouncements({
      trackedShows: ALL_STATUS_SHOWS, storage: memoryStorage(), now: NOW,
      fetchImpl: async () => jsonResponse({ articles: [
        { title: 'Ted Lasso renewed for Season 4 at Apple TV', publishedAt: '2026-07-20T00:00:00.000Z', sourceName: 'Deadline', url: 'https://deadline.com/x' },
      ] }),
    })
    expect(state.items.find((i) => /ted lasso/i.test(i.showName ?? ''))).toBeUndefined()
  })

  it('fetches trailers only for tracked show ids', async () => {
    const requested = []
    await loadTrailers({
      trackedShows: [{ tmdb_id: 1, name: 'From' }], storage: memoryStorage(), now: NOW,
      fetchImpl: async (url) => { requested.push(url); return jsonResponse({ results: [] }) },
    })
    // Only /tv/1/videos should be requested — no discover / untracked ids
    // (Marvel/DC exception is disabled until ids are verified).
    expect(requested.every((u) => u.includes('/tv/1/videos'))).toBe(true)
  })
})

describe('Scope S — caches are separate and legacy news cache is inert', () => {
  it('writes announcements and trailers to distinct namespaces, leaving legacy news cache untouched', async () => {
    const storage = memoryStorage({ 'rerun_news_cache:v1': 'legacy-blob' })
    await loadAnnouncements({
      trackedShows: ALL_STATUS_SHOWS, storage, now: NOW,
      fetchImpl: async () => jsonResponse({ articles: [{ title: 'From renewed for Season 4', publishedAt: '2026-07-20T00:00:00.000Z', sourceName: 'Deadline', url: 'https://deadline.com/a' }] }),
    })
    await loadTrailers({
      trackedShows: [{ tmdb_id: 1, name: 'From' }], storage, now: NOW,
      fetchImpl: async () => jsonResponse({ results: [{ key: 'k', site: 'YouTube', type: 'Trailer', name: 'Official Trailer', official: true, iso_639_1: 'en', published_at: '2026-07-10T00:00:00.000Z' }] }),
    })
    const keys = storage._keys()
    expect(keys).toContain(ANNOUNCEMENTS_CACHE_KEY)
    expect(keys).toContain(TRAILERS_CACHE_KEY)
    expect(storage.getItem('rerun_news_cache:v1')).toBe('legacy-blob') // untouched
  })
})

describe('Scope S — YouTube URLs and no UI dependency', () => {
  it('generates watch?v= URLs for handoff, never embeds', async () => {
    const state = await loadTrailers({
      trackedShows: [{ tmdb_id: 1, name: 'From' }], storage: memoryStorage(), now: NOW,
      fetchImpl: async () => jsonResponse({ results: [{ key: 'abc', site: 'YouTube', type: 'Trailer', name: 'Official Trailer', official: true, iso_639_1: 'en', published_at: '2026-07-10T00:00:00.000Z' }] }),
    })
    expect(state.items[0].youtubeUrl).toBe('https://www.youtube.com/watch?v=abc')
  })
})

describe('Scope S — classifier is a pure function of article + registry', () => {
  it('produces identical results without any DOM/UI or network', () => {
    const registry = buildIdentityRegistry([{ tmdb_id: 1, name: 'From' }])
    const article = { title: 'From renewed for Season 4', publishedAt: '2026-07-20T00:00:00.000Z', sourceName: 'Deadline', url: 'https://deadline.com/a' }
    const a = classifyAnnouncement(article, registry, { now: NOW })
    const b = classifyAnnouncement(article, registry, { now: NOW })
    expect(a).toEqual(b)
    expect(a.accepted).toBe(true)
  })
})
