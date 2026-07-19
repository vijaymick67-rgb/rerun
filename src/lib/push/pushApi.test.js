import { describe, expect, it, vi } from 'vitest'
import { sendTestPush, subscribePush, unsubscribePush } from './pushApi.js'

function fakeFetch(status, body) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

describe('subscribePush', () => {
  it('POSTs the subscription JSON to /api/push/subscribe', async () => {
    const fetchImpl = fakeFetch(200, { success: true })
    const subscription = { toJSON: () => ({ endpoint: 'https://example.test/1', keys: { p256dh: 'a', auth: 'b' } }) }
    const result = await subscribePush(subscription, fetchImpl)
    expect(result).toEqual({ success: true })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/push/subscribe',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://example.test/1', keys: { p256dh: 'a', auth: 'b' } }),
      }),
    )
  })

  it('throws the server error message on failure', async () => {
    const fetchImpl = fakeFetch(400, { error: 'Invalid subscription endpoint' })
    const subscription = { toJSON: () => ({ endpoint: 'bad' }) }
    await expect(subscribePush(subscription, fetchImpl)).rejects.toThrow('Invalid subscription endpoint')
  })
})

describe('unsubscribePush', () => {
  it('POSTs the endpoint and management token to /api/push/unsubscribe', async () => {
    const fetchImpl = fakeFetch(200, { success: true })
    await unsubscribePush('https://example.test/1', 'a-management-token', fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/push/unsubscribe',
      expect.objectContaining({
        body: JSON.stringify({ endpoint: 'https://example.test/1', managementToken: 'a-management-token' }),
      }),
    )
  })
})

describe('sendTestPush', () => {
  it('POSTs the management token to /api/push/test with no caller-supplied delivery target', async () => {
    const fetchImpl = fakeFetch(200, { success: true })
    const result = await sendTestPush('a-management-token', fetchImpl)
    expect(result).toEqual({ success: true })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/push/test',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ managementToken: 'a-management-token' }) }),
    )
  })

  it('surfaces a generic error when the response has no JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json')
      },
    })
    await expect(sendTestPush('a-management-token', fetchImpl)).rejects.toThrow('Request failed (502)')
  })
})
