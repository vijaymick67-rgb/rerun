import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachEpisodeReleaseData,
  attachReleaseData,
  deriveWatchingFields,
  enrichTrackedShowsForWatching,
  loadWatchingShowData,
  selectTrackedShowsForWatching,
} from './watchingShows'
import { episodeKey, hasAired } from './watchHelpers'
import { isRepresentedInStats, isVisibleInWatching } from './finishedShows'

describe('detail-screen release eligibility', () => {
  afterEach(() => vi.useRealTimers())

  it('gives Show Detail and Season Detail identical same-day Apple eligibility', () => {
    vi.useFakeTimers()
    const episode = { episode_number: 10, name: 'Finale', air_date: '2026-07-15' }
    const releaseMap = {
      '1:10': {
        airstamp: '2026-07-15T00:00:00Z',
        airdate: '2026-07-15',
        airtime: '00:00',
        tvmazeEpisodeId: 1010,
      },
    }
    const apple = {
      platform: 'apple', thresholdHourIST: 8, thresholdMinuteIST: 0, confidence: 'mapped',
    }
    const showDetailEpisode = attachReleaseData({ 1: [episode] }, releaseMap, apple)[1][0]
    const seasonDetailEpisode = attachEpisodeReleaseData(episode, releaseMap, 1, apple)

    vi.setSystemTime('2026-07-15T02:29:00.000Z')
    expect(hasAired(showDetailEpisode)).toBe(false)
    expect(hasAired(seasonDetailEpisode)).toBe(false)

    vi.setSystemTime('2026-07-15T02:30:00.000Z')
    expect(hasAired(showDetailEpisode)).toBe(true)
    expect(hasAired(seasonDetailEpisode)).toBe(true)
  })
})

describe('Watching archived-show loading', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 12, 12))
  })

  afterEach(() => vi.useRealTimers())

  it('keeps an archived show eligible when refresh calls fail', async () => {
    const show = { tmdb_id: 12, name: 'Retry me', finished_at: '2026-01-01T00:00:00Z' }
    const { candidates } = await selectTrackedShowsForWatching(
      [show],
      vi.fn(async () => { throw new Error('network') }),
      vi.fn(async () => { throw new Error('network') }),
    )
    expect(candidates).toEqual([show])
  })

  it('keeps an archived show eligible when return metadata times out', async () => {
    const show = { tmdb_id: 13, name: 'Pending return', finished_at: '2026-01-01T00:00:00Z' }
    const pending = new Promise(() => {})
    const resultPromise = selectTrackedShowsForWatching(
      [show], () => pending, () => pending,
    )
    await vi.advanceTimersByTimeAsync(12_000)
    const { candidates } = await resultPromise
    expect(candidates).toEqual([show])
  })

  it('does not fetch seasons for ineligible archived shows', async () => {
    const shows = [
      { tmdb_id: 1, name: 'Active', finished_at: null },
      { tmdb_id: 2, name: 'No return', finished_at: '2026-01-01' },
      { tmdb_id: 3, name: 'Far return', finished_at: '2026-01-01' },
    ]
    const getShowDetails = vi.fn(async (id) => ({
      networks: ['HBO'],
      seasons: [{ season_number: 1 }],
      next_episode_to_air:
        id === 2 ? null : id === 3 ? { air_date: '2026-09-11', episode_number: 1 } : null,
    }))
    const getSeasonEpisodes = vi.fn(async () => ({ episodes: [] }))

    const { candidates, preloadedById } = await selectTrackedShowsForWatching(shows, getShowDetails)
    const enriched = await enrichTrackedShowsForWatching(
      candidates,
      new Map(),
      preloadedById,
      { getShowDetails, getSeasonEpisodes },
    )

    expect(candidates.map((show) => show.tmdb_id)).toEqual([1])
    expect(enriched[0].status.type).toBe('caughtUp')
    expect(getSeasonEpisodes).toHaveBeenCalledTimes(1)
    expect(getSeasonEpisodes).toHaveBeenCalledWith(1, 1, { refreshDynamic: true })
  })

  it('keeps a returned show eligible after TMDB clears next_episode_to_air on air day', async () => {
    const show = { tmdb_id: 9, name: 'Returning', finished_at: '2026-01-01T00:00:00Z' }
    const upcomingDetails = {
      networks: ['HBO'],
      seasons: [{ season_number: 2 }],
      next_episode_to_air: { air_date: '2026-08-01', episode_number: 1 },
    }
    const initialDetails = vi.fn(async () => upcomingDetails)

    const initial = await selectTrackedShowsForWatching([show], initialDetails)
    expect(initial.candidates.map((candidate) => candidate.tmdb_id)).toEqual([9])

    vi.setSystemTime(new Date(2026, 7, 2, 12))
    const freshDetails = {
      networks: [],
      seasons: [{ season_number: 2 }],
      next_episode_to_air: null,
      last_episode_to_air: { air_date: '2026-08-01', season_number: 2, episode_number: 1 },
    }
    const getShowDetails = vi.fn(async () => freshDetails)
    const getSeasonEpisodes = vi.fn(async () => ({
      episodes: [{ episode_number: 1, name: 'Premiere', air_date: '2026-08-01' }],
    }))

    const { candidates, preloadedById } = await selectTrackedShowsForWatching([show], getShowDetails)
    expect(candidates.map((candidate) => candidate.tmdb_id)).toEqual([9])
    const enriched = await enrichTrackedShowsForWatching(
      candidates,
      new Map([[9, new Set()]]),
      preloadedById,
      { getShowDetails, getSeasonEpisodes },
    )

    expect(enriched[0].status).toMatchObject({ type: 'nextUp', season_number: 2, episode_number: 1 })
    expect(isVisibleInWatching(enriched[0], enriched[0].status)).toBe(true)
    expect(enriched[0].finished_at).toBe(show.finished_at)
    expect(isRepresentedInStats(enriched[0], [{ tmdb_show_id: 9, key: episodeKey(1, 1) }])).toBe(true)
  })
})

