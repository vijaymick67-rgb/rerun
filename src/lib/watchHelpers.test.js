import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeReleasedProgress,
  computeWatchingStatus,
  episodeReleaseDateInIST,
  formatReleaseDisplay,
  hasAired,
  isHiddenFromWatching,
  predictWeeklyNextRelease,
  watchingStatusLabel,
} from './watchHelpers'

afterEach(() => {
  vi.useRealTimers()
})

it('hides caught-up status but keeps the exact 60-day countdown boundary visible', () => {
  expect(isHiddenFromWatching({ type: 'caughtUp' })).toBe(true)
  expect(isHiddenFromWatching({ type: 'countdown', daysUntil: 60 })).toBe(false)
  expect(isHiddenFromWatching({ type: 'countdown', daysUntil: 61 })).toBe(true)
})

const platform = (name, hour) => ({
  platform: name, thresholdHourIST: hour, thresholdMinuteIST: 0,
  confidence: name === 'unknown' ? 'fallback' : 'mapped',
})
const ep = (n, airDate, releasePlatform = platform('prime', 14)) => ({
  episode_number: n, name: `E${n}`, air_date: airDate, releasePlatform,
})

// Every release is 14:00 IST == 08:30 UTC on its air_date, so these helpers keep
// the UTC math readable in the tests below.
const at = (episodesBySeason, watched, details, iso) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(iso))
  return computeWatchingStatus(episodesBySeason, watched, details)
}

describe('computeWatchingStatus — airsSoon 12h threshold (Fix C)', () => {
  // Release instant for 2026-07-20 is 2026-07-20T08:30:00Z. "Soon" is strictly
  // under 12 real hours out, so it turns on at 2 AM IST (20:30 UTC prior day).
  const details = { next_episode_to_air: {
    air_date: '2026-07-20', episode_number: 5, releasePlatform: platform('prime', 14),
  } }

  it('is soon under 12h out', () => {
    expect(at({}, new Set(), details, '2026-07-19T21:30:00.000Z')) // 11h out
      .toMatchObject({ type: 'countdown', airsSoon: true })
  })

  it('is not soon at exactly 12h out', () => {
    expect(at({}, new Set(), details, '2026-07-19T20:30:00.000Z')) // 12h out
      .toMatchObject({ type: 'countdown', airsSoon: false })
  })

  it('is not soon beyond 12h out', () => {
    expect(at({}, new Set(), details, '2026-07-19T19:30:00.000Z')) // 13h out
      .toMatchObject({ type: 'countdown', airsSoon: false })
  })
})

describe('computeWatchingStatus — stale-pointer guard (Fix B)', () => {
  // The House of the Dragon bug: TMDB's next_episode_to_air lags for hours
  // after an episode actually drops, so its air_date is today or in the past.
  // The old code counted down to that already-passed instant and rendered
  // "New episode soon". The guard falls through to caughtUp instead.
  it('returns caughtUp (not a countdown) when next_episode_to_air already released', () => {
    // Two aired, watched episodes a fortnight apart — no weekly cadence, so no
    // prediction fires either; this isolates the stale-pointer guard.
    const episodesBySeason = { 1: [ep(1, '2026-06-15'), ep(2, '2026-06-29')] }
    const watched = new Set(['1:1', '1:2'])
    const status = at(
      episodesBySeason,
      watched,
      // Stale pointer: this episode already dropped (release was ~28h ago).
      { status: 'Returning Series', next_episode_to_air: { air_date: '2026-07-05', episode_number: 3 } },
      '2026-07-06T12:00:00.000Z',
    )
    expect(status).toEqual({ type: 'caughtUp' })
  })
})

