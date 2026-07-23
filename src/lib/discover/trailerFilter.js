// Trailer filtering (Scope J + R). Decides whether a single TMDB `videos`
// record is a real trailer/teaser worth surfacing. Precision-first: a record
// must be a YouTube Trailer/Teaser AND survive a name filter that rejects clips,
// featurettes, previews, and other non-trailer content — including records TMDB
// mistypes (an "Official Clip" typed as a Trailer).
//
// TMDB video shape (per official /tv/{id}/videos and /movie/{id}/videos docs):
//   { key, site, type, name, official, iso_639_1, published_at, id }

export const ACCEPTED_TMDB_TYPES = new Set(['Trailer', 'Teaser'])

// TMDB types that are never trailers, regardless of name.
export const REJECTED_TMDB_TYPES = new Set([
  'Clip', 'Featurette', 'Behind the Scenes', 'Opening Credits', 'Bloopers',
])

// Normalized-name substrings that disqualify a video even when TMDB types it as
// a Trailer/Teaser (TMDB typing is frequently wrong). Matched against the
// lower-cased name.
const REJECT_NAME_PATTERNS = [
  /\bofficial clip\b/, /\bclip\b/, /\bpreview\b/, /\bepisode preview\b/, /\bnext episode\b/,
  /\bpromo\b/, /\bsneak peek\b/, /\bfeaturette\b/, /\bbehind the scenes\b/, /\bmaking of\b/,
  /\binterview\b/, /\bcast interview\b/, /\bcast reacts\b/, /\binside the episode\b/,
  /\brecap\b/, /\bexplained\b/, /\breaction\b/, /\bfan (?:trailer|made)\b/, /\bconcept (?:trailer|teaser)\b/,
  /\bopening credits\b/, /\btitle sequence\b/, /\bbloopers?\b/, /\bgag reel\b/, /\bdeleted scene\b/,
]

// Names that are unambiguously trailers/teasers. Used as a positive allow signal
// so a clean "Official Trailer" is never accidentally caught by a broad reject.
const ACCEPT_NAME_PATTERNS = [
  /\bofficial trailer\b/, /\bfinal trailer\b/, /\bteaser trailer\b/, /\bofficial teaser\b/,
  /\bseason \d+ (?:official )?(?:trailer|teaser)\b/, /\bmain trailer\b/, /\blaunch trailer\b/,
  /^trailer$/, /^teaser$/, /\bred band trailer\b/,
]

function normalizeName(name) {
  return typeof name === 'string' ? name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ') : ''
}

export function classifyVideo(video, { allowUnofficialFallback = false } = {}) {
  const reasons = []
  if (!video || typeof video !== 'object') return { accepted: false, reasons: ['invalid'] }
  if (video.site !== 'YouTube') reasons.push('not_youtube')
  if (!video.key) reasons.push('missing_key')
  if (REJECTED_TMDB_TYPES.has(video.type)) reasons.push('rejected_tmdb_type')
  if (!ACCEPTED_TMDB_TYPES.has(video.type)) reasons.push('non_trailer_type')

  const name = normalizeName(video.name)
  const nameAccepted = ACCEPT_NAME_PATTERNS.some((p) => p.test(name))
  const nameRejected = REJECT_NAME_PATTERNS.some((p) => p.test(name))
  // A clean positive name overrides a broad reject only when it is not ALSO an
  // explicit clip/featurette phrase. "Official Clip" -> rejected. "Official
  // Trailer" -> accepted.
  if (nameRejected && !(nameAccepted && !/\b(?:clip|featurette|behind the scenes|preview|sneak peek|promo)\b/.test(name))) {
    reasons.push('rejected_name')
  }

  if (!allowUnofficialFallback && video.official !== true) reasons.push('unofficial')

  return { accepted: reasons.length === 0, reasons, nameAccepted }
}

export function isAcceptableTrailer(video, options) {
  return classifyVideo(video, options).accepted
}
