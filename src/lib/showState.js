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
