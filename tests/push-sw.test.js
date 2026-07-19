import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const swSource = readFileSync(resolve(import.meta.dirname, '..', 'public', 'push-sw.js'), 'utf8')

let previousSelf

afterEach(() => {
  if (previousSelf === undefined) delete globalThis.self
  else globalThis.self = previousSelf
  previousSelf = undefined
})

// public/push-sw.js is a plain script pulled into the generated service
// worker via importScripts() (see vite/pwa-options.js), not an ES module —
// it only ever calls the bare global `self`. Evaluating its source against a
// fake `self` we control lets these tests exercise the real file byte-for-byte
// without needing an actual service worker environment.
function loadPushSw() {
  previousSelf = globalThis.self
  const listeners = new Map()
  const showNotification = vi.fn().mockResolvedValue(undefined)
  const matchAll = vi.fn().mockResolvedValue([])
  const openWindow = vi.fn().mockResolvedValue(undefined)

  globalThis.self = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    registration: { showNotification },
    clients: { matchAll, openWindow },
  }

  // Wrapped in an IIFE so each test gets a fresh function scope — otherwise
  // the script's top-level `const` declarations collide across repeat
  // evaluations in the same vm.runInThisContext realm.
  vm.runInThisContext(`(function () {\n${swSource}\n})()`, { filename: 'push-sw.js' })

  return { listeners, showNotification, matchAll, openWindow }
}

function pushEvent(data) {
  return {
    data: data === undefined ? null : { json: () => data },
    waitUntil: vi.fn(),
  }
}

describe('push-sw.js: push event', () => {
  it('shows a notification using the payload title/body/icon', async () => {
    const { listeners, showNotification } = loadPushSw()
    const event = pushEvent({ title: 'S3E1 is out', body: 'The Bear — new episode', url: '/watching/123' })
    listeners.get('push')(event)
    await event.waitUntil.mock.calls[0][0]

    expect(showNotification).toHaveBeenCalledWith(
      'S3E1 is out',
      expect.objectContaining({
        body: 'The Bear — new episode',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url: '/watching/123' },
      }),
    )
  })

  it('falls back to default title/body/url when there is no payload at all', async () => {
    const { listeners, showNotification } = loadPushSw()
    const event = pushEvent(undefined)
    listeners.get('push')(event)
    await event.waitUntil.mock.calls[0][0]

    expect(showNotification).toHaveBeenCalledWith(
      'Rerun',
      expect.objectContaining({ body: 'You have a new notification.', data: { url: '/watching' } }),
    )
  })

  it('falls back to default title/body when the payload is not valid JSON', async () => {
    const { listeners, showNotification } = loadPushSw()
    const event = {
      data: {
        json: () => {
          throw new Error('not json')
        },
      },
      waitUntil: vi.fn(),
    }
    listeners.get('push')(event)
    await event.waitUntil.mock.calls[0][0]

    expect(showNotification).toHaveBeenCalledWith(
      'Rerun',
      expect.objectContaining({ body: 'You have a new notification.' }),
    )
  })

  it('ignores blank title/body fields and falls back instead of showing an empty notification', async () => {
    const { listeners, showNotification } = loadPushSw()
    const event = pushEvent({ title: '   ', body: '' })
    listeners.get('push')(event)
    await event.waitUntil.mock.calls[0][0]

    expect(showNotification).toHaveBeenCalledWith('Rerun', expect.objectContaining({ body: 'You have a new notification.' }))
  })

  it('passes through a stable tag when the payload provides one (automatic episode notifications)', async () => {
    const { listeners, showNotification } = loadPushSw()
    const event = pushEvent({ title: 'The Bear', body: 'S3E1 · Up next', url: '/watching/123', tag: 'rerun-episode-123-s3e1' })
    listeners.get('push')(event)
    await event.waitUntil.mock.calls[0][0]

    expect(showNotification).toHaveBeenCalledWith('The Bear', expect.objectContaining({ tag: 'rerun-episode-123-s3e1' }))
  })

  it('omits the tag option entirely when the payload has none (Phase 1 manual test push)', async () => {
    const { listeners, showNotification } = loadPushSw()
    const event = pushEvent({ title: 'Rerun notifications are working', body: 'Test push' })
    listeners.get('push')(event)
    await event.waitUntil.mock.calls[0][0]

    const options = showNotification.mock.calls[0][1]
    expect('tag' in options).toBe(false)
  })
})

describe('push-sw.js: notificationclick', () => {
  function clickEvent(url) {
    return { notification: { close: vi.fn(), data: url ? { url } : null }, waitUntil: vi.fn() }
  }

  it('focuses an existing Rerun client instead of opening a new one', async () => {
    const { listeners, matchAll, openWindow } = loadPushSw()
    const focus = vi.fn()
    matchAll.mockResolvedValue([{ focus }])
    const event = clickEvent('/watching/123')
    listeners.get('notificationclick')(event)
    await event.waitUntil.mock.calls[0][0]

    expect(event.notification.close).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('opens /watching when no existing client is available', async () => {
    const { listeners, matchAll, openWindow } = loadPushSw()
    matchAll.mockResolvedValue([])
    const event = clickEvent(undefined)
    listeners.get('notificationclick')(event)
    await event.waitUntil.mock.calls[0][0]

    expect(openWindow).toHaveBeenCalledWith('/watching')
  })

  it('opens the payload-provided url when no existing client is available', async () => {
    const { listeners, matchAll, openWindow } = loadPushSw()
    matchAll.mockResolvedValue([])
    const event = clickEvent('/watching/999')
    listeners.get('notificationclick')(event)
    await event.waitUntil.mock.calls[0][0]

    expect(openWindow).toHaveBeenCalledWith('/watching/999')
  })
})
