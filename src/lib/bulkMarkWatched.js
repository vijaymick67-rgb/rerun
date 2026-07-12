// Shared "mark every aired episode of a show as watched" logic.
//
// This is the single source of truth for three call sites:
//   1. Browse's "Log as watched" button (retroactively log a finished show)
//   2. The import's fallback path (a completed show with no per-episode data)
//   3. Settings' one-time "bulk-mark everything except an exception list" tool
//
// The guiding rule, same as the import: NEVER overwrite a watched row that
// already exists. Every write upserts with `ignoreDuplicates` on the standard
// conflict key, so re-running is always harmless (already-marked episodes are
// left exactly as they were).

import { supabase as realSupabase } from './supabase.js'
import {
  getShowDetails as realGetShowDetails,
  getSeasonEpisodes as realGetSeasonEpisodes,
} from './tmdb.js'
import { dayShiftForNetworks } from './networkReleaseTiming.js'
import { hasAired } from './watchHelpers.js'

// The one conflict key used everywhere watched_episodes is written.
export const WATCHED_CONFLICT_KEY = 'tmdb_show_id,season_number,episode_number'

// watched_episodes rows per upsert. A bulk run across ~20 shows can be a few
// thousand rows; chunking keeps each request small.
const DEFAULT_CHUNK_SIZE = 300

// The single watched_episodes row shape, in one place so all callers agree.
function makeWatchedRow(showId, seasonNumber, episode, watchedAt) {
  return {
    tmdb_show_id: showId,
    season_number: seasonNumber,
    episode_number: episode.episode_number,
    episode_name: episode.name ?? null,
    runtime_minutes: episode.runtime ?? null,
    watched_at: watchedAt,
  }
}

// Build watched_episodes rows for every already-aired episode of a show.
//
// Fetches the show's details (for its `networks` day-shift and season list) and
// each real (season_number > 0) season's episodes from TMDB, then keeps only
// episodes that have actually aired — unaired future episodes don't exist to
// mark yet. Pure assembly: no DB writes.
//
// Season fetches are tolerated individually (Promise.allSettled) so one flaky
// season doesn't abort the whole show — matching the import's per-season
// resilience. `failedSeasons` reports how many were skipped for that reason.
//
// Options: inject `getShowDetails`/`getSeasonEpisodes` fakes for tests, pass a
// pre-fetched `details` to avoid a redundant fetch, and set the `watchedAt`
// stamp. Returns { rows, details, failedSeasons }.
export async function buildAiredEpisodeRows(showId, options = {}) {
  const getShowDetails = options.getShowDetails ?? realGetShowDetails
  const getSeasonEpisodes = options.getSeasonEpisodes ?? realGetSeasonEpisodes
  const watchedAt = options.watchedAt ?? new Date().toISOString()

  const details = options.details ?? (await getShowDetails(showId))
  const dayShift = dayShiftForNetworks(details.networks)
  const seasons = (details.seasons ?? [])
    .filter((season) => season.season_number > 0)
    .sort((a, b) => a.season_number - b.season_number)

  const settled = await Promise.allSettled(
    seasons.map((season) => getSeasonEpisodes(showId, season.season_number)),
  )

  const rows = []
  let failedSeasons = 0
  seasons.forEach((season, i) => {
    const outcome = settled[i]
    if (outcome.status !== 'fulfilled') {
      failedSeasons += 1
      return
    }
    for (const ep of outcome.value.episodes ?? []) {
      if (hasAired(ep, dayShift)) {
        rows.push(makeWatchedRow(showId, season.season_number, ep, watchedAt))
      }
    }
  })

  return { rows, details, failedSeasons }
}

// Upsert watched rows without ever overwriting an existing one. Chunked so a
// large bulk run stays within request limits. Returns the count actually
// inserted (ignoreDuplicates omits already-present rows from the result).
export async function upsertWatchedRows(rows, options = {}) {
  const supabase = options.supabase ?? realSupabase
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  let inserted = 0
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const { data, error } = await supabase
      .from('watched_episodes')
      .upsert(chunk, { onConflict: WATCHED_CONFLICT_KEY, ignoreDuplicates: true })
      .select('id')
    if (error) throw error
    inserted += data?.length ?? 0
  }
  return { inserted }
}

