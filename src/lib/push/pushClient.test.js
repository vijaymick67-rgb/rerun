import { describe, expect, it, vi } from 'vitest'
import {
  getExistingPushSubscription,
  getServiceWorkerRegistration,
  requestNotificationPermission,
  subscribeToPush,
  unsubscribeFromPush,
} from './pushClient.js'

function base64UrlKey() {
  const raw = new Uint8Array(65)
  raw[0] = 4
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('requestNotificationPermission', () => {
  it('requests permission when it has not been decided yet', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    const notificationApi = { permission: 'default', requestPermission }
    expect(await requestNotificationPermission(notificationApi)).toBe('granted')
    expect(requestPermission).toHaveBeenCalledOnce()
  })

  it('returns "granted" without re-prompting when already granted', async () => {
    const requestPermission = vi.fn()
    const notificationApi = { permission: 'granted', requestPermission }
    expect(await requestNotificationPermission(notificationApi)).toBe('granted')
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('returns "denied" without re-prompting when already denied', async () => {
    const requestPermission = vi.fn()
    const notificationApi = { permission: 'denied', requestPermission }
    expect(await requestNotificationPermission(notificationApi)).toBe('denied')
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('reports "unsupported" when there is no Notification API at all', async () => {
    expect(await requestNotificationPermission(undefined)).toBe('unsupported')
  })
})

describe('getServiceWorkerRegistration', () => {
  it('resolves the ready registration when a service worker container exists', async () => {
    const registration = { pushManager: {} }
    const container = { ready: Promise.resolve(registration) }
    expect(await getServiceWorkerRegistration(container)).toBe(registration)
  })

  it('returns null when there is no service worker support', async () => {
    expect(await getServiceWorkerRegistration(undefined)).toBeNull()
  })
})

describe('getExistingPushSubscription', () => {
  it('returns the existing subscription from pushManager', async () => {
    const subscription = { endpoint: 'https://example.test/1' }
    const registration = { pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } }
    expect(await getExistingPushSubscription(registration)).toBe(subscription)
  })

  it('returns null when there is no registration', async () => {
    expect(await getExistingPushSubscription(null)).toBeNull()
  })
})

describe('subscribeToPush', () => {
  it('reuses an existing subscription instead of creating a new one', async () => {
    const existing = { endpoint: 'https://example.test/existing' }
    const subscribe = vi.fn()
    const registration = {
      pushManager: { getSubscription: vi.fn().mockResolvedValue(existing), subscribe },
    }
    const result = await subscribeToPush(registration, base64UrlKey())
    expect(result).toBe(existing)
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('creates a new subscription with the VAPID key when none exists', async () => {
    const created = { endpoint: 'https://example.test/new' }
    const subscribe = vi.fn().mockResolvedValue(created)
    const registration = {
      pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe },
    }
    const result = await subscribeToPush(registration, base64UrlKey())
    expect(result).toBe(created)
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        userVisibleOnly: true,
        applicationServerKey: expect.any(Uint8Array),
      }),
    )
  })

  it('throws when there is no active registration', async () => {
    await expect(subscribeToPush(null, base64UrlKey())).rejects.toThrow(/registration/)
  })
})

describe('unsubscribeFromPush', () => {
  it('unsubscribes an existing subscription', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true)
    expect(await unsubscribeFromPush({ unsubscribe })).toBe(true)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('is a no-op success when there is nothing to unsubscribe', async () => {
    expect(await unsubscribeFromPush(null)).toBe(true)
  })
})
