import { describe, it, expect, vi } from 'vitest'
import handler, {
  createAnnouncementsHandler, buildAnnouncementQueries, MAX_QUERIES,
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
    const queries = buildAnnouncementQueries([{ id: 1, title: 'From' }])
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('"From"')
    expect(queries[0]).toMatch(/renewed|canceled|premiere|cast/)
  })

  it('batches shows and never exceeds the query cap', () => {
    const shows = Array.from({ length: 400 }, (_, i) => ({ id: i, title: `Show Number ${i}` }))
    const queries = buildAnnouncementQueries(shows)
    expect(queries.length).toBeLessThanOrEqual(MAX_QUERIES)
    // Each query OR-batches multiple show terms (not one request per show).
    expect(queries[0].match(/ OR /g)?.length ?? 0).toBeGreaterThan(0)
  })

  it('includes a capped number of verified aliases', () => {
    const queries = buildAnnouncementQueries([
      { id: 1, title: 'Shogun', aliases: ['James Clavell\'s Shogun', 'Shougun', 'ThirdAlias', 'FourthAlias'] },
    ])
    // canonical + at most 2 aliases -> 3 quoted terms in the title clause.
    const titleClause = queries[0].split(' AND ')[0]
    expect(titleClause.match(/"/g)?.length).toBe(6) // 3 phrases => 6 quote chars
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
