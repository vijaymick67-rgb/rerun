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

const wideShows = [
  { tmdb_id: 10, name: 'Beef' },
  { tmdb_id: 11, name: 'You' },
  { tmdb_id: 12, name: 'From' },
  { tmdb_id: 13, name: 'Dark' },
  { tmdb_id: 14, name: 'The Bear' },
  { tmdb_id: 15, name: 'A Knight of the Seven Kingdoms' },
  { tmdb_id: 16, name: 'Only Murders in the Building' },
  { tmdb_id: 17, name: 'Your Friends & Neighbors' },
]

describe('single-word title disambiguation (Phase 5)', () => {
  it.each([
    ["'Beef' stars reunite for Netflix event", 10],
    ["'You' Season 5 premiere breaks streaming records", 11],
    ["'From' renewed for season 3 by MGM+", 12],
    ["Dark is streaming again after a surprise re-release", 13],
  ])('matches a weak single-word title when the headline names it with TV context: %s', (title, showId) => {
    expect(matchArticleToTrackedShow(article(1, title), wideShows)).toMatchObject({ matched: true, showId })
  })

  it.each([
    ['Beef sales rise as inflation hits grocery stores'],
    ['You should try this new dessert trend'],
    ['From New York, our correspondent reports on the housing market'],
    ["It's dark outside during winter evenings"],
  ])('rejects ordinary use of a common word with no TV context: %s', (title) => {
    expect(matchArticleToTrackedShow(
      { ...article(1, title), description: 'A local reporter filed this story.' }, wideShows,
    ).matched).toBe(false)
  })

  it.each([
    ['A Knight of the Seven Kingdoms sets premiere date', 15],
    ['Only Murders in the Building renewed for another season', 16],
    ['Your Friends & Neighbors trailer released', 17],
    ['The Bear renewed for season 4', 14],
  ])('matches a distinctive multi-word title directly: %s', (title, showId) => {
    expect(matchArticleToTrackedShow(article(1, title), wideShows)).toMatchObject({ matched: true, showId })
  })

  it('prefers a headline match over a weak description-only mention', () => {
    const result = matchArticleToTrackedShow(
      { ...article(1, 'The Bear renewed for season 4'), description: 'You should also watch this.' },
      wideShows,
    )
    expect(result.showId).toBe(14)
  })

  it('does not match an actor-only story with no show-title context', () => {
    expect(matchArticleToTrackedShow(
      article(1, 'Jeremy Allen White spotted at a downtown restaurant'), wideShows,
    ).matched).toBe(false)
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

describe('freshness and ranking (Phase 8)', () => {
  const now = Date.parse('2026-07-14T12:00:00Z')
  function daysAgoArticle(id, title, days) {
    return { id: `f${id}`, title, description: 'TV series news', url: `https://example.com/f${id}`,
      canonicalUrl: `https://example.com/f${id}`, imageUrl: null, sourceName: `Source ${id}`,
      publishedAt: new Date(now - days * 24 * 60 * 60 * 1000).toISOString() }
  }
  function matchedArticle(id, title, days) { return daysAgoArticle(id, `House of the Dragon ${title}`, days) }

  it('prefers a recent personal match over an older one when both are queued', () => {
    const older = matchedArticle(1, 'older update', 10)
    const recent = matchedArticle(2, 'recent update', 1)
    const state = mergeNews(emptyNewsState(), [older, recent], shows, now)
    expect(state.visibleIds[0]).toBe(recent.id)
    expect(state.visibleIds[1]).toBe(older.id)
  })

  it('still surfaces an older personal match when the pool is sparse rather than showing nothing', () => {
    const older = matchedArticle(3, 'sparse pool update', 15)
    const state = mergeNews(emptyNewsState(), [older], shows, now)
    expect(state.visibleIds).toContain(older.id)
  })

  it('never queues a personal match older than 30 days', () => {
    const ancient = matchedArticle(4, 'ancient update', 40)
    const state = mergeNews(emptyNewsState(), [ancient], shows, now)
    expect(state.visibleIds).not.toContain(ancient.id)
    expect(state.queuedIds).not.toContain(ancient.id)
  })

  it('excludes a general story older than 30 days', () => {
    const ancient = daysAgoArticle(5, 'Streaming series renewed after a long run', 40)
    const state = mergeNews(emptyNewsState(), [ancient], shows, now)
    expect(selectGeneralNews(state, shows, now).map((item) => item.id)).not.toContain(ancient.id)
  })

  it('prefers a curated-source general story over an equally fresh GNews story', () => {
    const curated = { ...daysAgoArticle(6, 'Streaming series renewed for another season', 1), provider: 'tvline' }
    const gnews = { ...daysAgoArticle(7, 'Streaming series renewed for a different season', 1), provider: 'gnews' }
    const state = mergeNews(emptyNewsState(), [curated, gnews], shows, now)
    expect(selectGeneralNews(state, shows, now)[0].id).toBe(curated.id)
  })
})

describe('general news rotation', () => {
  it('excludes visible, queued, and dismissed My Shows stories', () => {
    let state = mergeNews(emptyNewsState(), [...Array.from({ length: 11 }, (_, i) => myArticle(i)), article(40, 'New television series announced')], shows)
    state = dismissMyShowsArticle(state, 'a0')
    expect(selectGeneralNews(state, shows).map((item) => item.id)).toEqual(['a40'])
  })
  it('selects the freshest six and removes duplicate identities', () => {
    const items = Array.from({ length: 8 }, (_, i) => article(i + 20, `New television series industry story ${i}`, i))
    const state = mergeNews(emptyNewsState(), [...items, { ...items[0] }], shows)
    expect(selectGeneralNews(state, shows).map((item) => item.id)).toEqual(items.slice(0, 6).map((item) => item.id))
  })
  it('rotates after a successful merge', () => {
    const old = mergeNews(emptyNewsState(), Array.from({ length: 6 }, (_, i) => article(i + 20, `Drama series story ${i}`, i + 10)), shows)
    const next = mergeNews(old, [article(99, 'Fresh limited series trailer', -1)], shows)
    expect(selectGeneralNews(next, shows)[0].id).toBe('a99')
  })

  it('keeps a directly named tracked-show story even when generic relevance rejects it', () => {
    const tracked = [{ tmdb_id: 70, name: 'Severance' }]
    const candidate = article(70, 'Severance star comments on election network coverage')
    const state = mergeNews(emptyNewsState(), [candidate], tracked)

    expect(visibleMyShowsArticles(state)).toMatchObject([{ id: 'a70', matchedShowName: 'Severance' }])
    expect(selectGeneralNews(state, tracked)).toEqual([])
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
      ...Array.from({ length: 8 }, (_, i) => article(i + 30, `New comedy series story ${i}`, i)),
    ], shows)
    const html = renderToStaticMarkup(<BrowseNewsView state={state} trackedShows={shows} />)
    expect(html).toContain('Latest from your shows')
    expect(html).toContain('TV headlines')
    expect(html).not.toMatch(/>News<\/h2>/)
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
    expect(empty).toContain('No new updates from your shows.')
    expect(empty).toContain('No TV news available right now.')
    expect(renderToStaticMarkup(<BrowseNewsView state={emptyNewsState()} error />)).toContain('Retry')
  })
  it('shows a non-blocking stale-cache notice instead of hiding cached stories on refresh failure', () => {
    const state = mergeNews(emptyNewsState(), [myArticle(1)], shows)
    const html = renderToStaticMarkup(<BrowseNewsView state={state} trackedShows={shows} error />)
    expect(html).toContain('House of the Dragon update 1')
    expect(html).toContain('Showing saved stories')
    expect(html).toContain('Retry')
  })
  it('formats relative publication age without a live timer', () => {
    const now = Date.parse('2026-07-14T12:00:00Z')
    expect(formatRelativeTime(now, now)).toBe('Just now')
    expect(formatRelativeTime(now - 12 * 60000, now)).toBe('12m ago')
    expect(formatRelativeTime(now - 3 * 3600000, now)).toBe('3h ago')
    expect(formatRelativeTime(now - 2 * 86400000, now)).toBe('2d ago')
  })
})
