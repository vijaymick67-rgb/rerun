import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BrowseNewsView, NewsStoryCard } from '../../components/BrowseNews.jsx'
import { createNewsClient, NEWS_REFRESH_MS } from './client.js'
import { matchArticleToTrackedShow } from './matchTrackedShows.js'
import {
  dismissMyShowsArticle, emptyNewsState, mergeNews, NEWS_CACHE_KEY,
  readNewsCache, selectGeneralNews, visibleMyShowsArticles, writeNewsCache,
} from './newsStore.js'
import { formatRelativeTime } from './relativeTime.js'
import { upsertTrackedShowForNews } from './trackedShows.js'

const shows = [
  { tmdb_id: 1, name: 'House of the Dragon' },
  { tmdb_id: 2, name: 'Sugar' },
  { tmdb_id: 3, name: 'Law & Order' },
]
function article(id, title = `General TV story ${id}`, hours = id) {
  return { id: `a${id}`, title, description: 'TV series news', url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`, imageUrl: null, sourceName: `Source ${id}`,
    publishedAt: new Date(Date.UTC(2026, 6, 14, 12 - hours)).toISOString() }
}
function storage(seed) {
  const values = new Map(seed ? [[NEWS_CACHE_KEY, seed]] : [])
  return { getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)), values }
}
function myArticle(id) { return article(id, `House of the Dragon update ${id}`, id) }

describe('tracked-show news matching', () => {
  it('matches exact, punctuation-normalized, and ampersand variants', () => {
    expect(matchArticleToTrackedShow(article(1, 'House of the Dragon renewed'), shows)).toMatchObject({ matched: true, showId: 1 })
    expect(matchArticleToTrackedShow(article(1, 'House-of-the-Dragon renewed'), shows).matched).toBe(true)
    expect(matchArticleToTrackedShow(article(1, 'Law and Order casts a new lead'), shows)).toMatchObject({ matched: true, showId: 3 })
  })
  it('rejects unrelated and weak ambiguous-title mentions', () => {
    expect(matchArticleToTrackedShow(article(1, 'Prestige drama renewed'), shows).matched).toBe(false)
    expect(matchArticleToTrackedShow({ ...article(1, 'Dessert trends'), description: 'Sugar prices rise' }, shows).matched).toBe(false)
  })
  it('accepts an ambiguous title as an exact headline phrase', () => {
    expect(matchArticleToTrackedShow(article(1, 'Sugar renewed for season two'), shows)).toMatchObject({ matched: true, showId: 2 })
  })
  it('resolves multiple matches deterministically to the strongest title', () => {
    const result = matchArticleToTrackedShow(article(1, 'Sugar joins House of the Dragon'), shows)
    expect(result.showId).toBe(1)
  })
  it('rejects malformed articles safely', () => {
    expect(matchArticleToTrackedShow(null, shows).matched).toBe(false)
    expect(matchArticleToTrackedShow({}, shows).matched).toBe(false)
  })
})

describe('in-session tracked-show updates', () => {
  it('makes a newly added show eligible for My Shows news without a reload', () => {
    const cached = mergeNews(emptyNewsState(), [
      article(70, 'Severance renewed after acclaimed season'),
    ], shows)
    expect(visibleMyShowsArticles(cached)).toHaveLength(0)

    const existing = [{ tmdb_id: 1, name: 'House of the Dragon', hidden_at: null }]
    const tracked = upsertTrackedShowForNews(existing, { id: 70, name: 'Severance' })
    const rematched = mergeNews(cached, Object.values(cached.articles), tracked, cached.lastSuccess)

    expect(tracked).toEqual([
      existing[0],
      { tmdb_id: 70, name: 'Severance' },
    ])
    expect(visibleMyShowsArticles(rematched)).toMatchObject([
      { id: 'a70', matchedShowId: 70, matchedShowName: 'Severance' },
    ])
  })

  it('updates an existing record in place and deduplicates by tmdb_id', () => {
    const first = { tmdb_id: 1, name: 'Old name', hidden_at: null }
    const second = { tmdb_id: 2, name: 'Other show' }
    expect(upsertTrackedShowForNews([first, second], { id: 1, title: 'New name' })).toEqual([
      { tmdb_id: 1, name: 'New name', hidden_at: null },
      second,
    ])
  })
})

describe('My Shows inbox', () => {
  it.each([7, 10])('keeps %i matching stories visible', (count) => {
    const state = mergeNews(emptyNewsState(), Array.from({ length: count }, (_, i) => myArticle(i)), shows)
    expect(state.visibleIds).toHaveLength(count)
    expect(state.queuedIds).toHaveLength(0)
  })
  it('queues the eleventh and additional stories without replacing visible stories', () => {
    const first = mergeNews(emptyNewsState(), Array.from({ length: 11 }, (_, i) => myArticle(i)), shows)
    const originalVisible = [...first.visibleIds]
    const next = mergeNews(first, [myArticle(11), myArticle(12)], shows)
    expect(first.queuedIds).toEqual(['a10'])
    expect(next.visibleIds).toEqual(originalVisible)
    expect(next.queuedIds).toEqual(['a10', 'a11', 'a12'])
  })
  it('promotes the next queued story immediately after dismissal', () => {
    const state = mergeNews(emptyNewsState(), Array.from({ length: 11 }, (_, i) => myArticle(i)), shows)
    const next = dismissMyShowsArticle(state, 'a2')
    expect(next.visibleIds).not.toContain('a2')
    expect(next.visibleIds).toContain('a10')
    expect(next.dismissedIds).toContain('a2')
  })
  it('persists dismissals and does not restore a dismissed refetch', () => {
    const local = storage()
    const initial = mergeNews(emptyNewsState(), [myArticle(1)], shows)
    writeNewsCache(dismissMyShowsArticle(initial, 'a1'), local)
    const reloaded = readNewsCache(local)
    expect(reloaded.dismissedIds).toContain('a1')
    expect(mergeNews(reloaded, [myArticle(1)], shows).visibleIds).not.toContain('a1')
  })
  it('deduplicates canonical identity', () => {
    const duplicate = { ...myArticle(1), id: 'different', url: 'https://example.com/1?utm_source=x', canonicalUrl: 'https://example.com/1?utm_source=x' }
    const state = mergeNews(emptyNewsState(), [myArticle(1), duplicate], shows)
    expect(Object.keys(state.articles)).toHaveLength(1)
  })
  it('caps the pool at 50 without evicting the original visible ten', () => {
    const first = mergeNews(emptyNewsState(), Array.from({ length: 10 }, (_, i) => myArticle(i)), shows)
    const state = mergeNews(first, Array.from({ length: 60 }, (_, i) => myArticle(i + 10)), shows)
    expect([...state.visibleIds]).toEqual(first.visibleIds)
    expect(state.visibleIds.length + state.queuedIds.length).toBe(50)
  })
})

describe('general news rotation', () => {
  it('excludes visible, queued, and dismissed My Shows stories', () => {
    let state = mergeNews(emptyNewsState(), [...Array.from({ length: 11 }, (_, i) => myArticle(i)), article(40)], shows)
    state = dismissMyShowsArticle(state, 'a0')
    expect(selectGeneralNews(state, shows).map((item) => item.id)).toEqual(['a40'])
  })
  it('selects the freshest six and removes duplicate identities', () => {
    const items = Array.from({ length: 8 }, (_, i) => article(i + 20, `TV industry story ${i}`, i))
    const state = mergeNews(emptyNewsState(), [...items, { ...items[0] }], shows)
    expect(selectGeneralNews(state, shows).map((item) => item.id)).toEqual(items.slice(0, 6).map((item) => item.id))
  })
  it('rotates after a successful merge', () => {
    const old = mergeNews(emptyNewsState(), Array.from({ length: 6 }, (_, i) => article(i + 20, `TV story ${i}`, i + 10)), shows)
    const next = mergeNews(old, [article(99, 'Fresh TV story', -1)], shows)
    expect(selectGeneralNews(next, shows)[0].id).toBe('a99')
  })
})

describe('news cache and stale-while-refresh client', () => {
  it('returns cached stories before the fetch completes and deduplicates requests', async () => {
    const local = storage()
    writeNewsCache(mergeNews(emptyNewsState(), [article(20)], shows, 1), local)
    let resolveFetch
    const fetchImpl = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve }))
    const client = createNewsClient()
    const first = client.load({ storage: local, trackedShows: shows, fetchImpl, now: NEWS_REFRESH_MS + 2 })
    const second = client.load({ storage: local, trackedShows: shows, fetchImpl, now: NEWS_REFRESH_MS + 2 })
    expect(Object.keys(first.cached.articles)).toHaveLength(1)
    expect(second.refresh).toBe(first.refresh)
    await Promise.resolve()
    resolveFetch({ ok: true, json: async () => ({ articles: [article(21)] }) })
    await first.refresh
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('/api/news?limit=10', {
      headers: { Accept: 'application/json' },
    })
  })
  it('avoids refresh for a fresh cache', () => {
    const local = storage()
    writeNewsCache(mergeNews(emptyNewsState(), [article(20)], shows, 1000), local)
    const fetchImpl = vi.fn()
    expect(createNewsClient().load({ storage: local, fetchImpl, now: 1001 }).refresh).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('preserves cache after failed refresh', async () => {
    const local = storage()
    writeNewsCache(mergeNews(emptyNewsState(), [article(20)], shows, 1), local)
    const { refresh } = createNewsClient().load({ storage: local, fetchImpl: async () => ({ ok: false }), now: NEWS_REFRESH_MS + 2 })
    await expect(refresh).rejects.toThrow()
    expect(readNewsCache(local).articles.a20).toBeTruthy()
  })
  it('resets malformed and version-mismatched storage safely', () => {
    expect(readNewsCache(storage('{bad'))).toEqual(emptyNewsState())
    expect(readNewsCache(storage(JSON.stringify({ version: 99, articles: {} })))).toEqual(emptyNewsState())
  })
})

describe('news UI', () => {
  it('renders both headings and enforces card limits', () => {
    const state = mergeNews(emptyNewsState(), [
      ...Array.from({ length: 12 }, (_, i) => myArticle(i)),
      ...Array.from({ length: 8 }, (_, i) => article(i + 30, `TV business story ${i}`, i)),
    ], shows)
    const html = renderToStaticMarkup(<BrowseNewsView state={state} trackedShows={shows} />)
    expect(html).toContain('News about your shows')
    expect(html).toContain('Interesting TV news')
    expect((html.match(/aria-label="Dismiss/g) ?? [])).toHaveLength(10)
    expect((html.match(/<article/g) ?? [])).toHaveLength(16)
  })
  it('puts dismiss controls only on My Shows and prevents navigation', () => {
    const onDismiss = vi.fn()
    const tree = NewsStoryCard({ article: myArticle(1), onDismiss })
    const button = tree.props.children[1]
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    button.props.onClick(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(onDismiss).toHaveBeenCalledWith('a1')
    expect(renderToStaticMarkup(<NewsStoryCard article={article(20)} />)).not.toContain('Dismiss')
  })
  it('renders a stable image fallback and safe empty/error states', () => {
    expect(renderToStaticMarkup(<NewsStoryCard article={article(20)} />)).toContain('data-news-image-fallback="true"')
    const empty = renderToStaticMarkup(<BrowseNewsView state={emptyNewsState()} trackedShows={shows} />)
    expect(empty).toContain('No news about your shows right now.')
    expect(empty).toContain('No TV news available right now.')
    expect(renderToStaticMarkup(<BrowseNewsView state={emptyNewsState()} error />)).toContain('Retry')
  })
  it('formats relative publication age without a live timer', () => {
    const now = Date.parse('2026-07-14T12:00:00Z')
    expect(formatRelativeTime(now, now)).toBe('Just now')
    expect(formatRelativeTime(now - 12 * 60000, now)).toBe('12m ago')
    expect(formatRelativeTime(now - 3 * 3600000, now)).toBe('3h ago')
    expect(formatRelativeTime(now - 2 * 86400000, now)).toBe('2d ago')
  })
})
