import { describe, it, expect, vi } from 'vitest'
import handler, {
  createAnnouncementsHandler, buildAnnouncementQueries, MAX_QUERIES, TERM_BUDGET,
  createAcquisitionCache, ACQUISITION_CACHE_TTL_MS, GNEWS_MAX_QUERY_LENGTH,
} from './announcements.js'
import { planFromShows } from '../../src/lib/discover/announcementPlan.js'
import { createPlanStore } from '../../src/lib/discover/announcementPlanStore.js'

function makeRes() {
  const headers = new Map()
  return {
    headers, statusCode: null, body: null,
    status(code) { this.statusCode = code; return this },
    setHeader(name, value) { headers.set(name, value); return this },
    json(body) { this.body = body; return this },
  }
}

function gnews(articles) {
  return { ok: true, json: async () => ({ totalArticles: articles.length, articles }) }
}

function rawArticle(overrides = {}) {
  return {
    title: 'A tracked show renewed for Season 2',
    description: 'The network confirmed it.',
    url: 'https://deadline.com/tracked-a',
    image: 'https://deadline.com/img.jpg',
    publishedAt: '2026-07-20T00:00:00.000Z',
    source: { name: 'Deadline', url: 'https://deadline.com' },
    ...overrides,
  }
}

// Register a plan in the store the way a POST would, returning its opaque id so a
// GET can resolve it. Mirrors the server's own POST registration.
async function register(store, list) {
  const { planId, normalized } = await planFromShows(list)
  await store.set(planId, normalized)
  return planId
}

