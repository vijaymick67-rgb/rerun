// Announcements candidate pipeline (Scope B/C acquisition + Scope M efficiency +
// Part 12 server cache).
//
// This endpoint is the real acquisition layer: it takes the caller's tracked show
// identities and runs BOUNDED, BATCHED, event-scoped searches so an announcement
// for any tracked show — not just whatever a top-ten feed happens to contain — can
// be discovered. The query PLAN (guaranteed canonical coverage, cache token) lives
// in src/lib/discover/announcementPlan.js and is shared with the client.
//
// -----------------------------------------------------------------------------
// SERVER CACHE + ACTUAL PERSISTENCE GUARANTEE (Part 12)
// -----------------------------------------------------------------------------
// Normal Discover mounts must NOT trigger up to 20 GNews calls. Two layers:
//
//   1. DURABLE layer — the Vercel edge CDN. The client calls this endpoint as a
//      GET with a stable ?plan=<token> (the token is derived from the sorted
//      scheduled terms, so identical libraries produce an identical URL). The GET
//      response carries `Cache-Control: s-maxage=... , stale-while-revalidate,
//      stale-if-error`, so the CDN serves repeat requests within the TTL WITHOUT
//      invoking the function at all — genuinely zero upstream GNews calls, shared
//      across all clients/POPs, and persistent across serverless cold starts.
//      This is the real persistence guarantee. A POST `Cache-Control` header alone
//      would NOT be cacheable, which is exactly why the durable path is a GET.
//
//   2. Best-effort in-process layer — a small bounded Map, injected so it is
//      testable, that dedupes upstream calls WITHIN a warm invocation and lets a
//      full-upstream-failure serve the last usable candidates (stale-if-error).
//      It is explicitly NOT relied on for durability across invocations; the CDN
//      is. Corruption in this layer is treated as a miss, never a crash.
//
// The GNews key stays server-side. Absent key -> empty candidate set with
// configured:false, NEVER a generic feed. `refresh=1` (GET) / `forceRefresh`
// (POST) is the only way to bypass the cache — normal mounts never do.

import { normalizeArticle } from '../../src/lib/news/normalizeArticle.js'
import { dedupeArticles } from '../../src/lib/news/dedupeArticles.js'
import {
  buildAnnouncementQueries, buildQueriesFromTerms, buildPlanToken, decodePlanToken,
  QUERY_CONCURRENCY, GNEWS_MAX_PER_QUERY,
} from '../../src/lib/discover/announcementPlan.js'

// Re-exported so existing tests importing from this module keep working.
export { buildAnnouncementQueries, MAX_QUERIES, TERM_BUDGET } from '../../src/lib/discover/announcementPlan.js'

const GNEWS_SEARCH_ENDPOINT = 'https://gnews.io/api/v4/search'
const QUERY_TIMEOUT_MS = 8000
export const ACQUISITION_CACHE_TTL_MS = 30 * 60 * 1000 // 30m
export const ACQUISITION_CACHE_MAX_ENTRIES = 64
// Durable CDN caching for the GET plan path — this is the real persistence layer.
const GET_CACHE_CONTROL = 'public, s-maxage=1800, stale-while-revalidate=10800, stale-if-error=86400'

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

// Bounded in-process cache. NON-DURABLE by design (see header) — a best-effort
// warm-invocation dedup + stale-if-error store only. Corruption-safe reads.
export function createAcquisitionCache({ max = ACQUISITION_CACHE_MAX_ENTRIES } = {}) {
  const map = new Map()
  return {
    read(key) {
      try {
        const entry = map.get(key)
        if (!entry || typeof entry !== 'object' || !Number.isFinite(entry.storedAt) || !entry.value) return null
        return entry
      } catch {
        return null
      }
    },
    write(key, value, storedAt) {
      try {
        if (map.size >= max && !map.has(key)) map.delete(map.keys().next().value)
        map.set(key, { value, storedAt })
      } catch {
        // best effort
      }
    },
  }
}

// Module-level default cache. Best-effort only; the CDN is the durable layer.
const defaultCache = createAcquisitionCache()

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