describe('computeWatchingStatus — weekly-cadence fallback (Fix D)', () => {
  // Two episodes exactly a week apart, all watched, and TMDB's pointer is stale
  // (still on the just-aired episode). Predict the next air_date as last + 7d so
  // the UI shows "in N days" instead of going blank for the week.
  const episodesBySeason = { 1: [ep(1, '2026-07-01'), ep(2, '2026-07-08')] }
  const watched = new Set(['1:1', '1:2'])

  it('predicts last_air_date + 7 days and counts down to it', () => {
    // now: day after ep2 aired. IST date is 2026-07-09; predicted 2026-07-15.
    const status = at(
      episodesBySeason,
      watched,
      { status: 'Returning Series', next_episode_to_air: { air_date: '2026-07-08', episode_number: 2 } },
      '2026-07-09T12:00:00.000Z',
    )
    expect(status).toMatchObject({
      type: 'countdown',
      air_date: '2026-07-15',
      daysUntil: 6,
      airsSoon: false,
      predicted: true,
    })
  })

  it('predicts the same when the pointer is missing entirely', () => {
    const status = at(
      episodesBySeason,
      watched,
      { status: 'Returning Series' }, // no next_episode_to_air at all
      '2026-07-09T12:00:00.000Z',
    )
    expect(status).toMatchObject({ type: 'countdown', air_date: '2026-07-15', predicted: true })
  })

  // Reconciliation: once a real next_episode_to_air arrives it always wins,
  // even preponed 2 days ahead of the guess, with no predicted-date artifacts.
  it('lets a real (preponed) next_episode_to_air override the prediction', () => {
    const status = at(
      episodesBySeason,
      watched,
      { status: 'Returning Series', next_episode_to_air: { air_date: '2026-07-13', episode_number: 3 } },
      '2026-07-09T12:00:00.000Z',
    )
    expect(status).toMatchObject({
      type: 'countdown',
      air_date: '2026-07-13',
      daysUntil: 4,
      airsSoon: false,
    })
    expect(status.predicted).toBeUndefined()
  })
})

describe('computeWatchingStatus — no-cadence guard (Fix D)', () => {
  // Fewer than 2 aired episodes: not enough history to establish a cadence, so
  // no prediction is attempted — fall through to caughtUp rather than guess.
  it('does not predict for a show with a single aired episode', () => {
    const status = at(
      { 1: [ep(1, '2026-07-06')] },
      new Set(['1:1']),
      { status: 'Returning Series', next_episode_to_air: { air_date: '2026-07-06', episode_number: 1 } },
      '2026-07-08T12:00:00.000Z',
    )
    expect(status).toEqual({ type: 'caughtUp' })
  })
})

describe('episodeReleaseDateInIST — airstamp-aware display date', () => {
  // An HBO Sunday 9 PM ET drop: the raw TMDB air_date is the US Sunday, but the
  // real release lands Monday in IST. The displayed date must follow the
  // airstamp, not the calendar-day anchor — this is the "one day early" bug.
  it('uses the airstamp IST day over the raw air_date for an evening US drop', () => {
    expect(
      episodeReleaseDateInIST({ air_date: '2026-07-19', airstamp: '2026-07-19T21:00:00-04:00' }),
    ).toBe('2026-07-20')
  })

  it('falls back to the air_date itself when no airstamp is present', () => {
    expect(episodeReleaseDateInIST({ air_date: '2026-07-19' })).toBe('2026-07-19')
  })

  it('lets a manual override win over both the airstamp and the anchor', () => {
    expect(
      episodeReleaseDateInIST({
        air_date: '2026-07-19',
        airstamp: '2026-07-19T21:00:00-04:00',
        releaseOverride: '2026-07-25T09:00:00+05:30',
      }),
    ).toBe('2026-07-25')
  })

  it('returns null for an episode with no usable date', () => {
    expect(episodeReleaseDateInIST({ air_date: null })).toBeNull()
    expect(episodeReleaseDateInIST({})).toBeNull()
  })
})

