import { describe, expect, it, vi } from 'vitest'
import {
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  BackupValidationError,
  serializeBackup,
  buildBackup,
  backupFilename,
  isNativeBackup,
  validateNativeBackup,
  importNativeBackup,
  importBackupFile,
} from './backup'

// --- fakes -------------------------------------------------------------

// Read-only Supabase double: chainable select/order/in, paginated via range(),
// mirroring the real query shape used by buildBackup and by the existing
// fetchWatchedEpisodes helper it reuses.
function makeReadSupabase({ tracked_shows = [], watched_episodes = [] } = {}) {
  const calls = { tracked_shows: [], watched_episodes: [] }
  const tables = { tracked_shows, watched_episodes }
  return {
    calls,
    from(name) {
      const rows = tables[name]
      return {
        select() { return this },
        order() { return this },
        in() { return this },
        range(from, to) {
          calls[name].push({ from, to })
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
        },
      }
    },
  }
}

function keyFor(row, onConflict) {
  return onConflict.split(',').map((c) => row[c]).join('|')
}

// Write Supabase double honouring onConflict + ignoreDuplicates so
// never-overwrite / idempotency / chunking can be asserted end-to-end.
function makeWriteSupabase(seed = {}) {
  const tables = {
    tracked_shows: new Map(seed.tracked_shows ?? []),
    watched_episodes: new Map(seed.watched_episodes ?? []),
  }
  const upsertCalls = { tracked_shows: 0, watched_episodes: 0 }
  return {
    tables,
    upsertCalls,
    from(name) {
      return {
        upsert(rows, opts) {
          upsertCalls[name] += 1
          const inserted = []
          for (const row of rows) {
            const key = keyFor(row, opts.onConflict)
            if (opts.error && opts.error === name) continue
            if (!tables[name].has(key)) {
              tables[name].set(key, row)
              inserted.push(row)
            }
          }
          if (opts.errorTable === name) {
            return { select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }
          }
          return { select: () => Promise.resolve({ data: inserted, error: null }) }
        },
      }
    },
  }
}

