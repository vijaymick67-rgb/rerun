// Announcement classifier (Scopes C, D, E, F) — deterministic, auditable, no
// external inference. Given a normalized news article and the tracked-show
// identity registry, decides whether the article is one of exactly four allowed
// announcement events (renewal, season_date, cancellation, cast_addition) for a
// tracked show, and returns a fully explained result.
//
// Staged pipeline (Scope D):
//   1. normalize article
//   2. reject disallowed article categories
//   3. resolve tracked-show identity (bounded, ambiguity-gated)
//   4. detect event type
//   5. detect negation / speculation
//   6. extract event details
//   7. validate freshness (source trust is scored, not a hard gate here)
//   8. assign confidence
//   9. reject below threshold
// (Deduplication is a later stage handled by announcementDedup.js.)

import { normalizeText, neighboursOfPhrase, containsPhrase, hasQuotedTitle, hasPossessiveBeforeTitle } from './textNormalize.js'
import { AMBIGUITY } from './identities.js'
import { resolveSourceTrust, TRUST_TIER } from './sourceTrust.js'
import {
  SPECULATION_TERMS, RENEWAL_NEGATION, CANCELLATION_NEGATION,
  RENEWAL_POSITIVE, CANCELLATION_POSITIVE, PLANNED_CONCLUSION,
  SEASON_DATE_POSITIVE, DATE_REJECTION, CAST_ADDITION_POSITIVE, CAST_REJECTION,
  DISALLOWED_CATEGORY, LISTICLE_SHAPE, SEASON_ORDINALS,
} from './eventPatterns.js'

export const EVENT_TYPES = Object.freeze(['renewal', 'season_date', 'cancellation', 'cast_addition'])

// Default freshness windows per event type (Scope G). Renewals/cancellations
// stay useful a little longer than a specific premiere-date announcement.
export const DEFAULT_FRESHNESS_MS = {
  renewal: 75 * 24 * 60 * 60 * 1000,
  cancellation: 75 * 24 * 60 * 60 * 1000,
  season_date: 90 * 24 * 60 * 60 * 1000,
  cast_addition: 60 * 24 * 60 * 60 * 1000,
}

export const CONFIDENCE_THRESHOLD = 0.6

const CONTEXT_SIGNAL = /\b(?:season|series|episode|premieres?|returns?|arrives?|debuts?|lands?|renew(?:s|ed|al)?|cancel(?:s|led|ed|lation)?|showrunner|finale|spinoff|streaming|casts?|casting|network|greenlit|revival|reboot|hbo|max|netflix|apple tv|prime video|disney|hulu|peacock|paramount|fx|amc|showtime|starz|bbc)\b/
const CAST_CONTEXT = /\b(?:cast|season|series|recurring|regular|show|ensemble|role|play|star)\b/
const SERIES_PHRASING = /\b(?:tv series|television series|netflix series|hbo (?:series|drama|max)|streaming series|drama series|comedy series|limited series|the series)\b/
const GENRE_NOUNS = new Set([
  'comedy', 'drama', 'thriller', 'horror', 'mystery', 'romance', 'fantasy', 'sci',
  'humor', 'humour', 'tone', 'twist', 'academy', 'ages', 'matter', 'web', 'mode',
])

function rejection(reasons, evidence = []) {
  return {
    accepted: false,
    showId: null,
    showName: null,
    eventType: null,
    seasonNumber: null,
    premiereDate: null,
    releaseWindow: null,
    personName: null,
    confidence: 0,
    evidence,
    rejectionReasons: Array.isArray(reasons) ? reasons : [reasons],
  }
}

// Split raw text into clauses so "definitive clause wins" (Scope F): a positive
// event in a clause that carries no negation/speculation is accepted even if
// another clause hedges. Splits on punctuation and on hedge-bearing connectives.
function splitClauses(rawText) {
  if (typeof rawText !== 'string' || !rawText) return []
  return rawText
    .split(/[.;:!?]|,| - |—|–|\bafter\b|\bbut\b|\bhowever\b|\bdespite\b|\bthough\b|\balthough\b|\bwhile\b/i)
    .map((segment) => normalizeText(segment))
    .filter(Boolean)
}

function anyMatch(patterns, text) {
  return patterns.some((pattern) => pattern.test(text))
}

