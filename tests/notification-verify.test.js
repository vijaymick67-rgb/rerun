import { describe, expect, it, vi } from 'vitest'
import {
  createVerifyNotificationHandler,
  SYNTHETIC_EPISODE,
  SYNTHETIC_SHOW_NAME,
  SYNTHETIC_TMDB_SHOW_ID,
} from '../api/notifications/verify.js'
import { hashManagementToken } from '../api/push/_managementToken.js'

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

function request({ method = 'POST', body = { managementToken: 'a-token' } } = {}) {
  return { method, body }
}

function baseEnv() {
  return {
    VITE_VAPID_PUBLIC_KEY: 'public-key',
    VAPID_PRIVATE_KEY: 'private-key',
    VAPID_SUBJECT: 'mailto:owner@example.com',
  }
}

function makeSupabaseStub({ rowResult, updateResult = { error: null }, deleteResult = { error: null } } = {}) {
  const calls = { updateArgs: [], deleteEqCalls: [] }
  return {
    calls,
    from() {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve(rowResult) }),
        }),
        update: (obj) => ({
          eq: (col, val) => {
            calls.updateArgs.push([obj, col, val])
            return Promise.resolve(updateResult)
          },
        }),
        delete: () => ({
          eq: (col, val) => {
            calls.deleteEqCalls.push([col, val])
            return Promise.resolve(deleteResult)
          },
        }),
      }
    },
  }
}

describe('notification verify endpoint', () => {
  it('rejects non-POST methods', async () => {
    const handler = createVerifyNotificationHandler({ env: baseEnv(), supabase: makeSupabaseStub(), setVapidDetails: vi.fn() })
    const res = response()
    await handler(request({ method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('rejects a missing management token', async () => {
    const handler = createVerifyNotificationHandler({ env: baseEnv(), supabase: makeSupabaseStub(), setVapidDetails: vi.fn() })
    const res = response()
    await handler(request({ body: {} }), res)
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 when no subscription matches the token', async () => {
    const handler = createVerifyNotificationHandler({
      env: baseEnv(), supabase: makeSupabaseStub({ rowResult: { data: null, error: null } }), setVapidDetails: vi.fn(),
    })
    const res = response()
    await handler(request(), res)
    expect(res.statusCode).toBe(404)
  })

  it('sends a synthetic verification push through the real payload builder', async () => {
    const row = {
      endpoint: 'https://web.push.apple.com/abc',
      p256dh: 'p256dh-key',
      auth: 'auth-key',
      management_token_hash: hashManagementToken('a-token'),
      last_test_sent_at: null,
    }
    const supabase = makeSupabaseStub({ rowResult: { data: row, error: null } })
    const sendNotification = vi.fn(async () => undefined)
    const handler = createVerifyNotificationHandler({ env: baseEnv(), supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(request(), res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: true, synthetic: true })
    const [target, payloadJson] = sendNotification.mock.calls[0]
    expect(target).toEqual({ endpoint: row.endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } })
    const payload = JSON.parse(payloadJson)
    // Same minimal content shape a real episode notification uses, but the
    // title stays visibly "Rerun Verification" — never a real show name —
    // so a synthetic push can never be mistaken for a real one.
    expect(payload.title).toBe(SYNTHETIC_SHOW_NAME)
    expect(payload.body).toBe('New Episode')
    expect(SYNTHETIC_EPISODE.name).toBe('Verification episode') // still distinguishable in logs/fixtures, just not in the payload
    // A synthetic, never-real show falls back to /watching, not a dead detail route.
    expect(payload.url).toBe('/watching')
    expect(payload.tag).toBe(`rerun-episode-${SYNTHETIC_TMDB_SHOW_ID}-s1e1`)
  })

  it('throttles repeat verification the same way as the Phase 1 manual test', async () => {
    const row = {
      endpoint: 'https://web.push.apple.com/abc',
      p256dh: 'p256dh-key',
      auth: 'auth-key',
      management_token_hash: hashManagementToken('a-token'),
      last_test_sent_at: new Date().toISOString(),
    }
    const supabase = makeSupabaseStub({ rowResult: { data: row, error: null } })
    const sendNotification = vi.fn(async () => undefined)
    const handler = createVerifyNotificationHandler({ env: baseEnv(), supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(request(), res)
    expect(res.statusCode).toBe(429)
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('removes the subscription and returns 410 on a stale push service response', async () => {
    const row = {
      endpoint: 'https://web.push.apple.com/abc',
      p256dh: 'p256dh-key',
      auth: 'auth-key',
      management_token_hash: hashManagementToken('a-token'),
      last_test_sent_at: null,
    }
    const supabase = makeSupabaseStub({ rowResult: { data: row, error: null } })
    const sendNotification = vi.fn(async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }) })
    const handler = createVerifyNotificationHandler({ env: baseEnv(), supabase, sendNotification, setVapidDetails: vi.fn() })
    const res = response()
    await handler(request(), res)
    expect(res.statusCode).toBe(410)
    expect(supabase.calls.deleteEqCalls).toEqual([['endpoint', row.endpoint]])
  })

  it('never leaks the raw Supabase error message on a lookup failure', async () => {
    const handler = createVerifyNotificationHandler({
      env: baseEnv(),
      supabase: makeSupabaseStub({
        rowResult: { data: null, error: { message: 'internal: SUPABASE_SERVICE_ROLE_KEY=abc VAPID_PRIVATE_KEY=xyz' } },
      }),
      setVapidDetails: vi.fn(),
    })
    const res = response()
    await handler(request(), res)
    expect(res.statusCode).toBe(500)
    expect(JSON.stringify(res.body)).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|VAPID_PRIVATE_KEY|abc|xyz/)
  })
})
