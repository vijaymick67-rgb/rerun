import { describe, expect, it, vi } from 'vitest'
import { releaseDateInIST, releaseRuleForShow, releaseTimestamp } from './networkReleaseTiming'
import { computeWatchingStatus, hasAired } from './watchHelpers'

describe('release timing rules', () => {
  it('keeps HOTD in Airs soon through Sunday night IST and releases it Monday 6:30 AM IST', () => {
    vi.useFakeTimers()
    const rule = releaseRuleForShow(94997, ['HBO'])
    expect(new Date(releaseTimestamp('2026-07-12', rule)).toISOString()).toBe('2026-07-13T01:00:00.000Z')
    expect(releaseDateInIST('2026-07-12', rule)).toBe('2026-07-13')

    vi.setSystemTime(new Date('2026-07-12T18:00:00.000Z'))
    expect(hasAired({ air_date: '2026-07-12' }, rule)).toBe(false)
    expect(computeWatchingStatus(
      { 1: [{ episode_number: 1, name: 'Episode', air_date: '2026-07-12' }] },
      new Set(), rule, { next_episode_to_air: { air_date: '2026-07-12', episode_number: 1 } },
    )).toMatchObject({ type: 'countdown', airsSoon: true })

    vi.setSystemTime(new Date('2026-07-13T01:00:00.000Z'))
    expect(hasAired({ air_date: '2026-07-12' }, rule)).toBe(true)
    expect(computeWatchingStatus(
      { 1: [{ episode_number: 1, name: 'Episode', air_date: '2026-07-12' }] },
      new Set(), rule, { next_episode_to_air: { air_date: '2026-07-12', episode_number: 1 } },
    )).toMatchObject({ type: 'nextUp', season_number: 1, episode_number: 1 })
    vi.useRealTimers()
  })

  it('resolves Netflix midnight Pacific in the platform timezone', () => {
    const rule = releaseRuleForShow(1, ['Netflix'])
    expect(new Date(releaseTimestamp('2026-07-12', rule)).toISOString()).toBe('2026-07-12T07:00:00.000Z')
  })

  it.each([285404, 203744, 277439])(
    'keeps Apple show %s on the TMDB source date and releases the following IST morning',
    (showId) => {
      vi.useFakeTimers()
      const rule = releaseRuleForShow(showId, ['Apple TV+'])
      expect(new Date(releaseTimestamp('2026-07-14', rule)).toISOString()).toBe('2026-07-15T01:00:00.000Z')
      expect(releaseDateInIST('2026-07-14', rule)).toBe('2026-07-15')

      vi.setSystemTime(new Date('2026-07-15T00:59:59.000Z'))
      expect(hasAired({ air_date: '2026-07-14' }, rule)).toBe(false)
      expect(computeWatchingStatus(
        { 1: [{ episode_number: 10, name: 'Queens', air_date: '2026-07-14' }] },
        new Set(), rule, { next_episode_to_air: { air_date: '2026-07-14', episode_number: 10 } },
      )).toMatchObject({ type: 'countdown', airsSoon: true })

      vi.setSystemTime(new Date('2026-07-15T01:00:00.000Z'))
      expect(hasAired({ air_date: '2026-07-14' }, rule)).toBe(true)
      expect(computeWatchingStatus(
        { 1: [{ episode_number: 10, name: 'Queens', air_date: '2026-07-14' }] },
        new Set(), rule, { next_episode_to_air: { air_date: '2026-07-14', episode_number: 10 } },
      )).toMatchObject({ type: 'nextUp', season_number: 1, episode_number: 10 })
      vi.useRealTimers()
    },
  )

  it('automatically changes the New York offset across US daylight saving time', () => {
    const rule = releaseRuleForShow(1, ['HBO'])
    expect(new Date(releaseTimestamp('2026-03-01', rule)).toISOString()).toBe('2026-03-02T02:00:00.000Z')
    expect(new Date(releaseTimestamp('2026-03-15', rule)).toISOString()).toBe('2026-03-16T01:00:00.000Z')
  })

  it('uses a safe noon-UTC fallback for unknown networks', () => {
    const rule = releaseRuleForShow(1, ['Unknown Network'])
    expect(rule.fallback).toBe(true)
    expect(new Date(releaseTimestamp('2026-07-12', rule)).toISOString()).toBe('2026-07-12T12:00:00.000Z')
  })
})