// ---- Stage 2: disallowed categories -------------------------------------
function disallowedCategory(headlineNorm, descNorm) {
  if (anyMatch(DISALLOWED_CATEGORY, headlineNorm)) return 'disallowed_category_headline'
  if (anyMatch(LISTICLE_SHAPE, headlineNorm)) return 'listicle_shape'
  // Description only reinforces a few high-signal disallowed categories, never
  // the full list (a description mentioning "review" of another show shouldn't
  // sink a clean renewal headline).
  if (/\binterview\b|\brecap\b|\breview\b/.test(descNorm) && !CONTEXT_SIGNAL.test(headlineNorm)) {
    return 'disallowed_category_description'
  }
  return null
}

// ---- Stage 3: entity resolution -----------------------------------------
// Structural evidence for ULTRA titles (pronoun/preposition). Modeled on the
// stricter of the existing news matcher's rules.
const FROM_SUBJECT_VERBS = new Set([
  'renewed', 'renews', 'cancelled', 'canceled', 'axed', 'returns', 'premieres',
  'sets', 'adds', 'casts', 'boards', 'greenlit',
])
const FROM_VERB_CONNECTORS = new Set(['for', 'by', 'after', 'on', 'to', 'with', 'as'])
const YOU_AGREEMENT = new Set([
  'season', 'seasons', 'series', 'finale', 'premiere', 'premieres', 'spinoff',
  'showrunner', 'revival', 'reboot', 'sets', 'adds', 'casts', 'returns', 'renews', 'cancels',
])

function hasFromEvidence(rawTitle, headlineNorm) {
  if (hasQuotedTitle(rawTitle, 'from') || hasPossessiveBeforeTitle(rawTitle, 'from')) return true
  if (containsPhrase(headlineNorm, 'from season')) return true
  const words = headlineNorm.split(' ')
  return neighboursOfPhrase(headlineNorm, 'from').some(({ index }) => {
    const verb = words[index + 1]
    if (!verb || !FROM_SUBJECT_VERBS.has(verb)) return false
    const next = words[index + 2]
    // "From renewed for..." — a subject+verb reading requires a connector,
    // a season number, or a clause end after the verb. "from cancelled netflix
    // shows" (noun follows) fails this and stays a preposition.
    return !next || FROM_VERB_CONNECTORS.has(next) || /^\d+$/.test(next) || next === 'season'
  })
}

function hasYouEvidence(rawTitle, headlineNorm) {
  if (hasQuotedTitle(rawTitle, 'you') || hasPossessiveBeforeTitle(rawTitle, 'you')) return true
  const words = headlineNorm.split(' ')
  return neighboursOfPhrase(headlineNorm, 'you').some(({ index }) => {
    const after = words[index + 1]
    if (!after) return false
    if (YOU_AGREEMENT.has(after)) return true
    if (after === 'renewed' || after === 'cancelled' || after === 'canceled') {
      const next = words[index + 2]
      return next === 'for' || next === 'after'
    }
    return false
  })
}

function hasUltraEvidence(identity, rawTitle, headlineNorm) {
  if (identity.normalizedCanonical === 'from') return hasFromEvidence(rawTitle, headlineNorm)
  if (identity.normalizedCanonical === 'you') return hasYouEvidence(rawTitle, headlineNorm)
  return false
}

// Is a single-word title being used adjectivally ("dark comedy", "lost world")?
// If every occurrence is immediately followed by a genre/format noun, it is not
// a title reference.
function isAdjectivalUse(headlineNorm, form) {
  const occurrences = neighboursOfPhrase(headlineNorm, form)
  if (!occurrences.length) return false
  return occurrences.every(({ after }) => after && GENRE_NOUNS.has(after))
}

// Corroborating identity evidence for a HIGH/ULTRA title (Scope C).
function corroborators(identity, headlineNorm, contextNorm) {
  const found = []
  for (const network of identity.networks) {
    if (containsPhrase(contextNorm, network)) { found.push(`network:${network}`); break }
  }
  if (identity.firstAirYear && new RegExp(`\\b${identity.firstAirYear}\\b`).test(contextNorm)) {
    found.push(`year:${identity.firstAirYear}`)
  }
  for (const actor of identity.knownCast) {
    if (containsPhrase(contextNorm, actor)) { found.push(`cast:${actor}`); break }
  }
  // Season number grammatically attached to the title in the headline.
  const attachedSeason = neighboursOfPhrase(headlineNorm, identity.normalizedCanonical)
    .some(({ after }) => after === 'season')
  if (attachedSeason) found.push('season-attached')
  if (SERIES_PHRASING.test(contextNorm)) found.push('series-phrasing')
  return found
}

