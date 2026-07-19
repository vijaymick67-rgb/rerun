import { describe, expect, it, vi } from 'vitest'
import { clearStoredManagementToken, getStoredManagementToken, setStoredManagementToken } from './managementToken.js'

function fakeStorage() {
  const map = new Map()
  return {
    getItem: vi.fn((key) => map.get(key) ?? null),
    setItem: vi.fn((key, value) => map.set(key, value)),
    removeItem: vi.fn((key) => map.delete(key)),
  }
}

describe('managementToken storage', () => {
  it('returns null when nothing is stored', () => {
    expect(getStoredManagementToken(fakeStorage())).toBeNull()
  })

  it('round-trips a stored token', () => {
    const storage = fakeStorage()
    setStoredManagementToken('abc123', storage)
    expect(getStoredManagementToken(storage)).toBe('abc123')
  })

  it('removes the token when set to a falsy value', () => {
    const storage = fakeStorage()
    setStoredManagementToken('abc123', storage)
    setStoredManagementToken(null, storage)
    expect(getStoredManagementToken(storage)).toBeNull()
  })

  it('clears the stored token', () => {
    const storage = fakeStorage()
    setStoredManagementToken('abc123', storage)
    clearStoredManagementToken(storage)
    expect(getStoredManagementToken(storage)).toBeNull()
  })

  it('returns null and does not throw when there is no storage available', () => {
    expect(getStoredManagementToken(undefined)).toBeNull()
    expect(() => setStoredManagementToken('abc123', undefined)).not.toThrow()
    expect(() => clearStoredManagementToken(undefined)).not.toThrow()
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
    expect(getStoredManagementToken(storage)).toBeNull()
    expect(() => setStoredManagementToken('abc123', storage)).not.toThrow()
  })
})
