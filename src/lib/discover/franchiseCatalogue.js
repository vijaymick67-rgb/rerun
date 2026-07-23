// Dynamic Marvel/DC franchise catalogue (Scope J).
//
// Pipeline (all steps injectable + pure so they are unit-testable without a live
// key):
//
//   verified narrow franchise company seeds        (franchiseSeeds.enabledSeeds)
//         v
//   TMDB /discover/movie + /discover/tv            (discoverFranchiseCandidates)
//   bounded pagination inside a moving date window
//         v
//   detail-level company confirmation              (confirmMembership)
//   a candidate is admitted ONLY if its detail
//   production_companies contains a verified seed
//         v
//   moving date window + conservative unknown-date  (withinWindow)
//         v
//   exceptional include/exclude overrides           (franchiseOverrides)
//         v
//   deterministic, deduped membership records       -> franchiseCatalogueStore
//
// Membership is NEVER inferred from title text, synopsis, genre, or broad studio
// ownership. It is TMDB company attribution, re-confirmed at the detail level.
// New future projects appear automatically once TMDB attributes them to a
// verified seed. Nothing here is franchise-specific beyond the seed ids.

import { fetchTmdbJson, mapWithConcurrency, DEFAULT_CONCURRENCY } from './tmdbVideos.js'
import { FRANCHISE, MEDIA_TYPE, enabledSeeds, verifiedCompanyIdsFor } from './franchiseSeeds.js'
import { applyExcludeOverrides, resolveIncludeOverrides } from './franchiseOverrides.js'

// Moving date window (Scope 5). Derived from `now`, never hardcoded years, so it
// slides forward automatically as time passes. Configurable + documented.
export const DATE_WINDOW = Object.freeze({ pastMonths: 12, futureMonths: 36 })
// Bounded pagination (Scope 6). Discover is paginated; we never fetch unlimited
// pages. Hitting this cap is reported as partial coverage, never hidden.
export const MAX_DISCOVER_PAGES = 5
// Safety ceiling on catalogue size (bounds detail-confirm + video polling work).
export const MAX_CATALOGUE_ITEMS = 200
// TMDB statuses that justify conservatively KEEPING a title whose date is unknown
// or outside the window (active/planned production can still publish a teaser).
const ACTIVE_STATUSES = new Set([
  'planned', 'in production', 'post production', 'returning series', 'pilot',
])