function validShow(overrides = {}) {
  return {
    tmdb_id: 100,
    name: 'Lucky',
    poster_path: '/lucky.jpg',
    added_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function validEpisode(overrides = {}) {
  return {
    tmdb_show_id: 100,
    season_number: 1,
    episode_number: 1,
    episode_name: 'Pilot',
    runtime_minutes: 30,
    watched_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }
}

function nativeBackup({ trackedShows = [validShow()], watchedEpisodes = [validEpisode()], schemaVersion = 1 } = {}) {
  return {
    format: BACKUP_FORMAT,
    schemaVersion,
    exportedAt: '2026-01-03T00:00:00.000Z',
    data: { trackedShows, watchedEpisodes },
  }
}

// --- serializeBackup -----------------------------------------------------

describe('serializeBackup', () => {
  it('stamps the format identifier, schema version and exported timestamp', () => {
    const backup = serializeBackup({ trackedShows: [], watchedEpisodes: [], exportedAt: '2026-07-19T00:00:00.000Z' })
    expect(backup.format).toBe('rerun-backup')
    expect(backup.schemaVersion).toBe(1)
    expect(backup.exportedAt).toBe('2026-07-19T00:00:00.000Z')
  })

  it('keeps only the allowlisted fields, dropping ids and any other internal columns', () => {
    const backup = serializeBackup({
      trackedShows: [
        { id: 1, tmdb_id: 100, name: 'Lucky', poster_path: '/p.jpg', added_at: 'A', hidden_at: null, finished_at: null },
      ],
      watchedEpisodes: [
        { id: 55, tmdb_show_id: 100, season_number: 1, episode_number: 1, episode_name: 'Pilot', runtime_minutes: 30, watched_at: 'B' },
      ],
      exportedAt: 'X',
    })
    expect(Object.keys(backup.data.trackedShows[0]).sort()).toEqual(
      ['added_at', 'name', 'poster_path', 'tmdb_id'].sort(),
    )
    expect(Object.keys(backup.data.watchedEpisodes[0]).sort()).toEqual(
      ['episode_name', 'episode_number', 'runtime_minutes', 'season_number', 'tmdb_show_id', 'watched_at'].sort(),
    )
  })

  it('orders shows by added date, then tmdb id', () => {
    const backup = serializeBackup({
      trackedShows: [
        validShow({ tmdb_id: 3, added_at: '2026-01-02T00:00:00.000Z' }),
        validShow({ tmdb_id: 1, added_at: '2026-01-01T00:00:00.000Z' }),
        validShow({ tmdb_id: 2, added_at: '2026-01-01T00:00:00.000Z' }),
      ],
      watchedEpisodes: [],
      exportedAt: 'X',
    })
    expect(backup.data.trackedShows.map((s) => s.tmdb_id)).toEqual([1, 2, 3])
  })

  it('orders episodes by show, season, then episode number', () => {
    const backup = serializeBackup({
      trackedShows: [],
      watchedEpisodes: [
        validEpisode({ tmdb_show_id: 200, season_number: 1, episode_number: 2 }),
        validEpisode({ tmdb_show_id: 100, season_number: 2, episode_number: 1 }),
        validEpisode({ tmdb_show_id: 100, season_number: 1, episode_number: 2 }),
        validEpisode({ tmdb_show_id: 100, season_number: 1, episode_number: 1 }),
      ],
      exportedAt: 'X',
    })
    expect(
      backup.data.watchedEpisodes.map((e) => `${e.tmdb_show_id}:${e.season_number}:${e.episode_number}`),
    ).toEqual(['100:1:1', '100:1:2', '100:2:1', '200:1:2'])
  })

  it('serializes an empty database to empty arrays, not an error', () => {
    const backup = serializeBackup({ trackedShows: [], watchedEpisodes: [], exportedAt: 'X' })
    expect(backup.data.trackedShows).toEqual([])
    expect(backup.data.watchedEpisodes).toEqual([])
  })
})

// --- buildBackup (pagination + no TMDB) -----------------------------------

describe('buildBackup', () => {
  it('reads both tables and serializes them with no ids or secrets', async () => {
    const supabase = makeReadSupabase({
      tracked_shows: [{ id: 9, tmdb_id: 100, name: 'Lucky', poster_path: '/p.jpg', added_at: 'A' }],
      watched_episodes: [{ id: 1, tmdb_show_id: 100, season_number: 1, episode_number: 1, episode_name: 'Pilot', runtime_minutes: 30, watched_at: 'B' }],
    })
    const backup = await buildBackup({ supabase, now: 'NOW' })
    expect(backup.exportedAt).toBe('NOW')
    expect(backup.data.trackedShows).toEqual([{ tmdb_id: 100, name: 'Lucky', poster_path: '/p.jpg', added_at: 'A' }])
    expect(backup.data.watchedEpisodes).toEqual([
      { tmdb_show_id: 100, season_number: 1, episode_number: 1, episode_name: 'Pilot', runtime_minutes: 30, watched_at: 'B' },
    ])
  })

  it('explicitly paginates tracked_shows past the default 1,000-row response cap', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      tmdb_id: i + 1,
      name: `Show ${i + 1}`,
      poster_path: null,
      added_at: '2026-01-01T00:00:00.000Z',
    }))
    const supabase = makeReadSupabase({ tracked_shows: rows, watched_episodes: [] })
    const backup = await buildBackup({ supabase, now: 'NOW' })
    expect(backup.data.trackedShows).toHaveLength(1001)
    expect(supabase.calls.tracked_shows).toEqual([{ from: 0, to: 999 }, { from: 1000, to: 1999 }])
  })

  it('never imports or calls the TMDB client', async () => {
    vi.resetModules()
    vi.doMock('./tmdb.js', () => ({
      getShowDetails: () => { throw new Error('TMDB must not be called during export') },
      getSeasonEpisodes: () => { throw new Error('TMDB must not be called during export') },
    }))
    const { buildBackup: freshBuildBackup } = await import('./backup.js')
    const supabase = makeReadSupabase()
    await expect(freshBuildBackup({ supabase, now: 'NOW' })).resolves.toBeTruthy()
    vi.doUnmock('./tmdb.js')
    vi.resetModules()
  })
})

