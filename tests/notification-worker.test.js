import { describe, expect, it, vi } from 'vitest'
import { createNotificationWorkerHandler } from '../api/notifications/run.js'
import { EPISODE_NOTIFICATION_TYPE } from '../src/lib/notifications/episodeEligibility.js'

const SECRET = 'test-worker-secret'
const EVALUATION_TIME = new Date('2026-07-20T00:00:00.000Z')

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

function request({ method = 'POST', body = {}, headers = { authorization: `Bearer ${SECRET}` } } = {}) {
  return { method, body, headers }
}

function baseEnv(overrides = {}) {
  return {
    NOTIFICATION_WORKER_SECRET: SECRET,
    VITE_VAPID_PUBLIC_KEY: 'public-key',
    VAPID_PRIVATE_KEY: 'private-key',
    VAPID_SUBJECT: 'mailto:owner@example.com',
    TMDB_API_KEY: 'tmdb-key',
    ...overrides,
  }
}

// A minimal chainable+thenable Postgrest-style query builder. `resolve(calls)`
// is invoked once the query is awaited (or .maybeSingle()'d), receiving the
// full recorded call sequence for that one `.from(table)` chain so a single
// resolver can branch on which columns/filters were actually asked for.
function makeQueryBuilder(resolveResult) {
  const calls = []
  const builder = {
    select: (...args) => { calls.push(['select', args]); return builder },
    not: (...args) => { calls.push(['not', args]); return builder },
    in: (...args) => { calls.push(['in', args]); return builder },
    order: (...args) => { calls.push(['order', args]); return builder },
    range: (...args) => { calls.push(['range', args]); return builder },
    eq: (...args) => { calls.push(['eq', args]); return builder },
    update: (...args) => { calls.push(['update', args]); return builder },
    delete: (...args) => { calls.push(['delete', args]); return builder },
    maybeSingle: () => Promise.resolve(resolveResult(calls)),
    then: (onFulfilled, onRejected) => Promise.resolve(resolveResult(calls)).then(onFulfilled, onRejected),
  }
  return builder
}

function makeSupabaseStub({
  subscriptions = [],
  trackedShows = [],
  watchedRows = [],
  claim = () => ({ data: [], error: null }),
  onDelete = () => {},
  onDeliveredUpdate = () => {},
} = {}) {
  const record = { deletes: [], deliveredUpdates: [], rpcCalls: [] }
  return {
    record,
    from(table) {
      return makeQueryBuilder((calls) => {
        if (table === 'push_subscriptions') {
          const deleteCall = calls.find((c) => c[0] === 'delete')
          if (deleteCall) {
            const eqCall = calls.find((c) => c[0] === 'eq')
            record.deletes.push(eqCall[1])
            onDelete(eqCall[1])
            return { error: null }
          }
          return { data: subscriptions, error: null }
        }
        if (table === 'tracked_shows') return { data: trackedShows, error: null }
        if (table === 'watched_episodes') return { data: watchedRows, error: null }
        if (table === 'notification_deliveries') {
          const updateCall = calls.find((c) => c[0] === 'update')
          const inCall = calls.find((c) => c[0] === 'in')
          const entry = [updateCall[1][0], inCall[1][1]]
          record.deliveredUpdates.push(entry)
          onDeliveredUpdate(...entry)
          return { error: null }
        }
        return { data: null, error: null }
      })
    },
    rpc(name, args) {
      record.rpcCalls.push([name, args])
      return Promise.resolve(claim(args))
    },
  }
}

function subscriptionRow(overrides = {}) {
  return {
    id: 1,
    endpoint: 'https://web.push.apple.com/abc',
    p256dh: 'p256dh-key',
    auth: 'auth-key',
    automatic_notifications_enabled_at: '2026-07-17T00:00:00.000Z',
    ...overrides,
  }
}

function trackedShow(overrides = {}) {
  return { tmdb_id: 1, name: 'Test Show', ...overrides }
}