describe('watchingStatusLabel — grammar (Fix E)', () => {
  it('pluralizes the day count correctly', () => {
    expect(watchingStatusLabel({ subtype: 'episode', airsSoon: false, daysUntil: 1 }))
      .toBe('New episode in 1 day')
    expect(watchingStatusLabel({ subtype: 'episode', airsSoon: false, daysUntil: 3 }))
      .toBe('New episode in 3 days')
    expect(watchingStatusLabel({ subtype: 'premiere', airsSoon: false, daysUntil: 1 }))
      .toBe('Airs in 1 day')
    expect(watchingStatusLabel({ subtype: 'premiere', airsSoon: false, daysUntil: 2 }))
      .toBe('Airs in 2 days')
  })

  it('renders the soon wording without a day count', () => {
    expect(watchingStatusLabel({ subtype: 'episode', airsSoon: true })).toBe('New episode soon')
    expect(watchingStatusLabel({ subtype: 'premiere', airsSoon: true })).toBe('Airs soon')
  })
})

describe('timestamp-based HBO regressions', () => {
  it('predicts the next instant and preserves Monday 6:30 AM IST', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T04:30:00.000Z'))
    const prediction = predictWeeklyNextRelease({
      3: [
        { episode_number: 3, air_date: '2026-07-05', airstamp: '2026-07-06T01:00:00Z', releasePlatform: platform('hbo', 8) },
        { episode_number: 4, air_date: '2026-07-12', airstamp: '2026-07-13T01:00:00Z', releasePlatform: platform('hbo', 8) },
      ],
    })
    expect(prediction).toMatchObject({
      timestamp: Date.parse('2026-07-20T02:30:00Z'),
      istDate: '2026-07-20', thresholdTimeIST: '08:00',
      source: 'prediction', predicted: true,
    })
    expect(prediction.istDate).not.toBe('2026-07-19')
    expect(prediction.thresholdTimeIST).toBe('08:00')
  })

  it('counts six IST days and never exposes the raw TMDB Sunday', () => {
    const status = at({}, new Set(), {
      next_episode_to_air: {
        air_date: '2026-07-19', season_number: 3, episode_number: 5,
        airstamp: '2026-07-20T01:00:00+00:00', releasePlatform: platform('hbo', 8),
      },
    }, '2026-07-14T04:30:00.000Z')
    expect(status).toMatchObject({
      type: 'countdown', air_date: '2026-07-20', daysUntil: 6,
      source: 'platformThreshold',
    })
    expect(status.air_date).not.toBe('2026-07-19')
  })
})

describe('episode-list release display semantics', () => {
  it('always displays date only, including TVmaze and prediction sources', () => {
    expect(formatReleaseDisplay({
      istDate: '2026-07-20', thresholdTimeIST: '08:00', source: 'platformThreshold',
    })).toBe('Jul 20, 2026')
    const labels = ['Jul 20, 2026', `Airs ${formatReleaseDisplay({ istDate: '2026-07-20', source: 'prediction' })}`]
    for (const label of labels) {
      expect(label).not.toMatch(/IST|AM|PM|estimated|08:00|14:00|17:30/)
    }
  })
})

