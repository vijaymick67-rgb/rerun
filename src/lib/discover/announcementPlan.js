// Announcement acquisition PLAN + cache token (Scope B/C/M + Part 12).
//
// Shared by the server endpoint (api/discover/announcements.js) and the client
// (discoverClient.js) so both derive the SAME deterministic plan and cache token
// from the same code. Keeping it here (not in the api file) means the client
// bundle never imports the serverless handler.
//
// GUARANTEED CANONICAL COVERAGE (unchanged, Part 13): every tracked show's
// canonical title is scheduled into the shared term budget BEFORE any alias, so a
// large library's later shows are never silently dropped for an earlier show's
// alias. Beyond the budget the plan reports partialCoverage + showsOmitted.
//
// CACHE TOKEN (Part 12): the plan produces a stable, self-describing token from
// the SORTED scheduled canonical titles + SORTED scheduled aliases + vocabulary /
// schema / language versions. Equivalent search plans (same shows in any received
// order) therefore yield the SAME token — and the same cacheable GET URL — so the
// Vercel edge CDN serves repeat requests with zero upstream GNews calls. The token
// is self-describing: the server decodes it to rebuild the exact query set (it is
// the authority on the token), while the client computes the same token to form
// the cacheable URL without an extra round-trip.

export const MAX_ALIASES_PER_SHOW = 2 // verified alternative titles per show
export const MAX_TERMS_PER_QUERY = 8 // OR-batched title terms per query
export const MAX_QUERIES = 20 // hard request cap (bounds total upstream calls)
export const QUERY_CONCURRENCY = 4
export const GNEWS_MAX_PER_QUERY = 10
// Total term capacity across ALL queries. Canonicals fill it first; complete
// canonical coverage is guaranteed for up to TERM_BUDGET tracked shows.
export const TERM_BUDGET = MAX_QUERIES * MAX_TERMS_PER_QUERY // 160
export const MAX_SHOWS = TERM_BUDGET

// Bump these when the query vocabulary / plan schema / language changes so old
// cache tokens naturally stop matching.
export const ACQUISITION_SCHEMA_VERSION = 2
export const EVENT_VOCAB_VERSION = 1
export const ACQUISITION_LANG = 'en'

// Scope to the four allowed event categories only (renewal, cancellation, season
// date, cast addition). The client classifier does the precise work.
export const EVENT_CLAUSE = '(renewed OR renewal OR canceled OR cancelled OR "final season" OR premiere OR premieres OR "release date" OR "joins the cast" OR "cast")'

function quotePhrase(term) {
  return `"${String(term).replace(/["\\]+/g, ' ').trim()}"`
}

// Pack scheduled terms into bounded OR-batched queries, each ANDed with the shared
// event clause. Pure — used both when planning and when rebuilding from a token.
export function buildQueriesFromTerms(terms) {
  const list = Array.isArray(terms) ? terms.filter((t) => typeof t === 'string' && t.trim()) : []
  const queries = []
  for (let i = 0; i < list.length; i += MAX_TERMS_PER_QUERY) {
    const slice = list.slice(i, i + MAX_TERMS_PER_QUERY)
    const titleClause = `(${slice.map(quotePhrase).join(' OR ')})`
    queries.push(`${titleClause} AND ${EVENT_CLAUSE}`)
  }
  return queries
}

// Two-phase term scheduling with guaranteed canonical coverage. Returns the
// queries, the coverage plan, and the scheduled canonical/alias term lists (needed
// to build the cache token).
export function buildAnnouncementQueries(shows) {
  const rawList = Array.isArray(shows) ? shows : []
  const seen = new Set()

  // Phase 1 — every canonical title first (deduped), independent of aliases.
  const canonical = []
  let showsReceived = 0
  for (const show of rawList) {
    const title = typeof show?.title === 'string' ? show.title.trim() : ''
    if (!title) continue
    showsReceived += 1
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    canonical.push(title)
  }

  // Phase 2 — capped verified aliases, only AFTER all canonicals are collected.
  const aliasTerms = []
  for (const show of rawList) {
    const title = typeof show?.title === 'string' ? show.title.trim() : ''
    if (!title) continue
    const aliases = Array.isArray(show?.aliases) ? show.aliases : []
    let used = 0
    for (const rawAlias of aliases) {
      if (used >= MAX_ALIASES_PER_SHOW) break
      const alias = typeof rawAlias === 'string' ? rawAlias.trim() : ''
      if (!alias) continue
      const key = alias.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      aliasTerms.push(alias)
      used += 1
    }
  }

  // Phase 3 — schedule into the shared budget: canonicals first, aliases fill the
  // remainder. Canonicals beyond the budget are omitted (partial coverage).
  const canonicalScheduled = canonical.slice(0, TERM_BUDGET)
  const showsOmitted = canonical.length - canonicalScheduled.length
  const remaining = Math.max(0, TERM_BUDGET - canonicalScheduled.length)
  const aliasesScheduled = aliasTerms.slice(0, remaining)
  const aliasesOmitted = aliasTerms.length - aliasesScheduled.length
  const queries = buildQueriesFromTerms([...canonicalScheduled, ...aliasesScheduled])

  const plan = {
    showsReceived,
    canonicalTitlesSearched: canonicalScheduled.length,
    aliasesSearched: aliasesScheduled.length,
    aliasesOmitted,
    showsOmitted,
    partialCoverage: showsOmitted > 0,
  }
  return { queries, plan, canonicalScheduled, aliasesScheduled }
}

// ---- Cache token -----------------------------------------------------------
function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(token) {
  const b64 = String(token).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

// Stable token from SORTED scheduled terms + versions. Sorting makes the token
// order-independent so equivalent libraries share one cache entry.
export function buildPlanToken({ canonicalScheduled = [], aliasesScheduled = [] } = {}) {
  const payload = {
    v: ACQUISITION_SCHEMA_VERSION,
    ev: EVENT_VOCAB_VERSION,
    l: ACQUISITION_LANG,
    c: [...canonicalScheduled].sort(),
    a: [...aliasesScheduled].sort(),
  }
  return toBase64Url(JSON.stringify(payload))
}

// Decode a token back to its terms. Returns null on any corruption (the endpoint
// treats that as a cache miss and re-plans rather than crashing).
export function decodePlanToken(token) {
  try {
    const parsed = JSON.parse(fromBase64Url(token))
    if (!parsed || parsed.v !== ACQUISITION_SCHEMA_VERSION) return null
    const canonical = Array.isArray(parsed.c) ? parsed.c.filter((t) => typeof t === 'string') : []
    const aliases = Array.isArray(parsed.a) ? parsed.a.filter((t) => typeof t === 'string') : []
    return { canonical, aliases, terms: [...canonical, ...aliases] }
  } catch {
    return null
  }
}

// One-shot plan for the client: queries (not used client-side), coverage plan, and
// the cache token that forms the cacheable GET URL.
export function planFromShows(shows) {
  const { queries, plan, canonicalScheduled, aliasesScheduled } = buildAnnouncementQueries(shows)
  return { queries, plan, token: buildPlanToken({ canonicalScheduled, aliasesScheduled }) }
}
