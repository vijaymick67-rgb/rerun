import { describe, it, expect } from 'vitest'
import {
  DATE_WINDOW, MAX_DISCOVER_PAGES, dateWindow, withinWindow,
  discoverFranchiseCandidates, confirmMembership, buildFranchiseCatalogue,
} from './franchiseCatalogue.js'
import { FRANCHISE, MEDIA_TYPE } from './franchiseSeeds.js'

const NOW = Date.parse('2026-07-23T00:00:00.000Z')

// Verified + enabled synthetic seeds (the keyless sandbox ships none enabled, so
// tests inject their own to exercise the pipeline).
const MARVEL = 420
const DC = 128064
const SEEDS = [
  { franchise: FRANCHISE.MARVEL, companyId: MARVEL, candidateName: 'Marvel Studios', verified: true, enabled: true },
  { franchise: FRANCHISE.DC, companyId: DC, candidateName: 'DC Studios', verified: true, enabled: true },
]

// Build a proxy-style fetchImpl: it receives the `/api/tmdb/<path>?<query>` URL the
// shared tmdbVideos.fetchTmdbJson constructs, and returns a fixture payload.
function tmdbServer({ discover = {}, details = {} } = {}) {
  return async (url) => {
    const u = new URL(url, 'http://x')
    const path = u.pathname.replace(/^\/api\/tmdb/, '')
    const dMovie = path === '/discover/movie'
    const dTv = path === '/discover/tv'
    if (dMovie || dTv) {
      const type = dMovie ? 'movie' : 'tv'
      const companies = u.searchParams.get('with_companies')
      const page = u.searchParams.get('page')
      const payload = discover[`${type}:${companies}:${page}`] ?? discover[`${type}:${companies}`] ?? { page: 1, total_pages: 1, total_results: 0, results: [] }
      return { ok: true, json: async () => payload }
    }
    const detail = path.match(/^\/(movie|tv)\/(\d+)$/)
    if (detail) {
      const body = details[`${detail[1]}:${detail[2]}`]
      return body ? { ok: true, json: async () => body } : { ok: false, json: async () => ({}) }
    }
    return { ok: false, json: async () => ({}) }
  }
}

const inWindow = '2026-11-01' // within [now-12mo, now+36mo]
const farFuture = '2031-01-01' // beyond now+36mo
const farPast = '2020-01-01' // before now-12mo

describe('date window (Part 5) — moves from `now`, never a hardcoded year', () => {
  it('derives [now-12mo, now+36mo] from the supplied now', () => {
    const { gte, lte } = dateWindow(NOW)
    expect(gte).toBe('2025-07-23')
    expect(lte).toBe('2029-07-23')
    // A different now slides the window — nothing is pinned to a calendar year.
    expect(dateWindow(Date.parse('2030-01-01T00:00:00Z')).gte).toBe('2029-01-01')
  })

  it('keeps a dated title inside the window and drops one outside it', () => {
    expect(withinWindow(MEDIA_TYPE.MOVIE, { release_date: inWindow }, NOW)).toBe(true)
    expect(withinWindow(MEDIA_TYPE.MOVIE, { release_date: farFuture }, NOW)).toBe(false)
    expect(withinWindow(MEDIA_TYPE.MOVIE, { release_date: farPast }, NOW)).toBe(false)
  })

  it('conservatively keeps an undated title only when it is in active/planned production', () => {
    expect(withinWindow(MEDIA_TYPE.TV, { first_air_date: null, status: 'Planned' }, NOW)).toBe(true)
    expect(withinWindow(MEDIA_TYPE.TV, { first_air_date: null, status: 'Returning Series' }, NOW)).toBe(true)
    expect(withinWindow(MEDIA_TYPE.TV, { first_air_date: null, status: 'Ended' }, NOW)).toBe(false)
    expect(DATE_WINDOW.futureMonths).toBeGreaterThan(0)
  })
})