describe('platform threshold boundaries and wording', () => {
  const hbo = platform('hbo', 8)
  const future = { air_date: '2026-07-20', season_number: 3, episode_number: 2, releasePlatform: hbo }

  it('moves HBO from days to soon inside 12 hours', () => {
    expect(at({}, new Set(['2:8']), { next_episode_to_air: future }, '2026-07-19T14:29:00Z'))
      .toMatchObject({ type: 'countdown', subtype: 'episode', airsSoon: false })
    expect(at({}, new Set(['2:8']), { next_episode_to_air: future }, '2026-07-19T14:31:00Z'))
      .toMatchObject({ type: 'countdown', subtype: 'episode', airsSoon: true })
  })

  it('keeps HBO unavailable at 7:59 AM and releases at 8:00 AM IST', () => {
    vi.useFakeTimers()
    const episode = { ...future, episode_number: 1 }
    vi.setSystemTime(new Date('2026-07-20T02:29:00Z'))
    expect(hasAired(episode)).toBe(false)
    vi.setSystemTime(new Date('2026-07-20T02:30:00Z'))
    expect(hasAired(episode)).toBe(true)
    expect(computeWatchingStatus({ 3: [episode] }, new Set(), {}))
      .toMatchObject({ type: 'nextUp', season_number: 3, episode_number: 1 })
  })

  it.each([
    ['apple', 14, '2026-07-20T08:29:00Z', '2026-07-20T08:30:00Z'],
    ['netflix', 14, '2026-07-20T08:29:00Z', '2026-07-20T08:30:00Z'],
    ['prime', 14, '2026-07-20T08:29:00Z', '2026-07-20T08:30:00Z'],
    ['disney', 14, '2026-07-20T08:29:00Z', '2026-07-20T08:30:00Z'],
    ['hulu', 14, '2026-07-20T08:29:00Z', '2026-07-20T08:30:00Z'],
    ['peacock', 16, '2026-07-20T10:29:00Z', '2026-07-20T10:30:00Z'],
  ])('%s releases exactly at its mapped threshold', (name, hour, before, atThreshold) => {
    vi.useFakeTimers()
    const episode = ep(2, '2026-07-20', platform(name, hour))
    vi.setSystemTime(new Date(before))
    expect(hasAired(episode)).toBe(false)
    vi.setSystemTime(new Date(atThreshold))
    expect(hasAired(episode)).toBe(true)
  })

  it('reserves Airs wording for a genuine new-season episode one', () => {
    const watched = new Set(['2:8'])
    const premiere = at({}, watched, { next_episode_to_air: {
      air_date: '2026-07-20', season_number: 3, episode_number: 1, releasePlatform: hbo,
    } }, '2026-07-18T12:00:00Z')
    const normal = at({}, watched, { next_episode_to_air: future }, '2026-07-18T12:00:00Z')
    expect(watchingStatusLabel(premiere)).toMatch(/^Airs in/)
    expect(watchingStatusLabel(normal)).toMatch(/^New episode in/)
  })
})

describe('multi-episode release windows', () => {
  const prime = platform('prime', 14)
  const batch = [1, 2, 3].map((n) => ep(n, '2026-07-17', prime))

  it('advances one row through a three-episode premiere drop', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T08:30:00Z'))
    expect(computeWatchingStatus({ 2: batch }, new Set(), {})).toMatchObject({ episode_number: 1 })
    expect(computeWatchingStatus({ 2: batch }, new Set(['2:1']), {})).toMatchObject({ episode_number: 2 })
    expect(computeWatchingStatus({ 2: batch }, new Set(['2:1', '2:2']), {})).toMatchObject({ episode_number: 3 })
    expect(computeWatchingStatus({ 2: batch }, new Set(['2:1', '2:2', '2:3']), {})).not.toMatchObject({ type: 'nextUp' })
  })

  it('handles a mid-season double drop in episode order', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T08:30:00Z'))
    const episodes = [ep(4, '2026-07-10', prime), ep(5, '2026-07-17', prime), ep(6, '2026-07-17', prime)]
    expect(computeWatchingStatus({ 2: episodes }, new Set(['2:4']), {})).toMatchObject({ episode_number: 5 })
    expect(computeWatchingStatus({ 2: episodes }, new Set(['2:4', '2:5']), {})).toMatchObject({ episode_number: 6 })
  })
})

