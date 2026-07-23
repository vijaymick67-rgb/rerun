// Announcement acquisition PLAN + cache token (Scope B/C/M + Part 12).
//
// Shared by the server endpoint (api/discover/announcements.js) and the client
// (discoverClient.js) so both derive the SAME deterministic plan and cache token
// from the same code. Keeping it here (not in the api file) means the client
// bundle never imports the serverless handler.
//
// CANONICAL-FIRST COVERAGE: every tracked show's canonical title is scheduled
// before any alias. The upstream 200-character query limit and bounded request
// count are both enforced; anything that cannot fit is reported through
// partialCoverage + showsOmitted instead of being sent as an invalid query.
//
// OPAQUE PLAN ID (Blocker 2): the plan produces a stable, OPAQUE identifier — a
// SHA-256 digest (64 hex chars) of the normalized plan (SORTED scheduled canonical
// titles + SORTED scheduled aliases + vocabulary / schema / language versions).
//   * It is SHORT and CONSTANT-LENGTH regardless of library size, so a 120-show
//     library can never overflow the URL (the old Base64 token grew unbounded and
//     leaked every tracked title into the query string).
//   * It is OPAQUE: the id contains no show titles or aliases, so the URL no longer
//     exposes the tracked library.
//   * Equivalent plans (same shows in any received order) produce the SAME id and
//     therefore the SAME cacheable GET URL; different plans produce different ids.
// The id is NOT self-describing, so the server cannot reconstruct the query set
// from it alone — the normalized plan is stored server-side, keyed by the id, in a
// durable, server-accessible plan store (announcementPlanStore.js). A GET carries
// only the opaque id; the server looks up the stored terms. A forged / unknown /
// expired id resolves to nothing and triggers no upstream search (an explicit,
// recoverable PLAN_NOT_REGISTERED response tells the client to re-register).

export const MAX_ALIASES_PER_SHOW = 2 // verified alternative titles per show
export const MAX_TERMS_PER_QUERY = 8 // OR-batched title terms per query
export const MAX_QUERIES = 20 // hard request cap (bounds total upstream calls)
export const QUERY_CONCURRENCY = 4
export const GNEWS_MAX_PER_QUERY = 10
export const GNEWS_MAX_QUERY_LENGTH = 200
// Theoretical count ceiling across all queries. The character limit can produce
// a lower real capacity for long titles, which the coverage metadata reports.
export const TERM_BUDGET = MAX_QUERIES * MAX_TERMS_PER_QUERY // 160
export const MAX_SHOWS = TERM_BUDGET

// Bump these when the query vocabulary / plan schema / language changes so old
// cache tokens naturally stop matching.
export const ACQUISITION_SCHEMA_VERSION = 3
export const EVENT_VOCAB_VERSION = 2
export const ACQUISITION_LANG = 'en'

// Scope to the four allowed event categories only (renewal, cancellation, season
// date, cast addition). The client classifier does the precise work.
export const EVENT_CLAUSE =
  '(renewed OR canceled OR cancelled OR premiere OR "release date" OR cast OR joins)'

function quotePhrase(term) {
  return `"${String(term).replace(/["\\]+/g, ' ').trim()}"`
}

// Pack scheduled terms into bounded OR-batched queries, each ANDed with the shared
// event clause and never exceeding GNews's documented 200-character q limit.
// Pure — used both when planning and when rebuilding from a token.
function queryForTerms(terms) {
  const titleClause = `(${terms.map(quotePhrase).join(' OR ')})`
  return `${titleClause} AND ${EVENT_CLAUSE}`
}

function packTerms(terms) {
  const list = Array.isArray(terms) ? terms.filter((t) => typeof t === 'string' && t.trim()) : []
  const queries = []
  const scheduledTerms = []
  let current = []

  function flush() {
    if (!current.length || queries.length >= MAX_QUERIES) return
    queries.push(queryForTerms(current))
    scheduledTerms.push(...current)
    current = []
  }

  for (const term of list) {
    if (queries.length >= MAX_QUERIES) break
    const candidate = [...current, term]
    if (
      candidate.length <= MAX_TERMS_PER_QUERY
      && queryForTerms(candidate).length <= GNEWS_MAX_QUERY_LENGTH
    ) {
      current = candidate
      continue
    }
    flush()
    if (queries.length >= MAX_QUERIES) break
    if (queryForTerms([term]).length <= GNEWS_MAX_QUERY_LENGTH) current = [term]
  }
  flush()
  return { queries, scheduledTerms }
}

export function buildQueriesFromTerms(terms) {
  return packTerms(terms).queries
}

