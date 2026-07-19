import { describe, expect, it, vi } from 'vitest'
import { createSubscribeHandler } from '../api/push/subscribe.js'
import { createUnsubscribeHandler } from '../api/push/unsubscribe.js'
import { createTestPushHandler, TEST_NOTIFICATION_BODY, TEST_NOTIFICATION_TITLE } from '../api/push/test.js'
import { createPreferencesHandler } from '../api/push/preferences.js'
import { validateSubscriptionPayload } from '../api/push/_validation.js'
import { generateManagementToken, hashManagementToken, managementTokenMatches } from '../api/push/_managementToken.js'

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

// A single generic `rowResult` backs every select().eq().maybeSingle() call
// (existing-endpoint lookup in subscribe.js, token lookup in unsubscribe.js
// and test.js) — each handler only ever makes one such lookup per request,
// so one configurable result per test is enough.
function makeSupabaseStub({
  upsertResult = { data: [{ preferred_notification_hour_ist: 20 }], error: null },
  deleteResult = { error: null },
  rowResult = { data: null, error: null },
  countResult = { count: 0, error: null },
  updateResult = { error: null },
} = {}) {
  const calls = { upsertArgs: null, upsertSelectCols: null, deleteEqCalls: [], selectCalls: [], eqCalls: [], updateArgs: [] }
  return {
    calls,
    from() {
      return {
        upsert: (obj, opts) => {
          calls.upsertArgs = [obj, opts]
          return {
            select: (cols) => {
              calls.upsertSelectCols = cols
              return Promise.resolve(upsertResult)
            },
            then: (onFulfilled, onRejected) => Promise.resolve(upsertResult).then(onFulfilled, onRejected),
          }
        },
        delete: () => ({
          eq: (col, val) => {
            calls.deleteEqCalls.push([col, val])
            return Promise.resolve(deleteResult)
          },
        }),
        update: (obj) => ({
          eq: (col, val) => {
            calls.updateArgs.push([obj, col, val])
            return Promise.resolve(updateResult)
          },
        }),
        select: (cols, opts) => {
          calls.selectCalls.push([cols, opts])
          if (opts?.count === 'exact' && opts?.head) {
            return Promise.resolve(countResult)
          }
          return {
            eq: (col, val) => {
              calls.eqCalls.push([col, val])
              return { maybeSingle: () => Promise.resolve(rowResult) }
            },
          }
        },
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

describe('management token helpers', () => {
  it('generates a URL-safe opaque token', () => {
    const token = generateManagementToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBeGreaterThan(32)
  })

  it('hashes deterministically', () => {
    const token = generateManagementToken()
    expect(hashManagementToken(token)).toBe(hashManagementToken(token))
    expect(hashManagementToken(token)).not.toBe(token)
  })

  it('matches only the correct token against its own hash', () => {
    const token = generateManagementToken()
    const other = generateManagementToken()
    const hash = hashManagementToken(token)
    expect(managementTokenMatches(token, hash)).toBe(true)
    expect(managementTokenMatches(other, hash)).toBe(false)
  })

  it('treats missing/empty token or hash as no match', () => {
    expect(managementTokenMatches('', 'abc')).toBe(false)
    expect(managementTokenMatches(null, 'abc')).toBe(false)
    expect(managementTokenMatches('abc', '')).toBe(false)
    expect(managementTokenMatches('abc', null)).toBe(false)
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

  it('upserts a valid subscription by endpoint and returns a fresh management token', async () => {
    const supabase = makeSupabaseStub()
    const handler = createSubscribeHandler({ supabase })
    const res = response()
    const body = validSubscriptionBody()
    await handler(request({ body, headers: { 'user-agent': 'Rerun-Test/1.0' } }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.success).toBe(true)
    expect(typeof res.body.managementToken).toBe('string')
    expect(res.body.managementToken.length).toBeGreaterThan(32)
    // Lets Settings display the current server-stored value without a
    // separate read endpoint — see api/push/preferences.js and
    // src/routes/Settings.jsx.
    expect(res.body.preferredNotificationHourIst).toBe(20)
    expect(supabase.calls.upsertSelectCols).toBe('preferred_notification_hour_ist')

    const [row, opts] = supabase.calls.upsertArgs
    expect(row).toMatchObject({ endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, user_agent: 'Rerun-Test/1.0' })
    expect(row.management_token_hash).toBe(hashManagementToken(res.body.managementToken))
    expect(opts).toEqual({ onConflict: 'endpoint' })
    // Never resets an already-chosen notification time back to the column
    // default on a re-subscribe — the column is simply absent from the
    // upsert payload.
    expect(row).not.toHaveProperty('preferred_notification_hour_ist')
  })

  it('rejects new subscriptions once the stored-subscription cap is reached', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: null, error: null }, countResult: { count: 20, error: null } })
    const handler = createSubscribeHandler({ supabase })
    const res = response()
    await handler(request({ body: validSubscriptionBody() }), res)
    expect(res.statusCode).toBe(429)
    expect(supabase.calls.upsertArgs).toBeNull()
  })

  it('does not enforce the cap when re-subscribing an already-stored endpoint', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: { id: 1 }, error: null }, countResult: { count: 999, error: null } })
    const handler = createSubscribeHandler({ supabase })
    const res = response()
    await handler(request({ body: validSubscriptionBody() }), res)
    expect(res.statusCode).toBe(200)
    expect(supabase.calls.upsertArgs).not.toBeNull()
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

  describe('Phase 2 activation watermark', () => {
    it('backdates a brand-new subscription by the grace window (no backfill of old episodes)', async () => {
      vi.useFakeTimers()
      vi.setSystemTime('2026-07-19T12:00:00.000Z')
      const supabase = makeSupabaseStub({ rowResult: { data: null, error: null } })
      const handler = createSubscribeHandler({ supabase })
      const res = response()
      await handler(request({ body: validSubscriptionBody() }), res)
      const [row] = supabase.calls.upsertArgs
      expect(row.automatic_notifications_enabled_at).toBe('2026-07-19T11:30:00.000Z')
      vi.useRealTimers()
    })

    it('sets the watermark for an existing Phase 1-only subscription that has never activated', async () => {
      vi.useFakeTimers()
      vi.setSystemTime('2026-07-19T12:00:00.000Z')
      const supabase = makeSupabaseStub({
        rowResult: { data: { id: 1, automatic_notifications_enabled_at: null }, error: null },
      })
      const handler = createSubscribeHandler({ supabase })
      const res = response()
      await handler(request({ body: validSubscriptionBody() }), res)
      const [row] = supabase.calls.upsertArgs
      expect(row.automatic_notifications_enabled_at).toBe('2026-07-19T11:30:00.000Z')
      vi.useRealTimers()
    })

    it('never overwrites an already-set watermark on a later re-subscribe', async () => {
      const supabase = makeSupabaseStub({
        rowResult: { data: { id: 1, automatic_notifications_enabled_at: '2026-01-01T00:00:00.000Z' }, error: null },
      })
      const handler = createSubscribeHandler({ supabase })
      const res = response()
      await handler(request({ body: validSubscriptionBody() }), res)
      const [row] = supabase.calls.upsertArgs
      expect(row.automatic_notifications_enabled_at).toBe('2026-01-01T00:00:00.000Z')
    })
  })
})

describe('POST /api/push/unsubscribe', () => {
  const token = 'a-real-management-token'
  const tokenHash = hashManagementToken(token)

  it('rejects non-POST methods', async () => {
    const handler = createUnsubscribeHandler({ supabase: makeSupabaseStub() })
    const res = response()
    await handler(request({ method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('rejects a missing endpoint', async () => {
    const handler = createUnsubscribeHandler({ supabase: makeSupabaseStub() })
    const res = response()
    await handler(request({ body: { managementToken: token } }), res)
    expect(res.statusCode).toBe(400)
  })

  it('rejects a missing management token', async () => {
    const handler = createUnsubscribeHandler({ supabase: makeSupabaseStub() })
    const res = response()
    await handler(request({ body: { endpoint: 'https://web.push.apple.com/abc123' } }), res)
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 for an endpoint with no stored subscription', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: null, error: null } })
    const handler = createUnsubscribeHandler({ supabase })
    const res = response()
    await handler(request({ body: { endpoint: 'https://web.push.apple.com/abc123', managementToken: token } }), res)
    expect(res.statusCode).toBe(404)
    expect(supabase.calls.deleteEqCalls).toEqual([])
  })

  it('rejects a mismatched management token without deleting the row', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: { management_token_hash: tokenHash }, error: null } })
    const handler = createUnsubscribeHandler({ supabase })
    const res = response()
    await handler(request({ body: { endpoint: 'https://web.push.apple.com/abc123', managementToken: 'wrong-token' } }), res)
    expect(res.statusCode).toBe(403)
    expect(supabase.calls.deleteEqCalls).toEqual([])
  })

  it('deletes the stored row by endpoint when the management token matches', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: { management_token_hash: tokenHash }, error: null } })
    const handler = createUnsubscribeHandler({ supabase })
    const res = response()
    await handler(request({ body: { endpoint: 'https://web.push.apple.com/abc123', managementToken: token } }), res)
    expect(res.statusCode).toBe(200)
    expect(supabase.calls.deleteEqCalls).toEqual([['endpoint', 'https://web.push.apple.com/abc123']])
  })
})

