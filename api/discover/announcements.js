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
// OPAQUE PLAN ID + SERVER CACHE + ACTUAL PERSISTENCE GUARANTEES (Part 12 + Blocker 2)
// -----------------------------------------------------------------------------
// Normal Discover mounts must NOT trigger up to 20 GNews calls, and the URL must
// NOT leak the tracked library. The GET path carries only an OPAQUE plan id (a
// SHA-256 digest — no titles, constant length); the server rebuilds the query set
// from the normalized plan it stored under that id. Layers:
//
//   0. PLAN REGISTRY (durable, Blocker 2) — announcementPlanStore.js maps the
//      opaque id -> { terms }. A POST registers the plan; a GET looks it up. Its
//      durable backend is a Redis-compatible REST KV (Vercel KV / Upstash) when
//      configured, with a bounded in-process fallback otherwise. A missing/expired
//      id yields an explicit, recoverable PLAN_NOT_REGISTERED (the client re-POSTs)
//      — never a guessed query, never a client-supplied self-describing payload.
//
//   1. RESULT DURABLE layer — the Vercel edge CDN. The GET response carries
//      `Cache-Control: s-maxage=..., stale-while-revalidate, stale-if-error`, so
//      the CDN serves repeat requests within the TTL WITHOUT invoking the function
//      — genuinely zero upstream GNews calls, shared across clients/POPs, and
//      persistent across cold starts. A POST `Cache-Control` alone is not
//      cacheable, which is why the durable read path is a GET by opaque id.
//
//   2. Best-effort in-process result cache — a small bounded Map, injected so it
//      is testable, that dedupes upstream calls WITHIN a warm invocation and lets
//      a full-upstream-failure serve the last usable candidates (stale-if-error).
//      NOT relied on for durability across invocations. Corruption -> treated as a
//      miss, never a crash.
//
// The GNews key stays server-side. Absent key -> empty candidate set with
// configured:false, NEVER a generic feed. `refresh=1` (GET) / `forceRefresh`
// (POST) is the only way to bypass the result cache — normal mounts never do.

import { normalizeArticle } from '../../src/lib/news/normalizeArticle.js'
import { dedupeArticles } from '../../src/lib/news/dedupeArticles.js'
import {
  buildAnnouncementQueries, buildQueriesFromTerms, computePlanId, normalizedPlan,
  planTerms, isValidPlanId, QUERY_CONCURRENCY, GNEWS_MAX_PER_QUERY,
} from '../../src/lib/discover/announcementPlan.js'
import { createPlanStore } from '../../src/lib/discover/announcementPlanStore.js'

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

// Execute a query set through the result cache. Returns { status, body, headers }.
async function executeSearch({
  cacheKey, queries, coverageMeta, apiKey, fetchImpl, cache, now, forceRefresh, cacheControl,
}) {
  const cacheEntry = cache.read(cacheKey)
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
  cache.write(cacheKey, value, now)

  return {
    status: 200,
    body: { articles: deduped, meta: { ...value.meta, ...coverageMeta, cache: 'miss' } },
    headers: { 'Cache-Control': cacheControl },
  }
}

export function createAnnouncementsHandler({
  env = process.env, fetchImpl = globalThis.fetch, cache = defaultCache, planStore,
} = {}) {
  const store = planStore ?? createPlanStore({ env, fetchImpl })
  return async function announcementsHandler(req, res) {
    const apiKey = env.GNEWS_API_KEY
    const fetchedAt = new Date().toISOString()

    // ---- GET: opaque id -> stored plan -> CDN-cacheable execution ------------
    if (req.method === 'GET') {
      const planId = req.query?.plan
      if (typeof planId !== 'string' || !planId) {
        json(res, 400, errorBody('MISSING_PLAN', 'GET requires a ?plan=<id> parameter'))
        return
      }
      // Validate the SHAPE before any lookup: garbage is a cheap 400, never a
      // query. We never accept a client-supplied self-describing payload here.
      if (!isValidPlanId(planId)) {
        json(res, 400, errorBody('INVALID_PLAN', 'plan id is malformed'))
        return
      }
      // Resolve the opaque id to its stored terms. A missing / expired / forged id
      // is a recoverable PLAN_NOT_REGISTERED — the client re-registers via POST.
      // Crucially, NO upstream search runs for an unknown id.
      const stored = await store.get(planId).catch(() => null)
      if (!stored) {
        json(res, 409, errorBody('PLAN_NOT_REGISTERED', 'Unknown or expired plan id — POST the plan to register it'), { 'Cache-Control': 'no-store' })
        return
      }
      const queries = buildQueriesFromTerms(planTerms(stored))
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
        cacheKey: planId, queries, coverageMeta, apiKey, fetchImpl, cache, now: Date.now(),
        forceRefresh: req.query?.refresh === '1', cacheControl: GET_CACHE_CONTROL,
      })
      json(res, result.status, result.body, result.headers)
      return
    }

    // ---- POST: plan from shows, register the id, execute ---------------------
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
    const normalized = normalizedPlan({ canonicalScheduled, aliasesScheduled })
    const planId = await computePlanId(normalized)
    // Register the opaque id -> normalized plan so subsequent GETs by this id
    // resolve to the same terms (durable when a KV backend is configured).
    await store.set(planId, normalized).catch(() => {})
    const coverageMeta = { fetchedAt, queryCount: queries.length, planId, ...plan }

    if (!apiKey) {
      json(res, 200, { articles: [], meta: { configured: false, ...coverageMeta, count: 0 } }, { 'Cache-Control': 'no-store' })
      return
    }
    if (!queries.length) {
      json(res, 200, { articles: [], meta: { configured: true, ...coverageMeta, count: 0 } }, { 'Cache-Control': 'no-store' })
      return
    }

    const result = await executeSearch({
      cacheKey: planId, queries, coverageMeta, apiKey, fetchImpl, cache, now: Date.now(),
      forceRefresh: parsed.forceRefresh === true, cacheControl: 'no-store', // POST is not CDN-cacheable
    })
    json(res, result.status, result.body, result.headers)
  }
}

export default createAnnouncementsHandler()