// --- Settings bulk-mark-all-except tool ------------------------------------

// Shows to leave COMPLETELY untouched — no reads, no writes of any kind.
// Matched case-insensitively against a tracked show's name with trimmed
// whitespace (see normalizeShowName). Order here is the display order.
export const EXCEPTION_SHOWS = [
  'Adults',
  'Lucky',
  'Cape Fear',
  'Sugar',
  'The Sopranos',
  'Lanterns',
  'Maximum Pleasure Guaranteed',
  'House of the Dragon',
]

// Case-insensitive, whitespace-trimmed key for matching a stored show name
// against the exception list.
export function normalizeShowName(name) {
  return (name ?? '').trim().toLowerCase()
}

// Split tracked shows into what the bulk-mark WOULD touch vs. the exception
// list, without doing anything. This drives the preview so the user can eyeball
// it before any write happens.
//
// Returns:
//   affected            — tracked shows NOT on the exception list (would be marked)
//   skipped             — tracked shows matched to the exception list (untouched)
//   matchedExceptions   — exception names that matched at least one tracked show
//   unmatchedExceptions — exception names with ZERO match (likely a naming
//                         mismatch — surface these so the user can catch a show
//                         that would otherwise slip through and get marked)
export function planBulkMark(trackedShows) {
  const exceptionByNorm = new Map(
    EXCEPTION_SHOWS.map((name) => [normalizeShowName(name), name]),
  )

  const affected = []
  const skipped = []
  const matched = new Set()

  for (const show of trackedShows ?? []) {
    const canonical = exceptionByNorm.get(normalizeShowName(show.name))
    if (canonical) {
      matched.add(canonical)
      skipped.push(show)
    } else {
      affected.push(show)
    }
  }

  return {
    affected,
    skipped,
    matchedExceptions: EXCEPTION_SHOWS.filter((name) => matched.has(name)),
    unmatchedExceptions: EXCEPTION_SHOWS.filter((name) => !matched.has(name)),
  }
}

// Mark every aired episode watched for each of `shows` (already filtered to the
// non-exception set by planBulkMark — this function never touches the exception
// list). Sequential and gentle by design: this is an occasional one-time tool,
// so it favors caution and clear progress over speed.
//
// Each show is isolated: a single show's TMDB failure is caught and reported,
// the rest keep going. Returns a per-show result list:
//   { tmdb_id, name, airedCount, insertedCount, failedSeasons, error }
export async function bulkMarkShows(shows, options = {}) {
  const supabase = options.supabase ?? realSupabase
  const getShowDetails = options.getShowDetails ?? realGetShowDetails
  const getSeasonEpisodes = options.getSeasonEpisodes ?? realGetSeasonEpisodes
  const watchedAt = options.now ?? new Date().toISOString()
  const { onProgress } = options

  const results = []
  let processed = 0
  for (const show of shows) {
    let result = {
      tmdb_id: show.tmdb_id,
      name: show.name,
      airedCount: 0,
      insertedCount: 0,
      failedSeasons: 0,
      error: null,
    }
    try {
      const { rows, failedSeasons } = await buildAiredEpisodeRows(show.tmdb_id, {
        getShowDetails,
        getSeasonEpisodes,
        watchedAt,
      })
      const { inserted } = await upsertWatchedRows(rows, { supabase, chunkSize: options.chunkSize })
      result = {
        ...result,
        airedCount: rows.length,
        insertedCount: inserted,
        failedSeasons,
      }
    } catch (err) {
      result.error = err?.message || 'Unknown error'
    }
    results.push(result)
    processed += 1
    onProgress?.({
      current: processed,
      total: shows.length,
      label: `Marking ${show.name} (${processed}/${shows.length})…`,
    })
  }
  return results
}