// Resolve the single tracked show this article's event belongs to, or null.
function resolveShow(identities, { rawTitle, headlineNorm, contextNorm }) {
  const headlineMatches = []
  for (const identity of identities) {
    let form = null
    let viaSecondary = false
    for (const primary of identity.primaryForms) {
      if (containsPhrase(headlineNorm, primary)) { form = primary; break }
    }
    if (!form) {
      for (const secondary of identity.secondaryForms) {
        if (containsPhrase(headlineNorm, secondary)) { form = secondary; viaSecondary = true; break }
      }
    }
    if (!form) continue
    // A single-word title used adjectivally is not a reference to the show.
    if (identity.normalizedCanonical.split(' ').length === 1 && isAdjectivalUse(headlineNorm, form)) continue
    headlineMatches.push({ identity, form, viaSecondary })
  }

  if (!headlineMatches.length) return { resolved: null, reason: 'no_title_in_headline' }

  // Multi-title headline (Scope C): more than one distinct tracked show named in
  // the headline is a roundup by default — reject unless exactly one survives
  // the ambiguity gate below AND the others are only weak/secondary noise.
  const gated = headlineMatches.map((match) => {
    const { identity, viaSecondary } = match
    // A secondary (article-stripped) match never stands alone — treat as HIGH.
    const effective = viaSecondary && identity.ambiguity === AMBIGUITY.DISTINCT
      ? AMBIGUITY.HIGH : identity.ambiguity
    const corr = corroborators(identity, headlineNorm, contextNorm)
    let passes = false
    const evidence = [`title:${match.form}`]
    if (effective === AMBIGUITY.DISTINCT) {
      passes = true
    } else if (effective === AMBIGUITY.WEAK) {
      passes = CONTEXT_SIGNAL.test(contextNorm)
      if (passes) evidence.push('context-signal')
    } else if (effective === AMBIGUITY.HIGH) {
      passes = corr.length >= 1
      evidence.push(...corr)
    } else if (effective === AMBIGUITY.ULTRA) {
      // Structural evidence (subject-verb, quoted, or possessive) is itself
      // strong proof the pronoun/preposition is being used as a title.
      passes = hasUltraEvidence(identity, rawTitle, headlineNorm)
      if (passes) evidence.push('structural')
      evidence.push(...corr)
    }
    return { ...match, effective, corr, passes, evidence }
  })

  const survivors = gated.filter((match) => match.passes)
  if (!survivors.length) return { resolved: null, reason: 'ambiguity_gate' }
  if (survivors.length > 1) return { resolved: null, reason: 'multi_title_roundup' }
  // Forms of every OTHER tracked show named in the headline — used to require
  // the event to be structurally attached to the resolved show when the
  // headline names more than one tracked title.
  const competingForms = headlineMatches
    .filter((match) => match.identity.tmdbId !== survivors[0].identity.tmdbId)
    .map((match) => match.form)
  return { resolved: survivors[0], reason: null, competingForms }
}

// ---- Stage 4 + 5: event detection with negation / speculation -----------
function clauseIsClean(clause, negationPatterns) {
  if (anyMatch(SPECULATION_TERMS, clause)) return false
  if (anyMatch(negationPatterns, clause)) return false
  return true
}

function detectRenewal(clauses) {
  for (const clause of clauses) {
    if (anyMatch(RENEWAL_POSITIVE, clause) && clauseIsClean(clause, RENEWAL_NEGATION)) {
      return { eventType: 'renewal', clause }
    }
  }
  return null
}

function detectCancellation(clauses) {
  for (const clause of clauses) {
    if (!anyMatch(CANCELLATION_POSITIVE, clause)) continue
    if (!clauseIsClean(clause, CANCELLATION_NEGATION)) continue
    const explicitCancel = /\bcancel(?:led|ed)\b|\baxed\b|\bscrapped\b|\bpulls the plug\b/.test(clause)
    // A planned final season / natural conclusion is not a cancellation unless
    // an explicit cancel verb is present in the same clause.
    if (!explicitCancel && anyMatch(PLANNED_CONCLUSION, clause)) continue
    return { eventType: 'cancellation', clause }
  }
  return null
}

function detectSeasonDate(clauses) {
  for (const clause of clauses) {
    if (!anyMatch(SEASON_DATE_POSITIVE, clause)) continue
    if (!clauseIsClean(clause, [])) continue
    if (anyMatch(DATE_REJECTION, clause)) continue
    return { eventType: 'season_date', clause }
  }
  return null
}

function detectCastAddition(clauses) {
  for (const clause of clauses) {
    if (!anyMatch(CAST_ADDITION_POSITIVE, clause)) continue
    // A generic "joins"/"boards" only counts as a cast addition when a
    // cast-context word shares the clause — never "joins the conversation".
    if (!CAST_CONTEXT.test(clause)) continue
    if (!clauseIsClean(clause, [])) continue
    if (anyMatch(CAST_REJECTION, clause)) continue
    return { eventType: 'cast_addition', clause }
  }
  return null
}