describe('computeReleasedProgress — released-only progress', () => {
  const prime = platform('prime', 14)

  it('excludes future unreleased episodes from the denominator', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T08:30:00Z')) // exactly episode 3's threshold instant
    const episodesBySeason = {
      1: [
        ep(1, '2026-07-01', prime),
        ep(2, '2026-07-08', prime),
        ep(3, '2026-07-17', prime),
        ep(4, '2026-07-24', prime), // future — must not count
      ],
    }
    const watched = new Set(['1:1', '1:2'])
    expect(computeReleasedProgress(episodesBySeason, watched)).toEqual({
      releasedCount: 3,
      watchedCount: 2,
      percent: (2 / 3) * 100,
    })
  })

  it('matches the spec example: 22 watched, 23 released, 26 total in TMDB', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T08:30:00Z'))
    const released = Array.from({ length: 23 }, (_, i) => ep(i + 1, '2026-06-01', prime))
    const future = Array.from({ length: 3 }, (_, i) => ep(24 + i, '2026-08-01', prime))
    const watched = new Set(released.slice(0, 22).map((episode) => `1:${episode.episode_number}`))
    const { releasedCount, watchedCount } = computeReleasedProgress(
      { 1: [...released, ...future] },
      watched,
    )
    expect(releasedCount).toBe(23)
    expect(watchedCount).toBe(22)
  })

  it('clamps at 100% and never divides by a padded denominator when watched rows are stale', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T08:30:00Z'))
    const episodesBySeason = { 1: [ep(1, '2026-07-01', prime)] }
    // Stale/corrupt watched rows for episodes that no longer exist in this
    // show's episode list must never push the percentage past 100.
    const watched = new Set(['1:1', '1:99', '9:1'])
    expect(computeReleasedProgress(episodesBySeason, watched)).toEqual({
      releasedCount: 1,
      watchedCount: 1,
      percent: 100,
    })
  })

  it('returns a 0/0 zero percent (not NaN) before anything has released', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const episodesBySeason = { 1: [ep(1, '2026-07-01', prime)] }
    expect(computeReleasedProgress(episodesBySeason, new Set())).toEqual({
      releasedCount: 0,
      watchedCount: 0,
      percent: 0,
    })
  })

  it('shares the exact hasAired threshold instant — no parallel date/timezone logic', () => {
    vi.useFakeTimers()
    const episodesBySeason = { 1: [ep(1, '2026-07-20', prime)] }
    vi.setSystemTime(new Date('2026-07-20T08:29:00Z'))
    expect(computeReleasedProgress(episodesBySeason, new Set()).releasedCount).toBe(0)
    vi.setSystemTime(new Date('2026-07-20T08:30:00Z'))
    expect(computeReleasedProgress(episodesBySeason, new Set()).releasedCount).toBe(1)
  })
})

describe('distinct-window prediction and pointer safety', () => {
  const prime = platform('prime', 14)

  it('ignores zero-day gaps in a batch and predicts from unique weekly windows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-25T12:00:00Z'))
    const episodes = [
      ...[1, 2, 3].map((n) => ep(n, '2026-07-10', prime)),
      ep(4, '2026-07-17', prime), ep(5, '2026-07-24', prime),
    ]
    expect(predictWeeklyNextRelease({ 1: episodes })).toMatchObject({
      istDate: '2026-07-31', thresholdTimeIST: '14:00', source: 'prediction', predicted: true,
    })
  })

  it('uses a real future season episode over stale or missing pointers', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T12:00:00Z'))
    const episodes = [ep(1, '2026-07-10', prime), ep(2, '2026-07-20', prime)]
    const stale = { next_episode_to_air: ep(1, '2026-07-10', prime) }
    expect(computeWatchingStatus({ 1: episodes }, new Set(['1:1']), stale))
      .toMatchObject({ type: 'countdown', air_date: '2026-07-20' })
    expect(computeWatchingStatus({ 1: episodes }, new Set(['1:1']), {}))
      .toMatchObject({ type: 'countdown', air_date: '2026-07-20' })
  })

  it('does not predict irregular or ended schedules', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-25T12:00:00Z'))
    const irregular = { 1: [ep(1, '2026-07-01', prime), ep(2, '2026-07-20', prime)] }
    expect(predictWeeklyNextRelease(irregular)).toBeNull()
    const weekly = { 1: [ep(1, '2026-07-10', prime), ep(2, '2026-07-17', prime)] }
    expect(predictWeeklyNextRelease(weekly, { status: 'Ended' })).toBeNull()
  })
})
