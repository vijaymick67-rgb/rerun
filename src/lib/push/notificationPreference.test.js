import { describe, expect, it, vi } from 'vitest'
import { getStoredPreferredHour, setStoredPreferredHour } from './notificationPreference.js'
import { DEFAULT_PREFERRED_HOUR_IST } from '../notifications/deliverySchedule.js'

function fakeStorage() {
  const map = new Map()
  return {
    getItem: vi.fn((key) => map.get(key) ?? null),
    setItem: vi.fn((key, value) => map.set(key, value)),
    removeItem: vi.fn((key) => map.delete(key)),
  }
}

describe('notificationPreference storage', () => {
  it('defaults to 8 PM (20) when nothing is stored', () => {
    expect(getStoredPreferredHour(fakeStorage())).toBe(DEFAULT_PREFERRED_HOUR_IST)
  })

  it('round-trips a stored hour', () => {
    const storage = fakeStorage()
    setStoredPreferredHour(22, storage)
    expect(getStoredPreferredHour(storage)).toBe(22)
  })

  it('falls back to the default for a corrupted/out-of-range stored value', () => {
    const storage = fakeStorage()
    storage.setItem('rerun:push:preferredNotificationHourIst', '2')
    expect(getStoredPreferredHour(storage)).toBe(DEFAULT_PREFERRED_HOUR_IST)
    storage.setItem('rerun:push:preferredNotificationHourIst', 'not-a-number')
    expect(getStoredPreferredHour(storage)).toBe(DEFAULT_PREFERRED_HOUR_IST)
  })

  it('ignores an attempt to store an invalid hour', () => {
    const storage = fakeStorage()
    setStoredPreferredHour(99, storage)
    expect(getStoredPreferredHour(storage)).toBe(DEFAULT_PREFERRED_HOUR_IST)
  })

  it('returns the default and does not throw when there is no storage available', () => {
    expect(getStoredPreferredHour(undefined)).toBe(DEFAULT_PREFERRED_HOUR_IST)
    expect(() => setStoredPreferredHour(21, undefined)).not.toThrow()
  })

  it('swallows storage errors (e.g. private-browsing quota) without throwing', () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('blocked')
      }),
      setItem: vi.fn(() => {
        throw new Error('blocked')
      }),
      removeItem: vi.fn(() => {
        throw new Error('blocked')
      }),
    }
    expect(getStoredPreferredHour(storage)).toBe(DEFAULT_PREFERRED_HOUR_IST)
    expect(() => setStoredPreferredHour(21, storage)).not.toThrow()
  })
})
