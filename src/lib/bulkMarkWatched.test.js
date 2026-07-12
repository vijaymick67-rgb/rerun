import { describe, expect, it, vi } from 'vitest'
import {
  EXCEPTION_SHOWS,
  planBulkMark,
  bulkMarkShows,
  buildAiredEpisodeRows,
} from './bulkMarkWatched'

// --- Fakes (mirrors importWatchHistory.test.js) ----------------------------

function ep(n, airDate) {
  return { episode_number: n, name: `E${n}`, air_date: airDate, runtime: 30 }
}

const TMDB = {
  100: {
    name: 'Completed Show',
    networks: ['Netflix'],
    seasons: {
      0: [ep(1, '2014-12-01')], // specials — must be excluded
      1: [ep(1, '2015-01-01'), ep(2, '2015-01-08')],
      2: [ep(1, '2016-01-01'), ep(2, '2999-01-01')], // s2e2 not aired
    },
  },
  200: {
    name: 'Second Show',
    networks: ['Netflix'],
    seasons: { 1: [ep(1, '2019-01-01'), ep(2, '2019-01-08'), ep(3, '2019-01-15')] },
  },
}

function makeTmdb(db = TMDB) {
  return {
    getShowDetails: vi.fn(async (id) => {
      const s = db[id]
      if (!s) throw new Error('not found')
      return {
        id,
        name: s.name,
        networks: s.networks,
        seasons: Object.keys(s.seasons).map((n) => ({
          season_number: Number(n),
          episode_count: s.seasons[n].length,
        })),
      }
    }),
    getSeasonEpisodes: vi.fn(async (id, sn) => {
      const s = db[id]
      if (!s || !s.seasons[sn]) throw new Error('no season')
      return { season_number: sn, episodes: s.seasons[sn] }
    }),
  }
}

function keyFor(row, onConflict) {
  return onConflict
    .split(',')
    .map((c) => row[c])
    .join('|')
}

// Honours onConflict + ignoreDuplicates so never-overwrite / idempotency can be
// asserted end-to-end.
function makeSupabase(seed = {}) {
  const tables = { watched_episodes: new Map(seed.watched_episodes ?? []) }
  return {
    tables,
    from(name) {
      return {
        upsert(rows, opts) {
          const inserted = []
          for (const row of rows) {
            const key = keyFor(row, opts.onConflict)
            if (tables[name].has(key)) {
              if (!opts.ignoreDuplicates) {
                tables[name].set(key, row)
                inserted.push(row)
              }
            } else {
              tables[name].set(key, row)
              inserted.push(row)
            }
          }
          return { select: () => Promise.resolve({ data: inserted, error: null }) }
        },
      }
    },
  }
}

const NOW = '2026-07-12T00:00:00.000Z'

function watchedRow(supabase, tmId, sN, eN) {
  return supabase.tables.watched_episodes.get(`${tmId}|${sN}|${eN}`)
}

// --- planBulkMark ----------------------------------------------------------

describe('planBulkMark', () => {
  const tracked = [
    { tmdb_id: 1, name: 'Completed Show' },
    { tmdb_id: 2, name: 'the sopranos' }, // case-insensitive match
    { tmdb_id: 3, name: '  Sugar  ' }, // whitespace-trimmed match
    { tmdb_id: 4, name: 'House of the Dragon' },
  ]

  it('separates exception-list shows from everything else', () => {
    const { affected, skipped } = planBulkMark(tracked)
    expect(affected.map((s) => s.tmdb_id)).toEqual([1])
    expect(skipped.map((s) => s.tmdb_id).sort()).toEqual([2, 3, 4])
  })

  it('reports which exception names matched a tracked show', () => {
    const { matchedExceptions } = planBulkMark(tracked)
    expect(matchedExceptions.sort()).toEqual(
      ['House of the Dragon', 'Sugar', 'The Sopranos'].sort(),
    )
  })

  it('surfaces exception names with zero match (likely a naming mismatch)', () => {
    const { unmatchedExceptions } = planBulkMark(tracked)
    // Everything except the 3 that matched above.
    expect(unmatchedExceptions).toEqual(
      EXCEPTION_SHOWS.filter(
        (n) => !['Sugar', 'The Sopranos', 'House of the Dragon'].includes(n),
      ),
    )
  })

  it('marks all 8 as unmatched when nothing is tracked', () => {
    const { affected, matchedExceptions, unmatchedExceptions } = planBulkMark([])
    expect(affected).toEqual([])
    expect(matchedExceptions).toEqual([])
    expect(unmatchedExceptions).toEqual(EXCEPTION_SHOWS)
  })

  it('does not treat a near-miss title as a match', () => {
    // "Sugar (2024)" is NOT "Sugar" — it must land in affected, so the user can
    // catch the naming mismatch in the preview before confirming.
    const { affected, matchedExceptions } = planBulkMark([
      { tmdb_id: 9, name: 'Sugar (2024)' },
    ])
    expect(affected.map((s) => s.name)).toEqual(['Sugar (2024)'])
    expect(matchedExceptions).toEqual([])
  })
})

