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
  /\bofficial clip\b/, /\bclips?\b/, /\bpreview\b/,
  /\bepisode (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/,
  /\bnext episode\b/,
  /\bnext on\b/, /\bcoming up\b/, /\b(?:this|next) week\b/,
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+) (?:days?|weeks?|months?) (?:until|to go)\b/,
  /\bcountdown\b/, /\bpromo\b/, /\bsneak peek\b/, /\bfirst look\b/, /\bspecial look\b/,
  /\bdate announcement\b/, /\bfeaturette\b/, /\bbehind the scenes\b/, /\bmaking of\b/,
  /\binterview\b/, /\bcast interview\b/, /\bcast reacts\b/, /\binside the episode\b/,
  /\brecap\b/, /\bexplained\b/, /\breaction\b/, /\bbreakdown\b/,
  /\bfan (?:made )?(?:trailer|teaser)\b/, /\bconcept (?:trailer|teaser)\b/,
  /\bopening credits\b/, /\btitle sequence\b/, /\bbloopers?\b/, /\bgag reel\b/, /\bdeleted scene\b/,
]

// A Trailer/Teaser type is not enough: the normalized name must independently
// contain a trailer/teaser signal. Word boundaries keep this flexible across
// forms such as "Official Trailer 2", "Trailer - Season 2", and "Final Trailer"
// without accepting unrelated promotional names.
const ACCEPT_NAME_PATTERNS = [
  /\btrailer(?: \d+)?\b/,
  /\bteaser\b/,
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
  if (!nameAccepted) reasons.push('missing_name_signal')
  if (nameRejected) reasons.push('rejected_name')

  if (!allowUnofficialFallback && video.official !== true) reasons.push('unofficial')

  return { accepted: reasons.length === 0, reasons, nameAccepted }
}

export function isAcceptableTrailer(video, options) {
  return classifyVideo(video, options).accepted
}
