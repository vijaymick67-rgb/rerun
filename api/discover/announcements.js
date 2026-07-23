// Announcements candidate pipeline (Scope B/C acquisition + Scope M efficiency).
//
// The generic /api/news feed is a single small sample of "TV news" and cannot
// cover every tracked show — it starves the precision classifier of candidates.
// This endpoint is the real acquisition layer: it takes the caller's tracked
// show identities and runs BOUNDED, BATCHED, event-scoped searches so an
// announcement for any tracked show — not just whatever happens to be in a
// top-ten feed — can be discovered.
//
// Design (precision-first, key-safe, request-bounded):
//   * Membership terms come from the client's identity registry: each show's
//     canonical title plus a capped number of VERIFIED alternative titles. We
//     never invent aliases here.
//   * Queries are scoped to ONLY the four allowed event categories (renewal,
//     season date, cancellation, cast addition) via a shared event clause, so we
//     pull renewal/cancellation/date/casting candidates rather than arbitrary
//     coverage.
//   * Show terms are OR-batched (several shows per query) and the number of
//     queries is hard-capped (MAX_QUERIES) — never one uncontrolled request per
//     show. Queries run under a small concurrency limit.
//   * One failed query never fails the others (per-query isolation).
//   * Raw candidates are normalized and de-duplicated across queries before the
//     response, preserving source name, URL and timestamp for client-side
//     deterministic classification.
//   * The GNews API key stays server-side (same protection as api/news). Absent
//     key -> an empty candidate set with configured:false, NEVER a generic feed.

import { normalizeArticle } from '../../src/lib/news/normalizeArticle.js'
import { dedupeArticles } from '../../src/lib/news/dedupeArticles.js'

const GNEWS_SEARCH_ENDPOINT = 'https://gnews.io/api/v4/search'

export const MAX_SHOWS = 120 // hard ceiling on shows considered per request
export const MAX_ALIASES_PER_SHOW = 2 // verified alternative titles per show
export const MAX_TERMS_PER_QUERY = 8 // OR-batched title terms per query
export const MAX_QUERIES = 20 // hard request cap (bounds total upstream calls)
export const QUERY_CONCURRENCY = 4
export const GNEWS_MAX_PER_QUERY = 10
const QUERY_TIMEOUT_MS = 8000
const CACHE_CONTROL = 'public, s-maxage=1800, stale-while-revalidate=10800'

// Scope to the four allowed event categories only. Kept concise (query length is
// bounded by GNews). The client classifier does the precise work; this just
// biases recall toward announcement-shaped stories.
const EVENT_CLAUSE = '(renewed OR renewal OR canceled OR cancelled OR "final season" OR premiere OR premieres OR "release date" OR "joins the cast" OR "cast")'

function json(res, status, body, headers = {}) {
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  res.json(body)
}

function errorBody(code, message) {
  return { error: { code, message } }
}

function parseBody(req) {
  const body = req?.body
  if (!body) return {}
  if (typeof body === 'string') {
    try { return JSON.parse(body) } catch { return {} }
  }
  return typeof body === 'object' ? body : {}
}

function quotePhrase(term) {
  // Strip embedded quotes so a term cannot break out of its phrase.
  return `"${String(term).replace(/["\\]+/g, ' ').trim()}"`
}

// Turn one show identity into a small OR-group of quoted terms (canonical +
// capped verified aliases), de-duplicated and non-empty.
function showTerms(show) {
  const title = typeof show?.title === 'string' ? show.title.trim() : ''
  if (!title) return []
  const aliases = Array.isArray(show?.aliases) ? show.aliases : []
  const terms = [title, ...aliases]
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean)
  const seen = new Set()
  const unique = []
  for (const term of terms) {
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(term)
    if (unique.length >= 1 + MAX_ALIASES_PER_SHOW) break
  }
  return unique
}

