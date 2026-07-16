// A single-word title (Sugar, Beef, You, From, Dark, Lucky…) is inherently ambiguous —
// it can only match when the headline names it AND the surrounding text carries real
// TV-production context. Multi-word titles are distinctive enough to match directly.
const CONTEXT_SIGNAL = /\b(?:season|seasons|series|episode|episodes|premiere|premieres|premiered|renew|renews|renewed|renewal|cancel|cancels|cancelled|canceled|cancellation|trailer|showrunner|finale|spinoff|streaming|stream|cast|casts|casting|network|debut|debuts|greenlit|greenlight|revival|reboot|hbo|max|netflix|apple tv|prime video|disney|hulu|peacock|paramount|fx|amc|showtime|starz|bbc|itv|mgm)\b/

// Some single-word titles aren't just ambiguous — they're ordinary grammatical words
// ("from", "you") that show up constantly in headlines with no relation to the show at
// all ("Actor from Netflix series joins season 2 cast"). For these, a generic TV-context
// word appearing *anywhere* in the headline/body is not enough evidence, because that
// context can belong to a completely different subject. These titles require structural
// proof the word is being used *as a title* — see hasTitleStructuralEvidence below.
const ULTRA_AMBIGUOUS_TITLES = new Set(['from', 'you'])

// Words that, appearing immediately next to "From" (touching it, not merely present
// somewhere in the same sentence), mark it as a production noun rather than a
// preposition: "From renewed", "From season 4", "the series From". Deliberately
// excludes generic nouns like platform names, or "cast"/"trailer", that commonly
// precede "from" in ordinary sentences ("a trailer from Netflix", "cast from your
// phone") — those describe something else entirely, not the show.
const FROM_ADJACENCY_SIGNAL = new Set([
  'season', 'seasons', 'series', 'renew', 'renews', 'renewed', 'renewal',
  'cancel', 'cancels', 'cancelled', 'canceled', 'cancellation', 'finale',
  'premiere', 'premieres', 'premiered', 'casts', 'casting',
  'spinoff', 'showrunner', 'greenlit', 'reboot', 'revival', 'returns', 'sets', 'adds',
])

// "You" is not just ambiguous, it's a second-person pronoun — so unlike "From", a bare
// production verb sitting next to it proves nothing: "Have you renewed your Netflix
// subscription?" and "You Renewed Netflix" both place "renewed" directly next to "you"
// while talking to the reader, not about a show. Two narrower, grammar-driven signals
// are used instead of a plain adjacency word list:
//  1. Subject-verb agreement — a third-person singular ("-s") verb form directly after
//     "you" is ungrammatical for the pronoun (you set/add/cast/return/renew/cancel, never
//     "you sets"), so seeing one means "you" is standing in for a proper noun instead.
//  2. The "renewed for" / "cancelled for" renewal-announcement idiom — "renewed" and
//     "cancelled" are past tense and so look identical for any subject, but immediately
//     followed by "for"/"after" they are the standard trade-press phrasing ("You renewed
//     for a final season"), a construction ordinary second-person sentences don't produce.
const YOU_AGREEMENT_SIGNAL = new Set([
  'season', 'seasons', 'series', 'finale', 'premiere', 'premieres',
  'spinoff', 'showrunner', 'revival', 'reboot', 'cancellation', 'renewal',
  'sets', 'adds', 'casts', 'returns', 'renews', 'cancels',
])
const YOU_ANNOUNCEMENT_VERBS = new Set(['renewed', 'cancelled', 'canceled'])
const YOU_ANNOUNCEMENT_FOLLOWERS = new Set(['for', 'after'])

const QUOTE_CHAR_PATTERN = '[\'"‘’“”]'

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A title wrapped in quotes ("'From' adds new series regular") is, by construction, a
// named thing rather than a word used in its ordinary grammatical sense — this checks
// the raw (pre-normalization) headline, since normalizeNewsText strips quote characters.
function hasQuotedTitle(rawHeadline, title) {
  if (typeof rawHeadline !== 'string' || !rawHeadline) return false
  const escaped = title.split(' ').map(escapeRegExp).join('\\s+')
  return new RegExp(`${QUOTE_CHAR_PATTERN}\\s*${escaped}\\s*${QUOTE_CHAR_PATTERN}`, 'i').test(rawHeadline)
}

// A possessive platform/network construction ("Netflix's You", "MGM+'s From") names the
// title as a thing the platform owns, never as a pronoun/preposition. Checked against the
// raw headline because the apostrophe is what carries the meaning, and normalizeNewsText
// strips it (splitting "Netflix's" into separate "netflix"/"s" tokens).
function hasPossessiveBeforeTitle(rawHeadline, title) {
  if (typeof rawHeadline !== 'string' || !rawHeadline) return false
  const escaped = title.split(' ').map(escapeRegExp).join('\\s+')
  return new RegExp(`\\b[a-z0-9+]+['’]s\\s+${escaped}\\b`, 'i').test(rawHeadline)
}

