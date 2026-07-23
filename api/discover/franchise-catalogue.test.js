import { describe, it, expect } from 'vitest'
import handler, { createFranchiseCatalogueHandler } from './franchise-catalogue.js'

function makeRes() {
  const headers = new Map()
  return {
    headers, statusCode: null, body: null,
    status(code) { this.statusCode = code; return this },
    setHeader(name, value) { headers.set(name, value); return this },
    json(body) { this.body = body; return this },
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
  })

  it('returns an empty catalogue with seedsEnabled:0 when a key is set but no seed is verified (honest keyless-sandbox default)', async () => {
    const res = makeRes()
    // Every shipped seed is disabled/unverified, so even with a key the catalogue
    // is empty here — the feature is safely inert, not guessing a static list.
    await createFranchiseCatalogueHandler({ env: { TMDB_API_KEY: 'k' } })({ method: 'GET', query: {} }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.media).toEqual([])
    expect(res.body.meta.seedsEnabled).toBe(0)
  })
})
