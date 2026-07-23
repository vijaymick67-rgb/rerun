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
//   * GUARANTEED canonical coverage: every tracked show's canonical title is
//     scheduled into the query budget BEFORE any alias (see
//     buildAnnouncementQueries), so a large library's later shows are never
//     silently dropped in favour of an earlier show's alias. If the library
//     genuinely exceeds the budget the response reports partialCoverage +
//     showsOmitted instead of pretending full success. Every response's meta
//     reports shows received, canonical titles searched, aliases searched,
//     aliases omitted and shows omitted.
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

export const MAX_ALIASES_PER_SHOW = 2 // verified alternative titles per show
export const MAX_TERMS_PER_QUERY = 8 // OR-batched title terms per query
export const MAX_QUERIES = 20 // hard request cap (bounds total upstream calls)
export const QUERY_CONCURRENCY = 4
export const GNEWS_MAX_PER_QUERY = 10
// Total term capacity across ALL queries. Canonical titles are scheduled into
// this budget FIRST (before any alias), so complete canonical coverage is
// guaranteed for up to TERM_BUDGET tracked shows; aliases consume only the
// remainder. Beyond the budget the planner reports partial coverage rather than
// silently dropping shows.
//
// Quota tradeoff: each query is one GNews request, so total upstream requests
// are capped at MAX_QUERIES (20) regardless of library size, run at
// QUERY_CONCURRENCY (4) at a time. Raising canonical capacity means raising
// MAX_QUERIES (more requests per refresh). 160 canonical titles per refresh
// comfortably covers a personal tracked library while staying well within a
// free-tier daily request budget at the endpoint's 30-minute cache TTL.
export const TERM_BUDGET = MAX_QUERIES * MAX_TERMS_PER_QUERY // 160
export const MAX_SHOWS = TERM_BUDGET // canonical coverage guaranteed up to here
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

// Plan the bounded, batched query set with GUARANTEED canonical coverage.
//
// Two-phase term scheduling ensures no tracked show is silently omitted in
// favour of another show's alias:
//   Phase 1 — collect EVERY canonical tracked-show title (case-insensitively
//     de-duplicated), in received order, BEFORE touching any alias.
//   Phase 2 — collect capped verified aliases, in received order, only AFTER all
//     canonicals exist.
//   Phase 3 — schedule into the shared term budget: canonicals fill it first, so
//     they can never be displaced by aliases; aliases take only what remains.
// Scheduled terms are packed MAX_TERMS_PER_QUERY per query and each query ANDs
// the shared event clause. If canonical titles genuinely exceed the budget the
// plan reports partialCoverage + showsOmitted rather than pretending success.
//
// Returns { queries, plan } where plan reports exactly what was covered:
//   showsReceived, canonicalTitlesSearched, aliasesSearched, aliasesOmitted,
//   showsOmitted, partialCoverage.
export function buildAnnouncementQueries(shows) {
  const rawList = Array.isArray(shows) ? shows : []
  const seen = new Set()

  // Phase 1 — every canonical title first (deduped), independent of aliases.
  const canonical = []
  let showsReceived = 0
  for (const show of rawList) {
    const title = typeof show?.title === 'string' ? show.title.trim() : ''
    if (!title) continue
    showsReceived += 1
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    canonical.push(title)
  }

  // Phase 2 — capped verified aliases, after ALL canonicals are collected so a
  // canonical title is never displaced by an earlier show's alias.
  const aliasTerms = []
  for (const show of rawList) {
    const title = typeof show?.title === 'string' ? show.title.trim() : ''
    if (!title) continue
    const aliases = Array.isArray(show?.aliases) ? show.aliases : []
    let used = 0
    for (const rawAlias of aliases) {
      if (used >= MAX_ALIASES_PER_SHOW) break
      const alias = typeof rawAlias === 'string' ? rawAlias.trim() : ''
      if (!alias) continue
      const key = alias.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      aliasTerms.push(alias)
      used += 1
    }
  }

  // Phase 3 — schedule into the shared budget: canonicals first, aliases fill the
  // remainder. Canonicals beyond the budget are omitted (partial coverage), never
  // silently swapped for an alias.
  const canonicalScheduled = canonical.slice(0, TERM_BUDGET)
  const showsOmitted = canonical.length - canonicalScheduled.length
  const remaining = Math.max(0, TERM_BUDGET - canonicalScheduled.length)
  const aliasesScheduled = aliasTerms.slice(0, remaining)
  const aliasesOmitted = aliasTerms.length - aliasesScheduled.length
  const terms = [...canonicalScheduled, ...aliasesScheduled]

  const queries = []
  for (let i = 0; i < terms.length; i += MAX_TERMS_PER_QUERY) {
    const slice = terms.slice(i, i + MAX_TERMS_PER_QUERY)
    const titleClause = `(${slice.map(quotePhrase).join(' OR ')})`
    queries.push(`${titleClause} AND ${EVENT_CLAUSE}`)
  }

  const plan = {
    showsReceived,
    canonicalTitlesSearched: canonicalScheduled.length,
    aliasesSearched: aliasesScheduled.length,
    aliasesOmitted,
    showsOmitted,
    partialCoverage: showsOmitted > 0,
  }
  return { queries, plan }
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
    const { queries, plan } = buildAnnouncementQueries(shows)
    // Coverage is reported honestly on every response so the client can tell
    // complete canonical coverage from a partial (budget-limited) run.
    const coverageMeta = { fetchedAt, queryCount: queries.length, ...plan }

    // No provider key: return an EMPTY candidate set — never a generic feed.
    if (!apiKey) {
      json(res, 200, {
        articles: [],
        meta: { configured: false, ...coverageMeta, count: 0 },
      }, { 'Cache-Control': 'no-store' })
      return
    }

    if (!queries.length) {
      json(res, 200, { articles: [], meta: { configured: true, ...coverageMeta, count: 0 } }, { 'Cache-Control': 'no-store' })
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
        ...coverageMeta,
        failureCount,
        count: deduped.length,
      },
    }, { 'Cache-Control': CACHE_CONTROL })
  }
}

export default createAnnouncementsHandler()