describe('Watching TVmaze airstamp enrichment', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  const baseDeps = () => ({
    getShowDetails: vi.fn(async () => ({
      networks: ['HBO'],
      status: 'Returning Series',
      seasons: [{ season_number: 1 }],
      next_episode_to_air: null,
    })),
    getSeasonEpisodes: vi.fn(async () => ({
      // TMDB air_date is the US Sunday; the real IST drop is Monday morning.
      episodes: [{ episode_number: 1, name: 'Premiere', air_date: '2026-07-19' }],
    })),
  })

  it('gates on the TVmaze airstamp, not the universal anchor', async () => {
    // now: Mon 2026-07-20 04:00 IST (Sun 22:30 UTC) — PAST the 14:00-IST anchor
    // for the Sunday air_date, but BEFORE the real HBO drop (Mon 06:30 IST).
    vi.setSystemTime(new Date('2026-07-19T22:30:00.000Z'))
    const deps = baseDeps()
    // HBO Sunday 9 PM ET → Mon 01:00 UTC → Mon 06:30 IST.
    const getShowAirstamps = vi.fn(async () => ({ '1:1': '2026-07-19T21:00:00-04:00' }))

    const enriched = await enrichTrackedShowsForWatching(
      [{ tmdb_id: 5, name: 'Dragons' }],
      new Map(),
      new Map(),
      { ...deps, getShowAirstamps },
    )

    // Anchor logic would say ep1 already aired (nextUp). The airstamp says it
    // hasn't dropped yet → not nextUp.
    expect(enriched[0].status.type).not.toBe('nextUp')
    expect(getShowAirstamps).toHaveBeenCalledWith(5)
  })

  it('marks the episode aired once the airstamp instant passes', async () => {
    // now: Mon 2026-07-20 08:00 IST (02:30 UTC) — past the 06:30 IST drop.
    vi.setSystemTime(new Date('2026-07-20T02:30:00.000Z'))
    const deps = baseDeps()
    const getShowAirstamps = vi.fn(async () => ({ '1:1': '2026-07-19T21:00:00-04:00' }))

    const enriched = await enrichTrackedShowsForWatching(
      [{ tmdb_id: 5, name: 'Dragons' }],
      new Map(),
      new Map(),
      { ...deps, getShowAirstamps },
    )

    expect(enriched[0].status).toMatchObject({
      type: 'nextUp',
      season_number: 1,
      episode_number: 1,
    })
  })

  it('falls back to the universal anchor when TVmaze has no match', async () => {
    // Same instant as the first test, but no TVmaze data: the anchor says the
    // Sunday air_date already released at 14:00 IST → nextUp.
    vi.setSystemTime(new Date('2026-07-19T22:30:00.000Z'))
    const deps = baseDeps()
    const getShowAirstamps = vi.fn(async () => ({})) // no match

    const enriched = await enrichTrackedShowsForWatching(
      [{ tmdb_id: 5, name: 'Dragons' }],
      new Map(),
      new Map(),
      { ...deps, getShowAirstamps },
    )

    expect(enriched[0].status).toMatchObject({ type: 'nextUp', episode_number: 1 })
  })

  // The reported HOTD countdown: from 2026-07-14, an HBO Sunday-night episode
  // (US air_date 2026-07-19, real IST drop Mon 2026-07-20) is 6 days out, not 5.
  // The airstamp-attached next_episode_to_air must count off the true IST day.
  const hotdDeps = () => ({
    getShowDetails: vi.fn(async () => ({
      networks: ['HBO'],
      status: 'Returning Series',
      seasons: [{ season_number: 1 }],
      next_episode_to_air: { air_date: '2026-07-19', season_number: 1, episode_number: 2 },
    })),
    getSeasonEpisodes: vi.fn(async () => ({
      episodes: [{ episode_number: 1, name: 'Premiere', air_date: '2026-07-12' }],
    })),
  })

  it('counts down to the airstamp IST day (6 days, not the anchor 5)', async () => {
    vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z')) // 2026-07-14 IST
    const getShowAirstamps = vi.fn(async () => ({ '1:2': '2026-07-19T21:00:00-04:00' }))

    const enriched = await enrichTrackedShowsForWatching(
      [{ tmdb_id: 5, name: 'Dragons' }],
      new Map([[5, new Set(['1:1'])]]),
      new Map(),
      { ...hotdDeps(), getShowAirstamps },
    )

    expect(enriched[0].status).toMatchObject({
      type: 'countdown',
      air_date: '2026-07-20',
      daysUntil: 6,
    })
  })

  it('without the airstamp the bare anchor lands one IST day early (5 days)', async () => {
    vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z')) // 2026-07-14 IST
    const getShowAirstamps = vi.fn(async () => ({})) // no TVmaze match

    const enriched = await enrichTrackedShowsForWatching(
      [{ tmdb_id: 5, name: 'Dragons' }],
      new Map([[5, new Set(['1:1'])]]),
      new Map(),
      { ...hotdDeps(), getShowAirstamps },
    )

    expect(enriched[0].status).toMatchObject({
      type: 'countdown',
      air_date: '2026-07-19',
      daysUntil: 5,
    })
  })
})

