import { describe, expect, it, vi } from 'vitest'
import { createSubscribeHandler } from './subscribe.js'

function response() {
  return {
    statusCode: null,
    body: null,
    status: vi.fn(function status(code) { this.statusCode = code; return this }),
    setHeader: vi.fn(function setHeader() { return this }),
    json: vi.fn(function json(body) { this.body = body; return this }),
  }
}

function request(body) {
  return { method: 'POST', body, headers: { 'user-agent': 'test-agent' } }
}

function validSubscriptionBody(overrides = {}) {
  return {
    endpoint: 'https://web.push.apple.com/abc',
    keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
    ...overrides,
  }
}

// existingRow: what the lookup-by-endpoint query returns (null for a
// brand-new subscription). Captures the exact upsert payload so tests can
// assert on the two watermark columns without modeling a full Postgrest
// upsert.
function makeSupabaseStub({ existingRow = null, count = 0, upsertResult = [{ preferred_notification_hour_ist: 20 }] } = {}) {
  const upsertCalls = []
  return {
    upsertCalls,
    from(table) {
      if (table !== 'push_subscriptions') throw new Error(`unexpected table ${table}`)
      return {
        select: (columns, opts) => {
          if (opts?.count === 'exact' && opts?.head) {
            return Promise.resolve({ count, error: null })
          }
          return {
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: existingRow, error: null }) }),
          }
        },
        upsert: (payload) => {
          upsertCalls.push(payload)
          return { select: () => Promise.resolve({ data: upsertResult, error: null }) }
        },
      }
    },
  }
}

function baseEnv() {
  return {}
}

describe('subscribe endpoint: two-stage watermark initialization', () => {
  it('a brand-new subscription initializes both watermarks to the same grace-backdated instant', async () => {
    const supabase = makeSupabaseStub({ existingRow: null })
    const handler = createSubscribeHandler({ env: baseEnv(), supabase })
    const res = response()
    const before = Date.now()
    await handler(request(validSubscriptionBody()), res)
    const after = Date.now()

    expect(res.statusCode).toBe(200)
    const payload = supabase.upsertCalls[0]
    expect(payload.automatic_notifications_enabled_at).toBeTruthy()
    expect(payload.airtime_notifications_enabled_at).toBe(payload.automatic_notifications_enabled_at)

    const backdatedMs = new Date(payload.automatic_notifications_enabled_at).getTime()
    const graceWindowMs = 30 * 60 * 1000
    expect(backdatedMs).toBeGreaterThanOrEqual(before - graceWindowMs - 1000)
    expect(backdatedMs).toBeLessThanOrEqual(after - graceWindowMs + 1000)
  })

  it('an already-activated subscription keeps both existing watermarks untouched on re-subscribe', async () => {
    const existingRow = {
      id: 1,
      automatic_notifications_enabled_at: '2026-07-01T00:00:00.000Z',
      airtime_notifications_enabled_at: '2026-07-10T00:00:00.000Z',
    }
    const supabase = makeSupabaseStub({ existingRow })
    const handler = createSubscribeHandler({ env: baseEnv(), supabase })
    const res = response()
    await handler(request(validSubscriptionBody()), res)

    const payload = supabase.upsertCalls[0]
    expect(payload.automatic_notifications_enabled_at).toBe('2026-07-01T00:00:00.000Z')
    expect(payload.airtime_notifications_enabled_at).toBe('2026-07-10T00:00:00.000Z')
  })

  it('an existing row with an automatic watermark but no airtime watermark yet backfills airtime to match it', async () => {
    const existingRow = {
      id: 1,
      automatic_notifications_enabled_at: '2026-07-01T00:00:00.000Z',
      airtime_notifications_enabled_at: null,
    }
    const supabase = makeSupabaseStub({ existingRow })
    const handler = createSubscribeHandler({ env: baseEnv(), supabase })
    const res = response()
    await handler(request(validSubscriptionBody()), res)

    const payload = supabase.upsertCalls[0]
    expect(payload.automatic_notifications_enabled_at).toBe('2026-07-01T00:00:00.000Z')
    expect(payload.airtime_notifications_enabled_at).toBe('2026-07-01T00:00:00.000Z')
  })

  it('a disable-then-re-enable cycle (a fresh row, since disable deletes it) resets both watermarks together', async () => {
    // Disabling deletes the push_subscriptions row entirely (unchanged
    // Phase 1/2 behavior — see Settings' handleDisable), so a later
    // re-enable looks exactly like a brand-new subscription here: no
    // existingRow, both watermarks freshly grace-backdated together.
    const supabase = makeSupabaseStub({ existingRow: null })
    const handler = createSubscribeHandler({ env: baseEnv(), supabase })
    const res = response()
    await handler(request(validSubscriptionBody()), res)

    const payload = supabase.upsertCalls[0]
    expect(payload.airtime_notifications_enabled_at).toBe(payload.automatic_notifications_enabled_at)
  })
})