describe('buildAnnouncementQueries', () => {
  it('scopes every query to the four allowed event categories', () => {
    const { queries } = buildAnnouncementQueries([{ id: 1, title: 'From' }])
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('"From"')
    expect(queries[0]).toMatch(/renewed|canceled|premiere|cast/)
  })

  it('batches shows and never exceeds the query cap', () => {
    const shows = Array.from({ length: 400 }, (_, i) => ({ id: i, title: `Show Number ${i}` }))
    const { queries } = buildAnnouncementQueries(shows)
    expect(queries.length).toBeLessThanOrEqual(MAX_QUERIES)
    expect(queries[0].match(/ OR /g)?.length ?? 0).toBeGreaterThan(0)
  })

  it('includes a capped number of verified aliases', () => {
    const { queries } = buildAnnouncementQueries([
      { id: 1, title: 'Shogun', aliases: ['James Clavell\'s Shogun', 'Shougun', 'ThirdAlias', 'FourthAlias'] },
    ])
    const titleClause = queries[0].split(' AND ')[0]
    expect(titleClause.match(/"/g)?.length).toBe(6) // 3 phrases => 6 quote chars
  })

  it('schedules every canonical title before any alias so none is displaced', () => {
    const { queries, plan } = buildAnnouncementQueries([
      { id: 1, title: 'Alpha', aliases: ['Alpha Alt One', 'Alpha Alt Two'] },
      { id: 2, title: 'Bravo', aliases: ['Bravo Alt One', 'Bravo Alt Two'] },
    ])
    const flat = queries.join(' ')
    expect(flat.indexOf('"Alpha"')).toBeLessThan(flat.indexOf('"Alpha Alt One"'))
    expect(flat.indexOf('"Bravo"')).toBeLessThan(flat.indexOf('"Alpha Alt One"'))
    expect(plan.canonicalTitlesSearched).toBe(2)
    expect(plan.aliasesSearched).toBe(4)
    expect(plan.partialCoverage).toBe(false)
  })

  it('schedules canonicals before aliases and reports length-limited large-library coverage', () => {
    const shows = Array.from({ length: 120 }, (_, i) => ({
      id: i, title: `Canonical Series ${i}`,
      aliases: [`Series ${i} Alt A`, `Series ${i} Alt B`],
    }))
    const { queries, plan } = buildAnnouncementQueries(shows)
    const all = queries.join(' ')
    expect(all.match(/"Canonical Series \d+"/g)).toHaveLength(plan.canonicalTitlesSearched)
    expect(all).not.toContain('Alt A')
    expect(all).not.toContain('Alt B')
    expect(queries.every((query) => query.length <= GNEWS_MAX_QUERY_LENGTH)).toBe(true)
    expect(plan.showsReceived).toBe(120)
    expect(plan.canonicalTitlesSearched).toBeGreaterThan(0)
    expect(plan.canonicalTitlesSearched).toBeLessThan(120)
    expect(plan.showsOmitted).toBe(120 - plan.canonicalTitlesSearched)
    expect(plan.partialCoverage).toBe(true)
    expect(plan.aliasesSearched).toBe(0)
    expect(plan.aliasesOmitted).toBe(240)
    expect(queries.length).toBeLessThanOrEqual(MAX_QUERIES)
  })

  it('reports an explicit partial-coverage state when canonicals exceed the budget', () => {
    const shows = Array.from({ length: TERM_BUDGET + 25 }, (_, i) => ({ id: i, title: `Overflow Show ${i}` }))
    const { plan } = buildAnnouncementQueries(shows)
    expect(plan.canonicalTitlesSearched).toBeLessThanOrEqual(TERM_BUDGET)
    expect(plan.showsOmitted).toBe(shows.length - plan.canonicalTitlesSearched)
    expect(plan.partialCoverage).toBe(true)
  })
})

describe('announcements endpoint', () => {
  it('rejects an unsupported method (only GET and POST allowed)', async () => {
    const res = makeRes()
    await handler({ method: 'DELETE', query: {} }, res)
    expect(res.statusCode).toBe(405)
  })

  it('rejects a GET with no plan id', async () => {
    const res = makeRes()
    await handler({ method: 'GET', query: {} }, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error.code).toBe('MISSING_PLAN')
  })

  it('rejects a GET with a malformed (non-hash) plan id', async () => {
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' } })({ method: 'GET', query: { plan: 'not-a-token' } }, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error.code).toBe('INVALID_PLAN')
  })

  it('rejects a body without a shows array', async () => {
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' } })({ method: 'POST', body: {} }, res)
    expect(res.statusCode).toBe(400)
  })

  it('returns an empty candidate set (never a generic feed) when no key is configured', async () => {
    const res = makeRes()
    const fetchImpl = vi.fn()
    const logger = { warn: vi.fn() }
    await createAnnouncementsHandler({ env: {}, fetchImpl, logger })({ method: 'POST', body: { shows: [{ id: 1, title: 'From' }] } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.articles).toEqual([])
    expect(res.body.meta.configured).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      '[discover-announcements]',
      { stage: 'configuration', code: 'GNEWS_API_KEY_MISSING' },
    )
  })

  it('discovers an announcement for a tracked show that a generic top-ten feed would miss', async () => {
    const nicheArticle = rawArticle({
      title: 'Interior Chinatown renewed for Season 2 at Hulu',
      url: 'https://variety.com/interior-chinatown',
      source: { name: 'Variety', url: 'https://variety.com' },
    })
    const fetchImpl = async (url) => {
      const q = new URL(url).searchParams.get('q') ?? ''
      return gnews(q.includes('Interior Chinatown') ? [nicheArticle] : [])
    }
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl })(
      { method: 'POST', body: { shows: [{ id: 55, title: 'Interior Chinatown' }] } }, res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.articles.map((a) => a.title)).toContain('Interior Chinatown renewed for Season 2 at Hulu')
  })

  it('bounds the number of upstream requests for a large tracked set', async () => {
    const shows = Array.from({ length: 300 }, (_, i) => ({ id: i, title: `Tracked Series ${i}` }))
    const fetchImpl = vi.fn(async () => gnews([]))
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl })({ method: 'POST', body: { shows } }, res)
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(MAX_QUERIES)
  })

  it('reports honest length-limited coverage metadata for a 110-show library', async () => {
    const shows = Array.from({ length: 110 }, (_, i) => ({
      id: i, title: `Library Show ${i}`, aliases: [`Show ${i} AKA A`, `Show ${i} AKA B`],
    }))
    const fetchImpl = async () => gnews([])
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl })({ method: 'POST', body: { shows } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.meta.showsReceived).toBe(110)
    expect(res.body.meta.canonicalTitlesSearched).toBeGreaterThan(0)
    expect(res.body.meta.canonicalTitlesSearched).toBeLessThan(110)
    expect(res.body.meta.showsOmitted)
      .toBe(110 - res.body.meta.canonicalTitlesSearched)
    expect(res.body.meta.partialCoverage).toBe(true)
    expect(res.body.meta.aliasesSearched).toBe(0)
    expect(res.body.meta.aliasesOmitted).toBe(220)
  })

  it('signals partial coverage in metadata when the library exceeds the budget', async () => {
    const shows = Array.from({ length: TERM_BUDGET + 40 }, (_, i) => ({ id: i, title: `Huge Library ${i}` }))
    const fetchImpl = async () => gnews([])
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl })({ method: 'POST', body: { shows } }, res)
    expect(res.body.meta.partialCoverage).toBe(true)
    expect(res.body.meta.showsOmitted)
      .toBe(shows.length - res.body.meta.canonicalTitlesSearched)
    expect(res.body.meta.canonicalTitlesSearched).toBeLessThanOrEqual(TERM_BUDGET)
  })

  it('deduplicates the same story returned by more than one query', async () => {
    const shared = rawArticle({ url: 'https://deadline.com/shared-story', title: 'Shared renewal story' })
    const fetchImpl = async () => gnews([shared])
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl })(
      { method: 'POST', body: { shows: [
        { id: 1, title: 'Alpha Show One' }, { id: 2, title: 'Beta Show Two' },
        { id: 3, title: 'Gamma Show Three' }, { id: 4, title: 'Delta Show Four' },
        { id: 5, title: 'Epsilon Show Five' }, { id: 6, title: 'Zeta Show Six' },
      ] } }, res,
    )
    expect(res.body.articles).toHaveLength(1)
  })

  it('isolates a single failed query without failing the others', async () => {
    let call = 0
    const good = rawArticle({ url: 'https://deadline.com/good', title: 'Survivor renewal' })
    const fetchImpl = async () => {
      call += 1
      if (call === 1) return { ok: false, json: async () => ({}) }
      return gnews([good])
    }
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl })(
      { method: 'POST', body: { shows: Array.from({ length: 20 }, (_, i) => ({ id: i, title: `Show Alpha Bravo ${i}` })) } }, res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.articles.map((a) => a.title)).toContain('Survivor renewal')
    expect(res.body.meta.failureCount).toBeGreaterThanOrEqual(1)
  })

  it('surfaces a 502 only when every query fails with no cache (so the client keeps its cache)', async () => {
    const fetchImpl = async () => { throw new Error('network down') }
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl, cache: createAcquisitionCache() })(
      { method: 'POST', body: { shows: [{ id: 1, title: 'From' }] } }, res,
    )
    expect(res.statusCode).toBe(502)
  })

  it('logs bounded upstream status diagnostics without keys, titles, queries, or payloads', async () => {
    const logger = { warn: vi.fn() }
    const res = makeRes()
    await createAnnouncementsHandler({
      env: { GNEWS_API_KEY: 'server-secret-key' },
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: async () => ({ errors: ['raw upstream payload'] }),
      }),
      cache: createAcquisitionCache(),
      logger,
    })({
      method: 'POST',
      body: { shows: [{ id: 1, title: 'Private Tracked Show' }] },
    }, res)

    expect(res.statusCode).toBe(502)
    expect(logger.warn).toHaveBeenCalledWith(
      '[discover-announcements]',
      {
        stage: 'upstream_search',
        code: 'ALL_QUERIES_FAILED',
        queryCount: 1,
        failureCodes: { http_401: 1 },
      },
    )
    const diagnostic = JSON.stringify(logger.warn.mock.calls)
    expect(diagnostic).not.toContain('server-secret-key')
    expect(diagnostic).not.toContain('Private Tracked Show')
    expect(diagnostic).not.toContain('raw upstream payload')
    expect(diagnostic).not.toContain('renewed OR renewal')
  })
})