const BASE_ENV = { VITE_VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:owner@example.com' }
const TEST_TOKEN = 'the-owning-installations-token'
const TEST_TOKEN_HASH = hashManagementToken(TEST_TOKEN)

function storedRow(overrides = {}) {
  return {
    endpoint: 'https://web.push.apple.com/abc123',
    p256dh: validKeys().p256dh,
    auth: validKeys().auth,
    management_token_hash: TEST_TOKEN_HASH,
    updated_at: '2020-01-01T00:00:00.000Z',
    last_test_sent_at: null,
    ...overrides,
  }
}

function testRequest(body = {}) {
  return request({ body: { managementToken: TEST_TOKEN, ...body } })
}

describe('POST /api/push/test', () => {
  it('rejects non-POST methods', async () => {
    const handler = createTestPushHandler({ env: BASE_ENV, supabase: makeSupabaseStub() })
    const res = response()
    await handler(request({ method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('rejects a missing management token before touching Supabase or VAPID', async () => {
    const supabase = makeSupabaseStub()
    const setVapidDetails = vi.fn()
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, setVapidDetails })
    const res = response()
    await handler(request({ body: {} }), res)
    expect(res.statusCode).toBe(400)
    expect(setVapidDetails).not.toHaveBeenCalled()
    expect(supabase.calls.selectCalls).toEqual([])
  })

  it('returns 500 when VAPID is not configured, without calling Supabase', async () => {
    const supabase = makeSupabaseStub()
    const handler = createTestPushHandler({ env: {}, supabase })
    const res = response()
    await handler(testRequest(), res)
    expect(res.statusCode).toBe(500)
    expect(supabase.calls.selectCalls).toEqual([])
  })

  it('returns 404 when no subscription matches the management token', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: null, error: null } })
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, setVapidDetails: vi.fn() })
    const res = response()
    await handler(testRequest(), res)
    expect(res.statusCode).toBe(404)
  })

  it('sends the fixed test payload only to the subscription owned by the token, and reports success', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: storedRow(), error: null } })
    const sendNotification = vi.fn().mockResolvedValue(undefined)
    const setVapidDetails = vi.fn()
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, sendNotification, setVapidDetails })
    const res = response()
    await handler(testRequest(), res)

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
    expect(res.body).toEqual({ success: true })
    // Looked up by the caller's own token hash — never a table-wide read.
    expect(supabase.calls.eqCalls).toEqual([['management_token_hash', TEST_TOKEN_HASH]])
  })

  it('never accepts a caller-supplied delivery target', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: storedRow(), error: null } })
    const sendNotification = vi.fn().mockResolvedValue(undefined)
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(testRequest({ endpoint: 'https://evil.example.com/hijack' }), res)
    const [sentSubscription] = sendNotification.mock.calls[0]
    expect(sentSubscription.endpoint).toBe('https://web.push.apple.com/abc123')
  })

  it("never sends to another installation's subscription even if other rows exist", async () => {
    // The stub only ever returns the row matching the queried hash — this
    // asserts the handler queries by hash rather than reading every row.
    const supabase = makeSupabaseStub({ rowResult: { data: storedRow(), error: null } })
    const sendNotification = vi.fn().mockResolvedValue(undefined)
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(testRequest(), res)
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(supabase.calls.selectCalls).toEqual([['*', undefined]])
  })

  it('removes the subscription on a 410 Gone response and reports expiry', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: storedRow(), error: null } })
    const sendNotification = vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }))
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(testRequest(), res)
    expect(res.statusCode).toBe(410)
    expect(supabase.calls.deleteEqCalls).toEqual([['endpoint', 'https://web.push.apple.com/abc123']])
  })

  it('removes the subscription on a 404 Not Found response the same way', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: storedRow(), error: null } })
    const sendNotification = vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { statusCode: 404 }))
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(testRequest(), res)
    expect(res.statusCode).toBe(410)
    expect(supabase.calls.deleteEqCalls).toEqual([['endpoint', 'https://web.push.apple.com/abc123']])
  })

  it('reports a delivery failure without deleting the subscription for a transient error', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: storedRow(), error: null } })
    const sendNotification = vi.fn().mockRejectedValue(Object.assign(new Error('upstream unavailable'), { statusCode: 503 }))
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(testRequest(), res)
    expect(res.statusCode).toBe(502)
    expect(supabase.calls.deleteEqCalls).toEqual([])
  })

  it('rate-limits repeat test sends to the same subscription', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: storedRow({ last_test_sent_at: new Date().toISOString() }), error: null } })
    const sendNotification = vi.fn().mockResolvedValue(undefined)
    const handler = createTestPushHandler({ env: BASE_ENV, supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(testRequest(), res)
    expect(sendNotification).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(429)
  })
})

