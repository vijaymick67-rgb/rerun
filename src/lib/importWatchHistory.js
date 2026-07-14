// Import a watch-history JSON backup (exported by another TV-tracking app)
// into Rerun's Supabase tables. The guiding rule: NEVER overwrite anything
// already in Rerun. Every write either skips-if-present (tracked_shows) or
// upserts with `ignoreDuplicates` (watched_episodes), so the import only ever
// fills gaps and is safe to run twice on the same file.
//
// This module holds the pure orchestration so it can be unit-tested with fake
// TMDB/Supabase deps; Settings.jsx wires it to the real ones and renders
// progress. See the task's file-structure notes for the source JSON shape.

import { supabase as realSupabase } from './supabase.js'
import {
  getShowDetails as realGetShowDetails,
  getSeasonEpisodes as realGetSeasonEpisodes,
} from './tmdb.js'
import { hasAired } from './watchHelpers.js'
import { buildAiredEpisodeRows } from './bulkMarkWatched.js'

const UNIQUE_VIOLATION = '23505'

// How many shows' TMDB data to fetch at once. Modest so we don't hammer the
// TMDB proxy / hit rate limits, but enough to not take forever over ~100 shows.
const DEFAULT_CONCURRENCY = 6

// watched_episodes rows per write. A few hundred keeps each request small
// while there may be several thousand rows total.
const DEFAULT_CHUNK_SIZE = 300

// Run `fn` over `items` with at most `limit` in flight at once. A pool (not
// fixed batches) so one slow show doesn't stall the others behind it.
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker)
  await Promise.all(workers)
  return results
}

// Union cW + cH + cHid, deduplicated by tmId. Returns the distinct show list
// plus the lookup maps needed to resolve pEp/pSe records back to a TMDB id.
function buildShowList(shows, summary) {
  const byTmId = new Map()
  const tmIdByInternalId = new Map()

  function ingest(entries, completed) {
    for (const e of entries ?? []) {
      if (e.tmId == null) {
        summary.skippedNoTmId += 1
        continue
      }
      if (e.id != null) tmIdByInternalId.set(e.id, e.tmId)

      let show = byTmId.get(e.tmId)
      if (!show) {
        show = {
          tmId: e.tmId,
          name: e.t || `Show ${e.tmId}`,
          hasRealName: Boolean(e.t),
          isCompleted: false,
          completionTs: null,
          // Preserve the original add date from the backup when present.
          addedAt: e.a || null,
        }
        byTmId.set(e.tmId, show)
      } else if (e.t && !show.hasRealName) {
        // First entry only had a placeholder title; upgrade to a real one.
        show.name = e.t
        show.hasRealName = true
      }
      if (completed) {
        show.isCompleted = true
        if (e.w && !show.completionTs) show.completionTs = e.w
      }
      if (e.a && !show.addedAt) show.addedAt = e.a
    }
  }

  ingest(shows?.cW, false)
  ingest(shows?.cH, true)
  ingest(shows?.cHid, true)

  return { shows: [...byTmId.values()], tmIdByInternalId }
}

// Group pEp/pSe records under the TMDB id of the show they belong to.
// Resolve via `sId` (the source app's internal show id) first — that's the
// authoritative link — falling back to `stmId` (the redundant TMDB id carried
// on each record) only when it points at a show we're actually tracking.
function groupByShow(records, tmIdByInternalId, knownTmIds, summary) {
  const map = new Map()
  for (const r of records ?? []) {
    let tmId = tmIdByInternalId.get(r.sId)
    if (tmId == null && r.stmId != null && knownTmIds.has(r.stmId)) {
      tmId = r.stmId
    }
    if (tmId == null) {
      summary.orphanRecords += 1
      continue
    }
    if (!map.has(tmId)) map.set(tmId, [])
    map.get(tmId).push(r)
  }
  return map
}

