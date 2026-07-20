import { describe, expect, it } from 'vitest'
import { advanceCachedWatchingRow, advanceCachedWatchingRows } from './watchingCacheTransition.js'

const RELEASE_TIMESTAMP = Date.parse('2026-07-20T02:30:00.000Z') // 2026-07-20 08:00 IST

function countdownRow(overrides = {}) {
  return {
    id: 1,
    tmdb_id: 900,
    name: 'House of the Dragon',
    added_at: '2026-01-01T00:00:00Z',
    finished_at: null,
    hidden_at: null,
    status: {
      type: 'countdown',
      subtype: 'episode',
      season_number: 3,
      episode_number: 5,
      name: 'Unbowed and Unbent',
      air_date: '2026-07-20',
      daysUntil: 0,
      airsSoon: true,
    },
    releasedEpisodeCount: 4,
    releasedWatchedCount: 4,
    releasedProgress: 100,
    nextReleasedUnwatchedEpisode: null,
    nextScheduledEpisode: {
      season_number: 3,
      episode_number: 5,
      name: 'Unbowed and Unbent',
      runtime: 58,
      release: { timestamp: RELEASE_TIMESTAMP, istDate: '2026-07-20' },
    },
    ...overrides,
  }
}

describe('advanceCachedWatchingRow — before the resolved release timestamp', () => {
  it('leaves the countdown, denominator, and next-up state untouched', () => {
    const row = countdownRow()
    const before = RELEASE_TIMESTAMP - 1
    const result = advanceCachedWatchingRow(row, before)
    expect(result).toBe(row) // same reference — no new object created
    expect(result.status.type).toBe('countdown')
    expect(result.releasedEpisodeCount).toBe(4)
    expect(result.nextReleasedUnwatchedEpisode).toBeNull()
  })
})

describe('advanceCachedWatchingRow — exactly at the resolved timestamp', () => {
  it('transitions to nextUp, drops the countdown, increments the denominator once, and recalculates progress', () => {
    const row = countdownRow()
    const result = advanceCachedWatchingRow(row, RELEASE_TIMESTAMP)
    expect(result.status).toMatchObject({
      type: 'nextUp', season_number: 3, episode_number: 5, name: 'Unbowed and Unbent',
    })
    expect(result.releasedEpisodeCount).toBe(5)
    expect(result.releasedWatchedCount).toBe(4)
    expect(result.releasedProgress).toBeCloseTo((4 / 5) * 100)
    expect(result.nextReleasedUnwatchedEpisode).toEqual({
      season_number: 3, episode_number: 5, name: 'Unbowed and Unbent', runtime: 58,
    })
  })
})

describe('advanceCachedWatchingRow — after the resolved release timestamp', () => {
  it('renders already-transitioned on the very first call (no countdown-to-Up-next flip)', () => {
    const row = countdownRow()
    const result = advanceCachedWatchingRow(row, RELEASE_TIMESTAMP + 15 * 60 * 1000)
    expect(result.status.type).toBe('nextUp')
  })
})

describe('advanceCachedWatchingRow — idempotency', () => {
  it('calling it twice after the threshold does not double-increment the denominator', () => {
    const row = countdownRow()
    const once = advanceCachedWatchingRow(row, RELEASE_TIMESTAMP + 1)
    const twice = advanceCachedWatchingRow(once, RELEASE_TIMESTAMP + 1)
    expect(twice.releasedEpisodeCount).toBe(5)
    expect(twice).toEqual(once)
  })
})

describe('advanceCachedWatchingRow — caught-up weekly show', () => {
  it('makes the progress bar visible again once the cached countdown crosses its threshold', () => {
    // Fully caught up before the transition: watched === released, so
    // WatchingRow's showProgressBar condition (watchedCount < releasedCount)
    // is false and no bar renders.
    const row = countdownRow({ releasedEpisodeCount: 4, releasedWatchedCount: 4 })
    const before = advanceCachedWatchingRow(row, RELEASE_TIMESTAMP - 1)
    expect(before.releasedWatchedCount < before.releasedEpisodeCount).toBe(false)

    const after = advanceCachedWatchingRow(row, RELEASE_TIMESTAMP)
    expect(after.releasedWatchedCount < after.releasedEpisodeCount).toBe(true)
  })
})