describe('detail-level membership confirmation (Part 4)', () => {
  it('confirms a candidate whose detail production_companies contains a verified seed', async () => {
    const fetchImpl = tmdbServer({
      details: { 'movie:1001': { id: 1001, title: 'A New Marvel Movie', release_date: inWindow, poster_path: '/p.jpg', production_companies: [{ id: MARVEL, name: 'Marvel Studios' }] } },
    })
    const member = await confirmMembership({
      mediaType: MEDIA_TYPE.MOVIE, mediaId: 1001, franchise: FRANCHISE.MARVEL, seeds: SEEDS, now: NOW,
      fetchOptions: { fetchImpl, storage: undefined, now: NOW },
    })
    expect(member).toBeTruthy()
    expect(member.mediaId).toBe(1001)
    expect(member.franchise).toBe(FRANCHISE.MARVEL)
    expect(member.matchedCompanyIds).toContain(MARVEL)
  })

  it('rejects a candidate whose detail has NO verified seed company (defends against loose discover)', async () => {
    const fetchImpl = tmdbServer({
      details: { 'movie:1002': { id: 1002, title: 'Unrelated Disney Movie', release_date: inWindow, production_companies: [{ id: 2, name: 'Walt Disney Pictures' }] } },
    })
    const member = await confirmMembership({
      mediaType: MEDIA_TYPE.MOVIE, mediaId: 1002, franchise: FRANCHISE.MARVEL, seeds: SEEDS, now: NOW,
      fetchOptions: { fetchImpl, now: NOW },
    })
    expect(member).toBe(null)
  })

  it('rejects a confirmed-company title that falls outside the date window', async () => {
    const fetchImpl = tmdbServer({
      details: { 'movie:1003': { id: 1003, title: 'Old Marvel Movie', release_date: farPast, status: 'Released', production_companies: [{ id: MARVEL }] } },
    })
    const member = await confirmMembership({
      mediaType: MEDIA_TYPE.MOVIE, mediaId: 1003, franchise: FRANCHISE.MARVEL, seeds: SEEDS, now: NOW,
      fetchOptions: { fetchImpl, now: NOW },
    })
    expect(member).toBe(null)
  })
})

describe('bounded pagination + dedup (Part 6)', () => {
  it('stops at the page cap and reports truncation instead of pretending full coverage', async () => {
    const fetchImpl = tmdbServer({
      discover: {
        [`movie:${MARVEL}:1`]: { page: 1, total_pages: 9, total_results: 90, results: [{ id: 1 }, { id: 2 }] },
        [`movie:${MARVEL}:2`]: { page: 2, total_pages: 9, total_results: 90, results: [{ id: 3 }, { id: 1 }] }, // id 1 duplicated
      },
    })
    const { candidates, pagesFetched, truncated } = await discoverFranchiseCandidates({
      franchise: FRANCHISE.MARVEL, mediaType: MEDIA_TYPE.MOVIE, seeds: SEEDS, now: NOW,
      fetchOptions: { fetchImpl, now: NOW }, maxPages: 2,
    })
    expect(pagesFetched).toBe(2)
    expect(truncated).toBe(true) // 9 pages available, capped at 2
    expect(candidates.map((c) => c.id).sort((a, b) => a - b)).toEqual([1, 2, 3]) // id 1 deduped
    expect(MAX_DISCOVER_PAGES).toBeGreaterThan(0)
  })

  it('never fetches for a franchise with no verified seed', async () => {
    const result = await discoverFranchiseCandidates({
      franchise: FRANCHISE.MARVEL, mediaType: MEDIA_TYPE.MOVIE, seeds: [], now: NOW,
      fetchOptions: { fetchImpl: tmdbServer(), now: NOW },
    })
    expect(result.candidates).toEqual([])
    expect(result.pagesFetched).toBe(0)
  })
})

