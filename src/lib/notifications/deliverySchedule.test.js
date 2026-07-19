import { describe, expect, it } from 'vitest'
import { timestampFromISTDate } from '../networkReleaseTiming.js'
import {
  DEFAULT_PREFERRED_HOUR_IST,
  isSendableNow,
  isValidPreferredHour,
  MAX_PREFERRED_HOUR_IST,
  MIN_PREFERRED_HOUR_IST,
  scheduledDeliveryInstant,
} from './deliverySchedule.js'

const IST_DATE = '2026-07-19'
const EIGHT_PM_IST = timestampFromISTDate(IST_DATE, 20, 0)

describe('isValidPreferredHour', () => {
  it('accepts every integer hour 18 through 23', () => {
    for (let hour = MIN_PREFERRED_HOUR_IST; hour <= MAX_PREFERRED_HOUR_IST; hour += 1) {
      expect(isValidPreferredHour(hour)).toBe(true)
    }
  })

  it('rejects 17 (below the allowed range)', () => {
    expect(isValidPreferredHour(17)).toBe(false)
  })

  it('rejects 24 (above the allowed range)', () => {
    expect(isValidPreferredHour(24)).toBe(false)
  })

  it('rejects non-integer and non-numeric input', () => {
    expect(isValidPreferredHour('20')).toBe(false)
    expect(isValidPreferredHour(20.5)).toBe(false)
    expect(isValidPreferredHour(null)).toBe(false)
    expect(isValidPreferredHour(undefined)).toBe(false)
  })
})

describe('scheduledDeliveryInstant', () => {
  it('release at 9 AM IST, selected 8 PM -> scheduled for 8 PM the same IST day', () => {
    const release = timestampFromISTDate(IST_DATE, 9, 0)
    expect(scheduledDeliveryInstant(release, 20)).toBe(EIGHT_PM_IST)
  })

  it('release at 7:55 PM IST, selected 8 PM -> scheduled for 8 PM', () => {
    const release = timestampFromISTDate(IST_DATE, 19, 55)
    expect(scheduledDeliveryInstant(release, 20)).toBe(EIGHT_PM_IST)
  })

  it('release exactly at 8 PM -> scheduled instant is the release instant itself', () => {
    expect(scheduledDeliveryInstant(EIGHT_PM_IST, 20)).toBe(EIGHT_PM_IST)
  })

  it('release at 9:15 PM, selected 8 PM -> scheduled for 9:15 PM (the release instant, not delayed)', () => {
    const release = timestampFromISTDate(IST_DATE, 21, 15)
    expect(scheduledDeliveryInstant(release, 20)).toBe(release)
  })

  it('a release near the UTC/IST calendar-day boundary uses the correct IST calendar day', () => {
    // 2026-07-19T00:10 IST is 2026-07-18T18:40:00Z — a naive UTC-date read
    // would land on the wrong (prior) calendar day.
    const release = timestampFromISTDate('2026-07-19', 0, 10)
    expect(release).toBe(Date.parse('2026-07-18T18:40:00.000Z'))
    expect(scheduledDeliveryInstant(release, 20)).toBe(EIGHT_PM_IST)
  })

  it('falls back to the default hour for an invalid preferred hour', () => {
    const release = timestampFromISTDate(IST_DATE, 9, 0)
    expect(scheduledDeliveryInstant(release, 99)).toBe(scheduledDeliveryInstant(release, DEFAULT_PREFERRED_HOUR_IST))
  })

  it('returns null for a non-finite release timestamp', () => {
    expect(scheduledDeliveryInstant(null, 20)).toBeNull()
    expect(scheduledDeliveryInstant(NaN, 20)).toBeNull()
  })
})

describe('isSendableNow', () => {
  const release = timestampFromISTDate(IST_DATE, 9, 0) // scheduled = 8 PM IST

  it('evaluation before the scheduled instant is not sendable', () => {
    expect(isSendableNow(release, 20, EIGHT_PM_IST - 1)).toBe(false)
  })

  it('evaluation exactly at the scheduled instant is sendable', () => {
    expect(isSendableNow(release, 20, EIGHT_PM_IST)).toBe(true)
  })

  it('evaluation after the scheduled instant is sendable', () => {
    expect(isSendableNow(release, 20, EIGHT_PM_IST + 1)).toBe(true)
  })
})
