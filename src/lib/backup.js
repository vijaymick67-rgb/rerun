// Native Rerun backup: export/import of the two user-owned tables as a single
// versioned JSON file. Import is strictly merge-only — it can only add rows
// that don't already exist (via `ignoreDuplicates` on the same unique
// constraints the rest of the app relies on: tracked_shows.tmdb_id and
// watched_episodes(tmdb_show_id, season_number, episode_number)) — so current
// Rerun data always wins on conflict and importing the same file twice is a
// no-op the second time.
//
// The existing external-tracker importer (importWatchHistory.js) is untouched
// and reused as-is for any file that isn't this native format.

import { supabase as realSupabase } from './supabase.js'
import { fetchWatchedEpisodes } from './watchedEpisodes.js'
import { importWatchHistory } from './importWatchHistory.js'

export const BACKUP_FORMAT = 'rerun-backup'
export const BACKUP_SCHEMA_VERSION = 1

const TRACKED_SHOW_COLUMNS = 'tmdb_id, name, poster_path, added_at, finished_at, hidden_at'
const WATCHED_EPISODE_COLUMNS =
  'tmdb_show_id, season_number, episode_number, episode_name, runtime_minutes, watched_at'

// Supabase's default response cap — a single-user history can plausibly grow
// past this, so both tables are read with explicit range-paginated queries.
const PAGE_SIZE = 1000

// Rows per upsert on import. Keeps each request small even for a history of
// several thousand episodes, without ever writing one row per request.
const DEFAULT_CHUNK_SIZE = 300

// --- export ------------------------------------------------------------

// tmdb_id is unique, so ordering pagination by it guarantees every row is
// seen exactly once regardless of how many shows exist.
async function fetchAllTrackedShows(supabase) {
  const rows = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('tracked_shows')
      .select(TRACKED_SHOW_COLUMNS)
      .order('tmdb_id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
    from += PAGE_SIZE
  }
}

function toBackupShow(row) {
  return {
    tmdb_id: row.tmdb_id,
    name: row.name,
    poster_path: row.poster_path ?? null,
    added_at: row.added_at,
    finished_at: row.finished_at ?? null,
    hidden_at: row.hidden_at ?? null,
  }
}

function toBackupEpisode(row) {
  return {
    tmdb_show_id: row.tmdb_show_id,
    season_number: row.season_number,
    episode_number: row.episode_number,
    episode_name: row.episode_name ?? null,
    runtime_minutes: row.runtime_minutes ?? null,
    watched_at: row.watched_at,
  }
}

function compareShows(a, b) {
  if (a.added_at !== b.added_at) return a.added_at < b.added_at ? -1 : 1
  return a.tmdb_id - b.tmdb_id
}

function compareEpisodes(a, b) {
  if (a.tmdb_show_id !== b.tmdb_show_id) return a.tmdb_show_id - b.tmdb_show_id
  if (a.season_number !== b.season_number) return a.season_number - b.season_number
  return a.episode_number - b.episode_number
}

// Pure serializer: builds the versioned envelope from already-fetched rows,
// stripping to the allowlisted portable fields and sorting deterministically.
// No Supabase row ids, no secrets, no derived/TMDB payloads — only what's
// needed to recreate a tracked show or a watched episode.
export function serializeBackup({ trackedShows, watchedEpisodes, exportedAt }) {
  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt,
    data: {
      trackedShows: trackedShows.map(toBackupShow).sort(compareShows),
      watchedEpisodes: watchedEpisodes.map(toBackupEpisode).sort(compareEpisodes),
    },
  }
}

// Reads both tables (paginated) and serializes them. No TMDB calls, no
// poster images — poster_path is carried only as the existing text reference.
export async function buildBackup(options = {}) {
  const supabase = options.supabase ?? realSupabase
  const exportedAt = options.now ?? new Date().toISOString()

  const [trackedShows, watchedEpisodes] = await Promise.all([
    fetchAllTrackedShows(supabase),
    fetchWatchedEpisodes(supabase, WATCHED_EPISODE_COLUMNS),
  ])

  return serializeBackup({ trackedShows, watchedEpisodes, exportedAt })
}

// `rerun-backup-YYYY-MM-DD.json`, with an HHMMSS suffix so two exports on the
// same day never collide.
export function backupFilename(date = new Date()) {
  const iso = date.toISOString()
  const day = iso.slice(0, 10)
  const time = iso.slice(11, 19).replace(/:/g, '')
  return `rerun-backup-${day}-${time}.json`
}

