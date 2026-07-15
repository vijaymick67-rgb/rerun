import { describe, expect, it, vi } from 'vitest'
import { executeNotificationPlan } from './execute.js'
import { buildNtfyRequest, publishNtfy } from './ntfy.js'

const notification = {
  tmdbShowId: 7,
  showName: 'Lucky',
  title: 'Lucky — New episode',
  body: 'S1E3 · The Big Score',
  attachment: { url: 'https://image.tmdb.org/t/p/w342/lucky.jpg', filename: 'rerun-7.jpg' },
  episodes: [{ identity: '7:1:3:episode_available', seasonNumber: 1, episodeNumber: 3, name: 'The Big Score' }],
}

describe('ntfy publishing', () => {
  it('uses only the approved text and remote attachment request shape', () => {
    const request = buildNtfyRequest(notification, 'private-topic')
    expect(request.init).toEqual({
      method: 'POST',
      headers: {
        Title: 'Lucky — New episode',
        'Content-Type': 'text/plain; charset=utf-8',
        Attach: 'https://image.tmdb.org/t/p/w342/lucky.jpg',
        Filename: 'rerun-7.jpg',
      },
      body: 'S1E3 · The Big Score',
    })
    expect(request.init.headers).not.toHaveProperty('Click')
    expect(request.init.headers).not.toHaveProperty('Actions')
    expect(request.init.body).not.toMatch(/Apple|Rerun|tmdb|https?:\/\//i)
  })

  it('omits attachment headers when artwork is missing', () => {
    const request = buildNtfyRequest({ ...notification, attachment: null }, 'topic')
    expect(request.init.headers).not.toHaveProperty('Attach')
    expect(request.init.headers).not.toHaveProperty('Filename')
  })

  it('accepts success and rejects failure without exposing the topic in the error', async () => {
    const okFetch = vi.fn(async () => ({ ok: true }))
    await publishNtfy(notification, { topic: 'secret-topic', fetchImpl: okFetch })
    expect(okFetch).toHaveBeenCalledTimes(1)
    await expect(publishNtfy(notification, {
      topic: 'secret-topic',
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'unavailable' }),
    })).rejects.toThrow('ntfy push failed (503)')
    try {
      await publishNtfy(notification, {
        topic: 'secret-topic',
        fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }),
      })
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