describe('buildFranchiseCatalogue — dynamic discovery end to end', () => {
  // A brand-new Marvel movie + Marvel TV + DC movie + DC TV, none of which exist
  // as source-code titles — they enter purely through company attribution.
  function fullServer() {
    return tmdbServer({
      discover: {
        [`movie:${MARVEL}:1`]: { page: 1, total_pages: 1, total_results: 2, results: [{ id: 5001 }, { id: 5002 }] },
        [`tv:${MARVEL}:1`]: { page: 1, total_pages: 1, total_results: 1, results: [{ id: 5101 }] },
        [`movie:${DC}:1`]: { page: 1, total_pages: 1, total_results: 1, results: [{ id: 6001 }] },
        [`tv:${DC}:1`]: { page: 1, total_pages: 1, total_results: 1, results: [{ id: 6101 }] },
      },
      details: {
        'movie:5001': { id: 5001, title: 'Brand New Marvel Movie', release_date: inWindow, poster_path: '/m.jpg', production_companies: [{ id: MARVEL }] },
        'movie:5002': { id: 5002, title: 'Unrelated Disney Movie', release_date: inWindow, production_companies: [{ id: 2 }] }, // no seed -> rejected
        'tv:5101': { id: 5101, name: 'Brand New Marvel Series', first_air_date: inWindow, production_companies: [{ id: MARVEL }] },
        'movie:6001': { id: 6001, title: 'Brand New DC Movie', release_date: inWindow, production_companies: [{ id: DC }] },
        'tv:6101': { id: 6101, name: 'Brand New DC Series', first_air_date: inWindow, production_companies: [{ id: DC }] },
      },
    })
  }

  it('admits a new Marvel movie, Marvel TV, DC movie and DC TV with no source-code title entry', async () => {
    const { media, coverage } = await buildFranchiseCatalogue({ seeds: SEEDS, now: NOW, fetchImpl: fullServer() })
    const ids = media.map((m) => `${m.franchise}:${m.mediaType}:${m.mediaId}`)
    expect(ids).toContain('marvel:movie:5001')
    expect(ids).toContain('marvel:tv:5101')
    expect(ids).toContain('dc:movie:6001')
    expect(ids).toContain('dc:tv:6101')
    // The unrelated Disney movie discovered by the seed is rejected at detail-confirm.
    expect(ids).not.toContain('marvel:movie:5002')
    expect(coverage.seedsEnabled).toBe(2)
    expect(coverage.confirmed).toBe(4)
    expect(coverage.partial).toBe(false)
  })

  it('returns an EMPTY catalogue when no seed is verified (keyless-sandbox state)', async () => {
    const { media, coverage } = await buildFranchiseCatalogue({ seeds: [], now: NOW, fetchImpl: fullServer() })
    expect(media).toEqual([])
    expect(coverage.seedsEnabled).toBe(0)
  })

  it('produces deterministic ordering (franchise, media type, id)', async () => {
    const { media } = await buildFranchiseCatalogue({ seeds: SEEDS, now: NOW, fetchImpl: fullServer() })
    const keys = media.map((m) => `${m.franchise}:${m.mediaType}:${m.mediaId}`)
    expect(keys).toEqual([...keys].sort())
  })

  describe('overrides (Part 7)', () => {
    it('exclude override blocks a confirmed false positive', async () => {
      const { media } = await buildFranchiseCatalogue({
        seeds: SEEDS, now: NOW, fetchImpl: fullServer(),
        excludeOverrides: [{ mediaType: 'movie', tmdbId: 5001, franchise: 'marvel', explanation: 'not a real trailer target', verifiedAt: '2026-07-23', reason: 'test' }],
      })
      expect(media.map((m) => m.mediaId)).not.toContain(5001)
    })

    it('include override admits a verified metadata exception TMDB does not attribute', async () => {
      const server = tmdbServer({
        details: { 'movie:9001': { id: 9001, title: 'Metadata Exception Movie', release_date: inWindow, production_companies: [{ id: 999 }] } },
      })
      const { media } = await buildFranchiseCatalogue({
        seeds: [], now: NOW, fetchImpl: server,
        includeOverrides: [{ mediaType: 'movie', tmdbId: 9001, franchise: 'marvel', explanation: 'TMDB has not attached Marvel Studios yet', verifiedAt: '2026-07-23', reason: 'metadata gap' }],
      })
      const member = media.find((m) => m.mediaId === 9001)
      expect(member).toBeTruthy()
      expect(member.viaOverride).toBe(true)
    })

    it('ordinary titles do not depend on overrides (dynamic members present with none)', async () => {
      const { media } = await buildFranchiseCatalogue({ seeds: SEEDS, now: NOW, fetchImpl: fullServer() })
      expect(media.length).toBeGreaterThan(0)
    })
  })
})