// One season, one already-aired (well before EVALUATION_TIME and the
// watermark) episode, on a mapped platform so classifyReleasePlatform
// resolves deterministically instead of falling to the 'unknown' default.
function tmdbStubClient({ showsById = {} } = {}) {
  return {
    getShowDetails: vi.fn(async (tmdbId) => {
      const show = showsById[tmdbId]
      if (show?.detailsError) throw new Error('tmdb details down')
      return {
        id: tmdbId,
        name: show?.name ?? 'Unknown',
        status: 'Returning Series',
        networks: ['Netflix'],
        seasons: [{ season_number: 1, episode_count: (show?.episodes ?? []).length }],
        next_episode_to_air: null,
        last_episode_to_air: null,
      }
    }),
    getSeasonEpisodes: vi.fn(async (tmdbId, seasonNumber) => ({
      season_number: seasonNumber,
      episodes: showsById[tmdbId]?.episodes ?? [],
    })),
    getExternalIds: vi.fn(async () => ({ imdb_id: null })),
  }
}

function tvmazeStubClient() {
  return { getShowReleaseMap: vi.fn(async () => ({})) }
}

function makeHandler({ env = baseEnv(), supabase, showsById = {}, sendNotification, ...rest } = {}) {
  return createNotificationWorkerHandler({
    env,
    supabase,
    now: () => EVALUATION_TIME,
    createTmdbClient: () => tmdbStubClient({ showsById }),
    createTvmazeClient: () => tvmazeStubClient(),
    sendNotification: sendNotification ?? vi.fn(async () => undefined),
    setVapidDetails: vi.fn(),
    ...rest,
  })
}

const AIRED_EPISODE = { episode_number: 1, name: 'Pilot', air_date: '2026-07-18', runtime: 50 }

describe('notification worker: request handling', () => {
  it('rejects non-POST methods', async () => {
    const handler = makeHandler({ supabase: makeSupabaseStub() })
    const res = response()
    await handler(request({ method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
    expect(res.headers.Allow).toBe('POST')
  })

  it('returns 500 without leaking details when the worker secret is not configured', async () => {
    const handler = makeHandler({ env: baseEnv({ NOTIFICATION_WORKER_SECRET: undefined }), supabase: makeSupabaseStub() })
    const res = response()
    await handler(request(), res)
    expect(res.statusCode).toBe(500)
    expect(JSON.stringify(res.body)).not.toMatch(/secret/i)
  })

  it('rejects a missing Authorization header', async () => {
    const handler = makeHandler({ supabase: makeSupabaseStub() })
    const res = response()
    await handler(request({ headers: {} }), res)
    expect(res.statusCode).toBe(401)
  })

  it('rejects a wrong worker secret', async () => {
    const handler = makeHandler({ supabase: makeSupabaseStub() })
    const res = response()
    await handler(request({ headers: { authorization: 'Bearer wrong-secret' } }), res)
    expect(res.statusCode).toBe(401)
  })

  it('never returns VAPID/service-role secrets or internal stack traces', async () => {
    const handler = makeHandler({
      supabase: { from: () => { throw new Error('boom: SUPABASE_SERVICE_ROLE_KEY=abc123 VAPID_PRIVATE_KEY=xyz') } },
    })
    const res = response()
    await handler(request(), res)
    const text = JSON.stringify(res.body)
    expect(text).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|VAPID_PRIVATE_KEY|abc123|xyz/)
  })
})

describe('notification worker: no active subscriptions', () => {
  it('short-circuits with a zeroed summary and does not touch tracked shows', async () => {
    const supabase = makeSupabaseStub({ subscriptions: [] })
    const handler = makeHandler({ supabase })
    const res = response()
    await handler(request(), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ checkedShows: 0, eligibleEpisodes: 0, sent: 0, skipped: 0, staleRemoved: 0, failed: 0 })
  })
})

describe('notification worker: happy path', () => {
  it('claims, sends, and marks a newly-eligible episode delivered', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = makeSupabaseStub({
      subscriptions: [subscriptionRow()],
      trackedShows: [trackedShow()],
      claim: (args) => ({
        data: args.p_episodes.map((e) => ({
          season_number: e.season_number, episode_number: e.episode_number, notification_type: e.notification_type,
        })),
        error: null,
      }),
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification })
    const res = response()
    await handler(request(), res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ checkedShows: 1, eligibleEpisodes: 1, sent: 1, skipped: 0, staleRemoved: 0, failed: 0 })
    expect(sendNotification).toHaveBeenCalledTimes(1)
    const [target, payload] = sendNotification.mock.calls[0]
    expect(target).toEqual({ endpoint: subscriptionRow().endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } })
    const parsed = JSON.parse(payload)
    expect(parsed).toEqual({
      title: 'Test Show — New episode available',
      body: 'S1E1 · Pilot',
      url: '/watching/1',
      tag: 'rerun-episode-1-s1e1',
    })
    expect(supabase.record.deliveredUpdates).toHaveLength(1)
    const [updateBody, identities] = supabase.record.deliveredUpdates[0]
    expect(updateBody.delivered_at).toBe(EVALUATION_TIME.toISOString())
    expect(identities).toEqual([`1:1:1:1:${EPISODE_NOTIFICATION_TYPE}`])
  })

  it('an episode released before the subscription watermark is not eligible (no backfill)', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [{ ...AIRED_EPISODE, air_date: '2026-01-01' }] } }
    const supabase = makeSupabaseStub({
      subscriptions: [subscriptionRow({ automatic_notifications_enabled_at: '2026-07-19T00:00:00.000Z' })],
      trackedShows: [trackedShow()],
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification })
    const res = response()
    await handler(request(), res)
    expect(res.body).toEqual({ checkedShows: 1, eligibleEpisodes: 0, sent: 0, skipped: 0, staleRemoved: 0, failed: 0 })
    expect(sendNotification).not.toHaveBeenCalled()
    expect(supabase.record.rpcCalls).toHaveLength(0)
  })

  it('groups multiple same-season episodes into one batch notification', async () => {
    const showsById = {
      1: {
        name: 'Test Show',
        episodes: [AIRED_EPISODE, { episode_number: 2, name: 'Second', air_date: '2026-07-18', runtime: 50 }],
      },
    }
    const supabase = makeSupabaseStub({
      subscriptions: [subscriptionRow()],
      trackedShows: [trackedShow()],
      claim: (args) => ({
        data: args.p_episodes.map((e) => ({
          season_number: e.season_number, episode_number: e.episode_number, notification_type: e.notification_type,
        })),
        error: null,
      }),
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification })
    const res = response()
    await handler(request(), res)
    expect(res.body.sent).toBe(1)
    expect(res.body.eligibleEpisodes).toBe(2)
    const parsed = JSON.parse(sendNotification.mock.calls[0][1])
    expect(parsed.title).toBe('Test Show — 2 new episodes available')
    expect(parsed.body).toBe('Season 1 is ready')
    expect(parsed.tag).toBe('rerun-episode-1-batch')
  })
})