describe('backupFilename', () => {
  it('produces the rerun-backup-YYYY-MM-DD base name with a collision-safe time suffix', () => {
    const name = backupFilename(new Date('2026-07-19T14:32:05.000Z'))
    expect(name).toBe('rerun-backup-2026-07-19-143205.json')
  })
})

// --- validateNativeBackup --------------------------------------------------

describe('isNativeBackup', () => {
  it('identifies the native format by its format field', () => {
    expect(isNativeBackup(nativeBackup())).toBe(true)
    expect(isNativeBackup({ shows: {} })).toBe(false)
    expect(isNativeBackup(null)).toBe(false)
    expect(isNativeBackup([1, 2, 3])).toBe(false)
  })
})

describe('validateNativeBackup', () => {
  it('accepts a valid v1 backup and normalizes it to the allowlisted fields', () => {
    const result = validateNativeBackup(nativeBackup())
    expect(result.trackedShows).toEqual([validShow()])
    expect(result.watchedEpisodes).toEqual([validEpisode()])
  })

  it('tolerates unknown additional fields for forward-compatible evolution', () => {
    const backup = nativeBackup({
      trackedShows: [{ ...validShow(), futureField: 'x' }],
      watchedEpisodes: [{ ...validEpisode(), anotherFutureField: 42 }],
    })
    backup.someRootLevelAddition = true
    const result = validateNativeBackup(backup)
    expect(result.trackedShows[0]).not.toHaveProperty('futureField')
    expect(result.watchedEpisodes[0]).not.toHaveProperty('anotherFutureField')
  })

  it('accepts watched-episode rows whose show id is absent from trackedShows (orphaned history is normal)', () => {
    const backup = nativeBackup({ trackedShows: [], watchedEpisodes: [validEpisode({ tmdb_show_id: 999 })] })
    expect(() => validateNativeBackup(backup)).not.toThrow()
  })

  it.each([
    ['null root', null],
    ['array root', [1, 2, 3]],
    ['string root', 'not a backup'],
  ])('rejects a non-object root (%s)', (_label, root) => {
    expect(() => validateNativeBackup(root)).toThrow(BackupValidationError)
  })

  it('rejects a missing or incorrect format identifier', () => {
    expect(() => validateNativeBackup({ ...nativeBackup(), format: 'something-else' })).toThrow(BackupValidationError)
    const { format: _drop, ...noFormat } = nativeBackup()
    expect(() => validateNativeBackup(noFormat)).toThrow(BackupValidationError)
  })

  it('rejects an unsupported (future) schema version without silently importing it', () => {
    expect(() => validateNativeBackup(nativeBackup({ schemaVersion: BACKUP_SCHEMA_VERSION + 1 }))).toThrow(
      BackupValidationError,
    )
  })

  it('rejects a missing or invalid schema version', () => {
    expect(() => validateNativeBackup(nativeBackup({ schemaVersion: 0 }))).toThrow(BackupValidationError)
    expect(() => validateNativeBackup({ ...nativeBackup(), schemaVersion: '1' })).toThrow(BackupValidationError)
    const missing = nativeBackup()
    delete missing.schemaVersion
    expect(() => validateNativeBackup(missing)).toThrow(BackupValidationError)
  })

  it('rejects a missing data section', () => {
    const backup = nativeBackup()
    delete backup.data
    expect(() => validateNativeBackup(backup)).toThrow(BackupValidationError)
  })

  it('rejects trackedShows or watchedEpisodes that are not arrays', () => {
    expect(() => validateNativeBackup(nativeBackup({ trackedShows: {} }))).toThrow(BackupValidationError)
    expect(() => validateNativeBackup(nativeBackup({ watchedEpisodes: 'nope' }))).toThrow(BackupValidationError)
  })

  it.each([
    ['missing tmdb_id', validShow({ tmdb_id: undefined })],
    ['non-integer tmdb_id', validShow({ tmdb_id: 1.5 })],
    ['non-positive tmdb_id', validShow({ tmdb_id: 0 })],
    ['missing name', validShow({ name: undefined })],
    ['empty name', validShow({ name: '  ' })],
    ['non-string poster_path', validShow({ poster_path: 123 })],
    ['malformed added_at', validShow({ added_at: 'not-a-date' })],
  ])('rejects a malformed tracked-show row (%s)', (_label, badRow) => {
    expect(() => validateNativeBackup(nativeBackup({ trackedShows: [badRow] }))).toThrow(BackupValidationError)
  })

  it.each([
    ['missing tmdb_show_id', validEpisode({ tmdb_show_id: undefined })],
    ['non-positive tmdb_show_id', validEpisode({ tmdb_show_id: -1 })],
    ['negative season_number', validEpisode({ season_number: -1 })],
    ['non-integer season_number', validEpisode({ season_number: 1.5 })],
    ['zero episode_number', validEpisode({ episode_number: 0 })],
    ['non-integer episode_number', validEpisode({ episode_number: '1' })],
    ['non-numeric runtime_minutes', validEpisode({ runtime_minutes: 'thirty' })],
    ['malformed watched_at', validEpisode({ watched_at: 'not-a-date' })],
  ])('rejects a malformed watched-episode row (%s)', (_label, badRow) => {
    expect(() => validateNativeBackup(nativeBackup({ watchedEpisodes: [badRow] }))).toThrow(BackupValidationError)
  })

  it('rejects unreasonably malformed files without reading past the structural problem', () => {
    expect(() => validateNativeBackup('{"not": "even an object after parse issues"}')).toThrow(BackupValidationError)
  })
})

