// Normalized tracked-show identity registry (Scope B).
//
// Entity resolution (Scope C) needs more than a raw show name to decide whether
// an article is really about a tracked show. This module turns each tracked show
// — plus any TMDB details already cached for it — into a normalized identity:
// canonical/original/alternative titles, first-air year, origin country,
// networks, known cast, and an ambiguity level that governs how much
// corroboration the classifier demands before it accepts a match.
//
// Cost discipline: this module is pure. It never fetches. Callers pass whatever
// TMDB details they already have (the discover client reuses the existing
// getShowDetails cache and only augments when cheap). A show with no details
// still produces a usable identity from its name alone.

import { normalizeText, stripLeadingArticle } from './textNormalize.js'

// Titles that are a single ordinary English word carry real false-positive risk
// ("Dark", "Industry", "Love", "Beef", "Sugar", "Evil", "Lost", "Found",
// "Wednesday", "Upload"). They can only match with corroborating identity
// evidence. This is a curated set of common words that also happen to be real
// show titles — it is intentionally small and maintainable, not an attempt to
// enumerate the dictionary. Any single-word title also gets 'weak' ambiguity
// below even if it is not in this list.
const COMMON_WORD_TITLES = new Set([
  'dark', 'industry', 'love', 'beef', 'sugar', 'evil', 'lost', 'found',
  'wednesday', 'upload',
])

// The most dangerous titles: a bare pronoun or preposition that appears in
// ordinary sentences with no relation to any show ("from", "you"). These require
// structural proof the word is being used AS a title, not merely corroboration.
const ULTRA_AMBIGUOUS_TITLES = new Set(['from', 'you'])

export const AMBIGUITY = Object.freeze({
  ULTRA: 'ultra', // pronoun/preposition — needs structural title evidence
  HIGH: 'high', // single common word — needs corroborating identity evidence
  WEAK: 'weak', // single distinctive-ish word — needs a TV-context signal
  DISTINCT: 'distinct', // multi-word or long title — matches directly
})

function classifyAmbiguity(normalizedTitle) {
  const words = normalizedTitle.split(' ').filter(Boolean)
  if (words.length === 1) {
    if (ULTRA_AMBIGUOUS_TITLES.has(words[0])) return AMBIGUITY.ULTRA
    if (COMMON_WORD_TITLES.has(words[0]) || words[0].length <= 4) return AMBIGUITY.HIGH
    return AMBIGUITY.WEAK
  }
  return AMBIGUITY.DISTINCT
}

function cleanTitle(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function yearFromDate(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/^(\d{4})/)
  return match ? Number(match[1]) : null
}

function uniqueNormalized(values) {
  return [...new Set(values.map(normalizeText).filter(Boolean))]
}

// Collect verified alternative titles from TMDB metadata only. We accept
// alt-title strings the caller sourced from TMDB (details.alternative_titles or
// a cached equivalent) — we NEVER synthesize aliases by dropping words. The one
// derived form we keep is the leading-article-stripped variant, and it is
// tagged as a weaker secondary signal, not a verified alias.
function collectAlternativeTitles(details) {
  const raw = []
  const alt = details?.alternative_titles
  if (Array.isArray(alt)) {
    for (const entry of alt) {
      if (typeof entry === 'string') raw.push(entry)
      else if (entry && typeof entry === 'object') raw.push(entry.title ?? entry.name)
    }
  } else if (Array.isArray(details?.alternativeTitles)) {
    raw.push(...details.alternativeTitles)
  }
  return uniqueNormalized(raw)
}

function collectCast(details) {
  const cast = details?.credits?.cast ?? details?.cast
  if (!Array.isArray(cast)) return []
  return uniqueNormalized(cast.map((member) => (typeof member === 'string' ? member : member?.name)))
    .slice(0, 30)
}

function collectNetworks(details) {
  const networks = details?.networks
  if (!Array.isArray(networks)) return []
  return uniqueNormalized(networks.map((n) => (typeof n === 'string' ? n : n?.name)))
}

// Build one normalized identity. `show` is the tracked-show row (tmdb_id + name
// at minimum); `details` is optional TMDB metadata already available for it.
export function buildShowIdentity(show, details = null) {
  const tmdbId = show?.tmdb_id ?? show?.id ?? details?.id ?? null
  const canonicalTitle = cleanTitle(show?.name ?? show?.title ?? details?.name)
  if (tmdbId == null || !canonicalTitle) return null

  const normalizedCanonical = normalizeText(canonicalTitle)
  const originalTitle = cleanTitle(details?.original_name ?? details?.originalTitle)
  const normalizedOriginal = normalizeText(originalTitle ?? '')

  const alternativeTitles = collectAlternativeTitles(details)
  // Verified forms the classifier may match against directly. The article-
  // stripped variant is stored separately (secondaryForms) so callers can weight
  // it lower, never as a verified alias.
  const primaryForms = uniqueNormalized([canonicalTitle, originalTitle, ...alternativeTitles])
  const secondaryForms = [...new Set(primaryForms.map(stripLeadingArticle).filter(Boolean))]
    .filter((form) => !primaryForms.includes(form))

  return {
    tmdbId,
    canonicalTitle,
    originalTitle: originalTitle ?? null,
    alternativeTitles,
    firstAirYear: yearFromDate(details?.first_air_date) ?? show?.first_air_year ?? null,
    originCountry: Array.isArray(details?.origin_country) ? details.origin_country : [],
    networks: collectNetworks(details),
    knownCast: collectCast(details),
    normalizedCanonical,
    normalizedOriginal: normalizedOriginal || null,
    primaryForms,
    secondaryForms,
    ambiguity: classifyAmbiguity(normalizedCanonical),
  }
}

// Build the registry for a set of tracked shows. `detailsById` is an optional
// map of tmdbId -> TMDB details (already cached), so we never fetch here.
// Returns { list, byId } for O(1) lookups plus deterministic iteration.
export function buildIdentityRegistry(trackedShows, detailsById = {}) {
  const list = []
  const byId = new Map()
  for (const show of Array.isArray(trackedShows) ? trackedShows : []) {
    const tmdbId = show?.tmdb_id ?? show?.id
    const identity = buildShowIdentity(show, detailsById?.[tmdbId] ?? detailsById?.[String(tmdbId)] ?? null)
    if (identity && !byId.has(identity.tmdbId)) {
      list.push(identity)
      byId.set(identity.tmdbId, identity)
    }
  }
  return { list, byId }
}