describe('Watching enrichment failure isolation', () => {
  it('settles all shows when one metadata request hangs and preserves the failed show', async () => {
    vi.useFakeTimers()
    const candidates = [
      { tmdb_id: 1, name: 'Hanging show' },
      { tmdb_id: 2, name: 'Healthy show' },
    ]
    const getShowDetails = vi.fn((tmdbId) => tmdbId === 1
      ? new Promise(() => {})
      : Promise.resolve({ seasons: [], status: 'Returning Series' }))

    const settled = []
    const resultPromise = enrichTrackedShowsForWatching(
      candidates,
      new Map(),
      new Map(),
      {
        getShowDetails,
        getSeasonEpisodes: vi.fn(),
        getShowReleaseMap: vi.fn(async () => ({})),
      },
      { onShowSettled: (show) => settled.push(show.tmdb_id) },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toContain(2)
    await vi.advanceTimersByTimeAsync(12_000)
    const result = await resultPromise

    expect(result.map((show) => show.tmdb_id)).toEqual([1, 2])
    expect(result[0].loadError).toBe(true)
    expect(result[0].status).toBeTruthy()
    expect(result[1].loadError).toBe(false)
    expect(result[0].loadDiagnostics[0]).toMatchObject({
      code: 'DATA-TIMEOUT', tmdbShowId: 1,
    })
    vi.useRealTimers()
  })

  it('classifies per-show TMDB and TVmaze failures without rejecting the load', async () => {
    const result = await loadWatchingShowData(
      { tmdb_id: 21 }, new Set(), undefined,
      {
        getShowDetails: vi.fn(async () => { throw new TypeError('TMDB down') }),
        getSeasonEpisodes: vi.fn(),
        getShowReleaseMap: vi.fn(async () => { throw new Error('TVmaze down') }),
      },
    )
    expect(result.loadError).toBe(true)
    expect(result.failures.map((failure) => failure.code)).toEqual(['DATA-TMDB', 'DATA-TVMAZE'])
    expect(result.failures.every((failure) => failure.tmdbShowId === 21)).toBe(true)
  })

  it('can retry a timed-out show enrichment without mutating the candidate', async () => {
    vi.useFakeTimers()
    const show = { tmdb_id: 9, name: 'Retry me' }
    let attempt = 0
    const getShowDetails = vi.fn(() => {
      attempt += 1
      return attempt === 1
        ? new Promise(() => {})
        : Promise.resolve({ seasons: [], status: 'Returning Series' })
    })
    const first = enrichTrackedShowsForWatching(
      [show], new Map(), new Map(),
      { getShowDetails, getSeasonEpisodes: vi.fn(), getShowReleaseMap: vi.fn(async () => ({})) },
    )
    await vi.advanceTimersByTimeAsync(12_000)
    const firstResult = await first
    expect(firstResult[0]).toMatchObject({ tmdb_id: 9, loadError: true })

    const secondResult = await enrichTrackedShowsForWatching(
      [show], new Map(), new Map(),
      { getShowDetails, getSeasonEpisodes: vi.fn(), getShowReleaseMap: vi.fn(async () => ({})) },
    )
    expect(secondResult[0]).toMatchObject({ tmdb_id: 9, loadError: false })
    expect(getShowDetails).toHaveBeenCalledTimes(2)
    expect(show).toEqual({ tmdb_id: 9, name: 'Retry me' })
    vi.useRealTimers()
  })
})

describe('archived TVmaze release enrichment order', () => {
  afterEach(() => vi.useRealTimers())

  it('attaches next-episode release truth before eligibility', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T04:30:00.000Z'))
    const show = { tmdb_id: 77, finished_at: '2026-01-01T00:00:00Z' }
    const getShowDetails = vi.fn(async () => ({
      next_episode_to_air: {
        air_date: '2026-09-12', season_number: 3, episode_number: 5,
      },
    }))
    // Raw TMDB is 60 days away, but the authoritative instant lands 61 IST
    // calendar days away and must keep this archive filtered out.
    const getShowReleaseMap = vi.fn(async () => ({
      '3:5': {
        airstamp: '2026-09-13T01:00:00Z', airdate: '2026-09-12',
        airtime: '21:00', tvmazeEpisodeId: 305,
      },
    }))
    const result = await selectTrackedShowsForWatching(
      [show], getShowDetails, getShowReleaseMap,
    )
    expect(result.candidates).toEqual([])
    expect(getShowReleaseMap).toHaveBeenCalledWith(77)
  })
})

