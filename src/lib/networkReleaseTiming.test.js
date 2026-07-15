import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveReleaseInfo,
  timestampFromISTDate,
} from './networkReleaseTiming'

const hbo = {
  platform: 'hbo', thresholdHourIST: 8, thresholdMinuteIST: 0, confidence: 'mapped',
}
const apple = {
  platform: 'apple', thresholdHourIST: 8, thresholdMinuteIST: 0, confidence: 'mapped',
}

afterEach(() => vi.useRealTimers())

describe('platform-threshold release resolution', () => {
  it('uses TVmaze airstamp only for the IST date and HBO for the final time', () => {
    expect(resolveReleaseInfo(
      '2026-07-19',
      { airstamp: '2026-07-20T01:00:00Z' },
      hbo,
    )).toEqual({
      timestamp: Date.parse('2026-07-20T02:30:00Z'),
      istDate: '2026-07-20',
      thresholdTimeIST: '08:00',
      platform: 'hbo',
      source: 'platformThreshold',
      dateSource: 'tvmazeAirstamp',
      predicted: false,
      confidence: 'mapped',
    })
  })

  it('ignores an odd TVmaze clock time after resolving Apple date', () => {
    const result = resolveReleaseInfo(
      '2026-07-19',
      { airstamp: '2026-07-20T12:00:00Z' }, // 5:30 PM IST
      apple,
    )
    expect(result).toMatchObject({
      istDate: '2026-07-20', thresholdTimeIST: '08:00', platform: 'apple',
      timestamp: Date.parse('2026-07-20T02:30:00Z'),
    })
  })

  it('keeps a same-day Apple TV episode unavailable until 8 AM IST', () => {
    const release = resolveReleaseInfo('2026-07-15', {}, apple)
    vi.useFakeTimers()
    vi.setSystemTime('2026-07-15T02:29:59.999Z')
    expect(Date.now()).toBeLessThan(release.timestamp)
    vi.setSystemTime('2026-07-15T02:30:00.000Z')
    expect(Date.now()).toBe(release.timestamp)
  })

  it('uses valid TVmaze airdate before TMDB when airstamp is missing', () => {
    expect(resolveReleaseInfo('2026-07-19', { airdate: '2026-07-20' }, hbo))
      .toMatchObject({ istDate: '2026-07-20', dateSource: 'tvmazeAirdate' })
  })

  it('falls back to TMDB date and conservative unknown threshold', () => {
    expect(resolveReleaseInfo('2026-07-20')).toMatchObject({
      istDate: '2026-07-20', thresholdTimeIST: '18:00',
      platform: 'unknown', dateSource: 'tmdb', confidence: 'fallback',
    })
  })

  it('lets an override replace both date and threshold', () => {
    expect(resolveReleaseInfo('2026-12-25', {
      newsOverride: {
        date: '2026-12-23', thresholdHourIST: 8, thresholdMinuteIST: 15,
        reason: 'Holiday early release', source: 'newsOverride',
      },
    }, apple)).toMatchObject({
      istDate: '2026-12-23', thresholdTimeIST: '08:15',
      timestamp: timestampFromISTDate('2026-12-23', 8, 15),
      source: 'manualOverride', dateSource: 'manualOverride',
    })
  })

  it('returns null for malformed or missing dates without throwing', () => {
    expect(resolveReleaseInfo(null, { airstamp: 'bad', airdate: '2026-13-40' }, hbo)).toBeNull()
    expect(resolveReleaseInfo(null, {}, hbo)).toBeNull()
  })
})
