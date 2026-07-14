import { describe, expect, it, vi } from 'vitest'
import { importWatchHistory } from './importWatchHistory'

// --- Fakes -----------------------------------------------------------------

function ep(n, airDate) {
  return { episode_number: n, name: `E${n}`, air_date: airDate, runtime: 30 }
}

// A tiny TMDB fixture. `500` is intentionally absent so getShowDetails throws
// for it, exercising the "TMDB fetch failed — track anyway, keep going" path.
const TMDB = {
  100: {
    name: 'Completed Show',
    poster_path: '/c.jpg',
    networks: ['HBO'],
    status: 'Ended',
    seasons: {
      0: [ep(1, '2014-12-01')], // specials — must be excluded
      1: [ep(1, '2015-01-01'), ep(2, '2015-01-08'), ep(3, '2015-01-15')],
      2: [ep(1, '2016-01-01'), ep(2, '2016-01-08'), ep(3, '2016-01-15')],
    },
  },
  200: {
    name: 'Watching Show',
    poster_path: '/w.jpg',
    networks: ['Netflix'],
    status: 'Returning Series',
    seasons: { 1: [ep(1, '2019-01-01'), ep(2, '2019-01-08')] },
  },
  300: {
    name: 'Hidden Completed',
    poster_path: '/h.jpg',
    networks: ['Netflix'],
    status: 'Ended',
    seasons: { 1: [ep(1, '2017-01-01'), ep(2, '2017-01-08'), ep(3, '2017-01-15')] },
  },
  400: {
    name: 'Fallback Show',
    poster_path: '/f.jpg',
    networks: ['Netflix'],
    status: 'Ended',
    seasons: {
      0: [ep(1, '2017-12-01')], // specials — must be excluded from the fallback
      1: [ep(1, '2018-01-01'), ep(2, '2018-01-08')],
    },
  },
  600: {
    name: 'Partial Aired',
    poster_path: '/p.jpg',
    networks: ['Netflix'],
    status: 'Returning Series',
    seasons: { 1: [ep(1, '2019-01-01'), ep(2, '2999-01-01')] }, // ep2 not aired
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
        poster_path: s.poster_path,
        networks: s.networks,
        status: s.status,
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

// In-memory Supabase double that honours onConflict + ignoreDuplicates so the
// never-overwrite and idempotency guarantees can be asserted end-to-end.
function makeSupabase(seed = {}) {
  const tables = {
    tracked_shows: new Map(seed.tracked_shows ?? []),
    watched_episodes: new Map(seed.watched_episodes ?? []),
  }
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
        insert(row) {
          const key = keyFor(row, 'tmdb_id')
          if (tables[name].has(key)) {
            return Promise.resolve({ error: { code: '23505' } })
          }
          tables[name].set(key, row)
          return Promise.resolve({ error: null })
        },
      }
    },
  }
}

function fullBackup() {
  return {
    createdAt: '2020-01-01',
    platform: 'other-app',
    version: 1,
    movies: [{ id: 'm1' }], // out of scope — must be ignored
    lists: [{ id: 'l1' }], // out of scope — must be ignored
    shows: {
      cW: [
        { a: '2020-01-01T00:00:00.000Z', id: 'w200', t: 'Watching Show', tmId: 200 },
        { a: '2020-02-01T00:00:00.000Z', id: 'e500', t: 'Broken Show', tmId: 500 },
        { a: '2020-03-01T00:00:00.000Z', id: 'p600', t: 'Partial Aired', tmId: 600 },
      ],
      cH: [
        { a: '2019-01-01T00:00:00.000Z', id: 'h100', t: 'Completed Show', tmId: 100, w: '2016-06-01T00:00:00.000Z' },
        { a: '2019-02-01T00:00:00.000Z', id: 'f400', t: 'Fallback Show', tmId: 400, w: '2018-12-31T00:00:00.000Z' },
      ],
      cHid: [
        { a: '2019-03-01T00:00:00.000Z', id: 'hh300', t: 'Hidden Completed', tmId: 300, w: '2017-06-01T00:00:00.000Z' },
      ],
      pEp: [
        // Completed show, season 1 ep 1 — real historical watch.
        { a: '2016-05-01T00:00:00.000Z', eN: 1, id: 'pe1', sId: 'h100', sN: 1, stmId: 100 },
        // Partial show: ep1 aired (kept), ep2 in the future (dropped).
        { a: '2019-05-01T00:00:00.000Z', eN: 1, id: 'pe2', sId: 'p600', sN: 1, stmId: 600 },
        { a: '2999-05-01T00:00:00.000Z', eN: 2, id: 'pe3', sId: 'p600', sN: 1, stmId: 600 },
      ],
      pSe: [
        // Hidden completed show, whole season 1 — no pEp for it, so it expands.
        { a: '2017-05-01T00:00:00.000Z', id: 'ps1', sId: 'hh300', sN: 1, stmId: 300 },
        // Completed show season 1 — pEp already has an entry, so this is skipped.
        { a: '2016-05-15T00:00:00.000Z', id: 'ps2', sId: 'h100', sN: 1, stmId: 100 },
      ],
    },
  }
}

