export function filterVisibleStatsRows(trackedShows, watchedRows) {
  const visibleIds = new Set(
    (trackedShows ?? [])
      .filter((show) => show.hidden_at == null)
      .map((show) => show.tmdb_id),
  )
  return (watchedRows ?? []).filter((row) => visibleIds.has(row.tmdb_show_id))
}

export function removeShowFromStatsState(shows, watchedRows, tmdbId) {
  return {
    shows: (shows ?? []).filter((show) => show.tmdb_id !== tmdbId),
    watchedRows: (watchedRows ?? []).filter((row) => row.tmdb_show_id !== tmdbId),
  }
}

export function statsActionItems(show) {
  const items = [{ id: 'details', label: 'View details' }]
  if (show?.finished_at != null) {
    items.push({ id: 'restore', label: 'Restore to Watching' })
  }
  items.push(
    { id: 'remove', label: 'Remove from Stats', destructive: true },
    { id: 'cancel', label: 'Cancel' },
  )
  return items
}

export function toggleStatsActionSheet(currentShowId, requestedShowId) {
  return currentShowId === requestedShowId ? null : requestedShowId
}

export function isStatsShowBusy(busyIds, tmdbId) {
  return busyIds?.has(tmdbId) ?? false
}
