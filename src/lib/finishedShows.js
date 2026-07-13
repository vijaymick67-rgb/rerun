import {
  daysUntil,
  isHiddenFromWatching,
  WATCHING_COUNTDOWN_WINDOW_DAYS,
} from './watchHelpers.js'
import { releaseDateInIST } from './networkReleaseTiming.js'

export function isPersonallyFinished(show) {
  return show?.finished_at != null
}

export function isHiddenShow(show) {
  return show?.hidden_at != null
}

// Personal completion is intentionally separate from TMDB's series status:
// a returning show may still be finished for this owner.
export function isVisibleInWatching(show, status) {
  if (isHiddenShow(show)) return false
  if (!isPersonallyFinished(show)) return !isHiddenFromWatching(status)
  return status?.type === 'nextUp' || (status?.type === 'countdown' && !isHiddenFromWatching(status))
}

// Lightweight eligibility check for archived shows. The same shifted calendar
// date and >60 hiding boundary used by countdown rendering are reused here.
// Negative values are intentionally eligible: cached dated episode metadata
// lets the normal nextUp scan keep a returned show visible after air day.
function localDateISO(timestamp) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function shouldFinishedShowReturn(show, details, releaseRule) {
  const airDate = details?.next_episode_to_air?.air_date
  const remaining = daysUntil(airDate, releaseRule)
  if (remaining !== null && remaining <= WATCHING_COUNTDOWN_WINDOW_DAYS) return true

  // After air day TMDB may clear next_episode_to_air (season finale or
  // full-season drop). A last episode dated after the personal finish is a
  // lightweight signal that new material exists and merits a season scan.
  const lastAirDate = details?.last_episode_to_air?.air_date
  const daysSinceLastAir = daysUntil(lastAirDate, releaseRule)
  const finishedDate = localDateISO(show?.finished_at)
  return Boolean(
    finishedDate &&
      daysSinceLastAir !== null &&
      daysSinceLastAir <= 0 &&
      releaseDateInIST(lastAirDate, releaseRule) > finishedDate,
  )
}

// Stats is history-led. A personal archive must never remove metadata for a
// show that still has watched episodes.
export function isRepresentedInStats(show, watchedRows) {
  return Boolean(show) && !isHiddenShow(show) && (watchedRows?.length ?? 0) > 0
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
    .update({ finished_at: null, hidden_at: null })
    .eq('tmdb_id', tmdbId)
  if (error) throw error
}

export async function hideTrackedShow(supabase, tmdbId, hiddenAt = new Date().toISOString()) {
  const { error } = await supabase
    .from('tracked_shows')
    .update({ hidden_at: hiddenAt })
    .eq('tmdb_id', tmdbId)
  if (error) throw error
  return hiddenAt
}

// Browse's explicit add flow reactivates an existing hidden/finished row. This
// only writes tracked_shows metadata; watched_episodes is intentionally absent.
export async function upsertTrackedShow(supabase, show, addedAt = new Date().toISOString()) {
  const { error } = await supabase.from('tracked_shows').upsert(
    {
      tmdb_id: show.id,
      name: show.name,
      poster_path: show.poster_path,
      added_at: addedAt,
      finished_at: null,
      hidden_at: null,
    },
    { onConflict: 'tmdb_id' },
  )
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
