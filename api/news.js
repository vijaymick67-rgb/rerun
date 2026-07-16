import { createGnewsProvider } from '../src/lib/news/gnewsProvider.js'
import { createRssProvider } from '../src/lib/news/rssProvider.js'
import { CURATED_FEED_SOURCES } from '../src/lib/news/feedSources.js'
import { aggregateProviders } from '../src/lib/news/aggregateNews.js'
import { dedupeArticles } from '../src/lib/news/dedupeArticles.js'
import { normalizeArticle } from '../src/lib/news/normalizeArticle.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 10
// The response is a bounded *candidate pool* for client-side matching and filtering,
// not the final visible list — tracked-show matching, TV-relevance filtering, and age
// pruning all happen client-side, after this response lands. If the pool were sliced
// down to the client's requested visible `limit`, curated coverage alone could fill it
// and GNews fallback candidates would never survive to be considered. This is bounded
// by the fixed per-provider caps (curated sources + GNEWS_MAX_ARTICLES), so in normal
// operation it is a safety ceiling rather than a functional truncation.
const CANDIDATE_POOL_LIMIT = 30
const CACHE_CONTROL = 'public, s-maxage=1800, stale-while-revalidate=10800'
const RSS_TIMEOUT_MS = 6000
const RSS_MAX_ARTICLES_PER_SOURCE = 8

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

function providerKeyFor(name) {
  return name === 'gnews' ? 'gnews' : name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function logProviderFailure(result) {
  const error = result.error
  const providerCode = error?.code ?? 'UNKNOWN'
  const diagnostics = { provider: result.name, code: providerCode }
  if (error?.upstream) {
    if (error.upstream.status !== null) diagnostics.upstreamStatus = error.upstream.status
    if (error.upstream.code !== null) diagnostics.upstreamCode = error.upstream.code
    if (error.upstream.message !== null) diagnostics.upstreamMessage = error.upstream.message
  }
  console.error('news_provider_error', diagnostics)
}

export function createNewsHandler({
  env = process.env, fetchImpl = globalThis.fetch, feedSources = CURATED_FEED_SOURCES,
} = {}) {
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

    // Curated feeds are a small, fixed allow-list — never client-supplied — plus a
    // single bounded GNews request when a key is configured. GNews alone being
    // unconfigured no longer blanks the feed: curated sources still run.
    const curatedProviders = feedSources.map((source) => createRssProvider({
      name: source.name,
      url: source.url,
      fetchImpl,
      timeoutMs: RSS_TIMEOUT_MS,
      maxArticles: source.maxArticles ?? RSS_MAX_ARTICLES_PER_SOURCE,
    }))
    const providers = [...curatedProviders]
    if (env.GNEWS_API_KEY) {
      providers.push(createGnewsProvider({ apiKey: env.GNEWS_API_KEY, fetchImpl }))
    }

    if (!providers.length) {
      json(
        res,
        503,
        errorBody('NEWS_UNAVAILABLE', 'News is temporarily unavailable'),
        { 'Cache-Control': 'no-store' },
      )
      return
    }

    const fetchedAt = new Date().toISOString()
    // Providers are asked to fill the full candidate pool, not just the client's
    // requested visible `limit` — GNews already hard-caps itself at GNEWS_MAX_ARTICLES
    // regardless, and curated sources ignore this value entirely (their per-source cap
    // is fixed at creation time).
    const { results, providersUsed, failureCount } = await aggregateProviders(providers, { limit: CANDIDATE_POOL_LIMIT })
    results.filter((result) => !result.ok).forEach(logProviderFailure)

    if (!providersUsed.length) {
      json(
        res,
        502,
        errorBody('NEWS_PROVIDER_ERROR', 'News is temporarily unavailable'),
        { 'Cache-Control': 'no-store' },
      )
      return
    }

    const normalized = results.flatMap((result) => {
      if (!result.ok) return []
      const provider = providerKeyFor(result.name)
      return result.articles.map((raw) => normalizeArticle(raw, { fetchedAt, provider })).filter(Boolean)
    })
    // Generic relevance is evaluated in the client after tracked-show matching,
    // so personal stories are not discarded before the user's shows are known.
    const deduped = dedupeArticles(normalized)
    // Curated sources are ordered first as a quality/ranking signal, but the slice
    // below is bounded by the candidate pool size, not the client's visible `limit` —
    // GNews fallback candidates must survive into the response even when curated
    // coverage alone would exceed the visible count.
    const curated = deduped.filter((article) => article.provider !== 'gnews')
    const fallback = deduped.filter((article) => article.provider === 'gnews')
    const articles = [...curated, ...fallback].slice(0, CANDIDATE_POOL_LIMIT)

    json(
      res,
      200,
      { articles, meta: { providers: providersUsed, fetchedAt, count: articles.length, sourceFailureCount: failureCount } },
      { 'Cache-Control': CACHE_CONTROL },
    )
  }
}

export default createNewsHandler()