// --- importNativeBackup ----------------------------------------------------

describe('importNativeBackup', () => {
  it('inserts shows and episodes that are absent, preserving their exported timestamps', async () => {
    const supabase = makeWriteSupabase()
    const validated = validateNativeBackup(nativeBackup())
    const result = await importNativeBackup(validated, { supabase })

    expect(result).toMatchObject({ kind: 'native', showsAdded: 1, showsSkipped: 0, episodesAdded: 1, episodesSkipped: 0, errors: [] })
    expect(supabase.tables.tracked_shows.get('100')).toEqual(validShow())
    expect(supabase.tables.watched_episodes.get('100|1|1')).toEqual(validEpisode())
  })

  it('never overwrites an existing tracked show or watched episode', async () => {
    const existingShow = validShow({ name: 'Existing Name Wins' })
    const existingEpisode = validEpisode({ episode_name: 'Existing Episode Wins' })
    const supabase = makeWriteSupabase({
      tracked_shows: [['100', existingShow]],
      watched_episodes: [['100|1|1', existingEpisode]],
    })
    const validated = validateNativeBackup(
      nativeBackup({
        trackedShows: [validShow({ name: 'Incoming Name' })],
        watchedEpisodes: [validEpisode({ episode_name: 'Incoming Episode' })],
      }),
    )
    const result = await importNativeBackup(validated, { supabase })

    expect(result.showsAdded).toBe(0)
    expect(result.showsSkipped).toBe(1)
    expect(result.episodesAdded).toBe(0)
    expect(result.episodesSkipped).toBe(1)
    expect(supabase.tables.tracked_shows.get('100')).toEqual(existingShow)
    expect(supabase.tables.watched_episodes.get('100|1|1')).toEqual(existingEpisode)
  })

  it('is idempotent: importing the same backup twice adds nothing the second time', async () => {
    const supabase = makeWriteSupabase()
    const validated = validateNativeBackup(
      nativeBackup({
        trackedShows: [validShow({ tmdb_id: 1 }), validShow({ tmdb_id: 2 })],
        watchedEpisodes: [validEpisode({ episode_number: 1 }), validEpisode({ episode_number: 2 })],
      }),
    )

    const first = await importNativeBackup(validated, { supabase })
    expect(first.showsAdded).toBe(2)
    expect(first.episodesAdded).toBe(2)

    const second = await importNativeBackup(validated, { supabase })
    expect(second.showsAdded).toBe(0)
    expect(second.showsSkipped).toBe(2)
    expect(second.episodesAdded).toBe(0)
    expect(second.episodesSkipped).toBe(2)
    expect(supabase.tables.tracked_shows.size).toBe(2)
    expect(supabase.tables.watched_episodes.size).toBe(2)
  })

  it('deduplicates rows that repeat within a single file', async () => {
    const supabase = makeWriteSupabase()
    const validated = {
      trackedShows: [validShow(), validShow()],
      watchedEpisodes: [validEpisode(), validEpisode()],
    }
    const result = await importNativeBackup(validated, { supabase })
    expect(result.showsAdded).toBe(1)
    expect(result.showsSkipped).toBe(1)
    expect(result.episodesAdded).toBe(1)
    expect(result.episodesSkipped).toBe(1)
  })

  it('writes in chunks rather than one request per row', async () => {
    const supabase = makeWriteSupabase()
    const episodes = Array.from({ length: 5 }, (_, i) => validEpisode({ episode_number: i + 1 }))
    const result = await importNativeBackup({ trackedShows: [], watchedEpisodes: episodes }, { supabase, chunkSize: 2 })
    expect(result.episodesAdded).toBe(5)
    expect(supabase.upsertCalls.watched_episodes).toBe(3) // ceil(5/2), not 5
  })

  it('surfaces nonfatal write errors without misreporting the rows that did succeed', async () => {
    const supabase = makeWriteSupabase()
    const realFrom = supabase.from.bind(supabase)
    supabase.from = (name) => {
      const table = realFrom(name)
      if (name === 'tracked_shows') {
        return { upsert: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'network blip' } }) }) }
      }
      return table
    }
    const validated = validateNativeBackup(nativeBackup())
    const result = await importNativeBackup(validated, { supabase })

    expect(result.showsAdded).toBe(0)
    expect(result.errors).toEqual(["Couldn't write 1 tracked_shows row(s): network blip"])
    expect(result.episodesAdded).toBe(1) // the unrelated table's write still succeeded
  })

  it('never calls TMDB during a native import', async () => {
    vi.resetModules()
    vi.doMock('./tmdb.js', () => ({
      getShowDetails: () => { throw new Error('TMDB must not be called during native import') },
      getSeasonEpisodes: () => { throw new Error('TMDB must not be called during native import') },
    }))
    const { importNativeBackup: freshImport, validateNativeBackup: freshValidate } = await import('./backup.js')
    const supabase = makeWriteSupabase()
    await expect(freshImport(freshValidate(nativeBackup()), { supabase })).resolves.toMatchObject({ kind: 'native' })
    vi.doUnmock('./tmdb.js')
    vi.resetModules()
  })
})