// --- buildAiredEpisodeRows -------------------------------------------------

describe('buildAiredEpisodeRows', () => {
  it('includes only aired episodes and excludes specials (season 0)', async () => {
    const tmdb = makeTmdb()
    const { rows } = await buildAiredEpisodeRows(100, {
      getShowDetails: tmdb.getShowDetails,
      getSeasonEpisodes: tmdb.getSeasonEpisodes,
      watchedAt: NOW,
    })
    const keys = rows.map((r) => `${r.season_number}:${r.episode_number}`).sort()
    expect(keys).toEqual(['1:1', '1:2', '2:1']) // 0:1 special + 2:2 (unaired) dropped
    expect(rows.every((r) => r.watched_at === NOW)).toBe(true)
  })

  it('tolerates a failing season fetch instead of aborting the show', async () => {
    const getShowDetails = vi.fn(async () => ({
      networks: ['Netflix'],
      seasons: [
        { season_number: 1 },
        { season_number: 2 },
      ],
    }))
    const getSeasonEpisodes = vi.fn(async (id, sn) => {
      if (sn === 2) throw new Error('boom')
      return { episodes: [ep(1, '2015-01-01')] }
    })
    const { rows, failedSeasons } = await buildAiredEpisodeRows(100, {
      getShowDetails,
      getSeasonEpisodes,
      watchedAt: NOW,
    })
    expect(rows.map((r) => r.season_number)).toEqual([1])
    expect(failedSeasons).toBe(1)
  })
})

// --- bulkMarkShows ---------------------------------------------------------

describe('bulkMarkShows', () => {
  function run(shows, supabase = makeSupabase(), opts = {}) {
    const tmdb = makeTmdb()
    return bulkMarkShows(shows, {
      supabase,
      getShowDetails: tmdb.getShowDetails,
      getSeasonEpisodes: tmdb.getSeasonEpisodes,
      now: NOW,
      ...opts,
    }).then((results) => ({ results, supabase }))
  }

  it('marks every aired episode of each show and reports per-show counts', async () => {
    const { results, supabase } = await run([
      { tmdb_id: 100, name: 'Completed Show' },
      { tmdb_id: 200, name: 'Second Show' },
    ])
    expect(results.map((r) => ({ id: r.tmdb_id, aired: r.airedCount, ins: r.insertedCount }))).toEqual([
      { id: 100, aired: 3, ins: 3 },
      { id: 200, aired: 3, ins: 3 },
    ])
    expect(watchedRow(supabase, 100, 1, 1)).toBeDefined()
    expect(watchedRow(supabase, 200, 1, 3)).toBeDefined()
    // Unaired / special never written.
    expect(watchedRow(supabase, 100, 2, 2)).toBeUndefined()
    expect(watchedRow(supabase, 100, 0, 1)).toBeUndefined()
  })

  it('is idempotent — a second run marks nothing new and alters nothing', async () => {
    const supabase = makeSupabase()
    const first = await run([{ tmdb_id: 100, name: 'Completed Show' }], supabase)
    expect(first.results[0].insertedCount).toBe(3)

    const before = new Map(supabase.tables.watched_episodes)
    const second = await run([{ tmdb_id: 100, name: 'Completed Show' }], supabase)
    expect(second.results[0].airedCount).toBe(3)
    expect(second.results[0].insertedCount).toBe(0) // nothing new
    expect(supabase.tables.watched_episodes.size).toBe(before.size)
  })

  it('never overwrites an existing watched row', async () => {
    const preexisting = {
      tmdb_show_id: 100,
      season_number: 1,
      episode_number: 1,
      watched_at: 'ORIGINAL',
      runtime_minutes: 42,
    }
    const supabase = makeSupabase({ watched_episodes: [['100|1|1', preexisting]] })
    await run([{ tmdb_id: 100, name: 'Completed Show' }], supabase)
    const row = watchedRow(supabase, 100, 1, 1)
    expect(row.watched_at).toBe('ORIGINAL')
    expect(row.runtime_minutes).toBe(42)
  })

  it('isolates a failing show and keeps going', async () => {
    const { results, supabase } = await run([
      { tmdb_id: 999, name: 'Missing Show' }, // getShowDetails throws
      { tmdb_id: 200, name: 'Second Show' },
    ])
    expect(results[0].error).toBeTruthy()
    expect(results[0].insertedCount).toBe(0)
    expect(results[1].error).toBeNull()
    expect(results[1].insertedCount).toBe(3)
    expect(watchedRow(supabase, 200, 1, 1)).toBeDefined()
  })

  it('reports progress once per show', async () => {
    const onProgress = vi.fn()
    await run(
      [
        { tmdb_id: 100, name: 'Completed Show' },
        { tmdb_id: 200, name: 'Second Show' },
      ],
      makeSupabase(),
      { onProgress },
    )
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress.mock.calls.at(-1)[0]).toMatchObject({ current: 2, total: 2 })
  })
})
