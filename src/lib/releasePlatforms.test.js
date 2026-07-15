import { describe, expect, it } from 'vitest'
import { classifyReleasePlatform } from './releasePlatforms'

const cases = [
  ['HBO', 'hbo', 8], ['Max', 'hbo', 8], ['HBO Max', 'hbo', 8],
  ['MGM+', 'mgm', 8], ['Apple TV+', 'apple', 8], ['Apple TV', 'apple', 8],
  ['Amazon Prime Video', 'prime', 14], ['Prime Video', 'prime', 14],
  ['Netflix', 'netflix', 14], ['Disney+', 'disney', 14],
  ['Disney Plus', 'disney', 14], ['Hulu', 'hulu', 14],
  ['FX', 'hulu', 14], ['FX on Hulu', 'hulu', 14], ['Peacock', 'peacock', 16],
]

describe('classifyReleasePlatform', () => {
  const observedAppleShows = [
    ['Lucky', { id: 278624, name: 'Lucky', networks: ['Apple TV'] }],
    ['Maximum Pleasure Guaranteed', {
      id: 285404, name: 'Maximum Pleasure Guaranteed', networks: ['Apple TV'],
    }],
    ['Sugar', { id: 203744, name: 'Sugar', networks: ['Apple TV'] }],
  ]

  it.each(cases)('maps %s to %s at %i:00 IST', (name, platform, hour) => {
    expect(classifyReleasePlatform({ networks: [name] })).toEqual({
      platform, thresholdHourIST: hour, thresholdMinuteIST: 0, confidence: 'mapped',
    })
  })

  it('uses conservative unknown for missing or unmapped metadata', () => {
    expect(classifyReleasePlatform({ networks: ['JioHotstar'] })).toEqual({
      platform: 'unknown', thresholdHourIST: 18, thresholdMinuteIST: 0,
      confidence: 'fallback',
    })
    expect(classifyReleasePlatform({})).toMatchObject({ platform: 'unknown', thresholdHourIST: 18 })
  })

  it.each(observedAppleShows)('classifies the observed TMDB metadata for %s', (_name, details) => {
    expect(classifyReleasePlatform(details)).toEqual({
      platform: 'apple', thresholdHourIST: 8, thresholdMinuteIST: 0,
      confidence: 'mapped',
    })
  })

  it.each(['Apple', 'TV', 'Apple Studios', 'Pineapple TV', 'Apple TV Studios'])(
    'does not broadly classify unrelated network name %s as Apple',
    (name) => {
      expect(classifyReleasePlatform({ networks: [name] })).toMatchObject({
        platform: 'unknown', thresholdHourIST: 18, confidence: 'fallback',
      })
    },
  )

  it('uses explicit precedence instead of network array order', () => {
    expect(classifyReleasePlatform({ networks: ['Prime Video', 'MGM+'] }).platform).toBe('mgm')
    expect(classifyReleasePlatform({ networks: ['JioHotstar', 'Hulu'] }).platform).toBe('hulu')
    expect(classifyReleasePlatform({ networks: ['Prime Video', 'HBO'] }).platform).toBe('hbo')
  })
})