describe('announcements opaque plan id + server cache (Blocker 2 + Part 12)', () => {
  const shows = [{ id: 1, title: 'From' }, { id: 2, title: 'The Bear' }]
  const otherShows = [{ id: 9, title: 'Severance' }]

  it('a well-formed but UNREGISTERED (forged) id triggers no upstream search — recoverable 409', async () => {
    const fetchImpl = vi.fn(async () => gnews([]))
    const res = makeRes()
    await createAnnouncementsHandler({
      env: { GNEWS_API_KEY: 'k' }, fetchImpl, cache: createAcquisitionCache(), planStore: createPlanStore({ env: {} }),
    })({ method: 'GET', query: { plan: 'a'.repeat(64) } }, res)
    expect(res.statusCode).toBe(409)
    expect(res.body.error.code).toBe('PLAN_NOT_REGISTERED')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('1. first registered GET performs upstream searches', async () => {
    const store = createPlanStore({ env: {} })
    const cache = createAcquisitionCache()
    const fetchImpl = vi.fn(async () => gnews([]))
    const plan = await register(store, shows)
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl, cache, planStore: store })(
      { method: 'GET', query: { plan } }, res,
    )
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0)
    expect(res.body.meta.cache).toBe('miss')
  })

  it('2. second identical GET within TTL performs zero upstream searches', async () => {
    const store = createPlanStore({ env: {} })
    const cache = createAcquisitionCache()
    const fetchImpl = vi.fn(async () => gnews([rawArticle()]))
    const h = createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl, cache, planStore: store })
    const plan = await register(store, shows)
    const first = makeRes(); await h({ method: 'GET', query: { plan } }, first)
    const callsAfterFirst = fetchImpl.mock.calls.length
    const second = makeRes(); await h({ method: 'GET', query: { plan } }, second)
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst) // zero new upstream calls
    expect(second.body.meta.cache).toBe('hit')
    expect(second.body.articles.length).toBe(first.body.articles.length)
  })

  it('3. a changed tracked-show plan is a different id (upstream runs again)', async () => {
    const store = createPlanStore({ env: {} })
    const cache = createAcquisitionCache()
    const fetchImpl = vi.fn(async () => gnews([]))
    const h = createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl, cache, planStore: store })
    const planA = await register(store, shows)
    const planB = await register(store, otherShows)
    expect(planA).not.toBe(planB)
    await h({ method: 'GET', query: { plan: planA } }, makeRes())
    const callsAfterFirst = fetchImpl.mock.calls.length
    const other = makeRes(); await h({ method: 'GET', query: { plan: planB } }, other)
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterFirst)
    expect(other.body.meta.cache).toBe('miss')
  })

  it('4. an expired result-cache entry refreshes', async () => {
    let now = 1_000_000
    const store = createPlanStore({ env: {} })
    const cache = createAcquisitionCache()
    const fetchImpl = vi.fn(async () => gnews([]))
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const h = createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl, cache, planStore: store })
      const plan = await register(store, shows)
      await h({ method: 'GET', query: { plan } }, makeRes())
      const callsAfterFirst = fetchImpl.mock.calls.length
      now += ACQUISITION_CACHE_TTL_MS + 1
      const res = makeRes()
      await h({ method: 'GET', query: { plan } }, res)
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterFirst)
      expect(res.body.meta.cache).toBe('miss')
    } finally {
      spy.mockRestore()
    }
  })

  it('5. a partial upstream failure still preserves usable candidates', async () => {
    const store = createPlanStore({ env: {} })
    const cache = createAcquisitionCache()
    let call = 0
    const good = rawArticle({ url: 'https://deadline.com/good', title: 'Survivor renewal' })
    const fetchImpl = async () => { call += 1; return call === 1 ? { ok: false, json: async () => ({}) } : gnews([good]) }
    const many = Array.from({ length: 20 }, (_, i) => ({ id: i, title: `Show Alpha Bravo ${i}` }))
    const plan = await register(store, many)
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl, cache, planStore: store })(
      { method: 'GET', query: { plan } }, res,
    )
    expect(res.body.articles.map((a) => a.title)).toContain('Survivor renewal')
    const hit = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl: async () => { throw new Error('down') }, cache, planStore: store })(
      { method: 'GET', query: { plan } }, hit,
    )
    expect(hit.body.meta.cache).toBe('hit')
    expect(hit.body.articles.map((a) => a.title)).toContain('Survivor renewal')
  })

  it('6. a full upstream failure returns stale cache when available (stale-if-error)', async () => {
    let now = 5_000_000
    const store = createPlanStore({ env: {} })
    const cache = createAcquisitionCache()
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const good = rawArticle({ url: 'https://deadline.com/stale', title: 'Cached renewal' })
      const plan = await register(store, shows)
      await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl: async () => gnews([good]), cache, planStore: store })(
        { method: 'GET', query: { plan } }, makeRes(),
      )
      now += ACQUISITION_CACHE_TTL_MS + 1
      const res = makeRes()
      await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl: async () => { throw new Error('down') }, cache, planStore: store })(
        { method: 'GET', query: { plan } }, res,
      )
      expect(res.statusCode).toBe(200)
      expect(res.body.meta.cache).toBe('stale')
      expect(res.body.articles.map((a) => a.title)).toContain('Cached renewal')
    } finally {
      spy.mockRestore()
    }
  })

  it('7. no cache contamination between differing query plans', async () => {
    const store = createPlanStore({ env: {} })
    const cache = createAcquisitionCache()
    const fromArticle = rawArticle({ url: 'https://deadline.com/from', title: 'From renewed' })
    const sevArticle = rawArticle({ url: 'https://deadline.com/sev', title: 'Severance renewed' })
    const fetchImpl = async (url) => {
      const q = new URL(url).searchParams.get('q') ?? ''
      if (q.includes('From')) return gnews([fromArticle])
      if (q.includes('Severance')) return gnews([sevArticle])
      return gnews([])
    }
    const h = createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl, cache, planStore: store })
    const planA = await register(store, shows)
    const planB = await register(store, otherShows)
    const a = makeRes(); await h({ method: 'GET', query: { plan: planA } }, a)
    const b = makeRes(); await h({ method: 'GET', query: { plan: planB } }, b)
    expect(a.body.articles.map((x) => x.title)).toContain('From renewed')
    expect(a.body.articles.map((x) => x.title)).not.toContain('Severance renewed')
    expect(b.body.articles.map((x) => x.title)).toContain('Severance renewed')
    expect(b.body.articles.map((x) => x.title)).not.toContain('From renewed')
  })

  it('8. cache corruption does not crash the endpoint', async () => {
    const store = createPlanStore({ env: {} })
    const fetchImpl = async () => gnews([rawArticle()])
    const plan = await register(store, shows)
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl, planStore: store, cache: {
      read() { try { throw new Error('corrupt store') } catch { return null } }, write() {},
    } })({ method: 'GET', query: { plan } }, res)
    expect(res.statusCode).toBe(200)
  })

  it('forces a refresh past the cache only through the explicit option', async () => {
    const store = createPlanStore({ env: {} })
    const cache = createAcquisitionCache()
    const fetchImpl = vi.fn(async () => gnews([]))
    const h = createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl, cache, planStore: store })
    const plan = await register(store, shows)
    await h({ method: 'GET', query: { plan } }, makeRes())
    const afterFirst = fetchImpl.mock.calls.length
    await h({ method: 'GET', query: { plan } }, makeRes())
    expect(fetchImpl.mock.calls.length).toBe(afterFirst)
    await h({ method: 'GET', query: { plan, refresh: '1' } }, makeRes())
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(afterFirst)
  })

  it('POST registers the plan (durably retrievable) and returns its opaque id for the cacheable GET', async () => {
    const store = createPlanStore({ env: {} })
    const cache = createAcquisitionCache()
    const h = createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl: async () => gnews([rawArticle()]), cache, planStore: store })
    const post = makeRes()
    await h({ method: 'POST', body: { shows } }, post)
    const { planId } = await planFromShows(shows)
    expect(post.body.meta.planId).toBe(planId)
    // The plan is now registered, so a subsequent GET resolves (and hits the warm
    // result cache the POST populated) instead of 409-ing.
    expect(await store.get(planId)).toBeTruthy()
    const get = makeRes()
    await h({ method: 'GET', query: { plan: planId } }, get)
    expect(get.statusCode).toBe(200)
    expect(get.body.meta.cache).toBe('hit')
  })
})