// Build the bounded set of batched query strings. Each query OR-joins several
// shows' term-groups, then ANDs the shared event clause. Bounded by both terms
// per query and total query count.
export function buildAnnouncementQueries(shows) {
  const groups = []
  for (const show of Array.isArray(shows) ? shows.slice(0, MAX_SHOWS) : []) {
    const terms = showTerms(show)
    if (terms.length) groups.push(terms)
  }

  const queries = []
  let batchTerms = []
  const flush = () => {
    if (!batchTerms.length) return
    const titleClause = `(${batchTerms.map(quotePhrase).join(' OR ')})`
    queries.push(`${titleClause} AND ${EVENT_CLAUSE}`)
    batchTerms = []
  }
  for (const group of groups) {
    // Keep a show's own terms together in one query when possible.
    if (batchTerms.length && batchTerms.length + group.length > MAX_TERMS_PER_QUERY) flush()
    batchTerms.push(...group)
    if (batchTerms.length >= MAX_TERMS_PER_QUERY) flush()
    if (queries.length >= MAX_QUERIES) break
  }
  flush()
  return queries.slice(0, MAX_QUERIES)
}

async function runGnewsQuery(query, { apiKey, fetchImpl, timeoutMs = QUERY_TIMEOUT_MS }) {
  const url = new URL(GNEWS_SEARCH_ENDPOINT)
  url.searchParams.set('q', query)
  url.searchParams.set('lang', 'en')
  url.searchParams.set('sortby', 'publishedAt')
  url.searchParams.set('in', 'title,description')
  url.searchParams.set('max', String(GNEWS_MAX_PER_QUERY))
  url.searchParams.set('apikey', apiKey)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal })
    if (!response?.ok) return null
    const payload = await response.json()
    return Array.isArray(payload?.articles) ? payload.articles : []
  } catch {
    return null // per-query isolation: a failed query yields nothing, never throws
  } finally {
    clearTimeout(timer)
  }
}

// Bounded-concurrency runner (local so the endpoint has no client-lib import).
async function mapWithConcurrency(items, mapper, concurrency) {
  const list = Array.isArray(items) ? items : []
  const results = new Array(list.length).fill(null)
  let cursor = 0
  const limit = Math.max(1, concurrency)
  async function worker() {
    while (cursor < list.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker))
  return results
}

export function createAnnouncementsHandler({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async function announcementsHandler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      json(res, 405, errorBody('METHOD_NOT_ALLOWED', 'Only POST is supported'))
      return
    }

    const { shows } = parseBody(req)
    if (!Array.isArray(shows)) {
      json(res, 400, errorBody('INVALID_SHOWS', 'Body must include a "shows" array'))
      return
    }

    const apiKey = env.GNEWS_API_KEY
    const fetchedAt = new Date().toISOString()
    const queries = buildAnnouncementQueries(shows)

    // No provider key: return an EMPTY candidate set — never a generic feed.
    if (!apiKey) {
      json(res, 200, {
        articles: [],
        meta: { configured: false, fetchedAt, queryCount: queries.length, count: 0 },
      }, { 'Cache-Control': 'no-store' })
      return
    }

    if (!queries.length) {
      json(res, 200, { articles: [], meta: { configured: true, fetchedAt, queryCount: 0, count: 0 } }, { 'Cache-Control': 'no-store' })
      return
    }

    const perQuery = await mapWithConcurrency(
      queries,
      (query) => runGnewsQuery(query, { apiKey, fetchImpl }),
      QUERY_CONCURRENCY,
    )

    const failureCount = perQuery.filter((r) => r === null).length
    // Every query failed -> surface an error so the client keeps its cache.
    if (failureCount === queries.length) {
      json(res, 502, errorBody('ANNOUNCEMENTS_UPSTREAM_ERROR', 'Announcement search is temporarily unavailable'), { 'Cache-Control': 'no-store' })
      return
    }

    const normalized = []
    for (const articles of perQuery) {
      if (!Array.isArray(articles)) continue
      for (const raw of articles) {
        const article = normalizeArticle(raw, { fetchedAt, provider: 'gnews' })
        if (article) normalized.push(article)
      }
    }
    const deduped = dedupeArticles(normalized)

    json(res, 200, {
      articles: deduped,
      meta: {
        configured: true,
        fetchedAt,
        queryCount: queries.length,
        failureCount,
        count: deduped.length,
      },
    }, { 'Cache-Control': CACHE_CONTROL })
  }
}

export default createAnnouncementsHandler()
