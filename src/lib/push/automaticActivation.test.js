import { describe, expect, it, vi } from 'vitest'
import { getAutomaticNotificationsActivated, setAutomaticNotificationsActivated } from './automaticActivation.js'

function fakeStorage() {
  const map = new Map()
  return {
    getItem: vi.fn((key) => map.get(key) ?? null),
    setItem: vi.fn((key, value) => map.set(key, value)),
    removeItem: vi.fn((key) => map.delete(key)),
  }
}

describe('automaticActivation storage', () => {
  it('defaults to false when nothing is stored', () => {
    expect(getAutomaticNotificationsActivated(fakeStorage())).toBe(false)
  })

  it('round-trips true', () => {
    const storage = fakeStorage()
    setAutomaticNotificationsActivated(true, storage)
    expect(getAutomaticNotificationsActivated(storage)).toBe(true)
  })

  it('clears back to false', () => {
    const storage = fakeStorage()
    setAutomaticNotificationsActivated(true, storage)
    setAutomaticNotificationsActivated(false, storage)
    expect(getAutomaticNotificationsActivated(storage)).toBe(false)
  })

  it('returns false and does not throw when there is no storage available', () => {
    expect(getAutomaticNotificationsActivated(undefined)).toBe(false)
    expect(() => setAutomaticNotificationsActivated(true, undefined)).not.toThrow()
  })

  it('swallows storage errors without throwing', () => {
    const storage = {
      getItem: vi.fn(() => { throw new Error('blocked') }),
      setItem: vi.fn(() => { throw new Error('blocked') }),
      removeItem: vi.fn(() => { throw new Error('blocked') }),
    }
    expect(getAutomaticNotificationsActivated(storage)).toBe(false)
    expect(() => setAutomaticNotificationsActivated(true, storage)).not.toThrow()
  })
})