const NOW = '2026-07-12T00:00:00.000Z'

async function runFull(supabase = makeSupabase(), opts = {}) {
  const tmdb = makeTmdb()
  const summary = await importWatchHistory(fullBackup(), {
    supabase,
    getShowDetails: tmdb.getShowDetails,
    getSeasonEpisodes: tmdb.getSeasonEpisodes,
    now: NOW,
    ...opts,
  })
  return { summary, supabase, tmdb }
}

function watchedRow(supabase, tmId, sN, eN) {
  return supabase.tables.watched_episodes.get(`${tmId}|${sN}|${eN}`)
}

// --- Tests -----------------------------------------------------------------

describe('importWatchHistory', () => {
  it('tracks every cW + cH + cHid show without erroring on the broken one', async () => {
    const { summary, supabase } = await runFull()
    expect(summary.showsTotal).toBe(6)
    expect(summary.showsNewlyTracked).toBe(6)
    for (const tmId of [100, 200, 300, 400, 500, 600]) {
      expect(supabase.tables.tracked_shows.has(String(tmId))).toBe(true)
    }
  })

  it('a cW show that was only added (no pEp/pSe) ends up with no watched episodes', async () => {
    const { supabase } = await runFull()
    const rows = [...supabase.tables.watched_episodes.values()]
    expect(rows.some((r) => r.tmdb_show_id === 200)).toBe(false)
  })

  it('imports pEp episodes with their real historical watched_at, not "now"', async () => {
    const { supabase } = await runFull()
    const row = watchedRow(supabase, 100, 1, 1)
    expect(row).toBeDefined()
    expect(row.watched_at).toBe('2016-05-01T00:00:00.000Z')
    expect(row.watched_at).not.toBe(NOW)
    expect(row.episode_name).toBe('E1')
    expect(row.runtime_minutes).toBe(30)
  })

  it('expands a pSe-only season to every aired episode with the pSe timestamp', async () => {
    const { summary, supabase } = await runFull()
    for (const eN of [1, 2, 3]) {
      const row = watchedRow(supabase, 300, 1, eN)
      expect(row).toBeDefined()
      expect(row.watched_at).toBe('2017-05-01T00:00:00.000Z')
    }
    expect(summary.seasonMarkersApplied).toBe(1)
  })

  it('skips a pSe marker when pEp already covers that season', async () => {
    const { supabase } = await runFull()
    // pEp only logged 100 s1e1; the s1 pSe was skipped, so e2/e3 must be absent.
    expect(watchedRow(supabase, 100, 1, 2)).toBeUndefined()
    expect(watchedRow(supabase, 100, 1, 3)).toBeUndefined()
    // And season 2 (no pEp, no pSe, but show has rows so no fallback) is absent.
    expect(watchedRow(supabase, 100, 2, 1)).toBeUndefined()
  })

  it('drops pEp episodes that have not aired yet', async () => {
    const { supabase } = await runFull()
    expect(watchedRow(supabase, 600, 1, 1)).toBeDefined()
    expect(watchedRow(supabase, 600, 1, 2)).toBeUndefined()
  })

  it('falls back to bulk-marking a completed show with zero episode data, using its w date', async () => {
    const { summary, supabase } = await runFull()
    expect(summary.fallbackShows).toEqual(['Fallback Show'])
    for (const eN of [1, 2]) {
      const row = watchedRow(supabase, 400, 1, eN)
      expect(row).toBeDefined()
      expect(row.watched_at).toBe('2018-12-31T00:00:00.000Z')
    }
    // Specials (season 0) are excluded from the fallback.
    expect(watchedRow(supabase, 400, 0, 1)).toBeUndefined()
  })

  it('reports the count of episodes actually imported', async () => {
    const { summary } = await runFull()
    // 100:1, 300:3, 400:2, 600:1 = 7
    expect(summary.episodesImported).toBe(7)
  })

  it('tracks a show whose TMDB fetch fails and reports it without aborting', async () => {
    const { summary, supabase } = await runFull()
    const broken = supabase.tables.tracked_shows.get('500')
    expect(broken).toBeDefined()
    expect(broken.name).toBe('Broken Show')
    expect(broken.poster_path).toBeNull()
    expect(summary.errors.some((e) => e.includes('Broken Show'))).toBe(true)
    // Other shows still imported.
    expect(summary.episodesImported).toBe(7)
  })

  it('never overwrites a watched_episodes row that already exists in Rerun', async () => {
    const preexisting = {
      tmdb_show_id: 100,
      season_number: 1,
      episode_number: 1,
      watched_at: 'ORIGINAL-RERUN-DATE',
      episode_name: 'Kept',
      runtime_minutes: 42,
    }
    const supabase = makeSupabase({
      watched_episodes: [['100|1|1', preexisting]],
    })
    const { summary } = await runFull(supabase)
    const row = watchedRow(supabase, 100, 1, 1)
    expect(row.watched_at).toBe('ORIGINAL-RERUN-DATE')
    expect(row.runtime_minutes).toBe(42)
    // The pre-existing row is not counted as newly imported.
    expect(summary.episodesImported).toBe(6)
  })

  it('is idempotent — a second run on the same file imports nothing new', async () => {
    const supabase = makeSupabase()
    const first = await runFull(supabase)
    expect(first.summary.episodesImported).toBe(7)
    expect(first.summary.showsNewlyTracked).toBe(6)

    const second = await runFull(supabase)
    expect(second.summary.episodesImported).toBe(0)
    expect(second.summary.showsNewlyTracked).toBe(0)
    // No duplicate rows created.
    expect(supabase.tables.watched_episodes.size).toBe(7)
    expect(supabase.tables.tracked_shows.size).toBe(6)
  })

  it('does not re-track a show already tracked in Rerun', async () => {
    const supabase = makeSupabase({
      tracked_shows: [['100', { tmdb_id: 100, name: 'Completed Show', poster_path: '/existing.jpg' }]],
    })
    const { summary } = await runFull(supabase)
    expect(summary.showsNewlyTracked).toBe(5)
    // Existing poster is preserved, not overwritten.
    expect(supabase.tables.tracked_shows.get('100').poster_path).toBe('/existing.jpg')
  })

  it('reports progress while processing shows', async () => {
    const onProgress = vi.fn()
    await runFull(makeSupabase(), { onProgress })
    const showProgress = onProgress.mock.calls
      .map((c) => c[0])
      .filter((p) => p.phase === 'shows')
    expect(showProgress.length).toBe(6)
    expect(showProgress.at(-1)).toMatchObject({ current: 6, total: 6 })
  })

  it('ignores movies and lists entirely', async () => {
    // Nothing to assert beyond a clean run — presence of movies/lists in the
    // fixture must not create shows or errors.
    const { summary } = await runFull()
    expect(summary.showsTotal).toBe(6)
    expect(summary.errors.filter((e) => !e.includes('Broken Show'))).toEqual([])
  })

  it('rejects a file with no shows section', async () => {
    await expect(importWatchHistory({ movies: [] }, {})).rejects.toThrow(/backup file/)
  })
})