describe('Watching per-show failure isolation', () => {
  it('keeps successful shows when one show fails to enrich', async () => {
    const getShowDetails = vi.fn(async (id) => ({
      networks: ['Netflix'], seasons: [{ season_number: 1 }], id,
    }))
    const getSeasonEpisodes = vi.fn(async (id) => {
      if (id === 2) throw new Error('one show failed')
      return { episodes: [] }
    })
    const result = await enrichTrackedShowsForWatching(
      [{ tmdb_id: 1 }, { tmdb_id: 2 }], new Map(), new Map(),
      { getShowDetails, getSeasonEpisodes, getShowReleaseMap: async () => ({}) },
    )
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ tmdb_id: 1, loadError: false })
    expect(result[1]).toMatchObject({ tmdb_id: 2, loadError: true })
  })
})

describe('deriveWatchingFields — shared Watching-row derived fields', () => {
  afterEach(() => vi.useRealTimers())

  it('exposes released-only progress and the authoritative next-up episode with its runtime', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))
    const episodesBySeason = {
      1: [
        { episode_number: 1, name: 'Pilot', air_date: '2026-01-01', runtime: 42 },
        { episode_number: 2, name: 'Second', air_date: '2026-01-08', runtime: 44 },
        { episode_number: 3, name: 'Future', air_date: '2099-01-01', runtime: 40 },
      ],
    }
    const watched = new Set(['1:1'])
    const fields = deriveWatchingFields(episodesBySeason, watched, {})
    expect(fields.status).toMatchObject({ type: 'nextUp', season_number: 1, episode_number: 2 })
    expect(fields.releasedEpisodeCount).toBe(2)
    expect(fields.releasedWatchedCount).toBe(1)
    expect(fields.releasedProgress).toBe(50)
    expect(fields.nextReleasedUnwatchedEpisode).toEqual({
      season_number: 1, episode_number: 2, name: 'Second', runtime: 44,
    })
  })

  it('returns a null next-up episode once caught up on every released episode', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))
    const episodesBySeason = {
      1: [
        { episode_number: 1, name: 'Pilot', air_date: '2026-01-01', runtime: 42 },
        { episode_number: 2, name: 'Future', air_date: '2099-01-01', runtime: 40 },
      ],
    }
    const fields = deriveWatchingFields(episodesBySeason, new Set(['1:1']), {})
    expect(fields.nextReleasedUnwatchedEpisode).toBeNull()
    expect(fields.releasedEpisodeCount).toBe(1)
    expect(fields.releasedWatchedCount).toBe(1)
  })
})

