// Shared, pure title-priority logic for Feature 1 (best available episode
// title). This module makes no network calls and touches no release/date
// logic whatsoever — it only decides, given two candidate strings, which one
// is fit to display.
//
// Priority: proper TMDB title → otherwise proper TVmaze title → otherwise
// "TBA". TMDB is not universally primary — it's only preferred when its
// current title is meaningful; TVmaze is only a fallback when TMDB's title is
// missing or a generic placeholder.

const GENERIC_EXACT = new Set(['tba', 'tbd', 'untitled'])

// Case/spacing/punctuation-insensitive normalization: lowercase, strip
// periods/hyphens/underscores (so "T.B.A." and "TBA" compare equal), then
// collapse whitespace.
function normalize(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[.\-_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Matches TMDB/TVmaze's own generated-placeholder shape: "Episode 5",
// "Episode 05", "Episode #5" (any case/spacing). Deliberately anchored to the
// full string so a legitimate title merely containing the word "episode"
// (e.g. "The Final Episode") never matches.
const EPISODE_PLACEHOLDER_RE = /^episode\s*#?\s*0*(\d+)$/

// Is `title` a placeholder rather than a real episode name? `episodeNumber`
// (when known) disambiguates "Episode N" from a legitimate title that
// happens to be the literal word "Episode" followed by an unrelated number —
// when omitted, any "Episode N" shape is treated as generic (the safer
// default, since TMDB/TVmaze only ever emit this shape as a placeholder).
export function isGenericEpisodeTitle(title, episodeNumber) {
  if (title === null || title === undefined || typeof title !== 'string') return true
  const trimmed = title.trim()
  if (trimmed === '') return true

  const normalized = normalize(trimmed)
  if (GENERIC_EXACT.has(normalized.replace(/\s+/g, ''))) return true

  const placeholder = EPISODE_PLACEHOLDER_RE.exec(normalized)
  if (placeholder) {
    return Number.isInteger(episodeNumber) ? Number(placeholder[1]) === episodeNumber : true
  }

  return false
}

// The single place the display title for an episode is decided. `tmdbName`
// wins whenever it's meaningful; otherwise `tvmazeName` is used if it's
// meaningful; otherwise "TBA". Never throws, never returns null/undefined —
// always a display-ready string.
export function resolveEpisodeTitle({ tmdbName, tvmazeName, episodeNumber } = {}) {
  if (!isGenericEpisodeTitle(tmdbName, episodeNumber)) return tmdbName.trim()
  if (!isGenericEpisodeTitle(tvmazeName, episodeNumber)) return tvmazeName.trim()
  return 'TBA'
}
