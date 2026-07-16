import { afterEach, describe, expect, it, vi } from 'vitest'
import handler, { createNewsHandler, parseNewsLimit } from '../../../api/news.js'
import { dedupeArticles } from './dedupeArticles.js'
import { normalizeArticle, canonicalizeUrl, stableArticleId } from './normalizeArticle.js'
import { filterTvNews, isTvNewsArticle } from './tvNewsFilter.js'
import { createGnewsProvider } from './gnewsProvider.js'
import { CURATED_FEED_SOURCES } from './feedSources.js'

function makeResponse({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
  }
}

function makeXmlResponse(xml, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, async text() { return xml } }
}

const RSS_FEED_XML = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Curated series renewed for another season</title>
      <link>https://curated.example/story</link>
      <description>Straight from the curated desk.</description>
      <pubDate>Mon, 13 Jul 2026 11:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`

function makeHttpResponse() {
  const headers = new Map()
  return {
    headers,
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    setHeader(name, value) {
      headers.set(name, value)
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
}

function article(overrides = {}) {
  return {
    id: 'gnews-test',
    title: 'A TV series is renewed for season 2',
    description: 'The network confirmed the next season.',
    url: 'https://Example.com/story?utm_source=test',
    canonicalUrl: 'https://example.com/story',
    imageUrl: null,
    sourceName: 'Example News',
    publishedAt: '2026-07-13T10:00:00.000Z',
    fetchedAt: '2026-07-13T11:00:00.000Z',
    provider: 'gnews',
    ...overrides,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('news normalization and filtering', () => {
  it('canonicalizes URLs and creates a stable ID', () => {
    const first = canonicalizeUrl('HTTPS://Example.COM/story/?utm_source=x&fbclid=abc#comments')
    const second = canonicalizeUrl('https://example.com/story')

    expect(first).toBe(second)
    expect(stableArticleId(first)).toBe(stableArticleId(second))
  })

  it('normalizes provider articles and rejects malformed required fields', () => {
    const normalized = normalizeArticle(
      {
        title: '  Renewed show  ',
        description: '',
        url: 'https://example.com/news/?gclid=123',
        image: 'https://images.example.com/poster.jpg',
        source: { name: 'TV Desk' },
        publishedAt: '2026-07-13T10:00:00Z',
      },
      { fetchedAt: '2026-07-13T11:00:00Z' },
    )

    expect(normalized).toMatchObject({
      id: expect.stringMatching(/^gnews-[0-9a-f]+$/),
      title: 'Renewed show',
      description: null,
      canonicalUrl: 'https://example.com/news',
      imageUrl: 'https://images.example.com/poster.jpg',
      provider: 'gnews',
    })
    expect(normalized.publishedAt).toBe('2026-07-13T10:00:00.000Z')
    expect(
      normalizeArticle({
        title: 'A series headline',
        description: 'x'.repeat(400),
        url: 'https://example.com/long',
        source: { name: 'TV Desk' },
        publishedAt: '2026-07-13T10:00:00Z',
      }).description,
    ).toHaveLength(320)
    expect(normalizeArticle({ ...normalized, title: '' })).toBeNull()
    expect(normalizeArticle({ ...normalized, url: 'not-a-url' })).toBeNull()
    expect(normalizeArticle({ ...normalized, source: undefined })).toBeNull()
    expect(normalizeArticle({ ...normalized, publishedAt: 'not-a-date' })).toBeNull()
  })

  it('deduplicates canonical URLs and clearly equivalent titles', () => {
    const result = dedupeArticles([
      article({ url: 'https://example.com/story?fbclid=x', canonicalUrl: 'https://example.com/story' }),
      article({
        canonicalUrl: 'https://other.example/story',
        title: 'A TV-series is renewed for Season 2!',
        sourceName: 'Variety',
        imageUrl: 'https://images.example/story.jpg',
      }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0].sourceName).toBe('Variety')
  })

  it('prefers a curated-source duplicate over an equivalent GNews duplicate', () => {
    const result = dedupeArticles([
      article({
        canonicalUrl: 'https://gnews-aggregator.example/story',
        sourceName: 'Unlisted Aggregator',
        provider: 'gnews',
      }),
      article({
        canonicalUrl: 'https://tvline.com/story',
        sourceName: 'Unlisted Aggregator',
        provider: 'tvline',
      }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0].provider).toBe('tvline')
  })

  it.each([
    'HBO renews The Last of Us for season 3',
    'Netflix releases first trailer for new limited series',
    'Apple TV+ sets premiere date for Severance season 3',
    'FX casts lead actor in upcoming drama series',
    'Peacock cancels comedy series after two seasons',
  ])('accepts strong TV-entertainment news: %s', (title) => {
    expect(isTvNewsArticle(article({ title, description: '' }))).toBe(true)
  })

  it.each([
    'Iran executes 2 Islamic State members convicted of armed rebellion',
    'Fans at HR Derby given massive mitts to catch dingers',
    "TV presenter's apology slammed after insensitive remark on air",
    "'Ghost Hunters' star listed as owner of R.I.'s 'Conjuring' house",
    'Government network begins new election series on TV',
    'Police investigate crime series shared on TV network',
    'Football league launches weekly television series',
    'K-pop band announces TV music series',
    'New OLED television series enters production',
  ])('rejects irrelevant broad-word news: %s', (title) => {
    expect(isTvNewsArticle(article({ title, description: '' }))).toBe(false)
  })

  it('rejects a TV personality property story despite TV-series context', () => {
    expect(isTvNewsArticle(article({
      title: "'Ghost Hunters' star listed as owner of R.I.'s 'Conjuring' house",
      description: 'The TV series made the property famous with viewers.',
    }))).toBe(false)
  })

  it('requires corporate coverage to connect directly to TV programming', () => {
    expect(isTvNewsArticle(article({
      title: 'Paramount and Warner Bros. discuss merger',
      description: 'The deal could reshape streaming and television programming for subscribers.',
    }))).toBe(true)
    expect(isTvNewsArticle(article({
      title: 'Paramount and Warner Bros. face merger lawsuit',
      description: 'Investors debated shares and financing.',
    }))).toBe(false)
    expect(filterTvNews([article(), article({ title: 'Film festival fashion gossip' })])).toHaveLength(1)
  })
})

describe('GET /api/news', () => {
  it('validates limits and defaults safely', () => {
    expect(parseNewsLimit()).toBe(10)
    expect(parseNewsLimit('1')).toBe(1)
    expect(parseNewsLimit('10')).toBe(10)
    expect(parseNewsLimit('0')).toBeNull()
    expect(parseNewsLimit('11')).toBeNull()
    expect(parseNewsLimit('3.5')).toBeNull()
    expect(parseNewsLimit(['2'])).toBeNull()
  })

  it('returns a controlled response when no providers are configured at all', async () => {
    const fetchImpl = vi.fn()
    const res = makeHttpResponse()
    const newsHandler = createNewsHandler({ env: {}, fetchImpl, feedSources: [] })

    await newsHandler({ method: 'GET', query: {} }, res)

    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({
      error: { code: 'NEWS_UNAVAILABLE', message: 'News is temporarily unavailable' },
    })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('still serves curated articles when the GNews key is missing', async () => {
    const fetchImpl = vi.fn(async () => makeXmlResponse(RSS_FEED_XML))
    const res = makeHttpResponse()
    const newsHandler = createNewsHandler({
      env: {}, fetchImpl, feedSources: [{ name: 'Curated', url: 'https://curated.example/feed' }],
    })

    await newsHandler({ method: 'GET', query: {} }, res)

    expect(res.statusCode).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('https://curated.example/feed', expect.any(Object))
    expect(res.body.meta.providers).toEqual(['Curated'])
    expect(res.body.articles.length).toBeGreaterThan(0)
    expect(res.body.articles[0].provider).toBe('curated')
  })

  it('rejects unsupported methods and invalid limits', async () => {
    const newsHandler = createNewsHandler({ env: { GNEWS_API_KEY: 'secret' }, feedSources: [] })
    const methodRes = makeHttpResponse()
    const limitRes = makeHttpResponse()

    await newsHandler({ method: 'POST', query: {} }, methodRes)
    await newsHandler({ method: 'GET', query: { limit: '99' } }, limitRes)

    expect(methodRes.statusCode).toBe(405)
    expect(methodRes.headers.get('Allow')).toBe('GET')
    expect(limitRes.statusCode).toBe(400)
    expect(limitRes.body.error.code).toBe('INVALID_LIMIT')
  })

  it('ignores any client-supplied feed URL — only the fixed allow-list is ever fetched', async () => {
    const fetchImpl = vi.fn(async () => makeXmlResponse(RSS_FEED_XML))
    const res = makeHttpResponse()
    const newsHandler = createNewsHandler({
      env: {}, fetchImpl, feedSources: [{ name: 'Curated', url: 'https://curated.example/feed' }],
    })

    await newsHandler({ method: 'GET', query: { limit: '5', feedUrl: 'https://evil.example/feed' } }, res)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('https://curated.example/feed', expect.any(Object))
  })

  it('aggregates curated and GNews results, preferring curated stories when trimming to the limit', async () => {
    const calledUrls = []
    const fetchImpl = vi.fn(async (url) => {
      const key = String(url)
      calledUrls.push(key)
      if (key.includes('curated.example')) return makeXmlResponse(RSS_FEED_XML)
      return makeResponse({
        body: {
          articles: [
            {
              title: 'A TV series is renewed for season 2',
              description: 'The network confirmed the next season.',
              url: 'https://example.com/story?utm_medium=email#top',
              image: 'https://images.example.com/story.jpg',
              source: { name: 'Variety' },
              publishedAt: '2026-07-13T10:00:00Z',
            },
            {
              title: 'Movie box office rises',
              url: 'https://movies.example/story',
              source: { name: 'Movie Source' },
              publishedAt: '2026-07-13T08:00:00Z',
            },
          ],
        },
      })
    })
    const res = makeHttpResponse()

    await createNewsHandler({
      env: { GNEWS_API_KEY: 'secret' }, fetchImpl,
      feedSources: [{ name: 'Curated', url: 'https://curated.example/feed' }],
    })({ method: 'GET', query: { limit: '5' } }, res)

    expect(res.statusCode).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=1800, stale-while-revalidate=10800')
    expect(calledUrls).toHaveLength(2)
    expect(res.body.articles.some((article) => article.provider === 'curated')).toBe(true)
    expect(res.body.articles.some((article) => article.provider === 'gnews')).toBe(true)
    // Curated stories are ordered ahead of GNews stories in the final list.
    const providerOrder = res.body.articles.map((article) => article.provider)
    expect(providerOrder.indexOf('curated')).toBeLessThan(providerOrder.lastIndexOf('gnews'))
    expect(res.body.articles[0]).not.toHaveProperty('source')
    expect(res.body.meta).toMatchObject({ providers: ['Curated', 'gnews'], sourceFailureCount: 0 })
    expect(Number.isNaN(new Date(res.body.meta.fetchedAt).getTime())).toBe(false)
  })

  it('does not discard GNews fallback candidates just because curated raw count exceeds the visible limit', async () => {
    function manyItemsXml(count, titlePrefix, linkPrefix) {
      const items = Array.from({ length: count }, (_, index) => `
        <item>
          <title>${titlePrefix} ${index}</title>
          <link>${linkPrefix}-${index}</link>
          <description>Curated coverage ${index}</description>
          <pubDate>Mon, 13 Jul 2026 11:00:00 GMT</pubDate>
        </item>`).join('')
      return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`
    }
    const calledUrls = []
    const fetchImpl = vi.fn(async (url) => {
      const key = String(url)
      calledUrls.push(key)
      if (key.includes('feed-a')) return makeXmlResponse(manyItemsXml(8, 'FeedA story', 'https://a.example/story'))
      if (key.includes('feed-b')) return makeXmlResponse(manyItemsXml(8, 'FeedB story', 'https://b.example/story'))
      return makeResponse({
        body: {
          articles: Array.from({ length: 3 }, (_, index) => ({
            title: `GNews fallback story ${index}`,
            description: 'A distinct fallback story.',
            url: `https://gnews.example/story-${index}`,
            source: { name: 'Variety' },
            publishedAt: '2026-07-13T10:00:00Z',
          })),
        },
      })
    })
    const res = makeHttpResponse()

    await createNewsHandler({
      env: { GNEWS_API_KEY: 'secret' }, fetchImpl,
      feedSources: [
        { name: 'FeedA', url: 'https://a.example/feed-a', maxArticles: 8 },
        { name: 'FeedB', url: 'https://b.example/feed-b', maxArticles: 8 },
      ],
    })({ method: 'GET', query: {} }, res)

    expect(res.statusCode).toBe(200)
    // Bounded provider requests: two curated sources plus one GNews call — nothing more.
    expect(calledUrls).toHaveLength(3)
    const curatedCount = res.body.articles.filter((article) => article.provider !== 'gnews').length
    // Curated raw output alone (16 articles) exceeds the old MAX_LIMIT of 10 — GNews
    // fallback candidates must still survive into the response rather than being
    // discarded before client-side relevance filtering runs.
    expect(curatedCount).toBeGreaterThan(10)
    const gnewsArticles = res.body.articles.filter((article) => article.provider === 'gnews')
    expect(gnewsArticles).toHaveLength(3)
    // Curated stories still rank ahead of GNews stories in the final ordering.
    const providerOrder = res.body.articles.map((article) => article.provider)
    expect(providerOrder.slice(-3)).toEqual(['gnews', 'gnews', 'gnews'])
    // The whole candidate pool stays strictly bounded (fixed provider caps: 16 + 3 = 19).
    expect(res.body.articles).toHaveLength(19)
  })

  it('keeps the feed alive when one curated source fails and GNews succeeds', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const key = String(url)
      if (key.includes('broken.example')) throw new Error('dns failure')
      return makeResponse({ body: { articles: [] } })
    })
    const res = makeHttpResponse()

    await createNewsHandler({
      env: { GNEWS_API_KEY: 'secret' }, fetchImpl,
      feedSources: [{ name: 'Broken', url: 'https://broken.example/feed' }],
    })({ method: 'GET', query: {} }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body.meta.providers).toEqual(['gnews'])
    expect(res.body.meta.sourceFailureCount).toBe(1)
  })

  it('never requests more than ten articles from GNews', async () => {
    let requestedUrl
    const provider = createGnewsProvider({
      apiKey: 'secret',
      fetchImpl: vi.fn(async (url) => {
        requestedUrl = new URL(url)
        return makeResponse({ body: { articles: [] } })
      }),
    })

    await provider.fetchArticles({ limit: 30 })

    expect(requestedUrl.searchParams.get('q')).toBe('television')
    expect(requestedUrl.searchParams.get('lang')).toBe('en')
    expect(requestedUrl.searchParams.get('sortby')).toBe('publishedAt')
    expect(requestedUrl.searchParams.get('max')).toBe('10')
  })

  it('returns a safe response for malformed or failed upstream data', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = makeHttpResponse()
    const newsHandler = createNewsHandler({
      env: { GNEWS_API_KEY: 'secret' }, feedSources: [],
      fetchImpl: vi.fn(async () => makeResponse({ status: 500, body: { error: 'secret' } })),
    })

    await newsHandler({ method: 'GET', query: {} }, res)

    expect(res.statusCode).toBe(502)
    expect(res.body).toEqual({
      error: { code: 'NEWS_PROVIDER_ERROR', message: 'News is temporarily unavailable' },
    })
    expect(JSON.stringify(res.body)).not.toContain('secret')
    expect(errorSpy).toHaveBeenCalledWith('news_provider_error', {
      provider: 'gnews',
      code: 'UPSTREAM_ERROR',
      upstreamStatus: 500,
      upstreamMessage: '[REDACTED]',
    })
    errorSpy.mockRestore()
  })

  it.each([
    [401, { error: { code: 'API_KEY_INVALID', message: 'Invalid API key secret-key' } }, 'API_KEY_INVALID', 'Invalid API key [REDACTED]'],
    [403, { errors: ['Plan does not allow this request'] }, null, 'Plan does not allow this request'],
    [400, { code: 'INVALID_ARGUMENT', message: 'Invalid max parameter' }, 'INVALID_ARGUMENT', 'Invalid max parameter'],
    [400, { errors: { q: 'The query has a syntax error' } }, 'q', 'The query has a syntax error'],
    [400, { errors: { max: ['The max value is invalid'] } }, 'max', 'The max value is invalid'],
  ])('logs safe diagnostics for an upstream %i response', async (
    status, body, upstreamCode, upstreamMessage,
  ) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = makeHttpResponse()
    const newsHandler = createNewsHandler({
      env: { GNEWS_API_KEY: 'secret-key' }, feedSources: [],
      fetchImpl: vi.fn(async () => makeResponse({ status, body })),
    })

    await newsHandler({ method: 'GET', query: {} }, res)

    expect(res.statusCode).toBe(502)
    expect(res.body).toEqual({
      error: { code: 'NEWS_PROVIDER_ERROR', message: 'News is temporarily unavailable' },
    })
    const logged = errorSpy.mock.calls[0][1]
    expect(logged).toMatchObject({
      provider: 'gnews', code: 'UPSTREAM_ERROR', upstreamStatus: status, upstreamMessage,
    })
    if (upstreamCode) expect(logged.upstreamCode).toBe(upstreamCode)
    else expect(logged).not.toHaveProperty('upstreamCode')
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret-key')
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('apikey=')
    errorSpy.mockRestore()
  })

  it('does not expose raw malformed provider payloads', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = makeHttpResponse()
    const newsHandler = createNewsHandler({
      env: { GNEWS_API_KEY: 'secret' }, feedSources: [],
      fetchImpl: vi.fn(async () => ({ ok: true, status: 200, text: async () => '{bad json' })),
    })

    await newsHandler({ method: 'GET', query: {} }, res)

    expect(res.statusCode).toBe(502)
    expect(res.body.error.code).toBe('NEWS_PROVIDER_ERROR')
    expect(errorSpy).toHaveBeenCalledWith('news_provider_error', {
      provider: 'gnews',
      code: 'MALFORMED_RESPONSE',
    })
    errorSpy.mockRestore()
  })

  it('exports a Vercel-compatible default handler', () => {
    expect(typeof handler).toBe('function')
  })

  it('bounds total upstream requests to the curated allow-list plus one GNews call', async () => {
    const calledUrls = []
    const fetchImpl = vi.fn(async (url) => {
      calledUrls.push(String(url))
      return makeXmlResponse(RSS_FEED_XML)
    })
    const res = makeHttpResponse()

    await createNewsHandler({ env: {}, fetchImpl })({ method: 'GET', query: {} }, res)

    expect(calledUrls).toEqual(CURATED_FEED_SOURCES.map((source) => source.url))
    expect(calledUrls).toHaveLength(CURATED_FEED_SOURCES.length)
  })
})
