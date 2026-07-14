import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeWatchingStatus,
  episodeReleaseDateInIST,
  watchingStatusLabel,
} from './watchHelpers'

afterEach(() => {
  vi.useRealTimers()
})

const ep = (n, airDate) => ({ episode_number: n, name: `E${n}`, air_date: airDate })

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
  const details = { next_episode_to_air: { air_date: '2026-07-20', episode_number: 5 } }

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
