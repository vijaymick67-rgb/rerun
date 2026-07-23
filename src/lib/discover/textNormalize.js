// Shared text normalization for the Discover engine (announcements + trailers).
//
// This is the single authoritative place where a headline, a tracked-show
// title, or a video name is folded into a comparable canonical form. The
// announcement classifier and the identity registry both depend on it, so the
// normalization rules live here rather than being re-implemented per module.
//
// Safe normalization only (Scope B). We deliberately do NOT invent aliases by
// dropping words, and we never treat a substring as an alias — the classifier's
// bounded-phrase matching (below) is what makes "From" stop matching every
// article containing the preposition "from".

// Fold to a lowercased, accent-free, punctuation-collapsed token stream.
//   - Unicode NFKD + combining-mark strip (café -> cafe)
//   - typographic apostrophes normalized away with other punctuation
//   - `&` expanded to ` and ` (bounded — only the literal ampersand, never a
//     fuzzy "and"/"&" equivalence applied to arbitrary words)
//   - everything non-alphanumeric collapses to single spaces
export function normalizeText(value) {
  if (typeof value !== 'string') return ''
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

const LEADING_ARTICLES = new Set(['the', 'a', 'an'])

// Secondary comparison form only: the leading article removed. Per Scope B this
// is never sole proof of a match — callers keep both the full normalized form
// and this reduced form, and treat an article-stripped match as weaker evidence
// than an exact one. Returns '' when stripping would empty the title (a show
// literally titled "The").
export function stripLeadingArticle(normalized) {
  if (typeof normalized !== 'string' || !normalized) return ''
  const words = normalized.split(' ')
  if (words.length > 1 && LEADING_ARTICLES.has(words[0])) return words.slice(1).join(' ')
  return normalized
}

// Split normalized text into its word array once, so phrase scans don't
// re-split repeatedly.
export function toWords(normalized) {
  return typeof normalized === 'string' && normalized ? normalized.split(' ') : []
}

// Every 0-based index where `phraseWords` appears as a contiguous run inside
// `words`. This is the core of bounded matching: a phrase only matches on whole
// word boundaries, never as a substring of a larger word ("industry" never
// matches inside "industrywide", "bear" never matches inside "bearer").
export function phraseIndices(words, phraseWords) {
  if (!Array.isArray(words) || !Array.isArray(phraseWords) || !phraseWords.length) return []
  const indices = []
  for (let i = 0; i <= words.length - phraseWords.length; i += 1) {
    let matched = true
    for (let offset = 0; offset < phraseWords.length; offset += 1) {
      if (words[i + offset] !== phraseWords[offset]) { matched = false; break }
    }
    if (matched) indices.push(i)
  }
  return indices
}

// True when `phrase` appears as a bounded whole-word run inside `normalized`.
export function containsPhrase(normalized, phrase) {
  const words = toWords(normalized)
  const phraseWords = toWords(phrase)
  if (!phraseWords.length) return false
  return phraseIndices(words, phraseWords).length > 0
}

// The word immediately before / after each occurrence of `phrase`, for
// adjacency-based evidence (e.g. a season number touching a title). null marks
// a sentence boundary (start/end of the word stream).
export function neighboursOfPhrase(normalized, phrase) {
  const words = toWords(normalized)
  const phraseWords = toWords(phrase)
  if (!phraseWords.length) return []
  return phraseIndices(words, phraseWords).map((index) => ({
    index,
    before: index > 0 ? words[index - 1] : null,
    after: index + phraseWords.length < words.length ? words[index + phraseWords.length] : null,
  }))
}

const QUOTE_CHAR_CLASS = '[\'"\u2018\u2019\u201c\u201d]'

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A title wrapped in quotes in the RAW headline ("'From' renewed for Season 4")
// is, by construction, a named thing rather than the ordinary grammatical word.
// Checked pre-normalization because normalizeText strips the quote characters.
export function hasQuotedTitle(rawText, canonicalTitle) {
  if (typeof rawText !== 'string' || !rawText || typeof canonicalTitle !== 'string' || !canonicalTitle) return false
  const escaped = canonicalTitle.split(' ').map(escapeRegExp).join('\\s+')
  return new RegExp(`${QUOTE_CHAR_CLASS}\\s*${escaped}\\s*${QUOTE_CHAR_CLASS}`, 'i').test(rawText)
}

// A possessive platform/network construction ("Netflix's You", "HBO's Industry")
// names the title as an owned thing, never as a pronoun/preposition. Checked
// against the raw headline because the apostrophe carries the meaning and
// normalizeText strips it.
export function hasPossessiveBeforeTitle(rawText, canonicalTitle) {
  if (typeof rawText !== 'string' || !rawText || typeof canonicalTitle !== 'string' || !canonicalTitle) return false
  const escaped = canonicalTitle.split(' ').map(escapeRegExp).join('\\s+')
  return new RegExp(`\\b[a-z0-9+]+['\u2019]s\\s+${escaped}\\b`, 'i').test(rawText)
}
