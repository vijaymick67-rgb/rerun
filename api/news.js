import { createGnewsProvider } from '../src/lib/news/gnewsProvider.js'
import { dedupeArticles } from '../src/lib/news/dedupeArticles.js'
import { normalizeArticle } from '../src/lib/news/normalizeArticle.js'
import { NewsProviderError } from '../src/lib/news/provider.js'
import { filterTvNews } from '../src/lib/news/tvNewsFilter.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 30
const CACHE_CONTROL = 'public, s-maxage=1800, stale-while-revalidate=10800'

function json(res, status, body, headers = {}) {
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  res.json(body)
}

export function parseNewsLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT
  if (Array.isArray(value) || !/^\d+$/.test(String(value))) return null

  const limit = Number(value)
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? limit : null
}

function errorBody(code, message) {
  return { error: { code, message } }
}

export function createNewsHandler({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async function newsHandler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      json(res, 405, errorBody('METHOD_NOT_ALLOWED', 'Only GET is supported'))
      return
    }

    const limit = parseNewsLimit(req.query?.limit)
    if (!limit) {
      json(res, 400, errorBody('INVALID_LIMIT', `limit must be an integer from 1 to ${MAX_LIMIT}`))
      return
    }

    if (!env.GNEWS_API_KEY) {
      json(
        res,
        503,
        errorBody('NEWS_UNAVAILABLE', 'News is temporarily unavailable'),
        { 'Cache-Control': 'no-store' },
      )
      return
    }

    try {
      const provider = createGnewsProvider({ apiKey: env.GNEWS_API_KEY, fetchImpl })
      const rawArticles = await provider.fetchArticles({ limit: MAX_LIMIT })
      const fetchedAt = new Date().toISOString()
      const normalized = rawArticles
        .map((article) => normalizeArticle(article, { fetchedAt }))
        .filter(Boolean)
      const articles = dedupeArticles(filterTvNews(normalized)).slice(0, limit)

      json(
        res,
        200,
        { articles, meta: { provider: 'gnews', fetchedAt, cached: false, count: articles.length } },
        { 'Cache-Control': CACHE_CONTROL },
      )
    } catch (error) {
      const providerCode = error instanceof NewsProviderError ? error.code : 'UNKNOWN'
      console.error('news_provider_error', { provider: 'gnews', code: providerCode })
      json(
        res,
        502,
        errorBody('NEWS_PROVIDER_ERROR', 'News is temporarily unavailable'),
        { 'Cache-Control': 'no-store' },
      )
    }
  }
}

export default createNewsHandler()
