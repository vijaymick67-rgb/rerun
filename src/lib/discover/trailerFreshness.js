export const DISCOVER_TRAILER_MAX_AGE_DAYS = 45
export const DISCOVER_TRAILER_MAX_AGE_MS =
  DISCOVER_TRAILER_MAX_AGE_DAYS * 24 * 60 * 60 * 1000

export function isDiscoverTrailerFresh(
  trailer,
  { now = Date.now(), maxAgeMs = DISCOVER_TRAILER_MAX_AGE_MS } = {},
) {
  const publishedAt = Date.parse(trailer?.publishedAt ?? trailer?.published_at)
  if (!Number.isFinite(publishedAt)) return false
  const age = now - publishedAt
  return age >= 0 && age <= maxAgeMs
}