// --- importBackupFile: format detection ------------------------------------

describe('importBackupFile', () => {
  it('routes a native Rerun backup to the native importer', async () => {
    const supabase = makeWriteSupabase()
    const result = await importBackupFile(nativeBackup(), { supabase })
    expect(result.kind).toBe('native')
    expect(result.showsAdded).toBe(1)
  })

  it('routes a non-native backup to the existing external importWatchHistory flow', async () => {
    const supabase = makeWriteSupabase()
    const getShowDetails = vi.fn(async (id) => ({
      id, name: 'External Show', poster_path: '/e.jpg', networks: ['Netflix'], status: 'Ended',
      seasons: [{ season_number: 1, episode_count: 1 }],
    }))
    const getSeasonEpisodes = vi.fn(async () => ({
      season_number: 1,
      episodes: [{ episode_number: 1, name: 'Pilot', air_date: '2020-01-01', runtime: 30 }],
    }))
    const externalFile = { shows: { cW: [{ id: 1, tmId: 777, t: 'External Show', a: '2020-01-01T00:00:00.000Z' }] } }

    const result = await importBackupFile(externalFile, { supabase, getShowDetails, getSeasonEpisodes })
    expect(result.kind).toBe('external')
    expect(result.showsTotal).toBe(1)
  })

  it('rejects JSON that matches neither format with a clear message', async () => {
    await expect(importBackupFile({ nothing: 'useful' }, {})).rejects.toThrow(/supported backup file/)
  })

  it('validates a malformed native backup and rejects it before any Supabase call is made', async () => {
    const supabase = {
      from() { throw new Error('Supabase must not be touched when validation fails') },
    }
    const malformed = nativeBackup({ trackedShows: [validShow({ tmdb_id: -1 })] })
    await expect(importBackupFile(malformed, { supabase })).rejects.toThrow(BackupValidationError)
  })
})