describe('notification worker: dedup / concurrency safety', () => {
  it('a claim already taken by another invocation is counted as skipped, never sent', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = makeSupabaseStub({
      subscriptions: [subscriptionRow()],
      trackedShows: [trackedShow()],
      claim: () => ({ data: [], error: null }), // nothing returned = already claimed/delivered
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification })
    const res = response()
    await handler(request(), res)
    expect(res.body).toEqual({ checkedShows: 1, eligibleEpisodes: 1, sent: 0, skipped: 1, staleRemoved: 0, failed: 0 })
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('rerunning the worker at the same evaluation time produces no duplicate sends', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    let delivered = false
    const supabase = makeSupabaseStub({
      subscriptions: [subscriptionRow()],
      trackedShows: [trackedShow()],
      claim: (args) => {
        if (delivered) return { data: [], error: null }
        return {
          data: args.p_episodes.map((e) => ({
            season_number: e.season_number, episode_number: e.episode_number, notification_type: e.notification_type,
          })),
          error: null,
        }
      },
    })
    const sendNotification = vi.fn(async () => { delivered = true })
    const handler = makeHandler({ supabase, showsById, sendNotification })

    const first = response()
    await handler(request(), first)
    const second = response()
    await handler(request(), second)

    expect(first.body.sent).toBe(1)
    expect(second.body.sent).toBe(0)
    expect(second.body.skipped).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })
})