// Two-phase canonical-first scheduling. Returns the queries, the honest coverage
// plan, and the scheduled canonical/alias term lists (needed for the cache token).
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
  const candidateCanonicals = [...canonical]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, TERM_BUDGET)
  const remaining = Math.max(0, TERM_BUDGET - candidateCanonicals.length)
  const candidateAliases = [...aliasTerms]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, remaining)
  const { queries, scheduledTerms } = packTerms([...candidateCanonicals, ...candidateAliases])
  const scheduled = new Set(scheduledTerms.map((term) => term.toLowerCase()))
  const canonicalScheduled = candidateCanonicals
    .filter((term) => scheduled.has(term.toLowerCase()))
  const aliasesScheduled = candidateAliases
    .filter((term) => scheduled.has(term.toLowerCase()))
  const showsOmitted = canonical.length - canonicalScheduled.length
  const aliasesOmitted = aliasTerms.length - aliasesScheduled.length

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

// ---- Opaque plan id --------------------------------------------------------
// A well-formed plan id is exactly this: a lowercase 64-char SHA-256 hex digest.
// The server validates GET ids against it before any lookup, so garbage is a
// cheap 400 and a well-formed-but-unknown id is a cheap, recoverable 409.
export const PLAN_ID_PATTERN = /^[a-f0-9]{64}$/
export function isValidPlanId(id) {
  return typeof id === 'string' && PLAN_ID_PATTERN.test(id)
}

// The normalized plan: the canonical, order-independent description of a search
// plan. Sorting the term lists makes it identical for equivalent libraries. This
// is what gets stored server-side (keyed by the opaque id) and hashed into the id.
export function normalizedPlan({ canonicalScheduled = [], aliasesScheduled = [] } = {}) {
  return {
    v: ACQUISITION_SCHEMA_VERSION,
    ev: EVENT_VOCAB_VERSION,
    l: ACQUISITION_LANG,
    c: [...canonicalScheduled].filter((t) => typeof t === 'string').sort(),
    a: [...aliasesScheduled].filter((t) => typeof t === 'string').sort(),
  }
}

// The flat query terms a stored plan expands to (canonical first, then aliases) —
// used by the server GET path to rebuild the exact query set from the stored plan.
export function planTerms(plan) {
  const c = Array.isArray(plan?.c) ? plan.c.filter((t) => typeof t === 'string') : []
  const a = Array.isArray(plan?.a) ? plan.a.filter((t) => typeof t === 'string') : []
  return [...c, ...a]
}

// Deterministic serialization: fixed key order (v, ev, l, c, a) + sorted arrays,
// so equivalent plans serialize identically and hash to the same id.
function serializePlan(plan) {
  return JSON.stringify({ v: plan.v, ev: plan.ev, l: plan.l, c: plan.c, a: plan.a })
}

// Opaque, short, constant-length plan id = SHA-256 hex of the normalized plan.
// Uses Web Crypto (present in browsers on secure/localhost contexts and in Node
// 18+). Async because subtle.digest is async. `input` may be a normalizedPlan or
// the { canonicalScheduled, aliasesScheduled } shape.
export async function computePlanId(input, { subtle = globalThis.crypto?.subtle } = {}) {
  const plan = input && Array.isArray(input.c) ? input : normalizedPlan(input)
  const serialized = serializePlan(plan)
  if (subtle && typeof subtle.digest === 'function') {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(serialized))
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  // Defensive fallback (Web Crypto absent — e.g. an http non-secure context):
  // a deterministic, opaque 256-bit digest. Never self-describing.
  return fallbackDigest(serialized)
}

// A deterministic 256-bit hash assembled from eight independently-seeded FNV-1a
// passes, so it is 64 hex chars like SHA-256 and has a negligible collision rate
// across realistic plan counts. Only used when Web Crypto is unavailable.
function fallbackDigest(str) {
  const seeds = [0x811c9dc5, 0x01000193, 0xdeadbeef, 0xcafebabe, 0x9e3779b9, 0x7f4a7c15, 0x2545f491, 0x94d049bb]
  return seeds.map((seed) => {
    let h = seed >>> 0
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }).join('')
}

// One-shot plan for the client: coverage plan, the opaque id (for the cacheable
// GET URL), and the normalized plan + terms (for POST registration).
export async function planFromShows(shows, options = {}) {
  const { queries, plan, canonicalScheduled, aliasesScheduled } = buildAnnouncementQueries(shows)
  const normalized = normalizedPlan({ canonicalScheduled, aliasesScheduled })
  const planId = await computePlanId(normalized, options)
  return { queries, plan, planId, normalized, terms: planTerms(normalized) }
}