function pad(n) { return String(n).padStart(2, '0') }
function toIso(date) { return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` }

// [gte, lte] window around `now`, as YYYY-MM-DD strings.
export function dateWindow(now, window = DATE_WINDOW) {
  const base = new Date(now)
  const gte = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - window.pastMonths, base.getUTCDate()))
  const lte = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + window.futureMonths, base.getUTCDate()))
  return { gte: toIso(gte), lte: toIso(lte) }
}

function mediaDate(mediaType, detail) {
  const raw = mediaType === MEDIA_TYPE.MOVIE ? detail?.release_date : detail?.first_air_date
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

// Window membership with a conservative unknown-date allowance: a dated title
// must fall inside [gte, lte]; an undated title is kept only when its TMDB status
// indicates active/planned production (so it could still drop a trailer).
export function withinWindow(mediaType, detail, now, window = DATE_WINDOW) {
  const { gte, lte } = dateWindow(now, window)
  const date = mediaDate(mediaType, detail)
  if (date) return date >= gte && date <= lte
  const status = String(detail?.status ?? '').toLowerCase()
  return ACTIVE_STATUSES.has(status)
}

// One discover page for a media type across the given (verified) company ids.
// Company ids are OR-combined with the TMDB pipe operator so a single request
// covers every seed for the franchise. Uses the correct date field per media
// type. Returns the raw TMDB discover payload (or null on failure).
async function discoverPage({ mediaType, companyIds, window, page, now, fetchOptions }) {
  const type = mediaType === MEDIA_TYPE.MOVIE ? 'movie' : 'tv'
  const { gte, lte } = dateWindow(now, window)
  const dateGteKey = type === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte'
  const dateLteKey = type === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte'
  const params = {
    with_companies: companyIds.join('|'), // OR — any of the verified seeds
    [dateGteKey]: gte,
    [dateLteKey]: lte,
    sort_by: type === 'movie' ? 'primary_release_date.asc' : 'first_air_date.asc',
    include_adult: 'false',
    page: String(page),
  }
  return fetchTmdbJson(`/discover/${type}`, { ...fetchOptions, params, ttlMs: fetchOptions.discoverTtlMs })
}

// Paginate discover for one franchise + media type, bounded by MAX_DISCOVER_PAGES.
// Dedupes across pages. Reports `truncated` when a safety cap stopped us before
// TMDB's own last page — we never silently pretend full coverage.
export async function discoverFranchiseCandidates({
  franchise, mediaType, seeds, window = DATE_WINDOW, now, fetchOptions, maxPages = MAX_DISCOVER_PAGES,
}) {
  const companyIds = [...verifiedCompanyIdsFor(franchise, seeds)]
  if (!companyIds.length) return { candidates: [], pagesFetched: 0, truncated: false }

  const byId = new Map()
  let pagesFetched = 0
  let truncated = false
  let totalPages = 1
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await discoverPage({ mediaType, companyIds, window, page, now, fetchOptions })
    if (!payload) break
    pagesFetched += 1
    totalPages = Number(payload.total_pages) || totalPages
    for (const result of Array.isArray(payload.results) ? payload.results : []) {
      if (result && Number.isFinite(result.id) && !byId.has(result.id)) byId.set(result.id, result)
    }
    if (page >= totalPages) break
    if (page === maxPages && page < totalPages) truncated = true
  }
  return { candidates: [...byId.values()], pagesFetched, truncated }
}

function memberFrom({ mediaType, franchise, detail, matchedCompanyIds, now }) {
  return Object.freeze({
    mediaType,
    mediaId: detail.id,
    title: mediaType === MEDIA_TYPE.MOVIE ? (detail.title ?? detail.original_title ?? null)
      : (detail.name ?? detail.original_name ?? null),
    posterPath: detail.poster_path ?? null,
    backdropPath: detail.backdrop_path ?? null,
    releaseDate: mediaType === MEDIA_TYPE.MOVIE ? (detail.release_date ?? null) : null,
    firstAirDate: mediaType === MEDIA_TYPE.TV ? (detail.first_air_date ?? null) : null,
    franchise,
    matchedCompanyIds,
    verifiedAt: new Date(now).toISOString(),
  })
}

// Detail-level confirmation (Scope 4). A discover result is only a CANDIDATE.
// We fetch its detail and require at least one configured verified seed id in
// production_companies (the authoritative attribution field) before treating it
// as franchise media — this defends against loose discover behaviour, stale
// metadata, and query leakage. Returns a membership record or null.
export async function confirmMembership({ mediaType, mediaId, franchise, seeds, now, fetchOptions }) {
  const verified = verifiedCompanyIdsFor(franchise, seeds)
  if (!verified.size) return null
  const type = mediaType === MEDIA_TYPE.MOVIE ? 'movie' : 'tv'
  const detail = await fetchTmdbJson(`/${type}/${mediaId}`, { ...fetchOptions, ttlMs: fetchOptions.detailTtlMs })
  if (!detail || !Number.isFinite(detail.id)) return null
  const companies = Array.isArray(detail.production_companies) ? detail.production_companies : []
  const matched = companies.map((c) => c?.id).filter((id) => verified.has(id))
  if (!matched.length) return null
  if (!withinWindow(mediaType, detail, now, fetchOptions.window ?? DATE_WINDOW)) return null
  return memberFrom({ mediaType, franchise, detail, matchedCompanyIds: [...new Set(matched)], now })
}

// Build the full dynamic catalogue across both franchises and media types.
// Returns { media, coverage } where coverage reports exactly what happened so a
// truncated / partial build is never dressed up as complete.
export async function buildFranchiseCatalogue({
  seeds = enabledSeeds(), now = Date.now(), window = DATE_WINDOW,
  storage, fetchImpl = globalThis.fetch, concurrency = DEFAULT_CONCURRENCY,
  maxPages = MAX_DISCOVER_PAGES, maxItems = MAX_CATALOGUE_ITEMS,
  includeOverrides, excludeOverrides,
} = {}) {
  const activeSeeds = enabledSeeds(seeds)
  const fetchOptions = { storage, fetchImpl, now, window, discoverTtlMs: undefined, detailTtlMs: undefined }

  const coverage = {
    seedsEnabled: activeSeeds.length,
    discovered: 0,
    confirmed: 0,
    rejected: 0,
    pagesFetched: 0,
    truncated: false,
    partial: false,
  }

  if (!activeSeeds.length) {
    // No verified seed -> empty catalogue. This is the keyless-sandbox state:
    // the feature is safely inert rather than guessing a static list.
    const includeMembers = await resolveIncludeOverrides({ includeOverrides, now, fetchOptions })
    return { media: applyExcludeOverrides(includeMembers, excludeOverrides), coverage }
  }

  const combos = [
    { franchise: FRANCHISE.MARVEL, mediaType: MEDIA_TYPE.MOVIE },
    { franchise: FRANCHISE.MARVEL, mediaType: MEDIA_TYPE.TV },
    { franchise: FRANCHISE.DC, mediaType: MEDIA_TYPE.MOVIE },
    { franchise: FRANCHISE.DC, mediaType: MEDIA_TYPE.TV },
  ]

  const confirmed = new Map() // key `${mediaType}:${id}` -> member (cross-seed dedup)
  for (const { franchise, mediaType } of combos) {
    const { candidates, pagesFetched, truncated } = await discoverFranchiseCandidates({
      franchise, mediaType, seeds: activeSeeds, window, now, fetchOptions, maxPages,
    })
    coverage.discovered += candidates.length
    coverage.pagesFetched += pagesFetched
    coverage.truncated = coverage.truncated || truncated

    const members = await mapWithConcurrency(
      candidates,
      (candidate) => confirmMembership({
        mediaType, mediaId: candidate.id, franchise, seeds: activeSeeds, now, fetchOptions,
      }),
      concurrency,
    )
    for (const member of members) {
      if (!member) { coverage.rejected += 1; continue }
      const key = `${member.mediaType}:${member.mediaId}`
      if (!confirmed.has(key)) confirmed.set(key, member)
    }
  }

  // Exceptional overrides: excludes remove confirmed false positives; includes
  // add verified metadata exceptions the dynamic pipeline cannot yet represent.
  const includeMembers = await resolveIncludeOverrides({ includeOverrides, now, fetchOptions })
  for (const member of includeMembers) {
    const key = `${member.mediaType}:${member.mediaId}`
    if (!confirmed.has(key)) confirmed.set(key, member)
  }

  // Deterministic ordering: franchise, then media type, then id.
  let media = applyExcludeOverrides([...confirmed.values()], excludeOverrides)
    .sort((a, b) => (
      a.franchise.localeCompare(b.franchise)
      || a.mediaType.localeCompare(b.mediaType)
      || a.mediaId - b.mediaId
    ))

  coverage.confirmed = media.length
  if (media.length > maxItems) {
    media = media.slice(0, maxItems)
    coverage.truncated = true
  }
  coverage.partial = coverage.truncated
  return { media, coverage }
}
