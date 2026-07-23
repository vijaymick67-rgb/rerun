import { describe, it, expect, vi } from 'vitest'
import handler, { createFranchiseCatalogueHandler } from './franchise-catalogue.js'
import { createSeedVerificationCache } from '../../src/lib/discover/franchiseSeedVerifier.js'

function makeRes() {
  const headers = new Map()
  return {
    headers, statusCode: null, body: null,
    status(code) { this.statusCode = code; return this },
    setHeader(name, value) { headers.set(name, value); return this },
    json(body) { this.body = body; return this },
  }
}

// Verification JSON fetcher over the 4 SHIPPED candidate seeds (420, 7505,
// 128064, 9993). Only the ids in `pass` resolve with their exact expected name
// and a narrow movie+tv sample; the rest fail honestly.
const EXPECTED_NAMES = { 420: 'Marvel Studios', 7505: 'Marvel Television', 128064: 'DC Studios', 9993: 'DC Entertainment' }
function verifyJson({ pass = [420, 128064] } = {}) {
  return async (path, params = {}) => {
    const c = path.match(/^\/company\/(\d+)$/)
    if (c) {
      const id = Number(c[1])
      return pass.includes(id) ? { id, name: EXPECTED_NAMES[id] } : null
    }
    if (path === '/discover/movie' || path === '/discover/tv') {
      const id = Number(params.with_companies)
      return { total_results: pass.includes(id) ? 25 : 0 }
    }
    return null
  }
}

// Discovery fetcher over the /api/tmdb proxy path (Response-returning). Members
// carry status:'Planned' so they pass the moving date window regardless of now.
function discoveryServer() {
  const discover = {
    'movie:420:1': { page: 1, total_pages: 1, total_results: 1, results: [{ id: 5001 }] },
    'tv:420:1': { page: 1, total_pages: 1, total_results: 1, results: [{ id: 5101 }] },
    'movie:128064:1': { page: 1, total_pages: 1, total_results: 1, results: [{ id: 6001 }] },
    'tv:128064:1': { page: 1, total_pages: 1, total_results: 1, results: [{ id: 6101 }] },
  }
  const details = {
    'movie:5001': { id: 5001, title: 'New Marvel Movie', status: 'Planned', production_companies: [{ id: 420 }] },
    'tv:5101': { id: 5101, name: 'New Marvel Series', status: 'Planned', production_companies: [{ id: 420 }] },
    'movie:6001': { id: 6001, title: 'New DC Movie', status: 'Planned', production_companies: [{ id: 128064 }] },
    'tv:6101': { id: 6101, name: 'New DC Series', status: 'Planned', production_companies: [{ id: 128064 }] },
  }
  return async (url) => {
    const u = new URL(url, 'http://x')
    const path = u.pathname.replace(/^\/api\/tmdb/, '')
    if (path === '/discover/movie' || path === '/discover/tv') {
      const type = path.endsWith('movie') ? 'movie' : 'tv'
      const key = `${type}:${u.searchParams.get('with_companies')}:${u.searchParams.get('page')}`
      const payload = discover[key] ?? { page: 1, total_pages: 1, total_results: 0, results: [] }
      return { ok: true, json: async () => payload }
    }
    const d = path.match(/^\/(movie|tv)\/(\d+)$/)
    if (d) {
      const body = details[`${d[1]}:${d[2]}`]
      return body ? { ok: true, json: async () => body } : { ok: false, json: async () => ({}) }
    }
    return { ok: false, json: async () => ({}) }
  }
}

describe('franchise-catalogue endpoint', () => {
  it('rejects a non-GET method', async () => {
    const res = makeRes()
    await handler({ method: 'POST', query: {} }, res)
    expect(res.statusCode).toBe(405)
  })

  it('returns an empty catalogue with configured:false when no TMDB key is set', async () => {
    const res = makeRes()
    await createFranchiseCatalogueHandler({ env: {} })({ method: 'GET', query: {} }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.media).toEqual([])
    expect(res.body.meta.configured).toBe(false)
    expect(res.body.meta.seedsEnabled).toBe(0)
  })

  it('returns an empty catalogue (seedsEnabled:0) when a key is set but NO seed verifies', async () => {
    const res = makeRes()
    await createFranchiseCatalogueHandler({
      env: { TMDB_API_KEY: 'k' },
      verifyFetchJson: verifyJson({ pass: [] }), // nothing resolves
      verificationCache: createSeedVerificationCache(),
    })({ method: 'GET', query: {} }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.media).toEqual([])
    expect(res.body.meta.seedsEnabled).toBe(0)
    // Honest failure metadata for every candidate.
    expect(res.body.meta.seedVerification.failed).toBeGreaterThan(0)
    expect(res.body.meta.seedVerification.verified).toBe(0)
  })

  it('AUTOMATICALLY verifies seeds at runtime and builds the catalogue — no source-code verified:true', async () => {
    const res = makeRes()
    await createFranchiseCatalogueHandler({
      env: { TMDB_API_KEY: 'k' },
      verifyFetchJson: verifyJson({ pass: [420, 128064] }),
      fetchImpl: discoveryServer(),
      verificationCache: createSeedVerificationCache(),
    })({ method: 'GET', query: {} }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.meta.seedsEnabled).toBe(2)
    expect(res.body.meta.seedCompanyIds).toEqual([420, 128064])
    expect(res.body.meta.seedVerification.verified).toBe(2)
    const ids = res.body.media.map((m) => `${m.franchise}:${m.mediaType}:${m.mediaId}`)
    expect(ids).toContain('marvel:movie:5001')
    expect(ids).toContain('marvel:tv:5101')
    expect(ids).toContain('dc:movie:6001')
    expect(ids).toContain('dc:tv:6101')
  })

  it('reuses cached verification across calls (no repeat live verification)', async () => {
    const cache = createSeedVerificationCache()
    const spy = vi.fn(verifyJson({ pass: [420, 128064] }))
    const make = () => createFranchiseCatalogueHandler({
      env: { TMDB_API_KEY: 'k' }, verifyFetchJson: spy, fetchImpl: discoveryServer(), verificationCache: cache,
    })
    await make()({ method: 'GET', query: {} }, makeRes())
    const callsAfterFirst = spy.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)
    const res = makeRes()
    await make()({ method: 'GET', query: {} }, res)
    // The two SUCCESSFUL seeds were served from cache — no repeat live calls for
    // them (only the unresolved candidates legitimately retry).
    const secondCallPaths = spy.mock.calls.slice(callsAfterFirst).map((c) => c[0])
    expect(secondCallPaths).not.toContain('/company/420')
    expect(secondCallPaths).not.toContain('/company/128064')
    expect(res.body.meta.seedVerification.fromCache).toBe(2)
    expect(res.body.meta.seedsEnabled).toBe(2)
  })

  it('isolates a single failing seed — the rest still verify and build', async () => {
    const res = makeRes()
    await createFranchiseCatalogueHandler({
      env: { TMDB_API_KEY: 'k' },
      verifyFetchJson: verifyJson({ pass: [420] }), // only Marvel Studios resolves
      fetchImpl: discoveryServer(),
      verificationCache: createSeedVerificationCache(),
    })({ method: 'GET', query: {} }, res)
    expect(res.body.meta.seedsEnabled).toBe(1)
    expect(res.body.meta.seedCompanyIds).toEqual([420])
    const ids = res.body.media.map((m) => `${m.franchise}:${m.mediaType}:${m.mediaId}`)
    expect(ids).toContain('marvel:movie:5001')
    expect(ids).not.toContain('dc:movie:6001')
  })
})