describe('advanceCachedWatchingRow — invalid or missing release timestamp', () => {
  it('leaves the row unchanged when nextScheduledEpisode is absent', () => {
    const row = countdownRow({ nextScheduledEpisode: null })
    const result = advanceCachedWatchingRow(row, RELEASE_TIMESTAMP + 1000)
    expect(result).toBe(row)
  })

  it('leaves the row unchanged when the release timestamp is missing/non-numeric', () => {
    const row = countdownRow({
      nextScheduledEpisode: {
        season_number: 3, episode_number: 5, name: 'X', runtime: 1,
        release: { timestamp: null, istDate: '2026-07-20' },
      },
    })
    const result = advanceCachedWatchingRow(row, RELEASE_TIMESTAMP + 1000)
    expect(result).toBe(row)
  })

  it('leaves the row unchanged when episode identity is missing', () => {
    const row = countdownRow({
      nextScheduledEpisode: {
        season_number: null, episode_number: null, name: 'X', runtime: 1,
        release: { timestamp: RELEASE_TIMESTAMP, istDate: '2026-07-20' },
      },
    })
    const result = advanceCachedWatchingRow(row, RELEASE_TIMESTAMP + 1000)
    expect(result).toBe(row)
  })

  it('does not guess — a row that is not a countdown (e.g. already caughtUp) is left alone', () => {
    const row = countdownRow({ status: { type: 'caughtUp' }, nextScheduledEpisode: null })
    const result = advanceCachedWatchingRow(row, RELEASE_TIMESTAMP + 1000)
    expect(result).toBe(row)
  })
})

describe('advanceCachedWatchingRow — malformed cache data fails safely', () => {
  it('never crashes on null/undefined/non-object input', () => {
    expect(advanceCachedWatchingRow(null, RELEASE_TIMESTAMP)).toBeNull()
    expect(advanceCachedWatchingRow(undefined, RELEASE_TIMESTAMP)).toBeUndefined()
    expect(advanceCachedWatchingRow('not an object', RELEASE_TIMESTAMP)).toBe('not an object')
    expect(advanceCachedWatchingRow(42, RELEASE_TIMESTAMP)).toBe(42)
  })

  it('never crashes when status is missing entirely', () => {
    const row = { id: 1, tmdb_id: 1 }
    expect(() => advanceCachedWatchingRow(row, RELEASE_TIMESTAMP)).not.toThrow()
    expect(advanceCachedWatchingRow(row, RELEASE_TIMESTAMP)).toBe(row)
  })

  it('never crashes when nextScheduledEpisode.release is a non-object', () => {
    const row = countdownRow({
      nextScheduledEpisode: { season_number: 3, episode_number: 5, name: 'X', runtime: 1, release: 'garbage' },
    })
    expect(() => advanceCachedWatchingRow(row, RELEASE_TIMESTAMP)).not.toThrow()
    expect(advanceCachedWatchingRow(row, RELEASE_TIMESTAMP)).toBe(row)
  })

  it('advanceCachedWatchingRows tolerates a non-array and malformed entries', () => {
    expect(advanceCachedWatchingRows(null)).toBeNull()
    expect(advanceCachedWatchingRows(undefined)).toBeUndefined()
    expect(advanceCachedWatchingRows([null, 'garbage', countdownRow()], RELEASE_TIMESTAMP)).toHaveLength(3)
  })
})

describe('advanceCachedWatchingRow — IST/UTC boundary uses the exact stored instant', () => {
  it('transitions exactly at the stored instant, not at a local-calendar-day boundary', () => {
    // The resolved instant sits at 2026-07-20T02:30:00.000Z (08:00 IST) — a
    // naive local-midnight or calendar-day check would flip a different
    // moment than this. One millisecond before must not transition; the
    // exact millisecond must.
    const row = countdownRow()
    const justBefore = advanceCachedWatchingRow(row, RELEASE_TIMESTAMP - 1)
    const exact = advanceCachedWatchingRow(row, RELEASE_TIMESTAMP)
    expect(justBefore.status.type).toBe('countdown')
    expect(exact.status.type).toBe('nextUp')
  })
})