describe('notification worker: stale subscription cleanup', () => {
  it('removes a subscription on a 404/410 from web-push and continues the run', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = makeSupabaseStub({
      subscriptions: [subscriptionRow({ id: 9 })],
      trackedShows: [trackedShow()],
      claim: (args) => ({
        data: args.p_episodes.map((e) => ({
          season_number: e.season_number, episode_number: e.episode_number, notification_type: e.notification_type,
        })),
        error: null,
      }),
    })
    const err = Object.assign(new Error('gone'), { statusCode: 410 })
    const sendNotification = vi.fn(async () => { throw err })
    const handler = makeHandler({ supabase, showsById, sendNotification })
    const res = response()
    await handler(request(), res)

    expect(res.body).toEqual({ checkedShows: 1, eligibleEpisodes: 1, sent: 0, skipped: 0, staleRemoved: 1, failed: 0 })
    expect(supabase.record.deletes).toEqual([['id', 9]])
  })

  it('a transient (non-404/410) send failure counts as failed, not staleRemoved, and the subscription is not deleted', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = makeSupabaseStub({
      subscriptions: [subscriptionRow()],
      trackedShows: [trackedShow()],
      claim: (args) => ({
        data: args.p_episodes.map((e) => ({
          season_number: e.season_number, episode_number: e.episode_number, notification_type: e.notification_type,
        })),
        error: null,
      }),
    })
    const sendNotification = vi.fn(async () => { throw new Error('temporary network blip') })
    const handler = makeHandler({ supabase, showsById, sendNotification })
    const res = response()
    await handler(request(), res)
    expect(res.body).toEqual({ checkedShows: 1, eligibleEpisodes: 1, sent: 0, skipped: 0, staleRemoved: 0, failed: 1 })
    expect(supabase.record.deletes).toEqual([])
  })
})

describe('notification worker: isolation between shows and subscriptions', () => {
  it("one show's TMDB failure does not prevent another show's notification", async () => {
    const showsById = {
      1: { name: 'Broken Show', detailsError: true },
      2: { name: 'Good Show', episodes: [AIRED_EPISODE] },
    }
    const supabase = makeSupabaseStub({
      subscriptions: [subscriptionRow()],
      trackedShows: [trackedShow({ tmdb_id: 1, name: 'Broken Show' }), trackedShow({ tmdb_id: 2, name: 'Good Show' })],
      claim: (args) => ({
        data: args.p_episodes.map((e) => ({
          season_number: e.season_number, episode_number: e.episode_number, notification_type: e.notification_type,
        })),
        error: null,
      }),
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification })
    const res = response()
    await handler(request(), res)
    expect(res.body.sent).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })

  it("one subscription's unexpected failure does not prevent another subscription's notification", async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = makeSupabaseStub({
      subscriptions: [
        subscriptionRow({ id: 1, automatic_notifications_enabled_at: 'not-a-real-date' }),
        subscriptionRow({ id: 2 }),
      ],
      trackedShows: [trackedShow()],
      claim: (args) => ({
        data: args.p_episodes.map((e) => ({
          season_number: e.season_number, episode_number: e.episode_number, notification_type: e.notification_type,
        })),
        error: null,
      }),
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification })
    const res = response()
    await handler(request(), res)
    // Subscription 1's malformed watermark fails at row validation, so only
    // subscription 2 (well-formed) is ever processed and sent to.
    expect(res.body.sent).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })

  it('a malformed subscription row is skipped safely, without aborting the run', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = makeSupabaseStub({
      subscriptions: [
        { id: 1, endpoint: '', p256dh: '', auth: '', automatic_notifications_enabled_at: null },
        subscriptionRow({ id: 2 }),
      ],
      trackedShows: [trackedShow()],
      claim: (args) => ({
        data: args.p_episodes.map((e) => ({
          season_number: e.season_number, episode_number: e.episode_number, notification_type: e.notification_type,
        })),
        error: null,
      }),
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification })
    const res = response()
    await handler(request(), res)
    expect(res.statusCode).toBe(200)
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })
})

describe('notification worker: dry run', () => {
  it('never claims or sends, and creates no delivery records', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = makeSupabaseStub({
      subscriptions: [subscriptionRow()],
      trackedShows: [trackedShow()],
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification })
    const res = response()
    await handler(request({ body: { dryRun: true } }), res)

    expect(res.statusCode).toBe(200)
    expect(res.body.sent).toBe(0)
    expect(res.body.eligibleEpisodes).toBe(1)
    expect(res.body.preview).toEqual([
      { tmdbShowId: 1, title: 'Test Show — New episode available', body: 'S1E1 · Pilot', episodeCount: 1 },
    ])
    expect(sendNotification).not.toHaveBeenCalled()
    expect(supabase.record.rpcCalls).toHaveLength(0)
    expect(supabase.record.deliveredUpdates).toHaveLength(0)
  })

  it('dry run is deterministic across repeated calls', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = makeSupabaseStub({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const handler = makeHandler({ supabase, showsById })
    const first = response()
    await handler(request({ body: { dryRun: true } }), first)
    const second = response()
    await handler(request({ body: { dryRun: true } }), second)
    expect(first.body).toEqual(second.body)
  })
})
