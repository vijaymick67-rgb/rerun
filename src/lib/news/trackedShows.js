export function upsertTrackedShowForNews(trackedShows, show) {
  const tmdbId = show?.id ?? show?.tmdb_id
  if (tmdbId === null || tmdbId === undefined) return Array.isArray(trackedShows) ? trackedShows : []
  const normalized = { tmdb_id: tmdbId, name: show?.name ?? show?.title ?? '' }
  const current = Array.isArray(trackedShows) ? trackedShows : []
  const index = current.findIndex((item) => item?.tmdb_id === tmdbId)
  if (index < 0) return [...current, normalized]
  return current.map((item, itemIndex) => itemIndex === index ? { ...item, ...normalized } : item)
}
