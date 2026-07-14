import { describe, expect, it } from 'vitest'
import { classifyReleasePlatform } from './releasePlatforms'

const cases = [
  ['HBO', 'hbo', 8], ['Max', 'hbo', 8], ['HBO Max', 'hbo', 8],
  ['MGM+', 'mgm', 8], ['Apple TV+', 'apple', 14],
  ['Amazon Prime Video', 'prime', 14], ['Prime Video', 'prime', 14],
  ['Netflix', 'netflix', 14], ['Disney+', 'disney', 14],
  ['Disney Plus', 'disney', 14], ['Hulu', 'hulu', 14],
  ['FX', 'hulu', 14], ['FX on Hulu', 'hulu', 14], ['Peacock', 'peacock', 16],
]

describe('classifyReleasePlatform', () => {
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

  it('uses explicit precedence instead of network array order', () => {
    expect(classifyReleasePlatform({ networks: ['Prime Video', 'MGM+'] }).platform).toBe('mgm')
    expect(classifyReleasePlatform({ networks: ['JioHotstar', 'Hulu'] }).platform).toBe('hulu')
    expect(classifyReleasePlatform({ networks: ['Prime Video', 'HBO'] }).platform).toBe('hbo')
  })
})
