import { describe, it, expect, vi } from 'vitest'
import handler, {
  createAnnouncementsHandler, buildAnnouncementQueries, MAX_QUERIES, TERM_BUDGET,
} from './announcements.js'

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
    // Each query OR-batches multiple show terms (not one request per show).
    expect(queries[0].match(/ OR /g)?.length ?? 0).toBeGreaterThan(0)
  })

  it('includes a capped number of verified aliases', () => {
    const { queries } = buildAnnouncementQueries([
      { id: 1, title: 'Shogun', aliases: ['James Clavell\'s Shogun', 'Shougun', 'ThirdAlias', 'FourthAlias'] },
    ])
    // canonical + at most 2 aliases -> 3 quoted terms in the title clause.
    const titleClause = queries[0].split(' AND ')[0]
    expect(titleClause.match(/"/g)?.length).toBe(6) // 3 phrases => 6 quote chars
  })

  it('schedules every canonical title before any alias so none is displaced', () => {
    // Two shows, each with two aliases. Canonicals must appear before aliases in
    // the flattened term order, proving aliases never crowd out a canonical.
    const { queries, plan } = buildAnnouncementQueries([
      { id: 1, title: 'Alpha', aliases: ['Alpha Alt One', 'Alpha Alt Two'] },
      { id: 2, title: 'Bravo', aliases: ['Bravo Alt One', 'Bravo Alt Two'] },
    ])
    const flat = queries.join(' ')
    // Both canonicals come before either show's aliases in the scheduled order.
    expect(flat.indexOf('"Alpha"')).toBeLessThan(flat.indexOf('"Alpha Alt One"'))
    expect(flat.indexOf('"Bravo"')).toBeLessThan(flat.indexOf('"Alpha Alt One"'))
    expect(plan.canonicalTitlesSearched).toBe(2)
    expect(plan.aliasesSearched).toBe(4)
    expect(plan.partialCoverage).toBe(false)
  })

  it('covers every canonical title for a large 90–120 show library (two aliases each)', () => {
    const shows = Array.from({ length: 120 }, (_, i) => ({
      id: i, title: `Canonical Series ${i}`,
      aliases: [`Series ${i} Alt A`, `Series ${i} Alt B`],
    }))
    const { queries, plan } = buildAnnouncementQueries(shows)
    const all = queries.join(' ')
    // EVERY canonical title is present somewhere in the scheduled queries.
    for (let i = 0; i < 120; i += 1) {
      expect(all).toContain(`"Canonical Series ${i}"`)
    }
    expect(plan.showsReceived).toBe(120)
    expect(plan.canonicalTitlesSearched).toBe(120)
    expect(plan.showsOmitted).toBe(0)
    expect(plan.partialCoverage).toBe(false)
    // Aliases use only leftover budget; the surplus is reported, not hidden.
    expect(plan.aliasesSearched).toBe(TERM_BUDGET - 120)
    expect(plan.aliasesOmitted).toBe(240 - (TERM_BUDGET - 120))
    expect(queries.length).toBeLessThanOrEqual(MAX_QUERIES)
  })

  it('reports an explicit partial-coverage state when canonicals exceed the budget', () => {
    const shows = Array.from({ length: TERM_BUDGET + 25 }, (_, i) => ({ id: i, title: `Overflow Show ${i}` }))
    const { plan } = buildAnnouncementQueries(shows)
    expect(plan.canonicalTitlesSearched).toBe(TERM_BUDGET)
    expect(plan.showsOmitted).toBe(25)
    expect(plan.partialCoverage).toBe(true)
  })
})

describe('announcements endpoint', () => {
  it('rejects non-POST', async () => {
    const res = makeRes()
    await handler({ method: 'GET', query: {} }, res)
    expect(res.statusCode).toBe(405)
  })

  it('rejects a body without a shows array', async () => {
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' } })({ method: 'POST', body: {} }, res)
    expect(res.statusCode).toBe(400)
  })

  it('returns an empty candidate set (never a generic feed) when no key is configured', async () => {
    const res = makeRes()
    const fetchImpl = vi.fn()
    await createAnnouncementsHandler({ env: {}, fetchImpl })({ method: 'POST', body: { shows: [{ id: 1, title: 'From' }] } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.articles).toEqual([])
    expect(res.body.meta.configured).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('discovers an announcement for a tracked show that a generic top-ten feed would miss', async () => {
    // The niche show only appears when its own title is searched — proving the
    // endpoint derives per-show queries rather than relying on a shared feed.
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

  it('reports full canonical coverage in response metadata for a 110-show library', async () => {
    const shows = Array.from({ length: 110 }, (_, i) => ({
      id: i, title: `Library Show ${i}`, aliases: [`Show ${i} AKA A`, `Show ${i} AKA B`],
    }))
    const fetchImpl = async () => gnews([])
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl })({ method: 'POST', body: { shows } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.meta.showsReceived).toBe(110)
    expect(res.body.meta.canonicalTitlesSearched).toBe(110)
    expect(res.body.meta.showsOmitted).toBe(0)
    expect(res.body.meta.partialCoverage).toBe(false)
    expect(res.body.meta.aliasesSearched).toBe(TERM_BUDGET - 110)
    expect(res.body.meta.aliasesOmitted).toBe(220 - (TERM_BUDGET - 110))
  })

  it('signals partial coverage in metadata when the library exceeds the budget', async () => {
    const shows = Array.from({ length: TERM_BUDGET + 40 }, (_, i) => ({ id: i, title: `Huge Library ${i}` }))
    const fetchImpl = async () => gnews([])
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl })({ method: 'POST', body: { shows } }, res)
    expect(res.body.meta.partialCoverage).toBe(true)
    expect(res.body.meta.showsOmitted).toBe(40)
    expect(res.body.meta.canonicalTitlesSearched).toBe(TERM_BUDGET)
  })

  it('deduplicates the same story returned by more than one query', async () => {
    const shared = rawArticle({ url: 'https://deadline.com/shared-story', title: 'Shared renewal story' })
    const fetchImpl = async () => gnews([shared]) // every query returns the same article
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
      if (call === 1) return { ok: false, json: async () => ({}) } // first query fails
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

  it('surfaces a 502 only when every query fails (so the client keeps its cache)', async () => {
    const fetchImpl = async () => { throw new Error('network down') }
    const res = makeRes()
    await createAnnouncementsHandler({ env: { GNEWS_API_KEY: 'k' }, fetchImpl })(
      { method: 'POST', body: { shows: [{ id: 1, title: 'From' }] } }, res,
    )
    expect(res.statusCode).toBe(502)
  })
})