// Execute a query set through the cache. Returns { status, body, headers }.
async function executeSearch({
  token, queries, coverageMeta, apiKey, fetchImpl, cache, now, forceRefresh, cacheControl,
}) {
  const cacheEntry = cache.read(token)
  const fresh = cacheEntry && (now - cacheEntry.storedAt <= ACQUISITION_CACHE_TTL_MS)

  // Cache HIT within TTL -> zero upstream GNews calls.
  if (fresh && !forceRefresh) {
    return {
      status: 200,
      body: { articles: cacheEntry.value.articles, meta: { ...cacheEntry.value.meta, ...coverageMeta, cache: 'hit' } },
      headers: { 'Cache-Control': cacheControl },
    }
  }

  const perQuery = await mapWithConcurrency(
    queries,
    (query) => runGnewsQuery(query, { apiKey, fetchImpl }),
    QUERY_CONCURRENCY,
  )
  const failureCount = perQuery.filter((r) => r === null).length

  // Every query failed. Serve the last usable candidates if we have them
  // (stale-if-error); only surface an error when there is nothing cached.
  if (failureCount === queries.length) {
    if (cacheEntry) {
      return {
        status: 200,
        body: { articles: cacheEntry.value.articles, meta: { ...cacheEntry.value.meta, ...coverageMeta, cache: 'stale', failureCount } },
        headers: { 'Cache-Control': 'no-store' },
      }
    }
    return {
      status: 502,
      body: errorBody('ANNOUNCEMENTS_UPSTREAM_ERROR', 'Announcement search is temporarily unavailable'),
      headers: { 'Cache-Control': 'no-store' },
    }
  }

  const fetchedAt = coverageMeta.fetchedAt
  const normalized = []
  for (const articles of perQuery) {
    if (!Array.isArray(articles)) continue
    for (const raw of articles) {
      const article = normalizeArticle(raw, { fetchedAt, provider: 'gnews' })
      if (article) normalized.push(article)
    }
  }
  const deduped = dedupeArticles(normalized)
  const value = { articles: deduped, meta: { configured: true, failureCount, count: deduped.length } }
  // Cache the usable candidates even on a PARTIAL failure so a later request within
  // TTL is a hit and a subsequent total failure can still serve them.
  cache.write(token, value, now)

  return {
    status: 200,
    body: { articles: deduped, meta: { ...value.meta, ...coverageMeta, cache: 'miss' } },
    headers: { 'Cache-Control': cacheControl },
  }
}

export function createAnnouncementsHandler({ env = process.env, fetchImpl = globalThis.fetch, cache = defaultCache } = {}) {
  return async function announcementsHandler(req, res) {
    const apiKey = env.GNEWS_API_KEY
    const fetchedAt = new Date().toISOString()

    // ---- GET: durable, CDN-cacheable plan execution --------------------------
    if (req.method === 'GET') {
      const token = req.query?.plan
      if (typeof token !== 'string' || !token) {
        json(res, 400, errorBody('MISSING_PLAN', 'GET requires a ?plan=<token> parameter'))
        return
      }
      const decoded = decodePlanToken(token)
      if (!decoded) {
        json(res, 400, errorBody('INVALID_PLAN', 'plan token is malformed'))
        return
      }
      const queries = buildQueriesFromTerms(decoded.terms)
      const coverageMeta = { fetchedAt, queryCount: queries.length }
      if (!apiKey) {
        json(res, 200, { articles: [], meta: { configured: false, ...coverageMeta, count: 0 } }, { 'Cache-Control': 'no-store' })
        return
      }
      if (!queries.length) {
        json(res, 200, { articles: [], meta: { configured: true, ...coverageMeta, count: 0 } }, { 'Cache-Control': 'no-store' })
        return
      }
      const result = await executeSearch({
        token, queries, coverageMeta, apiKey, fetchImpl, cache, now: Date.now(),
        forceRefresh: req.query?.refresh === '1', cacheControl: GET_CACHE_CONTROL,
      })
      json(res, result.status, result.body, result.headers)
      return
    }

    // ---- POST: plan from shows + execute (also returns the token) ------------
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      json(res, 405, errorBody('METHOD_NOT_ALLOWED', 'Only GET and POST are supported'))
      return
    }

    const parsed = parseBody(req)
    const { shows } = parsed
    if (!Array.isArray(shows)) {
      json(res, 400, errorBody('INVALID_SHOWS', 'Body must include a "shows" array'))
      return
    }

    const { queries, plan, canonicalScheduled, aliasesScheduled } = buildAnnouncementQueries(shows)
    const token = buildPlanToken({ canonicalScheduled, aliasesScheduled })
    const coverageMeta = { fetchedAt, queryCount: queries.length, planToken: token, ...plan }

    if (!apiKey) {
      json(res, 200, { articles: [], meta: { configured: false, ...coverageMeta, count: 0 } }, { 'Cache-Control': 'no-store' })
      return
    }
    if (!queries.length) {
      json(res, 200, { articles: [], meta: { configured: true, ...coverageMeta, count: 0 } }, { 'Cache-Control': 'no-store' })
      return
    }

    const result = await executeSearch({
      token, queries, coverageMeta, apiKey, fetchImpl, cache, now: Date.now(),
      forceRefresh: parsed.forceRefresh === true, cacheControl: 'no-store', // POST is not CDN-cacheable
    })
    json(res, result.status, result.body, result.headers)
  }
}

export default createAnnouncementsHandler()
