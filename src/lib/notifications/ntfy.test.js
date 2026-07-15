import { describe, expect, it, vi } from 'vitest'
import { executeNotificationPlan } from './execute.js'
import { buildNtfyRequest, publishNtfy } from './ntfy.js'

const notification = {
  tmdbShowId: 7,
  showName: 'Lucky',
  title: 'Lucky — 2 new episodes',
  body: "S1E1 · No Shortcuts\nS1E2 · Make 'em Dance",
  attachment: { url: 'https://image.tmdb.org/t/p/w342/lucky.jpg', filename: 'rerun-7.jpg' },
  episodes: [{ identity: '7:1:3:episode_available', seasonNumber: 1, episodeNumber: 3, name: 'Make ’em Dance' }],
}

describe('ntfy publishing', () => {
  it('uses the UTF-8 JSON API and preserves Unicode notification text exactly', () => {
    const request = buildNtfyRequest(notification, 'private-topic')
    expect(request.url).toBe('https://ntfy.sh')
    expect(request.init.method).toBe('POST')
    expect(request.init.headers).toEqual({ 'Content-Type': 'application/json; charset=utf-8' })
    const payload = JSON.parse(request.init.body)
    expect(payload).toEqual({
      topic: 'private-topic',
      title: 'Lucky — 2 new episodes',
      message: "S1E1 · No Shortcuts\nS1E2 · Make 'em Dance",
      attach: 'https://image.tmdb.org/t/p/w342/lucky.jpg',
      filename: 'rerun-7.jpg',
    })
    expect(request.init.headers).not.toHaveProperty('Title')
    expect(request.init.headers).not.toHaveProperty('Click')
    expect(request.init.headers).not.toHaveProperty('Actions')
    expect(payload).not.toHaveProperty('Click')
    expect(payload).not.toHaveProperty('Actions')
  })

  it('omits attachment fields when artwork is missing', () => {
    const payload = JSON.parse(buildNtfyRequest({ ...notification, attachment: null }, 'topic').init.body)
    expect(payload).not.toHaveProperty('attach')
    expect(payload).not.toHaveProperty('filename')
  })

  it('preserves a non-ASCII show name and episode title in JSON', () => {
    const payload = JSON.parse(buildNtfyRequest({
      ...notification,
      title: 'Lücky — New episode',
      body: 'S1E1 · Épisode final',
      attachment: null,
    }, 'unicode-topic').init.body)
    expect(payload.title).toBe('Lücky — New episode')
    expect(payload.message).toBe('S1E1 · Épisode final')
  })

  it('requires a non-empty topic string', () => {
    expect(() => buildNtfyRequest(notification, '')).toThrow('NTFY_TOPIC is required')
    expect(() => buildNtfyRequest(notification, '   ')).toThrow('NTFY_TOPIC is required')
    expect(() => buildNtfyRequest(notification, null)).toThrow('NTFY_TOPIC is required')
  })

  it('accepts success and rejects failure without exposing the topic in the error', async () => {
    const okFetch = vi.fn(async () => ({ ok: true }))
    await publishNtfy(notification, { topic: 'secret-topic', fetchImpl: okFetch })
    expect(okFetch).toHaveBeenCalledWith('https://ntfy.sh', expect.objectContaining({ method: 'POST' }))
    await expect(publishNtfy(notification, {
      topic: 'secret-topic',
      fetchImpl: async () => ({ ok: false, status: 503 }),
    })).rejects.toThrow('ntfy push failed (503)')
    try {
      await publishNtfy(notification, { topic: 'secret-topic', fetchImpl: async () => ({ ok: false, status: 500 }) })
    } catch (error) {
      expect(error.message).not.toContain('secret-topic')
    }
  })
})

describe('delivery execution', () => {
  it('records only after a successful publish and repeated claims prevent resend', async () => {
    let delivered = false
    const calls = []
    const store = {
      claim: vi.fn(async () => delivered ? [] : [notification.episodes[0].identity]),
      complete: vi.fn(async () => { delivered = true; calls.push('complete') }),
      release: vi.fn(),
    }
    const publish = vi.fn(async () => { calls.push('publish') })
    const args = { plan: { notifications: [notification] }, enabled: true, store, deliveryStore: store, publish }
    await executeNotificationPlan(args)
    await executeNotificationPlan(args)
    expect(calls).toEqual(['publish', 'complete'])
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('releases claims and never completes after ntfy failure', async () => {
    const store = {
      claim: vi.fn(async () => [notification.episodes[0].identity]),
      complete: vi.fn(),
      release: vi.fn(),
    }
    await expect(executeNotificationPlan({
      plan: { notifications: [notification] }, enabled: true, deliveryStore: store,
      publish: async () => { throw new Error('ntfy down') },
    })).rejects.toThrow('ntfy down')
    expect(store.complete).not.toHaveBeenCalled()
    expect(store.release).toHaveBeenCalledWith([notification.episodes[0].identity])
  })

  it('dry-run and disabled modes perform no side effects', async () => {
    const store = { claim: vi.fn(), complete: vi.fn(), release: vi.fn() }
    const publish = vi.fn()
    await executeNotificationPlan({ plan: { notifications: [notification] }, dryRun: true, deliveryStore: store, publish })
    await executeNotificationPlan({ plan: { notifications: [notification] }, deliveryStore: store, publish })
    expect(store.claim).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
})

