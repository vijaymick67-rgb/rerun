import { afterEach, describe, expect, it, vi } from 'vitest'
import handler, { createNewsHandler, parseNewsLimit } from '../../../api/news.js'
import { dedupeArticles } from './dedupeArticles.js'
import { normalizeArticle, canonicalizeUrl, stableArticleId } from './normalizeArticle.js'
import { filterTvNews, isTvNewsArticle } from './tvNewsFilter.js'
import { createGnewsProvider } from './gnewsProvider.js'

function makeResponse({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
  }
}

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

  it('accepts TV-series development and rejects obvious unrelated categories', () => {
    expect(isTvNewsArticle(article())).toBe(true)
    expect(isTvNewsArticle(article({ title: 'The movie wins the box office weekend' }))).toBe(false)
    expect(isTvNewsArticle(article({ title: 'Star scores a hat-trick in the football final' }))).toBe(false)
    expect(isTvNewsArticle(article({ title: 'Singer announces a new album and tour' }))).toBe(false)
    expect(isTvNewsArticle(article({ title: 'Celebrity relationship gossip spreads online', description: '' }))).toBe(false)
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

  it('returns a controlled response when the API key is missing', async () => {
    const fetchImpl = vi.fn()
    const res = makeHttpResponse()
    const newsHandler = createNewsHandler({ env: {}, fetchImpl })

    await newsHandler({ method: 'GET', query: {} }, res)

    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({
      error: { code: 'NEWS_UNAVAILABLE', message: 'News is temporarily unavailable' },
    })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects unsupported methods and invalid limits', async () => {
    const newsHandler = createNewsHandler({ env: { GNEWS_API_KEY: 'secret' } })
    const methodRes = makeHttpResponse()
    const limitRes = makeHttpResponse()

    await newsHandler({ method: 'POST', query: {} }, methodRes)
    await newsHandler({ method: 'GET', query: { limit: '99' } }, limitRes)

    expect(methodRes.statusCode).toBe(405)
    expect(methodRes.headers.get('Allow')).toBe('GET')
    expect(limitRes.statusCode).toBe(400)
    expect(limitRes.body.error.code).toBe('INVALID_LIMIT')
  })

  it('returns normalized, filtered, deduplicated articles with safe metadata', async () => {
    let requestedUrl
    const fetchImpl = vi.fn(async (url) => {
      requestedUrl = new URL(url)
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
              title: 'A TV series is renewed for season 2!',
              url: 'https://other.example/story',
              source: { name: 'Small Source' },
              publishedAt: '2026-07-13T09:00:00Z',
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

    await createNewsHandler({ env: { GNEWS_API_KEY: 'secret' }, fetchImpl })(
      { method: 'GET', query: { limit: '5' } },
      res,
    )

    expect(res.statusCode).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=1800, stale-while-revalidate=10800')
    expect(res.body.articles).toHaveLength(1)
    expect(res.body.articles[0]).toMatchObject({
      title: 'A TV series is renewed for season 2',
      sourceName: 'Variety',
      provider: 'gnews',
    })
    expect(res.body.articles[0]).not.toHaveProperty('source')
    expect(res.body.meta).toMatchObject({ provider: 'gnews', cached: false, count: 1 })
    expect(Number.isNaN(new Date(res.body.meta.fetchedAt).getTime())).toBe(false)
    expect(requestedUrl.searchParams.get('apikey')).toBe('secret')
    expect(requestedUrl.searchParams.get('q')).toBe('television')
    expect(requestedUrl.searchParams.get('max')).toBe('5')
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
      env: { GNEWS_API_KEY: 'secret' },
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
      env: { GNEWS_API_KEY: 'secret-key' },
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
      env: { GNEWS_API_KEY: 'secret' },
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
})
