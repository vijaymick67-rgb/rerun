import { describe, expect, it, vi } from 'vitest'
import { createSubscribeHandler } from '../api/push/subscribe.js'
import { createUnsubscribeHandler } from '../api/push/unsubscribe.js'
import { createTestPushHandler, TEST_NOTIFICATION_BODY, TEST_NOTIFICATION_TITLE } from '../api/push/test.js'
import { validateSubscriptionPayload } from '../api/push/_validation.js'

function response() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    status: vi.fn(function status(code) { this.statusCode = code; return this }),
    setHeader: vi.fn(function setHeader(name, value) { this.headers[name] = value; return this }),
    json: vi.fn(function json(body) { this.body = body; return this }),
  }
}

function request({ method = 'POST', body = {}, headers = {} } = {}) {
  return { method, body, headers }
}

function validKeys() {
  const p256dh = Buffer.from(new Uint8Array(65).fill(4))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const auth = Buffer.from(new Uint8Array(16).fill(1))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return { p256dh, auth }
}

function validSubscriptionBody(endpoint = 'https://web.push.apple.com/abc123') {
  return { endpoint, keys: validKeys() }
}

function makeSupabaseStub({
  upsertResult = { error: null },
  deleteResult = { error: null },
  selectResult = { data: [], error: null },
  updateResult = { error: null },
} = {}) {
  const calls = { upsertArgs: null, deleteEqCalls: [], selectOrderArgs: null, updateArgs: [] }
  return {
    calls,
    from() {
      return {
        upsert: (obj, opts) => {
          calls.upsertArgs = [obj, opts]
          return Promise.resolve(upsertResult)
        },
        delete: () => ({
          eq: (col, val) => {
            calls.deleteEqCalls.push([col, val])
            return Promise.resolve(deleteResult)
          },
        }),
        select: (cols) => ({
          order: (col, opts) => {
            calls.selectOrderArgs = [cols, col, opts]
            return Promise.resolve(selectResult)
          },
        }),
        update: (obj) => ({
          eq: (col, val) => {
            calls.updateArgs.push([obj, col, val])
            return Promise.resolve(updateResult)
          },
        }),
      }
    },
  }
}

describe('validateSubscriptionPayload', () => {
  it('accepts a well-formed subscription', () => {
    expect(validateSubscriptionPayload(validSubscriptionBody()).valid).toBe(true)
  })

  it('rejects a missing payload', () => {
    expect(validateSubscriptionPayload(null).valid).toBe(false)
    expect(validateSubscriptionPayload(undefined).valid).toBe(false)
  })

  it('rejects a non-https endpoint', () => {
    const body = validSubscriptionBody('http://web.push.apple.com/abc123')
    expect(validateSubscriptionPayload(body).valid).toBe(false)
  })

  it('rejects an endpoint from an unrecognized push service host (SSRF guard)', () => {
    const body = validSubscriptionBody('https://evil.example.com/abc123')
    expect(validateSubscriptionPayload(body).valid).toBe(false)
  })

  it('rejects malformed or wrong-length key material', () => {
    expect(validateSubscriptionPayload({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'short', auth: validKeys().auth } }).valid).toBe(false)
    expect(validateSubscriptionPayload({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: validKeys().p256dh, auth: 'short' } }).valid).toBe(false)
    expect(validateSubscriptionPayload({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'not base64url!!', auth: validKeys().auth } }).valid).toBe(false)
  })

  it('rejects a payload with missing keys object', () => {
    expect(validateSubscriptionPayload({ endpoint: 'https://fcm.googleapis.com/fcm/send/x' }).valid).toBe(false)
  })
})