// Everything one show needs to produce its watched_episodes rows. Isolated so
// a single show's TMDB failure is caught and reported without aborting the run.
async function processShow(show, ctx) {
  const { getShowDetails, getSeasonEpisodes, pEpByTmId, pSeByTmId, now } = ctx

  const result = {
    tmId: show.tmId,
    name: show.name,
    trackedRow: null,
    episodeRows: [],
    usedFallback: false,
    seasonMarkersApplied: 0,
    error: null,
  }

  let details
  try {
    details = await getShowDetails(show.tmId)
  } catch {
    // TMDB fetch failed — still track the show (from backup title, no poster),
    // but we can't derive episode data for it. Log, skip, keep going.
    result.trackedRow = {
      tmdb_id: show.tmId,
      name: show.name,
      poster_path: null,
      added_at: show.addedAt || now,
    }
    result.error = `${show.name}: couldn't fetch show details from TMDB — tracked, but its episode history was skipped.`
    return result
  }

  result.trackedRow = {
    tmdb_id: show.tmId,
    name: details.name || show.name,
    poster_path: details.poster_path ?? null,
    added_at: show.addedAt || now,
  }

  const pEps = pEpByTmId.get(show.tmId) ?? []
  const pSes = pSeByTmId.get(show.tmId) ?? []

  // Seasons that have any per-episode record — used to skip pSe markers that
  // pEp already covers more precisely (step 4).
  const pEpSeasons = new Set(pEps.map((r) => r.sN))

  // Lazily-fetched season episode lists, keyed by season number. A null value
  // means the fetch failed — recorded so we don't retry it within this show.
  const seasonEpisodes = new Map()
  async function ensureSeasons(seasonNumbers) {
    const missing = [...new Set(seasonNumbers)].filter(
      (n) => !seasonEpisodes.has(n),
    )
    const fetched = await Promise.all(
      missing.map(async (n) => {
        try {
          const data = await getSeasonEpisodes(show.tmId, n)
          return [n, data.episodes ?? []]
        } catch {
          return [n, null]
        }
      }),
    )
    for (const [n, eps] of fetched) seasonEpisodes.set(n, eps)
  }

  // Dedupe rows within this show; the first writer for an episode wins, which
  // matters because pEp (precise, real timestamp) is processed before the
  // pSe/fallback bulk fills.
  const rowsByKey = new Map()
  function addRow(seasonNumber, episodeNumber, episode, watchedAt) {
    const key = `${seasonNumber}:${episodeNumber}`
    if (rowsByKey.has(key)) return
    rowsByKey.set(key, {
      tmdb_show_id: show.tmId,
      season_number: seasonNumber,
      episode_number: episodeNumber,
      episode_name: episode?.name ?? null,
      runtime_minutes: episode?.runtime ?? null,
      watched_at: watchedAt || now,
    })
  }

  // --- Step 3: real per-episode history from pEp ---
  await ensureSeasons(pEps.map((r) => r.sN))
  for (const r of pEps) {
    const eps = seasonEpisodes.get(r.sN)
    const ep = eps?.find((e) => e.episode_number === r.eN)
    if (ep) {
      // Guard defensively: only import episodes that have actually aired.
      if (hasAired(ep)) addRow(r.sN, r.eN, ep, r.a)
    } else {
      // Episode not in TMDB's data (missing season, or TMDB fetch failed). It's
      // still a real watch record the user made, so preserve it — we just can't
      // attach a name/runtime or verify the air date.
      addRow(r.sN, r.eN, null, r.a)
    }
  }

  // --- Step 4: reconcile pSe season-complete markers ---
  const uncoveredSeasons = pSes.filter((r) => !pEpSeasons.has(r.sN))
  await ensureSeasons(uncoveredSeasons.map((r) => r.sN))
  for (const r of uncoveredSeasons) {
    const eps = seasonEpisodes.get(r.sN)
    if (!eps) continue // couldn't fetch this season — skip the marker
    let applied = false
    for (const ep of eps) {
      if (hasAired(ep)) {
        addRow(r.sN, ep.episode_number, ep, r.a)
        applied = true
      }
    }
    if (applied) result.seasonMarkersApplied += 1
  }

  // --- Step 5: fallback for completed shows with zero episode-level data ---
  // Reuse the shared bulk-mark routine (the same one behind Browse's "Log as
  // watched" and Settings' bulk tool) so "every aired episode of a show" is
  // defined in exactly one place. rowsByKey is empty here, so these rows can't
  // collide with earlier pEp/pSe writes.
  if (show.isCompleted && rowsByKey.size === 0) {
    const watchedAt = show.completionTs || now
    const { rows } = await buildAiredEpisodeRows(show.tmId, {
      details,
      getShowDetails,
      getSeasonEpisodes,
      watchedAt,
    })
    for (const row of rows) {
      rowsByKey.set(`${row.season_number}:${row.episode_number}`, row)
    }
    if (rowsByKey.size > 0) result.usedFallback = true
  }

  result.episodeRows = [...rowsByKey.values()]
  return result
}

// Insert distinct shows into tracked_shows without overwriting existing rows.
// Uses upsert+ignoreDuplicates (the batched equivalent of Browse's per-row
// UNIQUE_VIOLATION skip) so already-tracked shows keep their existing data.
// Returns the count actually inserted (ignoreDuplicates omits skips from the
// returned rows).
async function writeTrackedShows(supabase, rows, chunkSize) {
  let inserted = 0
  const errors = []
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const { data, error } = await supabase
      .from('tracked_shows')
      .upsert(chunk, { onConflict: 'tmdb_id', ignoreDuplicates: true })
      .select('tmdb_id')
    if (error) {
      // Fall back to per-row inserts so one bad row doesn't sink the batch,
      // mirroring Browse's UNIQUE_VIOLATION-tolerant insert.
      for (const row of chunk) {
        const { error: rowError } = await supabase
          .from('tracked_shows')
          .insert(row)
        if (!rowError) inserted += 1
        else if (rowError.code !== UNIQUE_VIOLATION) {
          errors.push(`Couldn't track "${row.name}": ${rowError.message}`)
        }
      }
    } else {
      inserted += data?.length ?? 0
    }
  }
  return { inserted, errors }
}

