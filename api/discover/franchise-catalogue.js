// Dynamic Marvel/DC franchise catalogue endpoint (Scope J + 8).
//
// Runs the discover -> detail-confirm pipeline (src/lib/discover/franchiseCatalogue.js)
// SERVER-SIDE with the protected TMDB key, so the expensive discovery work
// happens once per TTL at the edge rather than on every client mount.
//
// Persistence guarantee: the DURABLE cache layer is the Vercel edge CDN via the
// Cache-Control header below (GET, keyed by URL). Repeated GETs within s-maxage
// are served by the CDN with zero re-computation. The client also keeps a 24h
// localStorage copy (franchiseCatalogueStore) with stale-on-error, so a failed
// refresh never empties the trailers feed. There is NO in-memory module cache
// pretending to be durable across serverless invocations.
//
// In an environment WITHOUT a TMDB key (or with no verified seeds), this returns
// an empty catalogue with configured/seedsEnabled metadata — the feature is
// safely inert rather than guessing a static list.

import { buildFranchiseCatalogue } from '../../src/lib/discover/franchiseCatalogue.js'
import { enabledSeeds, seedCompanyIds } from '../../src/lib/discover/franchiseSeeds.js'

const TMDB_BASE_URL = 'https://api.themoviedb.org/3'
// 24h at the edge; serve stale for a further day while revalidating, and keep
// serving stale on upstream error so the feed survives a TMDB blip.
const CACHE_CONTROL = 'public, s-maxage=86400, stale-while-revalidate=86400, stale-if-error=172800'

function json(res, status, body, headers = {}) {
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  res.json(body)
}

// Adapter so the shared pipeline (which fetches through the /api/tmdb proxy path)
// can run server-side: it rewrites the proxy path to a direct keyed TMDB call.
// The key never leaves the server and only read requests are made.
function createServerTmdbFetch(apiKey) {
  return async function serverTmdbFetch(proxyUrl) {
    const rel = String(proxyUrl).replace(/^\/api\/tmdb/, '')
    const url = new URL(`${TMDB_BASE_URL}${rel}`)
    url.searchParams.set('api_key', apiKey)
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    return response
  }
}

export function createFranchiseCatalogueHandler({ env = process.env, fetchImpl } = {}) {
  return async function franchiseCatalogueHandler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported' } })
      return
    }

    const apiKey = env.TMDB_API_KEY
    const seeds = enabledSeeds()
    const now = Date.now()
    const meta = {
      fetchedAt: new Date(now).toISOString(),
      configured: Boolean(apiKey),
      seedsEnabled: seeds.length,
      seedCompanyIds: seedCompanyIds(),
    }

    // No key OR no verified seed -> empty catalogue, honestly reported. Not cached
    // long (the situation can change once a maintainer configures seeds).
    if (!apiKey || !seeds.length) {
      json(res, 200, { media: [], coverage: { seedsEnabled: seeds.length, partial: false }, meta },
        { 'Cache-Control': 'public, s-maxage=300' })
      return
    }

    const serverFetch = fetchImpl ?? createServerTmdbFetch(apiKey)
    try {
      const { media, coverage } = await buildFranchiseCatalogue({ seeds, now, fetchImpl: serverFetch })
      json(res, 200, { media, coverage, meta: { ...meta, count: media.length } },
        { 'Cache-Control': CACHE_CONTROL })
    } catch {
      json(res, 502, { error: { code: 'FRANCHISE_CATALOGUE_ERROR', message: 'Catalogue build failed' } },
        { 'Cache-Control': 'no-store' })
    }
  }
}

export default createFranchiseCatalogueHandler()