function indicesOfPhrase(words, phraseWords) {
  const indices = []
  for (let i = 0; i <= words.length - phraseWords.length; i += 1) {
    if (phraseWords.every((word, offset) => words[i + offset] === word)) indices.push(i)
  }
  return indices
}

// True when a FROM_ADJACENCY_SIGNAL word directly touches "from"'s occurrence in the
// headline — "From season 4" or "the series From" — rather than merely co-occurring
// somewhere in the same headline, which is what let "Actor from Netflix series joins
// season 2 cast" slip through before.
function hasFromTitleEvidence(rawHeadline, normalizedHeadline, title) {
  const words = normalizedHeadline.split(' ').filter(Boolean)
  const phraseWords = title.split(' ')
  const adjacent = indicesOfPhrase(words, phraseWords).some((index) => {
    const before = index > 0 ? words[index - 1] : null
    const after = index + phraseWords.length < words.length ? words[index + phraseWords.length] : null
    return (before && FROM_ADJACENCY_SIGNAL.has(before)) || (after && FROM_ADJACENCY_SIGNAL.has(after))
  })
  return adjacent || hasQuotedTitle(rawHeadline, title) || hasPossessiveBeforeTitle(rawHeadline, title)
}

// "You" only accepts right-adjacency (never left — "the series you watched" is ordinary
// relative-clause grammar, not a title introduction) and only the two narrower signals
// described above, plus quoted/possessive evidence.
function hasYouTitleEvidence(rawHeadline, normalizedHeadline) {
  if (hasQuotedTitle(rawHeadline, 'you') || hasPossessiveBeforeTitle(rawHeadline, 'you')) return true
  const words = normalizedHeadline.split(' ').filter(Boolean)
  return indicesOfPhrase(words, ['you']).some((index) => {
    const after = index + 1 < words.length ? words[index + 1] : null
    if (!after) return false
    if (YOU_AGREEMENT_SIGNAL.has(after)) return true
    if (YOU_ANNOUNCEMENT_VERBS.has(after)) {
      const next = index + 2 < words.length ? words[index + 2] : null
      return Boolean(next && YOU_ANNOUNCEMENT_FOLLOWERS.has(next))
    }
    return false
  })
}

// Ultra-ambiguous titles need proof the word is functioning as a title in the headline
// itself — a generic context word anywhere in the headline/body (the ordinary weak-title
// rule) isn't enough, because "from"/"you" appear constantly with no relation to the show.
// Each title gets its own rule rather than a shared one, because the grammar of a
// preposition ("from") and a second-person pronoun ("you") fail in different ways.
function hasTitleStructuralEvidence(rawHeadline, normalizedHeadline, title) {
  if (title === 'you') return hasYouTitleEvidence(rawHeadline, normalizedHeadline)
  return hasFromTitleEvidence(rawHeadline, normalizedHeadline, title)
}

export function normalizeNewsText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
    : ''
}

function titleVariants(show) {
  const raw = [show?.name, show?.title, show?.original_name, show?.originalTitle,
    ...(Array.isArray(show?.alternateTitles) ? show.alternateTitles : [])]
  return [...new Set(raw.map(normalizeNewsText).filter(Boolean))]
}

function phraseIn(text, phrase) {
  return (` ${text} `).includes(` ${phrase} `)
}

function titleInHeadline(headline, title) {
  return phraseIn(headline, title)
}

export function matchArticleToTrackedShow(article, trackedShows = []) {
  if (!article || typeof article !== 'object' || !normalizeNewsText(article.title)) {
    return { matched: false, showId: null, showName: null, confidence: 'none' }
  }
  const headline = normalizeNewsText(article.title)
  const body = normalizeNewsText(`${article.description ?? ''} ${article.sourceName ?? ''}`)
  const candidates = []

  for (const show of Array.isArray(trackedShows) ? trackedShows : []) {
    const variants = titleVariants(show)
    for (const variant of variants) {
      const words = variant.split(' ')
      const headlineMatch = titleInHeadline(headline, variant)
      const contextMatch = phraseIn(body, variant)
      const isWeakTitle = words.length === 1
      const isUltraAmbiguous = isWeakTitle && ULTRA_AMBIGUOUS_TITLES.has(variant)
      if (isUltraAmbiguous) {
        if (!headlineMatch || !hasTitleStructuralEvidence(article.title, headline, variant)) continue
      } else if (isWeakTitle) {
        if (!headlineMatch || !CONTEXT_SIGNAL.test(`${headline} ${body}`)) continue
      } else if (!headlineMatch && !contextMatch) {
        continue
      }
      candidates.push({
        show,
        variant,
        headlineMatch,
        score: (headlineMatch ? 1000 : 100) + words.length * 20 + variant.length,
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score || String(a.show?.tmdb_id ?? a.show?.id)
    .localeCompare(String(b.show?.tmdb_id ?? b.show?.id)))
  const best = candidates[0]
  return best ? {
    matched: true,
    showId: best.show?.tmdb_id ?? best.show?.id ?? null,
    showName: best.show?.name ?? best.show?.title ?? best.variant,
    confidence: 'high',
  } : { matched: false, showId: null, showName: null, confidence: 'none' }
}
