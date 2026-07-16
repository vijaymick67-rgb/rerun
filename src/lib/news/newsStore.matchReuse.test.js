import { describe, expect, it, vi } from 'vitest'

// Spied at the matchTrackedShows.js module boundary (not an implementation-detail
// function inside newsStore.js) so this proves the actual production call pattern:
// mergeNews's reclassification step is the only place still allowed to invoke the
// matcher; selectGeneralNews must trust the matchedShowId it already stored instead of
// re-running it for every article on every render.
vi.mock('./matchTrackedShows.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, matchArticleToTrackedShow: vi.fn(actual.matchArticleToTrackedShow) }
})

const { matchArticleToTrackedShow } = await import('./matchTrackedShows.js')
const { emptyNewsState, mergeNews, selectGeneralNews, visibleMyShowsArticles } = await import('./newsStore.js')

const shows = [{ tmdb_id: 1, name: 'House of the Dragon' }]

function article(id, title) {
  return { id: `a${id}`, title, description: 'TV series news', url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`, imageUrl: null, sourceName: `Source ${id}`,
    publishedAt: new Date(Date.UTC(2026, 6, 14, 12 - id)).toISOString() }
}

describe('tracked-show match reuse in selectors', () => {
  it('does not call the matcher from selectGeneralNews once mergeNews has classified the article', () => {
    const state = mergeNews(emptyNewsState(), [
      article(1, 'House of the Dragon renewed for another season'),
      article(2, 'Unrelated streaming series announced'),
    ], shows)
    expect(visibleMyShowsArticles(state)).toMatchObject([{ id: 'a1', matchedShowId: 1 }])

    matchArticleToTrackedShow.mockClear()
    const general = selectGeneralNews(state, shows)

    expect(general.map((item) => item.id)).toEqual(['a2'])
    expect(matchArticleToTrackedShow).not.toHaveBeenCalled()
  })

  it('still calls the matcher from mergeNews for incoming and already-personal articles', () => {
    const state = mergeNews(emptyNewsState(), [article(3, 'House of the Dragon renewed')], shows)
    matchArticleToTrackedShow.mockClear()

    mergeNews(state, [article(4, 'Another general story')], shows)
    expect(matchArticleToTrackedShow).toHaveBeenCalled()
  })
})