// Triggers a client-side download of the backup JSON. iOS WebKit can still be
// reading the blob URL asynchronously right after the click, so the revoke is
// deferred instead of running immediately — an immediate revoke has been
// observed to truncate the download on installed iPhone PWAs.
export function downloadBackupFile(backup, filename) {
  const json = JSON.stringify(backup, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// --- native import: validation -----------------------------------------

export class BackupValidationError extends Error {}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteInt(value) {
  return typeof value === 'number' && Number.isInteger(value)
}

function isValidDateString(value) {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

function validateTrackedShowRow(row, index) {
  if (!isPlainObject(row)) {
    throw new BackupValidationError(`trackedShows[${index}] is not an object.`)
  }
  if (!isFiniteInt(row.tmdb_id) || row.tmdb_id <= 0) {
    throw new BackupValidationError(`trackedShows[${index}] has an invalid tmdb_id.`)
  }
  if (typeof row.name !== 'string' || row.name.trim() === '') {
    throw new BackupValidationError(`trackedShows[${index}] is missing a name.`)
  }
  if (row.poster_path != null && typeof row.poster_path !== 'string') {
    throw new BackupValidationError(`trackedShows[${index}] has an invalid poster_path.`)
  }
  if (!isValidDateString(row.added_at)) {
    throw new BackupValidationError(`trackedShows[${index}] has an invalid added_at date.`)
  }
  if (row.finished_at != null && !isValidDateString(row.finished_at)) {
    throw new BackupValidationError(`trackedShows[${index}] has an invalid finished_at date.`)
  }
  if (row.hidden_at != null && !isValidDateString(row.hidden_at)) {
    throw new BackupValidationError(`trackedShows[${index}] has an invalid hidden_at date.`)
  }
  return {
    tmdb_id: row.tmdb_id,
    name: row.name,
    poster_path: row.poster_path ?? null,
    added_at: row.added_at,
    finished_at: row.finished_at ?? null,
    hidden_at: row.hidden_at ?? null,
  }
}

// Note: a watched_episodes row's tmdb_show_id is deliberately NOT required to
// match a trackedShows row in the same backup. Removing a show from
// tracked_shows intentionally leaves its watched_episodes history in place
// (see finishedShows.js), so orphaned history is normal, real data — only
// structurally unusable ids (missing/non-integer/non-positive) are rejected.
function validateWatchedEpisodeRow(row, index) {
  if (!isPlainObject(row)) {
    throw new BackupValidationError(`watchedEpisodes[${index}] is not an object.`)
  }
  if (!isFiniteInt(row.tmdb_show_id) || row.tmdb_show_id <= 0) {
    throw new BackupValidationError(`watchedEpisodes[${index}] has an invalid tmdb_show_id.`)
  }
  if (!isFiniteInt(row.season_number) || row.season_number < 0) {
    throw new BackupValidationError(`watchedEpisodes[${index}] has an invalid season_number.`)
  }
  if (!isFiniteInt(row.episode_number) || row.episode_number < 1) {
    throw new BackupValidationError(`watchedEpisodes[${index}] has an invalid episode_number.`)
  }
  if (row.episode_name != null && typeof row.episode_name !== 'string') {
    throw new BackupValidationError(`watchedEpisodes[${index}] has an invalid episode_name.`)
  }
  if (
    row.runtime_minutes != null &&
    (typeof row.runtime_minutes !== 'number' || !Number.isFinite(row.runtime_minutes))
  ) {
    throw new BackupValidationError(`watchedEpisodes[${index}] has an invalid runtime_minutes.`)
  }
  if (!isValidDateString(row.watched_at)) {
    throw new BackupValidationError(`watchedEpisodes[${index}] has an invalid watched_at date.`)
  }
  return {
    tmdb_show_id: row.tmdb_show_id,
    season_number: row.season_number,
    episode_number: row.episode_number,
    episode_name: row.episode_name ?? null,
    runtime_minutes: row.runtime_minutes ?? null,
    watched_at: row.watched_at,
  }
}

export function isNativeBackup(json) {
  return isPlainObject(json) && json.format === BACKUP_FORMAT
}

// Validates and normalizes the whole file before any Supabase mutation is
// even considered. Throws BackupValidationError on the first structural
// problem — there is no partial validation pass, so a bad file never reaches
// the write path. Unknown extra fields (on the root or on rows) are ignored,
// so future additive schema versions stay forward-compatible.
export function validateNativeBackup(json) {
  if (!isPlainObject(json)) {
    throw new BackupValidationError('This file is not a valid Rerun backup.')
  }
  if (json.format !== BACKUP_FORMAT) {
    throw new BackupValidationError('This file is not a Rerun backup.')
  }
  if (!isFiniteInt(json.schemaVersion) || json.schemaVersion < 1) {
    throw new BackupValidationError('This backup is missing a valid schema version.')
  }
  if (json.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new BackupValidationError(
      `This backup was made with a newer version of Rerun (schema v${json.schemaVersion}) and can't be imported here yet.`,
    )
  }
  if (!isPlainObject(json.data)) {
    throw new BackupValidationError('This backup is missing its data.')
  }
  if (!Array.isArray(json.data.trackedShows)) {
    throw new BackupValidationError("This backup's trackedShows section is malformed.")
  }
  if (!Array.isArray(json.data.watchedEpisodes)) {
    throw new BackupValidationError("This backup's watchedEpisodes section is malformed.")
  }

  return {
    trackedShows: json.data.trackedShows.map(validateTrackedShowRow),
    watchedEpisodes: json.data.watchedEpisodes.map(validateWatchedEpisodeRow),
  }
}

// --- native import: writes ----------------------------------------------

function dedupeBy(rows, keyFn) {
  const seen = new Set()
  const result = []
  for (const row of rows) {
    const key = keyFn(row)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(row)
  }
  return result
}

// Chunked upsert with `ignoreDuplicates: true` on the table's real unique
// constraint — an existing row is never touched, so exported added_at /
// watched_at values are preserved on insert and current Rerun data always
// wins on conflict. The returned `data` set contains only the rows Supabase
// actually inserted.
//
// A chunk whose write fails is counted as `failed`, never as `alreadyPresent`
// — otherwise a failed write would be indistinguishable from rows that were
// genuinely already in Supabase, and the UI could tell the user data is safe
// when it was never written.
async function upsertChunked(supabase, table, rows, onConflict, chunkSize, onChunkProgress) {
  let inserted = 0
  let alreadyPresent = 0
  let failed = 0
  const errors = []
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const { data, error } = await supabase
      .from(table)
      .upsert(chunk, { onConflict, ignoreDuplicates: true })
      .select('*')
    if (error) {
      failed += chunk.length
      errors.push(`Couldn't write ${chunk.length} ${table} row(s): ${error.message}`)
    } else {
      const insertedInChunk = data?.length ?? 0
      inserted += insertedInChunk
      alreadyPresent += chunk.length - insertedInChunk
    }
    onChunkProgress?.(Math.min(i + chunkSize, rows.length), rows.length)
  }
  return { inserted, alreadyPresent, failed, errors }
}

// Imports an already-validated native backup. Merge-only: writes go through
// `ignoreDuplicates` upserts keyed on the same constraints the rest of the
// app uses (tracked_shows.tmdb_id; watched_episodes on tmdb_show_id +
// season_number + episode_number), so nothing existing is ever overwritten
// and re-importing the same backup a second time inserts nothing further.
export async function importNativeBackup(validated, options = {}) {
  const supabase = options.supabase ?? realSupabase
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  const onProgress = options.onProgress

  const trackedShows = dedupeBy(validated.trackedShows, (row) => row.tmdb_id)
  const watchedEpisodes = dedupeBy(
    validated.watchedEpisodes,
    (row) => `${row.tmdb_show_id}:${row.season_number}:${row.episode_number}`,
  )
  // Rows that repeat within the file itself, collapsed before ever reaching
  // Supabase — distinct from rows Supabase reports as already present.
  const showsDuplicateInFile = validated.trackedShows.length - trackedShows.length
  const episodesDuplicateInFile = validated.watchedEpisodes.length - watchedEpisodes.length
  const totalRows = trackedShows.length + watchedEpisodes.length

  onProgress?.({ phase: 'writing', current: 0, total: totalRows, label: 'Adding shows…' })
  const showsResult = await upsertChunked(
    supabase,
    'tracked_shows',
    trackedShows,
    'tmdb_id',
    chunkSize,
    (done) => onProgress?.({ phase: 'writing', current: done, total: totalRows, label: 'Adding shows…' }),
  )

  onProgress?.({
    phase: 'writing',
    current: trackedShows.length,
    total: totalRows,
    label: 'Adding watched episodes…',
  })
  const episodesResult = await upsertChunked(
    supabase,
    'watched_episodes',
    watchedEpisodes,
    'tmdb_show_id,season_number,episode_number',
    chunkSize,
    (done) =>
      onProgress?.({
        phase: 'writing',
        current: trackedShows.length + done,
        total: totalRows,
        label: `Adding watched episodes ${done}/${watchedEpisodes.length}…`,
      }),
  )

  return {
    kind: 'native',
    showsAdded: showsResult.inserted,
    showsAlreadyTracked: showsResult.alreadyPresent,
    showsDuplicateInFile,
    showsFailed: showsResult.failed,
    episodesAdded: episodesResult.inserted,
    episodesAlreadyLogged: episodesResult.alreadyPresent,
    episodesDuplicateInFile,
    episodesFailed: episodesResult.failed,
    errors: [...showsResult.errors, ...episodesResult.errors],
  }
}

// --- format detection -----------------------------------------------------

// Routes a parsed backup file to the right importer without asking the user
// which app produced it. Native Rerun backups are validated (and rejected
// up-front on any structural problem) before any write. Anything else is
// handed to the existing external-tracker importer unchanged, which already
// raises a clear error for JSON that matches neither shape.
export async function importBackupFile(json, options = {}) {
  if (isNativeBackup(json)) {
    const validated = validateNativeBackup(json)
    return importNativeBackup(validated, options)
  }
  const summary = await importWatchHistory(json, options)
  return { kind: 'external', ...summary }
}