// Detection order is deterministic; a headline that genuinely carries two event
// types resolves to the first in this precedence, which is rare in practice for
// a single show.
function detectEvent(clauses) {
  return detectRenewal(clauses)
    || detectCancellation(clauses)
    || detectSeasonDate(clauses)
    || detectCastAddition(clauses)
    || null
}

// ---- Stage 6: detail extraction -----------------------------------------
function extractSeasonNumber(text) {
  const digit = text.match(/\bseason (\d{1,2})\b/)
  if (digit) return Number(digit[1])
  const ordinalWord = text.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth) season\b/)
  if (ordinalWord) return SEASON_ORDINALS[ordinalWord[1]]
  const ordered = text.match(/\bordered (?:a )?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/)
  if (ordered) return SEASON_ORDINALS[ordered[1]]
  return null
}

const MONTHS_LIST = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december']

function extractDate(text) {
  const monthDay = text.match(new RegExp(`\\b(${MONTHS_LIST.join('|')}) (\\d{1,2})(?: (\\d{4}))?\\b`))
  if (monthDay) {
    const month = monthDay[1][0].toUpperCase() + monthDay[1].slice(1)
    return { premiereDate: `${month} ${monthDay[2]}${monthDay[3] ? `, ${monthDay[3]}` : ''}`, releaseWindow: null }
  }
  const monthYear = text.match(new RegExp(`\\b(${MONTHS_LIST.join('|')}) (\\d{4})\\b`))
  if (monthYear) {
    const month = monthYear[1][0].toUpperCase() + monthYear[1].slice(1)
    return { premiereDate: null, releaseWindow: `${month} ${monthYear[2]}` }
  }
  const quarter = text.match(/\b(q[1-4]) (\d{4})\b/)
  if (quarter) return { premiereDate: null, releaseWindow: `${quarter[1].toUpperCase()} ${quarter[2]}` }
  const season = text.match(/\b(spring|summer|fall|autumn|winter) (\d{4})\b/)
  if (season) return { premiereDate: null, releaseWindow: `${season[1][0].toUpperCase() + season[1].slice(1)} ${season[2]}` }
  const relSeason = text.match(/\b(?:this|next) (spring|summer|fall|autumn|winter)\b/)
  if (relSeason) return { premiereDate: null, releaseWindow: relSeason[1][0].toUpperCase() + relSeason[1].slice(1) }
  const earlyLate = text.match(/\b(early|late) (\d{4})\b/)
  if (earlyLate) return { premiereDate: null, releaseWindow: `${earlyLate[1][0].toUpperCase() + earlyLate[1].slice(1)} ${earlyLate[2]}` }
  return { premiereDate: null, releaseWindow: null }
}

