// Marvel / DC catalogue strategy (Scope J — the ONLY catalogue exception beyond
// tracked shows).
//
// Requirement: in addition to tracked shows, the Trailers feed includes official
// trailers/teasers for Marvel TV, Marvel movies, DC TV, and DC movies — and
// NOTHING broader (not all of Disney, not all of Warner Bros., not "superhero
// media" by keyword).
//
// Design decision (precision-first, auditable):
//   * Franchise membership is decided ONLY by TMDB's own production-company
//     attribution, obtained via /discover/{movie,tv}?with_companies=<verified
//     ids>. We never classify a title as Marvel/DC from its name or synopsis.
//   * The company-id set is a small, isolated, explicitly documented
//     configuration layer. Each id records what it represents.
//   * Deliberately broad parent companies (Walt Disney Studios, Warner Bros.,
//     Warner Bros. Discovery) are listed in EXCLUDED_BROAD_COMPANY_IDS and are
//     NEVER queried — using them would pull unrelated catalogues.
//
// HONEST VERIFICATION STATUS: these ids are the well-known, widely-documented
// TMDB company ids for these entities, but they were NOT verified against a live
// TMDB response in this build environment (no TMDB key available here). Every
// entry is therefore flagged `verified: false`. `assertVerifiedBeforeProduction`
// and the discover client's guard mean the Marvel/DC exception stays DISABLED
// until an id is confirmed live (see docs/discover-engine.md). This is the
// "clearly report the limitation rather than guessing" path the task requires.

export const FRANCHISE = Object.freeze({ MARVEL: 'marvel', DC: 'dc' })

// Each entry: { id, label, mediaScope, verified }.
//   mediaScope documents what kind of screen media the company id covers.
export const MARVEL_COMPANY_IDS = [
  { id: 420, label: 'Marvel Studios', mediaScope: 'movie+tv (MCU films & Disney+ series)', verified: false },
  { id: 7505, label: 'Marvel Entertainment', mediaScope: 'movie+tv (older Marvel productions)', verified: false },
  { id: 19551, label: 'Marvel Studios (secondary attribution seen on some titles)', mediaScope: 'movie+tv', verified: false },
]

export const DC_COMPANY_IDS = [
  { id: 429, label: 'DC Comics', mediaScope: 'movie+tv (source-material attribution)', verified: false },
  { id: 9993, label: 'DC Entertainment', mediaScope: 'movie+tv', verified: false },
  { id: 128064, label: 'DC Studios', mediaScope: 'movie+tv (current DCU)', verified: false },
]

// Explicitly NOT used. Documented so a future maintainer does not "helpfully"
// add them: each of these pulls a vast unrelated catalogue.
export const EXCLUDED_BROAD_COMPANY_IDS = Object.freeze([
  { id: 2, label: 'Walt Disney Pictures', why: 'all Disney film output' },
  { id: 3, label: 'Pixar', why: 'unrelated animation' },
  { id: 174, label: 'Warner Bros. Pictures', why: 'all Warner film output' },
  { id: 128, label: 'Warner Bros. Television (broad)', why: 'all WB TV output' },
  { id: 6704, label: 'The Walt Disney Company (broad)', why: 'entire Disney conglomerate' },
])

function idsFor(franchise) {
  if (franchise === FRANCHISE.MARVEL) return MARVEL_COMPANY_IDS
  if (franchise === FRANCHISE.DC) return DC_COMPANY_IDS
  return []
}

export function companyIdList(franchise) {
  return idsFor(franchise).map((entry) => entry.id)
}

// Is `id` one of our configured Marvel/DC company ids (and NOT a broad-excluded
// one)? Used to double-check discover results actually came from a configured
// company, and to keep the excluded ids from ever leaking in.
export function isConfiguredCompanyId(id) {
  const excluded = new Set(EXCLUDED_BROAD_COMPANY_IDS.map((e) => e.id))
  if (excluded.has(id)) return false
  return [...MARVEL_COMPANY_IDS, ...DC_COMPANY_IDS].some((entry) => entry.id === id)
}

// Build the /discover query params for one franchise + media type. Company ids
// are OR-joined with '|' per TMDB discover syntax. Freshness / sort params are
// added by the caller (the discover client), not here.
export function buildDiscoverParams({ franchise, mediaType }) {
  const ids = companyIdList(franchise)
  if (!ids.length) return null
  const type = mediaType === 'movie' ? 'movie' : 'tv'
  return {
    path: `/discover/${type}`,
    params: {
      with_companies: ids.join('|'),
      include_adult: 'false',
      sort_by: type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc',
    },
  }
}

// Given a media item returned by a franchise discover query, confirm it belongs
// by TMDB's own attribution before tagging it. `item.production_company_ids` (or
// an equivalent shape the caller supplies from details) must intersect our
// configured company ids. Title/synopsis are intentionally ignored.
export function classifyFranchiseMedia(item, franchise) {
  const configured = new Set(companyIdList(franchise))
  const attributed = Array.isArray(item?.production_company_ids)
    ? item.production_company_ids
    : Array.isArray(item?.production_companies)
      ? item.production_companies.map((c) => (typeof c === 'number' ? c : c?.id))
      : null
  // When the caller trusts the discover query's own company filter (the item
  // came directly from buildDiscoverParams), attribution may be omitted — but if
  // attribution IS provided, it must intersect, or the item is rejected.
  if (attributed && attributed.length) {
    if (!attributed.some((id) => configured.has(id))) return null
  } else if (item?.__fromDiscover !== true) {
    // No attribution and not sourced from a company-filtered discover query ->
    // we cannot safely confirm franchise membership. Reject rather than guess.
    return null
  }
  return { ...item, franchise }
}

// Verification helper (Scope J). Throws if the caller tries to use the Marvel/DC
// catalogue while any configured id is still unverified — the discover client
// calls this so the exception cannot silently ship on unverified ids.
export function assertVerifiedBeforeProduction() {
  const unverified = [...MARVEL_COMPANY_IDS, ...DC_COMPANY_IDS].filter((entry) => !entry.verified)
  if (unverified.length) {
    const error = new Error('marvel_dc_ids_unverified')
    error.unverified = unverified.map((entry) => `${entry.id} (${entry.label})`)
    throw error
  }
}

export function isMarvelDcEnabled() {
  try {
    assertVerifiedBeforeProduction()
    return true
  } catch {
    return false
  }
}