describe('POST /api/push/preferences', () => {
  it('rejects non-POST methods', async () => {
    const handler = createPreferencesHandler({ supabase: makeSupabaseStub() })
    const res = response()
    await handler(request({ method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('rejects a missing management token before touching Supabase', async () => {
    const supabase = makeSupabaseStub()
    const handler = createPreferencesHandler({ supabase })
    const res = response()
    await handler(request({ body: { preferredNotificationHourIst: 20 } }), res)
    expect(res.statusCode).toBe(400)
    expect(supabase.calls.selectCalls).toEqual([])
  })

  it.each([18, 19, 20, 21, 22, 23])('accepts integer hour %i', async (hour) => {
    const supabase = makeSupabaseStub({ rowResult: { data: { id: 7 }, error: null } })
    const handler = createPreferencesHandler({ supabase })
    const res = response()
    await handler(request({ body: { managementToken: TEST_TOKEN, preferredNotificationHourIst: hour } }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: true, preferredNotificationHourIst: hour })
  })

  it('rejects 17 (below the allowed range) without touching Supabase', async () => {
    const supabase = makeSupabaseStub()
    const handler = createPreferencesHandler({ supabase })
    const res = response()
    await handler(request({ body: { managementToken: TEST_TOKEN, preferredNotificationHourIst: 17 } }), res)
    expect(res.statusCode).toBe(400)
    expect(supabase.calls.selectCalls).toEqual([])
  })

  it('rejects 24 (above the allowed range) without touching Supabase', async () => {
    const supabase = makeSupabaseStub()
    const handler = createPreferencesHandler({ supabase })
    const res = response()
    await handler(request({ body: { managementToken: TEST_TOKEN, preferredNotificationHourIst: 24 } }), res)
    expect(res.statusCode).toBe(400)
    expect(supabase.calls.selectCalls).toEqual([])
  })

  it('rejects strings, floats, null, and a missing hour', async () => {
    const supabase = makeSupabaseStub()
    const handler = createPreferencesHandler({ supabase })
    for (const bad of ['20', 20.5, null]) {
      const res = response()
      await handler(request({ body: { managementToken: TEST_TOKEN, preferredNotificationHourIst: bad } }), res)
      expect(res.statusCode).toBe(400)
    }
    const missingRes = response()
    await handler(request({ body: { managementToken: TEST_TOKEN } }), missingRes)
    expect(missingRes.statusCode).toBe(400)
    expect(supabase.calls.selectCalls).toEqual([])
  })

  it('requires ownership: an unrecognized token returns 404 and never updates', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: null, error: null } })
    const handler = createPreferencesHandler({ supabase })
    const res = response()
    await handler(request({ body: { managementToken: 'someone-elses-token', preferredNotificationHourIst: 21 } }), res)
    expect(res.statusCode).toBe(404)
    expect(supabase.calls.updateArgs).toEqual([])
  })

  it("resolves exactly one subscription by management-token hash, so an invalid token can never reach another subscription's row", async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: { id: 7 }, error: null } })
    const handler = createPreferencesHandler({ supabase })
    const res = response()
    await handler(request({ body: { managementToken: TEST_TOKEN, preferredNotificationHourIst: 22 } }), res)
    expect(supabase.calls.eqCalls).toEqual([['management_token_hash', TEST_TOKEN_HASH]])
    expect(supabase.calls.updateArgs).toEqual([
      [{ preferred_notification_hour_ist: 22, updated_at: expect.any(String) }, 'id', 7],
    ])
  })

  it('never rotates the management token — only preferred_notification_hour_ist and updated_at are written', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: { id: 7 }, error: null } })
    const handler = createPreferencesHandler({ supabase })
    const res = response()
    await handler(request({ body: { managementToken: TEST_TOKEN, preferredNotificationHourIst: 22 } }), res)
    const [updateObj] = supabase.calls.updateArgs[0]
    expect(Object.keys(updateObj).sort()).toEqual(['preferred_notification_hour_ist', 'updated_at'])
    expect(res.body).toEqual({ success: true, preferredNotificationHourIst: 22 })
  })

  it('returns only success and the hour — never a subscription endpoint or push keys', async () => {
    const supabase = makeSupabaseStub({ rowResult: { data: { id: 7 }, error: null } })
    const handler = createPreferencesHandler({ supabase })
    const res = response()
    await handler(request({ body: { managementToken: TEST_TOKEN, preferredNotificationHourIst: 22 } }), res)
    expect(Object.keys(res.body).sort()).toEqual(['preferredNotificationHourIst', 'success'])
  })

  it('returns 500 without leaking details when the update fails', async () => {
    const supabase = makeSupabaseStub({
      rowResult: { data: { id: 7 }, error: null },
      updateResult: { error: { message: 'db exploded' } },
    })
    const handler = createPreferencesHandler({ supabase })
    const res = response()
    await handler(request({ body: { managementToken: TEST_TOKEN, preferredNotificationHourIst: 22 } }), res)
    expect(res.statusCode).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('db exploded')
  })
})