// Chunked, gap-only writes of watched_episodes. ignoreDuplicates guarantees an
// existing row (from normal use or a prior import) is never overwritten.
// Returns the count actually inserted.
async function writeWatchedEpisodes(supabase, rows, chunkSize, onProgress) {
  let inserted = 0
  const errors = []
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const { data, error } = await supabase
      .from('watched_episodes')
      .upsert(chunk, {
        onConflict: 'tmdb_show_id,season_number,episode_number',
        ignoreDuplicates: true,
      })
      .select('id')
    if (error) {
      errors.push(`Failed to write ${chunk.length} episode records: ${error.message}`)
    } else {
      inserted += data?.length ?? 0
    }
    onProgress?.({
      phase: 'writing',
      current: Math.min(i + chunkSize, rows.length),
      total: rows.length,
      label: `Saving episodes ${Math.min(i + chunkSize, rows.length)}/${rows.length}…`,
    })
  }
  return { inserted, errors }
}

// Main entry point. `json` is the parsed backup object. Options let tests
// inject fakes and tune batching; production callers pass just `onProgress`.
export async function importWatchHistory(json, options = {}) {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    chunkSize = DEFAULT_CHUNK_SIZE,
    onProgress,
    now = new Date().toISOString(),
  } = options

  if (!json || typeof json !== 'object' || !json.shows || typeof json.shows !== 'object') {
    throw new Error(
      "This doesn't look like a supported backup file (no \"shows\" section found).",
    )
  }

  // Injected fakes in tests, real modules in production.
  const supabase = options.supabase ?? realSupabase
  const getShowDetails = options.getShowDetails ?? realGetShowDetails
  const getSeasonEpisodes = options.getSeasonEpisodes ?? realGetSeasonEpisodes

  const summary = {
    showsTotal: 0,
    showsNewlyTracked: 0,
    episodesImported: 0,
    seasonMarkersApplied: 0,
    fallbackShows: [],
    skippedNoTmId: 0,
    orphanRecords: 0,
    errors: [],
  }

  const { shows: showList, tmIdByInternalId } = buildShowList(json.shows, summary)
  const knownTmIds = new Set(showList.map((s) => s.tmId))
  const pEpByTmId = groupByShow(json.shows.pEp, tmIdByInternalId, knownTmIds, summary)
  const pSeByTmId = groupByShow(json.shows.pSe, tmIdByInternalId, knownTmIds, summary)

  summary.showsTotal = showList.length

  if (showList.length === 0) {
    return summary
  }

  // --- Per-show processing (the slow part: TMDB fetches) ---
  let processed = 0
  const results = await mapConcurrent(showList, concurrency, async (show) => {
    const res = await processShow(show, {
      getShowDetails,
      getSeasonEpisodes,
      pEpByTmId,
      pSeByTmId,
      now,
    })
    processed += 1
    onProgress?.({
      phase: 'shows',
      current: processed,
      total: showList.length,
      label: `Processing show ${processed}/${showList.length}…`,
    })
    return res
  })

  // --- Collect writes ---
  const trackedRows = []
  const episodeRows = []
  const seenEpisodeKeys = new Set()
  for (const res of results) {
    if (res.trackedRow) trackedRows.push(res.trackedRow)
    if (res.error) summary.errors.push(res.error)
    summary.seasonMarkersApplied += res.seasonMarkersApplied
    if (res.usedFallback) summary.fallbackShows.push(res.name)
    for (const row of res.episodeRows) {
      // Distinct tmId per show already makes these globally unique, but guard
      // against any duplicate key ending up in a single upsert chunk.
      const key = `${row.tmdb_show_id}:${row.season_number}:${row.episode_number}`
      if (seenEpisodeKeys.has(key)) continue
      seenEpisodeKeys.add(key)
      episodeRows.push(row)
    }
  }

  // --- Write tracked_shows (never overwrites existing) ---
  onProgress?.({ phase: 'writing', current: 0, total: episodeRows.length, label: 'Tracking shows…' })
  const tracked = await writeTrackedShows(supabase, trackedRows, chunkSize)
  summary.showsNewlyTracked = tracked.inserted
  summary.errors.push(...tracked.errors)

  // --- Write watched_episodes (gap-only, chunked) ---
  const episodes = await writeWatchedEpisodes(supabase, episodeRows, chunkSize, onProgress)
  summary.episodesImported = episodes.inserted
  summary.errors.push(...episodes.errors)

  return summary
}
