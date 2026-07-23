// Dynamic Marvel/DC franchise catalogue endpoint (Scope J + 8 + Blocker 1).
//
// Runs the discover -> detail-confirm pipeline (src/lib/discover/franchiseCatalogue.js)
// SERVER-SIDE with the protected TMDB key, so the expensive discovery work
// happens once per TTL at the edge rather than on every client mount.
//
// AUTOMATIC RUNTIME SEED VERIFICATION (Blocker 1)
// -----------------------------------------------
// Seeds are NO LONGER enabled by a hand-edited `verified: true` source flag.
// Instead, when a TMDB key is present this endpoint verifies each candidate seed
// LIVE (franchiseSeedVerifier.resolveVerifiedSeeds): it confirms the company
// identity and samples movie + tv discover for franchise-scale narrowness, using
// the server key only. Only seeds that pass participate in discovery; the rest
// are reported honestly in meta.seedVerification. No source edit is required for a
// normal deployment — a key-holding environment self-verifies at runtime.
//
// Persistence guarantee: the DURABLE cache layer is the Vercel edge CDN via the
// Cache-Control header below (GET, keyed by URL). Repeated GETs within s-maxage
// are served by the CDN with zero re-computation — no verification, no discovery.
// The client also keeps a 24h localStorage copy (franchiseCatalogueStore) with
// stale-on-error, so a failed refresh never empties the trailers feed.
//
// In an environment WITHOUT a TMDB key (or where no candidate seed can be
// verified), this returns an empty catalogue with honest configured/seedsEnabled
// metadata — the feature is safely inert rather than guessing a static list.

import { buildFranchiseCatalogue } from '../../src/lib/discover/franchiseCatalogue.js'
import { resolveVerifiedSeeds } from '../../src/lib/discover/franchiseSeedVerifier.js'

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

// JSON adapter for seed verification: hits /company/{id} and /discover/{type}
// directly with the protected key and returns parsed JSON (or null on any
// failure, so a network blip becomes an honest "unresolved" rather than a throw).
// The key never leaves the server.
function createServerTmdbJson(apiKey, fetchImpl = fetch) {
  return async function fetchJson(path, params = {}) {
    try {
      const url = new URL(`${TMDB_BASE_URL}${path}`)
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
      url.searchParams.set('api_key', apiKey)
      const response = await fetchImpl(url, { headers: { Accept: 'application/json' } })
      if (!response?.ok) return null
      return await response.json()
    } catch {
      return null
    }
  }
}

// Adapter so the shared discovery pipeline (which fetches through the /api/tmdb
// proxy path) can run server-side: it rewrites the proxy path to a direct keyed
// TMDB call. The key never leaves the server and only read requests are made.
function createServerTmdbFetch(apiKey, fetchImpl = fetch) {
  return async function serverTmdbFetch(proxyUrl) {
    const rel = String(proxyUrl).replace(/^\/api\/tmdb/, '')
    const url = new URL(`${TMDB_BASE_URL}${rel}`)
    url.searchParams.set('api_key', apiKey)
    return fetchImpl(url, { headers: { Accept: 'application/json' } })
  }
}

export function createFranchiseCatalogueHandler({
  env = process.env, fetchImpl, verifyFetchJson, verificationCache,
} = {}) {
  return async function franchiseCatalogueHandler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported' } })
      return
    }

    const apiKey = env.TMDB_API_KEY
    const now = Date.now()
    const baseMeta = { fetchedAt: new Date(now).toISOString(), configured: Boolean(apiKey) }

    // No key -> empty catalogue, honestly reported. Cannot verify anything.
    if (!apiKey) {
      json(res, 200,
        { media: [], coverage: { seedsEnabled: 0, partial: false }, meta: { ...baseMeta, seedsEnabled: 0, seedCompanyIds: [] } },
        { 'Cache-Control': 'public, s-maxage=300' })
      return
    }

    // Verify candidate seeds LIVE with the server key. Failures are isolated and
    // reported; only verified seeds proceed. No source-code verified:true needed.
    const verifyJson = verifyFetchJson ?? createServerTmdbJson(apiKey)
    const { activeSeeds, evidence, summary } = await resolveVerifiedSeeds({
      fetchJson: verifyJson, now, ...(verificationCache ? { cache: verificationCache } : {}),
    })
    const meta = {
      ...baseMeta,
      seedsEnabled: activeSeeds.length,
      seedCompanyIds: activeSeeds.map((s) => s.companyId),
      seedVerification: { ...summary, seeds: evidence },
    }

    // Key present but no seed could be verified -> empty catalogue, honestly
    // reported (not cached long — a maintainer fixing a seed should take effect).
    if (!activeSeeds.length) {
      json(res, 200, { media: [], coverage: { seedsEnabled: 0, partial: false }, meta },
        { 'Cache-Control': 'public, s-maxage=300' })
      return
    }

    const serverFetch = fetchImpl ?? createServerTmdbFetch(apiKey)
    try {
      const { media, coverage } = await buildFranchiseCatalogue({ seeds: activeSeeds, now, fetchImpl: serverFetch })
      json(res, 200, { media, coverage, meta: { ...meta, count: media.length } },
        { 'Cache-Control': CACHE_CONTROL })
    } catch {
      json(res, 502, { error: { code: 'FRANCHISE_CATALOGUE_ERROR', message: 'Catalogue build failed' } },
        { 'Cache-Control': 'no-store' })
    }
  }
}

export default createFranchiseCatalogueHandler()
