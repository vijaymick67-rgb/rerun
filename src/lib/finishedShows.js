import { isHiddenFromWatching } from './watchHelpers.js'

export function isPersonallyFinished(show) {
  return show?.finished_at != null
}

// Personal completion is intentionally separate from TMDB's series status:
// a returning show may still be finished for this owner.
export function isVisibleInWatching(show, status) {
  return !isPersonallyFinished(show) && !isHiddenFromWatching(status)
}

// Stats is history-led. A personal archive must never remove metadata for a
// show that still has watched episodes.
export function isRepresentedInStats(show, watchedRows) {
  return Boolean(show) && (watchedRows?.length ?? 0) > 0
}

export async function markTrackedShowFinished(supabase, tmdbId, finishedAt = new Date().toISOString()) {
  const { error } = await supabase
    .from('tracked_shows')
    .update({ finished_at: finishedAt })
    .eq('tmdb_id', tmdbId)
  if (error) throw error
  return finishedAt
}

export async function restoreTrackedShow(supabase, tmdbId) {
  const { error } = await supabase
    .from('tracked_shows')
    .update({ finished_at: null })
    .eq('tmdb_id', tmdbId)
  if (error) throw error
}

// Repairs only the persisted archive state. It never reads or writes
// watched_episodes, so historic watched_at values remain exactly as stored.
export async function finishTrackedShows(shows, options = {}) {
  const { supabase, now = new Date().toISOString(), onProgress } = options
  const results = []
  let current = 0
  for (const show of shows) {
    let error = null
    try {
      await markTrackedShowFinished(supabase, show.tmdb_id, now)
    } catch (err) {
      error = err?.message || 'Unknown error'
    }
    results.push({ tmdb_id: show.tmdb_id, name: show.name, error })
    current += 1
    onProgress?.({ current, total: shows.length, label: `Finishing ${show.name} (${current}/${shows.length})…` })
  }
  return results
}
