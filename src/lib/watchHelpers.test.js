import { afterEach, describe, expect, it, vi } from 'vitest'
import { releaseRuleForShow } from './networkReleaseTiming'
import { computeWatchingStatus, watchingStatusLabel } from './watchHelpers'

afterEach(() => {
  vi.useRealTimers()
})

describe('computeWatchingStatus — countdown guard (FIX 1 + FIX 2)', () => {
  // The House of the Dragon bug: TMDB's next_episode_to_air lags for hours
  // after an episode actually drops, so its air_date is today or in the past
  // while the season list hasn't caught up either. The old code counted down
  // to that already-passed instant and rendered "New episode soon". With the
  // guard, a stale/past release falls through to caughtUp.
  it('returns caughtUp (not a countdown) when next_episode_to_air already released', () => {
    vi.useFakeTimers()
    // HBO 9 PM ET on 2026-07-13 (Sun) resolves to 2026-07-14T01:00:00Z.
    vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'))
    const rule = releaseRuleForShow(94997, ['HBO'])

    const status = computeWatchingStatus(
      // Latest known episode is watched; TMDB hasn't surfaced the new one yet.
      { 1: [{ episode_number: 1, name: 'Premiere', air_date: '2026-07-06' }] },
      new Set(['1:1']),
      rule,
      // Stale pointer: this episode already dropped (release was 11h ago).
      { status: 'Returning Series', next_episode_to_air: { air_date: '2026-07-13', episode_number: 2 } },
    )

    expect(status).toEqual({ type: 'caughtUp' })
  })

  it('marks a still-future release airsSoon only when under 24h out', () => {
    const rule = releaseRuleForShow(1, ['Prime Video']) // midnight UTC anchor
    const episodesBySeason = {}
    const details = { next_episode_to_air: { air_date: '2026-07-20', episode_number: 5 } }
    // Prime release instant for 2026-07-20 is exactly 2026-07-20T00:00:00Z.

    const at = (iso) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(iso))
      return computeWatchingStatus(episodesBySeason, new Set(), rule, details)
    }

    expect(at('2026-07-19T01:00:00.000Z')).toMatchObject({ type: 'countdown', airsSoon: true }) // 23h
    expect(at('2026-07-19T00:00:00.000Z')).toMatchObject({ type: 'countdown', airsSoon: false }) // 24h
    expect(at('2026-07-18T23:00:00.000Z')).toMatchObject({ type: 'countdown', airsSoon: false }) // 25h
  })
})

describe('watchingStatusLabel — grammar (FIX 5)', () => {
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