describe('POST /api/push/subscribe', () => {
  it('rejects non-POST methods', async () => {
    const handler = createSubscribeHandler({ supabase: makeSupabaseStub() })
    const res = response()
    await handler(request({ method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('rejects a malformed subscription payload without writing to Supabase', async () => {
    const supabase = makeSupabaseStub()
    const handler = createSubscribeHandler({ supabase })
    const res = response()
    await handler(request({ body: { endpoint: 'not-a-url' } }), res)
    expect(res.statusCode).toBe(400)
    expect(supabase.calls.upsertArgs).toBeNull()
  })

  it('upserts a valid subscription by endpoint', async () => {
    const supabase = makeSupabaseStub()
    const handler = createSubscribeHandler({ supabase })
    const res = response()
    const body = validSubscriptionBody()
    await handler(request({ body, headers: { 'user-agent': 'Rerun-Test/1.0' } }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: true })
    const [row, opts] = supabase.calls.upsertArgs
    expect(row).toMatchObject({ endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, user_agent: 'Rerun-Test/1.0' })
    expect(opts).toEqual({ onConflict: 'endpoint' })
  })

  it('returns 500 without leaking details when Supabase write fails', async () => {
    const supabase = makeSupabaseStub({ upsertResult: { error: { message: 'db exploded' } } })
    const handler = createSubscribeHandler({ supabase })
    const res = response()
    await handler(request({ body: validSubscriptionBody() }), res)
    expect(res.statusCode).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('db exploded')
  })

  it('returns 500 when server credentials are not configured', async () => {
    const handler = createSubscribeHandler({ env: {} })
    const res = response()
    await handler(request({ body: validSubscriptionBody() }), res)
    expect(res.statusCode).toBe(500)
  })
})

describe('POST /api/push/unsubscribe', () => {
  it('rejects non-POST methods', async () => {
    const handler = createUnsubscribeHandler({ supabase: makeSupabaseStub() })
    const res = response()
    await handler(request({ method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('rejects a missing endpoint', async () => {
    const handler = createUnsubscribeHandler({ supabase: makeSupabaseStub() })
    const res = response()
    await handler(request({ body: {} }), res)
    expect(res.statusCode).toBe(400)
  })

  it('deletes the stored row by endpoint', async () => {
    const supabase = makeSupabaseStub()
    const handler = createUnsubscribeHandler({ supabase })
    const res = response()
    await handler(request({ body: { endpoint: 'https://web.push.apple.com/abc123' } }), res)
    expect(res.statusCode).toBe(200)
    expect(supabase.calls.deleteEqCalls).toEqual([['endpoint', 'https://web.push.apple.com/abc123']])
  })
})

const BASE_ENV = { VITE_VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:owner@example.com' }

function storedRow(overrides = {}) {
  return {
    endpoint: 'https://web.push.apple.com/abc123',
    p256dh: validKeys().p256dh,
    auth: validKeys().auth,
    updated_at: '2020-01-01T00:00:00.000Z',
    last_test_sent_at: null,
    ...overrides,
  }
}

describe('POST /api/push/test', () => {
  it('rejects non-POST methods', async () => {
    const handler = createTestPushHandler({ env: BASE_ENV, supabase: makeSupabaseStub() })
    const res = response()
    await handler(request({ method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('returns 500 when VAPID is not configured, without calling Supabase', async () => {
    const supabase = makeSupabaseStub()
    const handler = createTestPushHandler({ env: {}, supabase })
    const res = response()
    await handler(request(), res)
    expect(res.statusCode).toBe(500)
    expect(supabase.calls.selectOrderArgs).toBeNull()
  })

  it('returns 404 when there is no stored subscription', async () => {
    const supabase = makeSupabaseStub({ selectResult: { data: [], error: null } })
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, setVapidDetails: vi.fn() })
    const res = response()
    await handler(request(), res)
    expect(res.statusCode).toBe(404)
  })

  it('sends the fixed test payload to the stored subscription and reports success', async () => {
    const supabase = makeSupabaseStub({ selectResult: { data: [storedRow()], error: null } })
    const sendNotification = vi.fn().mockResolvedValue(undefined)
    const setVapidDetails = vi.fn()
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, sendNotification, setVapidDetails })
    const res = response()
    await handler(request(), res)

    expect(setVapidDetails).toHaveBeenCalledWith('mailto:owner@example.com', 'pub', 'priv')
    expect(sendNotification).toHaveBeenCalledTimes(1)
    const [sentSubscription, payload] = sendNotification.mock.calls[0]
    expect(sentSubscription).toEqual({
      endpoint: 'https://web.push.apple.com/abc123',
      keys: { p256dh: validKeys().p256dh, auth: validKeys().auth },
    })
    const parsed = JSON.parse(payload)
    expect(parsed).toEqual({ title: TEST_NOTIFICATION_TITLE, body: TEST_NOTIFICATION_BODY, url: '/watching' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: true, sent: 1, staleRemoved: 0 })
  })

  it('never accepts a caller-supplied delivery target', async () => {
    const supabase = makeSupabaseStub({ selectResult: { data: [storedRow()], error: null } })
    const sendNotification = vi.fn().mockResolvedValue(undefined)
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(request({ body: { endpoint: 'https://evil.example.com/hijack' } }), res)
    const [sentSubscription] = sendNotification.mock.calls[0]
    expect(sentSubscription.endpoint).toBe('https://web.push.apple.com/abc123')
  })

  it('removes the subscription on a 410 Gone response and reports expiry', async () => {
    const supabase = makeSupabaseStub({ selectResult: { data: [storedRow()], error: null } })
    const sendNotification = vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }))
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(request(), res)
    expect(res.statusCode).toBe(410)
    expect(supabase.calls.deleteEqCalls).toEqual([['endpoint', 'https://web.push.apple.com/abc123']])
  })

  it('removes the subscription on a 404 Not Found response the same way', async () => {
    const supabase = makeSupabaseStub({ selectResult: { data: [storedRow()], error: null } })
    const sendNotification = vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { statusCode: 404 }))
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(request(), res)
    expect(res.statusCode).toBe(410)
    expect(supabase.calls.deleteEqCalls).toEqual([['endpoint', 'https://web.push.apple.com/abc123']])
  })

  it('reports a delivery failure without deleting the subscription for a transient error', async () => {
    const supabase = makeSupabaseStub({ selectResult: { data: [storedRow()], error: null } })
    const sendNotification = vi.fn().mockRejectedValue(Object.assign(new Error('upstream unavailable'), { statusCode: 503 }))
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(request(), res)
    expect(res.statusCode).toBe(502)
    expect(supabase.calls.deleteEqCalls).toEqual([])
  })

  it('rate-limits repeat test sends to the same subscription', async () => {
    const recentRow = storedRow({ last_test_sent_at: new Date().toISOString() })
    const supabase = makeSupabaseStub({ selectResult: { data: [recentRow], error: null } })
    const sendNotification = vi.fn().mockResolvedValue(undefined)
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(request(), res)
    expect(sendNotification).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(429)
  })
})