// Extract a named person for a cast addition from the RAW title (capitalization
// is the signal). Requires a plausible two-token proper name to avoid accepting
// a bare verb phrase.
function extractPersonName(rawTitle, showCanonical) {
  if (typeof rawTitle !== 'string') return null
  const matches = rawTitle.match(/\b([A-Z][a-z]+(?:['’-][A-Za-z]+)?(?: [A-Z][a-z.]+){1,2})\b/g)
  if (!matches) return null
  const showWords = new Set(normalizeText(showCanonical).split(' '))
  for (const candidate of matches) {
    const norm = normalizeText(candidate)
    // Skip a candidate that is just the show's own title words.
    if (norm.split(' ').every((word) => showWords.has(word))) continue
    return candidate
  }
  return null
}

// ---- Stage 7: freshness --------------------------------------------------
function freshnessMs(eventType, overrides) {
  return (overrides && overrides[eventType]) || DEFAULT_FRESHNESS_MS[eventType]
}

function isFresh(publishedAt, eventType, now, overrides) {
  const published = Date.parse(publishedAt)
  if (!Number.isFinite(published)) return false
  if (published - now > 48 * 60 * 60 * 1000) return false // impossible future date
  return now - published <= freshnessMs(eventType, overrides)
}

// ---- Stage 8: confidence -------------------------------------------------
function scoreConfidence({ effective, corr, tier, hasDetail, eventType }) {
  let score = 0.5
  if (tier === TRUST_TIER.OFFICIAL) score += 0.2
  else if (tier === TRUST_TIER.TRADE) score += 0.12
  if (effective === AMBIGUITY.DISTINCT) score += 0.18
  else if (effective === AMBIGUITY.WEAK) score += 0.08
  else score += Math.min(0.15, 0.05 * corr.length)
  if (hasDetail) score += 0.1
  // Tier 3 with a non-distinct title can never clear the bar on language alone.
  if (tier === TRUST_TIER.OTHER && effective !== AMBIGUITY.DISTINCT) score -= 0.22
  // cast_addition without a named person is impossible; guarded elsewhere.
  if (eventType === 'cast_addition' && !hasDetail) score -= 0.15
  return Math.max(0, Math.min(1, score))
}

// Main entry point. `identityRegistry` is { list, byId } from buildIdentityRegistry.
export function classifyAnnouncement(article, identityRegistry, options = {}) {
  const now = options.now ?? Date.now()
  const identities = identityRegistry?.list ?? []
  if (!article || typeof article !== 'object' || !article.title) return rejection('invalid_article')

  const rawTitle = String(article.title)
  const headlineNorm = normalizeText(rawTitle)
  const descNorm = normalizeText(article.description ?? '')
  const contextNorm = normalizeText(`${rawTitle} ${article.description ?? ''} ${article.sourceName ?? ''}`)
  if (!headlineNorm) return rejection('empty_headline')

  const evidence = []

  // Stage 2
  const category = disallowedCategory(headlineNorm, descNorm)
  if (category) return rejection(category, evidence)

  // Stage 3
  const { resolved, reason, competingForms = [] } = resolveShow(identities, { rawTitle, headlineNorm, contextNorm })
  if (!resolved) return rejection(reason ?? 'entity_unresolved', evidence)
  evidence.push(...resolved.evidence)

  // Stage 4 + 5 — event detection uses headline clauses (primary surface).
  const clauses = splitClauses(rawTitle)
  const event = detectEvent(clauses)
  if (!event) return rejection('no_allowed_event', evidence)
  evidence.push(`event:${event.eventType}`, `clause:${event.clause}`)

  // When the headline names more than one tracked show, the event must be
  // structurally attached to the resolved show — i.e. its title form appears in
  // the same clause as the event language. This stops a date/renewal belonging
  // to another title in the headline from being credited to this show (Scope C).
  if (competingForms.length && !containsPhrase(event.clause, resolved.form)) {
    return rejection('event_not_attached_to_show', evidence)
  }

  // Description-level contradiction of the detected event (Scope C/F).
  const eventNegation = event.eventType === 'renewal' ? RENEWAL_NEGATION
    : event.eventType === 'cancellation' ? CANCELLATION_NEGATION : []
  if (eventNegation.length && anyMatch(eventNegation, descNorm)) {
    return rejection('description_contradicts_event', evidence)
  }

  // Stage 6 — details.
  const seasonNumber = extractSeasonNumber(event.clause) ?? extractSeasonNumber(headlineNorm)
  const { premiereDate, releaseWindow } = event.eventType === 'season_date'
    ? extractDate(event.clause) : { premiereDate: null, releaseWindow: null }
  const personName = event.eventType === 'cast_addition'
    ? extractPersonName(rawTitle, resolved.identity.canonicalTitle) : null

  // A cast addition MUST name a person; a season_date MUST have a concrete
  // date or window — otherwise the "event" is not really actionable.
  if (event.eventType === 'cast_addition' && !personName) return rejection('cast_addition_no_person', evidence)
  if (event.eventType === 'season_date' && !premiereDate && !releaseWindow) return rejection('season_date_no_window', evidence)

  // Stage 7 — freshness.
  if (!isFresh(article.publishedAt, event.eventType, now, options.freshnessMs)) {
    return rejection('stale', evidence)
  }

  // Stage 8 + 9 — confidence and threshold.
  const tier = resolveSourceTrust(article)
  const hasDetail = Boolean(seasonNumber || premiereDate || releaseWindow || personName)
  const confidence = scoreConfidence({
    effective: resolved.effective, corr: resolved.corr, tier, hasDetail, eventType: event.eventType,
  })
  evidence.push(`tier:${tier}`, `confidence:${confidence.toFixed(2)}`)
  if (confidence < CONFIDENCE_THRESHOLD) return rejection('below_confidence_threshold', evidence)

  return {
    accepted: true,
    showId: resolved.identity.tmdbId,
    showName: resolved.identity.canonicalTitle,
    eventType: event.eventType,
    seasonNumber: seasonNumber ?? null,
    premiereDate: premiereDate ?? null,
    releaseWindow: releaseWindow ?? null,
    personName: personName ?? null,
    confidence,
    evidence,
    rejectionReasons: [],
  }
}