describe('enrichTrackedShowsForWatching — released progress fields end to end', () => {
  afterEach(() => vi.useRealTimers())

  it('attaches releasedEpisodeCount/releasedWatchedCount/releasedProgress/nextReleasedUnwatchedEpisode to each row', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))
    const getShowDetails = vi.fn(async () => ({
      seasons: [{ season_number: 1 }], status: 'Returning Series',
    }))
    const getSeasonEpisodes = vi.fn(async () => ({
      episodes: [
        { episode_number: 1, name: 'Pilot', air_date: '2026-01-01', runtime: 42 },
        { episode_number: 2, name: 'Second', air_date: '2026-01-08', runtime: 44 },
        { episode_number: 3, name: 'Future', air_date: '2099-01-01', runtime: 40 },
      ],
    }))
    const watchedByShowId = new Map([[5, new Set(['1:1'])]])
    const result = await enrichTrackedShowsForWatching(
      [{ tmdb_id: 5, name: 'Test Show' }],
      watchedByShowId,
      new Map(),
      { getShowDetails, getSeasonEpisodes, getShowReleaseMap: async () => ({}) },
    )
    expect(result[0]).toMatchObject({
      releasedEpisodeCount: 2,
      releasedWatchedCount: 1,
      releasedProgress: 50,
      nextReleasedUnwatchedEpisode: { season_number: 1, episode_number: 2, name: 'Second', runtime: 44 },
    })
  })

  it('passes full episodesBySeason/details/watched context to onShowSettled for local recompute', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))
    const getShowDetails = vi.fn(async () => ({ seasons: [{ season_number: 1 }] }))
    const getSeasonEpisodes = vi.fn(async () => ({
      episodes: [{ episode_number: 1, name: 'Pilot', air_date: '2026-01-01', runtime: 42 }],
    }))
    const settled = []
    await enrichTrackedShowsForWatching(
      [{ tmdb_id: 6 }], new Map(), new Map(),
      { getShowDetails, getSeasonEpisodes, getShowReleaseMap: async () => ({}) },
      { onShowSettled: (show, loaded) => settled.push({ show, loaded }) },
    )
    expect(settled).toHaveLength(1)
    expect(settled[0].loaded.episodesBySeason[1]).toHaveLength(1)
    expect(settled[0].loaded.watched).toBeInstanceOf(Set)
    expect(settled[0].loaded.details).toBeTruthy()
  })

  it('a failed show still exposes zeroed released fields and a null next-up (no crash)', async () => {
    const result = await enrichTrackedShowsForWatching(
      [{ tmdb_id: 7 }], new Map(), new Map(),
      {
        getShowDetails: vi.fn(async () => { throw new Error('down') }),
        getSeasonEpisodes: vi.fn(),
        getShowReleaseMap: vi.fn(async () => ({})),
      },
    )
    expect(result[0].loadError).toBe(true)
    expect(result[0].releasedEpisodeCount).toBe(0)
    expect(result[0].releasedWatchedCount).toBe(0)
    expect(result[0].nextReleasedUnwatchedEpisode).toBeNull()
  })
})
