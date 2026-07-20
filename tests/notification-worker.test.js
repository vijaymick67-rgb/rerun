import { describe, expect, it, vi } from 'vitest'
import { createNotificationWorkerHandler } from '../api/notifications/run.js'
import {
  EPISODE_AIRTIME_NOTIFICATION_TYPE,
  EPISODE_REMINDER_NOTIFICATION_TYPE,
} from '../src/lib/notifications/episodeEligibility.js'

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

// Default `complete` resolver: durably finalizes every identity requested,
// as long as the claim_token matches — mirroring the real
// complete_episode_notification_deliveries RPC's WHERE clause closely enough
// for these tests (the "delivered_at is null" guard doesn't need modeling
// here since no test reuses an already-finalized identity through this
// resolver directly — see realisticSupabase for tests that need that).
function defaultComplete(args, record) {
  const claimedTokens = record.claimTokensByIdentity
  const finalized = args.p_identities.filter((identity) => claimedTokens.get(identity) === args.p_claim_token)
  for (const identity of finalized) claimedTokens.set(identity, 'delivered')
  return { data: finalized.map((identity) => ({ identity })), error: null }
}

function makeSupabaseStub({
  subscriptions = [],
  trackedShows = [],
  watchedRows = [],
  claim = () => ({ data: [], error: null }),
  complete,
  onDelete = () => {},
} = {}) {
  const record = { deletes: [], rpcCalls: [], claimTokensByIdentity: new Map() }
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
        return { data: null, error: null }
      })
    },
    rpc(name, args) {
      record.rpcCalls.push([name, args])
      if (name === 'claim_episode_notifications') {
        const result = claim(args)
        for (const row of result.data ?? []) {
          const identity = `${args.p_push_subscription_id}:${args.p_tmdb_show_id}:${row.season_number}:${row.episode_number}:${row.notification_type}`
          record.claimTokensByIdentity.set(identity, args.p_claim_token)
        }
        return Promise.resolve(result)
      }
      if (name === 'complete_episode_notification_deliveries') {
        return Promise.resolve((complete ?? defaultComplete)(args, record))
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
}

// Full claim -> deliver round trip against a single shared, lease-aware
// store — not just "delivered or not" but the same claimed-and-not-yet-
// delivered lease state the real claim_episode_notifications RPC enforces (a
// 10-minute window during which a fresh, undelivered claim blocks anyone
// else from winning the same identity). This is what lets a test simulate
// two genuinely *overlapping* worker invocations racing the same identity,
// not just repeated sequential runs.
const CLAIM_LEASE_MS = 10 * 60 * 1000

function realisticSupabase({ subscriptions = [], trackedShows = [], watchedRows = [] } = {}) {
  // identity -> { claimToken, claimedAtMs, delivered }
  const store = new Map()

  function isFreeToClaim(identity, claimToken, claimedAtMs) {
    const existing = store.get(identity)
    if (!existing) return true
    if (existing.delivered) return false
    if (existing.claimToken === claimToken) return true
    return existing.claimedAt < claimedAtMs - CLAIM_LEASE_MS
  }

  function setClaim(identity, claimToken, claimedAtMs) {
    store.set(identity, { claimToken, claimedAt: claimedAtMs, delivered: false })
  }

  return makeSupabaseStub({
    subscriptions,
    trackedShows,
    watchedRows,
    // Mirrors claim_episode_notifications: per episode, if
    // episode_reminder was requested it must be free or nothing is reserved
    // for the episode at all; episode_airtime (whether requested alone or
    // alongside a reminder) is attempted only if it's independently free.
    // Every caller — airtime-only, reminder-only, or both — goes through
    // this exact same function/state, the same way the real RPC's shared
    // advisory lock key serializes every claim type together.
    claim: (args) => {
      const claimedAtMs = Date.parse(args.p_claimed_at)
      const rows = []
      for (const ep of args.p_episodes) {
        const types = ep.notification_types ?? []
        const wantsReminder = types.includes('episode_reminder')
        const wantsAirtime = types.includes('episode_airtime')
        const reminderIdentity = `${args.p_push_subscription_id}:${args.p_tmdb_show_id}:${ep.season_number}:${ep.episode_number}:episode_reminder`
        const airtimeIdentity = `${args.p_push_subscription_id}:${args.p_tmdb_show_id}:${ep.season_number}:${ep.episode_number}:episode_airtime`

        if (wantsReminder && !isFreeToClaim(reminderIdentity, args.p_claim_token, claimedAtMs)) continue

        const attemptAirtime = wantsAirtime && isFreeToClaim(airtimeIdentity, args.p_claim_token, claimedAtMs)
        if (!wantsReminder && !attemptAirtime) continue

        if (wantsReminder) {
          setClaim(reminderIdentity, args.p_claim_token, claimedAtMs)
          rows.push({ season_number: ep.season_number, episode_number: ep.episode_number, notification_type: 'episode_reminder' })
        }
        if (attemptAirtime) {
          setClaim(airtimeIdentity, args.p_claim_token, claimedAtMs)
          rows.push({ season_number: ep.season_number, episode_number: ep.episode_number, notification_type: 'episode_airtime' })
        }
      }
      return { data: rows, error: null }
    },
    complete: (args) => {
      const finalized = []
      for (const identity of args.p_identities) {
        const existing = store.get(identity)
        if (existing && existing.claimToken === args.p_claim_token && !existing.delivered) {
          existing.delivered = true
          finalized.push(identity)
        }
      }
      return { data: finalized.map((identity) => ({ identity })), error: null }
    },
  })
}

// Lets a test deterministically pause one worker invocation mid-flight (after
// it has already committed a claim, before it sends/finalizes) and run a
// second, fully-concurrent invocation to completion in between — simulating
// two overlapping Vercel Cron invocations without relying on incidental
// microtask-ordering luck.
function makeGate() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

// A single macrotask tick lets every already-scheduled microtask (including
// chains of them, e.g. several sequential `await`s over stub promises) run
// to completion before returning — enough to let a handler run all the way
// up to a genuinely blocking await (like makeGate's promise), since nothing
// else in the stubbed pipeline does real async I/O.
async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function subscriptionRow(overrides = {}) {
  return {
    id: 1,
    endpoint: 'https://web.push.apple.com/abc',
    p256dh: 'p256dh-key',
    auth: 'auth-key',
    automatic_notifications_enabled_at: '2026-07-17T00:00:00.000Z',
    airtime_notifications_enabled_at: '2026-07-17T00:00:00.000Z',
    preferred_notification_hour_ist: 20,
    ...overrides,
  }
}

function trackedShow(overrides = {}) {
  return { tmdb_id: 1, name: 'Test Show', ...overrides }
}

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

function makeHandler({ env = baseEnv(), supabase, showsById = {}, sendNotification, now = () => EVALUATION_TIME, ...rest } = {}) {
  return createNotificationWorkerHandler({
    env,
    supabase,
    now,
    createTmdbClient: () => tmdbStubClient({ showsById }),
    createTvmazeClient: () => tvmazeStubClient(),
    sendNotification: sendNotification ?? vi.fn(async () => undefined),
    setVapidDetails: vi.fn(),
    ...rest,
  })
}

// Releases at 2026-07-18T08:30:00Z (14:00 IST, the mapped Netflix platform
// threshold — tmdbStubClient always reports networks: ['Netflix']). With the
// default 8 PM IST preferred hour, the reminder instant is
// max(release, 20:00 IST same day) = 2026-07-18T14:30:00Z.
const AIRED_EPISODE = { episode_number: 1, name: 'Pilot', air_date: '2026-07-18', runtime: 50 }
const RELEASE_INSTANT = Date.parse('2026-07-18T08:30:00.000Z')
const DEFAULT_REMINDER_INSTANT = Date.parse('2026-07-18T14:30:00.000Z') // 8 PM IST same day

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

describe('notification worker: airtime alert', () => {
  it('is eligible on the first evaluation after release and sends immediately', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000), // 5 minutes after release
    })
    const res = response()
    await handler(request(), res)

    expect(res.body.sent).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(sendNotification.mock.calls[0][1])
    expect(parsed).toEqual({
      title: 'Test Show - New Episode',
      url: '/watching/1',
      tag: 'rerun-episode-airtime-1-s1e1',
      omitBody: true,
    })
    const claimCall = supabase.record.rpcCalls.find((c) => c[0] === 'claim_episode_notifications')
    expect(claimCall[1].p_episodes[0].notification_types).toEqual([EPISODE_AIRTIME_NOTIFICATION_TYPE])
  })

  it('is not eligible before release', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT - 5 * 60 * 1000), // 5 minutes before release
    })
    const res = response()
    await handler(request(), res)
    expect(res.body).toEqual({ checkedShows: 1, eligibleEpisodes: 0, sent: 0, skipped: 0, staleRemoved: 0, failed: 0 })
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('the preferred reminder hour never delays airtime', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    // 11 PM preferred — airtime must still send minutes after release, not
    // wait for anything close to 11 PM IST.
    const supabase = realisticSupabase({
      subscriptions: [subscriptionRow({ preferred_notification_hour_ist: 23 })], trackedShows: [trackedShow()],
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000),
    })
    const res = response()
    await handler(request(), res)
    expect(res.body.sent).toBe(1)
    const parsed = JSON.parse(sendNotification.mock.calls[0][1])
    expect(parsed.tag).toBe('rerun-episode-airtime-1-s1e1')
  })

  it('a repeated worker run at the same evaluation time does not resend airtime', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const sendNotification = vi.fn(async () => undefined)
    const now = () => new Date(RELEASE_INSTANT + 5 * 60 * 1000)
    const handler = makeHandler({ supabase, showsById, sendNotification, now })

    const first = response()
    await handler(request(), first)
    const second = response()
    await handler(request(), second)

    expect(first.body.sent).toBe(1)
    expect(second.body.sent).toBe(0)
    expect(second.body.skipped).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })

  it('multiple episodes released together from one show produce exactly one airtime push', async () => {
    const episodes = Array.from({ length: 8 }, (_, i) => ({
      episode_number: i + 1, name: `Ep ${i + 1}`, air_date: '2026-07-18', runtime: 30,
    }))
    const showsById = { 1: { name: 'The Bear', episodes } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow({ name: 'The Bear' })] })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000),
    })
    const res = response()
    await handler(request(), res)
    expect(res.body.sent).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(sendNotification.mock.calls[0][1])
    expect(parsed.tag).toBe('rerun-episode-airtime-1-batch')
    const completeCall = supabase.record.rpcCalls.find((c) => c[0] === 'complete_episode_notification_deliveries')
    expect(completeCall[1].p_identities).toHaveLength(8)
  })

  it('multiple shows with new episodes in the same window each get their own airtime push', async () => {
    const showsById = {
      1: { name: 'House of the Dragon', episodes: [AIRED_EPISODE] },
      2: { name: 'Sugar', episodes: [AIRED_EPISODE] },
      3: { name: 'The Bear', episodes: [AIRED_EPISODE] },
    }
    const supabase = realisticSupabase({
      subscriptions: [subscriptionRow()],
      trackedShows: [
        trackedShow({ tmdb_id: 1, name: 'House of the Dragon' }),
        trackedShow({ tmdb_id: 2, name: 'Sugar' }),
        trackedShow({ tmdb_id: 3, name: 'The Bear' }),
      ],
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000),
    })
    const res = response()
    await handler(request(), res)
    expect(res.body.sent).toBe(3)
    expect(sendNotification).toHaveBeenCalledTimes(3)
    const tags = sendNotification.mock.calls.map(([, payload]) => JSON.parse(payload).tag).sort()
    expect(tags).toEqual(['rerun-episode-airtime-1-s1e1', 'rerun-episode-airtime-2-s1e1', 'rerun-episode-airtime-3-s1e1'])
  })
})

describe('notification worker: custom-time reminder', () => {
  it('holds a reminder until the worker run at or after the preferred hour', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(DEFAULT_REMINDER_INSTANT - 60 * 60 * 1000), // 1 hour before 8 PM IST
    })
    const res = response()
    await handler(request(), res)
    // Airtime fires this run (first evaluation after release); the reminder
    // does not, since the preferred hour hasn't arrived yet.
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(JSON.parse(sendNotification.mock.calls[0][1]).tag).toBe('rerun-episode-airtime-1-s1e1')
  })

  it('sends a standalone reminder on the first run at or after the preferred hour, once airtime already went out earlier', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000) })

    // Run 1: shortly after release — airtime only.
    const first = response()
    await handler(request(), first)
    expect(first.body.sent).toBe(1)
    expect(JSON.parse(sendNotification.mock.calls[0][1]).tag).toBe('rerun-episode-airtime-1-s1e1')

    // Run 2: still before the preferred hour — nothing new.
    const secondHandler = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(DEFAULT_REMINDER_INSTANT - 30 * 60 * 1000),
    })
    const second = response()
    await secondHandler(request(), second)
    expect(second.body.sent).toBe(0)

    // Run 3: at the preferred hour — a genuine, separate reminder push.
    const thirdHandler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(DEFAULT_REMINDER_INSTANT) })
    const third = response()
    await thirdHandler(request(), third)
    expect(third.body.sent).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(2)
    const parsed = JSON.parse(sendNotification.mock.calls[1][1])
    expect(parsed.tag).toBe('rerun-episode-reminder-1-s1e1')
    const completeCalls = supabase.record.rpcCalls.filter((c) => c[0] === 'complete_episode_notification_deliveries')
    const reminderFinalize = completeCalls.find((c) => c[1].p_identities[0].endsWith(EPISODE_REMINDER_NOTIFICATION_TYPE))
    expect(reminderFinalize).toBeTruthy()
  })

  it('a watched-before-reminder episode never gets a reminder', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const watchedRows = [{ tmdb_show_id: 1, season_number: 1, episode_number: 1 }]
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()], watchedRows })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(DEFAULT_REMINDER_INSTANT) })
    const res = response()
    await handler(request(), res)
    expect(res.body).toEqual({ checkedShows: 1, eligibleEpisodes: 0, sent: 0, skipped: 0, staleRemoved: 0, failed: 0 })
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('a partially-watched batch reminds only for what remains unwatched', async () => {
    const episodes = [AIRED_EPISODE, { episode_number: 2, name: 'Second', air_date: '2026-07-18', runtime: 50 }]
    const showsById = { 1: { name: 'Test Show', episodes } }
    // Episode 1 already watched before the reminder time; episode 2 is not.
    const watchedRows = [{ tmdb_show_id: 1, season_number: 1, episode_number: 1 }]
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()], watchedRows })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000) })

    // Airtime run: only episode 2 is unwatched, so only it goes out (as
    // airtime — this test only cares about the later reminder stage).
    const first = response()
    await handler(request(), first)

    const secondHandler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(DEFAULT_REMINDER_INSTANT) })
    const second = response()
    await secondHandler(request(), second)
    expect(second.body.sent).toBe(1)
    const parsed = JSON.parse(sendNotification.mock.calls[1][1])
    expect(parsed.tag).toBe('rerun-episode-reminder-1-s1e2')
  })

  it('a repeated run at the same evaluation time does not resend the reminder', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const sendNotification = vi.fn(async () => undefined)
    const now = () => new Date(DEFAULT_REMINDER_INSTANT)
    const handler = makeHandler({ supabase, showsById, sendNotification, now })

    const first = response()
    await handler(request(), first)
    const second = response()
    await handler(request(), second)

    // First run: airtime + reminder collide (release long before the
    // watermark check matters here, both instants already passed) — only
    // one push goes out. Second run at the identical instant must resend
    // nothing at all.
    expect(first.body.sent).toBe(1)
    expect(second.body.sent).toBe(0)
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })
})

describe('notification worker: same-evaluation collision', () => {
  it('an episode released after the preferred hour sends exactly one push (airtime), not two', async () => {
    // Releases at 21:15 IST, after the 8 PM preferred hour — the reminder
    // instant collapses to the release instant itself, so both stages
    // become eligible in the very same evaluation.
    const lateEpisode = { episode_number: 1, name: 'Pilot', airstamp: '2026-07-18T15:45:00.000Z', runtime: 50 } // 21:15 IST
    const showsById = { 1: { name: 'Test Show', episodes: [lateEpisode] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(Date.parse('2026-07-18T15:50:00.000Z')),
    })
    const res = response()
    await handler(request(), res)
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(res.body.sent).toBe(1)
    const parsed = JSON.parse(sendNotification.mock.calls[0][1])
    expect(parsed.tag).toBe('rerun-episode-airtime-1-s1e1')
  })

  it('the successful airtime delivery also durably satisfies the reminder — a later run never sends it', async () => {
    const lateEpisode = { episode_number: 1, name: 'Pilot', airstamp: '2026-07-18T15:45:00.000Z', runtime: 50 }
    const showsById = { 1: { name: 'Test Show', episodes: [lateEpisode] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(Date.parse('2026-07-18T15:50:00.000Z')),
    })
    await handler(request(), response())

    const completeCalls = supabase.record.rpcCalls.filter((c) => c[0] === 'complete_episode_notification_deliveries')
    const reminderFinalize = completeCalls.find((c) => c[1].p_identities.some((id) => id.endsWith(EPISODE_REMINDER_NOTIFICATION_TYPE)))
    expect(reminderFinalize).toBeTruthy() // reminder identity finalized without a second push
    // The same call also finalized the airtime identity — one combined
    // finalize, not two separate ones.
    expect(reminderFinalize[1].p_identities.some((id) => id.endsWith(EPISODE_AIRTIME_NOTIFICATION_TYPE))).toBe(true)

    // A later run (well after this evaluation) must not resend anything.
    const laterHandler = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(Date.parse('2026-07-20T00:00:00.000Z')),
    })
    const later = response()
    await laterHandler(request(), later)
    expect(later.body.sent).toBe(0)
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })

  it('a failed airtime send finalizes neither type', async () => {
    const lateEpisode = { episode_number: 1, name: 'Pilot', airstamp: '2026-07-18T15:45:00.000Z', runtime: 50 }
    const showsById = { 1: { name: 'Test Show', episodes: [lateEpisode] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const sendNotification = vi.fn(async () => { throw new Error('temporary network blip') })
    const handler = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(Date.parse('2026-07-18T15:50:00.000Z')),
    })
    const res = response()
    await handler(request(), res)
    expect(res.body.sent).toBe(0)
    expect(res.body.failed).toBeGreaterThan(0)
    const completeCalls = supabase.record.rpcCalls.filter((c) => c[0] === 'complete_episode_notification_deliveries')
    expect(completeCalls).toHaveLength(0)
  })

  it('a failed combined finalize (push already sent) is reported as failed, not silently dropped, and leaves both identities retryable', async () => {
    const lateEpisode = { episode_number: 1, name: 'Pilot', airstamp: '2026-07-18T15:45:00.000Z', runtime: 50 }
    const showsById = { 1: { name: 'Test Show', episodes: [lateEpisode] } }
    let combinedCompleteCalls = 0
    const supabase = makeSupabaseStub({
      subscriptions: [subscriptionRow()],
      trackedShows: [trackedShow()],
      claim: (args) => ({
        data: args.p_episodes.flatMap((e) =>
          (e.notification_types ?? []).map((notificationType) => ({
            season_number: e.season_number, episode_number: e.episode_number, notification_type: notificationType,
          })),
        ),
        error: null,
      }),
      complete: () => {
        combinedCompleteCalls += 1
        // The push already went out; the finalize write itself fails once,
        // simulating a transient database error right after a successful
        // combined send.
        return { data: null, error: { message: 'connection reset' } }
      },
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(Date.parse('2026-07-18T15:50:00.000Z')),
    })
    const res = response()
    await handler(request(), res)

    // A push already fired, but since the finalize RPC never durably
    // confirmed it, this run must not credit it as sent — exactly the same
    // contract a non-collision send/finalize failure already has.
    expect(res.body.sent).toBe(0)
    expect(res.body.failed).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(combinedCompleteCalls).toBe(1)
    const completeCall = supabase.record.rpcCalls.find((c) => c[0] === 'complete_episode_notification_deliveries')
    expect(completeCall[1].p_identities).toHaveLength(2) // one call, both identities together
  })
})

describe('notification worker: cross-invocation collision race', () => {
  it('two overlapping workers racing the same airtime+reminder collision send exactly one combined push, and both identities finalize together', async () => {
    const lateEpisode = { episode_number: 1, name: 'Pilot', airstamp: '2026-07-18T15:45:00.000Z', runtime: 50 }
    const showsById = { 1: { name: 'Test Show', episodes: [lateEpisode] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const now = () => new Date(Date.parse('2026-07-18T15:50:00.000Z'))

    const gate = makeGate()
    let sendCallCount = 0
    const sendNotification = vi.fn(async () => {
      sendCallCount += 1
      if (sendCallCount === 1) await gate.promise // Worker A: claimed, paused before actually sending.
    })

    const handlerA = makeHandler({ supabase, showsById, sendNotification, now })
    const handlerB = makeHandler({ supabase, showsById, sendNotification, now })

    const resA = response()
    const runA = handlerA(request(), resA)
    await flushAsync() // let A run candidate computation + claim, then block on the send gate

    const resB = response()
    await handlerB(request(), resB) // fully concurrent worker B, starting before A has sent/finalized anything

    // Worker B must not have won or sent anything — the reminder must not go
    // out standalone just because B lost the airtime side of the race.
    expect(resB.body.sent).toBe(0)
    expect(sendCallCount).toBe(1) // B never called sendNotification at all

    gate.release()
    await runA

    expect(resA.body.sent).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1) // only ever one push, total, across both workers
    const parsed = JSON.parse(sendNotification.mock.calls[0][1])
    expect(parsed.tag).toBe('rerun-episode-airtime-1-s1e1')

    const completeCalls = supabase.record.rpcCalls.filter((c) => c[0] === 'complete_episode_notification_deliveries')
    expect(completeCalls).toHaveLength(1)
    expect(completeCalls[0][1].p_identities).toHaveLength(2)
    expect(completeCalls[0][1].p_identities.some((id) => id.endsWith(EPISODE_AIRTIME_NOTIFICATION_TYPE))).toBe(true)
    expect(completeCalls[0][1].p_identities.some((id) => id.endsWith(EPISODE_REMINDER_NOTIFICATION_TYPE))).toBe(true)
  })

  it('a failed combined send while a second worker was mid-race finalizes neither identity, and both stay retryable', async () => {
    const lateEpisode = { episode_number: 1, name: 'Pilot', airstamp: '2026-07-18T15:45:00.000Z', runtime: 50 }
    const showsById = { 1: { name: 'Test Show', episodes: [lateEpisode] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const now = () => new Date(Date.parse('2026-07-18T15:50:00.000Z'))

    const gate = makeGate()
    let sendCallCount = 0
    const sendNotification = vi.fn(async () => {
      sendCallCount += 1
      if (sendCallCount === 1) {
        await gate.promise
        throw new Error('temporary network blip') // Worker A's send ultimately fails.
      }
    })

    const handlerA = makeHandler({ supabase, showsById, sendNotification, now })
    const handlerB = makeHandler({ supabase, showsById, sendNotification, now })

    const resA = response()
    const runA = handlerA(request(), resA)
    await flushAsync()

    const resB = response()
    await handlerB(request(), resB)
    expect(resB.body.sent).toBe(0) // B still must not send standalone while A's claim is live

    gate.release()
    await runA

    expect(resA.body.sent).toBe(0)
    expect(resA.body.failed).toBeGreaterThan(0)
    expect(sendNotification).toHaveBeenCalledTimes(1) // B never sent; A's single attempt failed
    const completeCalls = supabase.record.rpcCalls.filter((c) => c[0] === 'complete_episode_notification_deliveries')
    expect(completeCalls).toHaveLength(0) // never reached — a failed send never finalizes

    // A later, non-overlapping run picks the same episode back up and
    // succeeds — nothing was left permanently stuck.
    const laterHandler = makeHandler({
      supabase, showsById, sendNotification: vi.fn(async () => undefined),
      now: () => new Date(Date.parse('2026-07-18T15:50:00.000Z') + 11 * 60 * 1000), // past the 10-minute lease
    })
    const later = response()
    await laterHandler(request(), later)
    expect(later.body.sent).toBe(1)
  })

  it('a reminder due after airtime already delivered on an earlier run still sends for real, even when two workers race the reminder claim', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })

    // Run 1: airtime alone, well before the preferred hour — no collision.
    const firstHandler = makeHandler({
      supabase, showsById, sendNotification: vi.fn(async () => undefined), now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000),
    })
    const first = response()
    await firstHandler(request(), first)
    expect(first.body.sent).toBe(1)

    // Run 2 (later, separate): two workers race the now-due standalone
    // reminder for the same episode — airtime is already fully delivered,
    // so neither worker should treat this as a fresh collision.
    const gate = makeGate()
    let sendCallCount = 0
    const sendNotification = vi.fn(async () => {
      sendCallCount += 1
      if (sendCallCount === 1) await gate.promise
    })
    const now = () => new Date(DEFAULT_REMINDER_INSTANT)
    const handlerA = makeHandler({ supabase, showsById, sendNotification, now })
    const handlerB = makeHandler({ supabase, showsById, sendNotification, now })

    const resA = response()
    const runA = handlerA(request(), resA)
    await flushAsync()

    const resB = response()
    await handlerB(request(), resB)
    expect(resB.body.sent).toBe(0)

    gate.release()
    await runA

    expect(resA.body.sent).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(sendNotification.mock.calls[0][1])
    expect(parsed.tag).toBe('rerun-episode-reminder-1-s1e1') // a real, standalone reminder — not folded into airtime
  })

  it('a worker racing the reminder-eligibility boundary never reports a false combined win — airtime and reminder each deliver exactly once, under their own claim', async () => {
    // Worker A evaluates one millisecond before the reminder becomes due:
    // it only ever asks for episode_airtime. Worker B evaluates at the
    // instant the reminder becomes due: it asks for both types together
    // (a combined attempt), for the very same episode. Before this
    // migration, A's plain airtime claim and B's collision claim used
    // different (lock-free vs lock-protected) paths and could both believe
    // they owned the airtime identity — see
    // supabase/migrations/20260720110000_add_unified_episode_notification_claim.sql.
    // Now both go through the same advisory-lock-protected RPC, so
    // whichever commits first fully settles the episode before the other
    // even reads its state.
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })

    const gate = makeGate()
    let sendCallCount = 0
    const sendNotification = vi.fn(async () => {
      sendCallCount += 1
      if (sendCallCount === 1) await gate.promise // Worker A: claimed airtime-only, paused before sending.
    })

    const handlerA = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(DEFAULT_REMINDER_INSTANT - 1) })
    const handlerB = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(DEFAULT_REMINDER_INSTANT) })

    const resA = response()
    const runA = handlerA(request(), resA)
    await flushAsync() // A computes airtime-only, claims it, then blocks on the send gate

    const resB = response()
    await handlerB(request(), resB) // fully concurrent Worker B, requesting a combined claim

    // B must correctly see the airtime identity as already (freshly) owned
    // by A and fall back to a real, standalone reminder — never a false
    // "combined" report, and never a second airtime-flavored push.
    expect(resB.body.sent).toBe(1)
    expect(resB.body.failed).toBe(0)

    gate.release()
    await runA

    expect(resA.body.sent).toBe(1)
    expect(resA.body.failed).toBe(0)
    expect(sendNotification).toHaveBeenCalledTimes(2) // one airtime push (A), one reminder push (B) — never a duplicate airtime send
    const tags = sendNotification.mock.calls.map(([, payload]) => JSON.parse(payload).tag).sort()
    expect(tags).toEqual(['rerun-episode-airtime-1-s1e1', 'rerun-episode-reminder-1-s1e1'])

    // Each identity finalized exactly once, under its own claim — never a
    // phantom combined finalize call claiming ownership of a row it never
    // actually won.
    const completeCalls = supabase.record.rpcCalls.filter((c) => c[0] === 'complete_episode_notification_deliveries')
    expect(completeCalls).toHaveLength(2)
    for (const call of completeCalls) expect(call[1].p_identities).toHaveLength(1)
    const finalizedTypes = completeCalls.map((c) => c[1].p_identities[0].split(':').pop()).sort()
    expect(finalizedTypes).toEqual([EPISODE_AIRTIME_NOTIFICATION_TYPE, EPISODE_REMINDER_NOTIFICATION_TYPE])
  })

  it('a claim RPC error for one worker sends nothing and reports failed, without disturbing the other worker’s legitimate claim', async () => {
    const lateEpisode = { episode_number: 1, name: 'Pilot', airstamp: '2026-07-18T15:45:00.000Z', runtime: 50 }
    const showsById = { 1: { name: 'Test Show', episodes: [lateEpisode] } }
    let claimCallCount = 0
    const supabase = makeSupabaseStub({
      subscriptions: [subscriptionRow()],
      trackedShows: [trackedShow()],
      // The first claim call (Worker A) fails outright — simulating a
      // dropped connection mid-transaction, before ownership could even be
      // verified. The second (Worker B) succeeds normally and wins the
      // combined claim.
      claim: (args) => {
        claimCallCount += 1
        if (claimCallCount === 1) return { data: null, error: { message: 'connection reset' } }
        return {
          data: args.p_episodes.flatMap((e) =>
            (e.notification_types ?? []).map((notificationType) => ({
              season_number: e.season_number, episode_number: e.episode_number, notification_type: notificationType,
            })),
          ),
          error: null,
        }
      },
    })
    const sendNotification = vi.fn(async () => undefined)
    const handlerA = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(Date.parse('2026-07-18T15:50:00.000Z')),
    })
    const resA = response()
    await handlerA(request(), resA)

    expect(resA.body.sent).toBe(0)
    expect(resA.body.failed).toBeGreaterThan(0)
    expect(sendNotification).not.toHaveBeenCalled()

    const handlerB = makeHandler({
      supabase, showsById, sendNotification, now: () => new Date(Date.parse('2026-07-18T15:50:00.000Z')),
    })
    const resB = response()
    await handlerB(request(), resB)
    expect(resB.body.sent).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })
})

describe('notification worker: watermarks and rollout', () => {
  it('an episode substantially older than the airtime rollout never gets a retroactive airtime alert, but still reminds', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [{ ...AIRED_EPISODE, air_date: '2026-01-01' }] } }
    const supabase = realisticSupabase({
      subscriptions: [subscriptionRow({
        automatic_notifications_enabled_at: '2025-12-01T00:00:00.000Z', // long-active subscription
        airtime_notifications_enabled_at: '2026-07-19T00:00:00.000Z', // airtime rolled out well after this old episode aired
      })],
      trackedShows: [trackedShow()],
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification, now: () => EVALUATION_TIME })
    const res = response()
    await handler(request(), res)
    expect(res.body.sent).toBe(1)
    const parsed = JSON.parse(sendNotification.mock.calls[0][1])
    // Reminder only — never an airtime tag for pre-rollout backlog.
    expect(parsed.tag).toBe('rerun-episode-reminder-1-s1e1')
  })

  it('an episode released just inside the rollout grace window is still airtime-eligible', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    // Airtime watermark backdated by the same 30-minute grace window used at
    // activation — an episode releasing 10 minutes before that watermark's
    // nominal "rollout instant" is still strictly after the (backdated)
    // watermark, so it's eligible, not swallowed as backlog.
    const supabase = realisticSupabase({
      subscriptions: [subscriptionRow({ airtime_notifications_enabled_at: new Date(RELEASE_INSTANT - 10 * 60 * 1000).toISOString() })],
      trackedShows: [trackedShow()],
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000) })
    const res = response()
    await handler(request(), res)
    expect(res.body.sent).toBe(1)
    expect(JSON.parse(sendNotification.mock.calls[0][1]).tag).toBe('rerun-episode-airtime-1-s1e1')
  })

  it('an episode released exactly at the airtime watermark is backlog, not new (airtime), but can still remind', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({
      subscriptions: [subscriptionRow({ airtime_notifications_enabled_at: new Date(RELEASE_INSTANT).toISOString() })],
      trackedShows: [trackedShow()],
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(DEFAULT_REMINDER_INSTANT) })
    const res = response()
    await handler(request(), res)
    expect(res.body.sent).toBe(1)
    expect(JSON.parse(sendNotification.mock.calls[0][1]).tag).toBe('rerun-episode-reminder-1-s1e1')
  })
})

describe('notification worker: later episode from an already-notified show', () => {
  it('a newly available episode from a show that already notified earlier can still notify separately', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000) })

    const first = response()
    await handler(request(), first)
    expect(first.body.sent).toBe(1)

    showsById[1].episodes.push({ episode_number: 2, name: 'Second', air_date: '2026-07-18', runtime: 50 })
    const second = response()
    await handler(request(), second)
    expect(second.body.sent).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(2)
  })
})

describe('notification worker: stale subscription cleanup', () => {
  it('removes a subscription on a 404/410 from web-push and continues the run', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow({ id: 9 })], trackedShows: [trackedShow()] })
    const err = Object.assign(new Error('gone'), { statusCode: 410 })
    const sendNotification = vi.fn(async () => { throw err })
    const handler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000) })
    const res = response()
    await handler(request(), res)

    expect(res.body.staleRemoved).toBe(1)
    expect(res.body.sent).toBe(0)
    expect(supabase.record.deletes).toEqual([['id', 9]])
  })

  it('a transient (non-404/410) send failure counts as failed, not staleRemoved, and the subscription is not deleted', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const sendNotification = vi.fn(async () => { throw new Error('temporary network blip') })
    const handler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000) })
    const res = response()
    await handler(request(), res)
    expect(res.body.staleRemoved).toBe(0)
    expect(res.body.sent).toBe(0)
    expect(res.body.failed).toBeGreaterThan(0)
    expect(supabase.record.deletes).toEqual([])
  })
})

describe('notification worker: isolation between shows and subscriptions', () => {
  it("one show's TMDB failure does not prevent another show's notification", async () => {
    const showsById = {
      1: { name: 'Broken Show', detailsError: true },
      2: { name: 'Good Show', episodes: [AIRED_EPISODE] },
    }
    const supabase = realisticSupabase({
      subscriptions: [subscriptionRow()],
      trackedShows: [trackedShow({ tmdb_id: 1, name: 'Broken Show' }), trackedShow({ tmdb_id: 2, name: 'Good Show' })],
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000) })
    const res = response()
    await handler(request(), res)
    expect(res.body.sent).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })

  it("one subscription's unexpected failure does not prevent another subscription's notification", async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({
      subscriptions: [
        subscriptionRow({ id: 1, automatic_notifications_enabled_at: 'not-a-real-date' }),
        subscriptionRow({ id: 2 }),
      ],
      trackedShows: [trackedShow()],
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000) })
    const res = response()
    await handler(request(), res)
    // Subscription 1's malformed watermark fails at row validation, so only
    // subscription 2 (well-formed) is ever processed and sent to.
    expect(res.body.sent).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })

  it('a malformed subscription row is skipped safely, without aborting the run', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({
      subscriptions: [
        { id: 1, endpoint: '', p256dh: '', auth: '', automatic_notifications_enabled_at: null },
        subscriptionRow({ id: 2 }),
      ],
      trackedShows: [trackedShow()],
    })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000) })
    const res = response()
    await handler(request(), res)
    expect(res.statusCode).toBe(200)
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })
})

describe('notification worker: dry run', () => {
  it('never claims or sends, and creates no delivery records', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const sendNotification = vi.fn(async () => undefined)
    const handler = makeHandler({ supabase, showsById, sendNotification, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000) })
    const res = response()
    await handler(request({ body: { dryRun: true } }), res)

    expect(res.statusCode).toBe(200)
    expect(res.body.sent).toBe(0)
    expect(res.body.eligibleEpisodes).toBe(1)
    expect(res.body.preview).toEqual([
      { tmdbShowId: 1, title: 'Test Show - New Episode', episodeCount: 1, notificationType: EPISODE_AIRTIME_NOTIFICATION_TYPE },
    ])
    expect(sendNotification).not.toHaveBeenCalled()
    expect(supabase.record.rpcCalls).toHaveLength(0)
  })

  it('dry run is deterministic across repeated calls', async () => {
    const showsById = { 1: { name: 'Test Show', episodes: [AIRED_EPISODE] } }
    const supabase = realisticSupabase({ subscriptions: [subscriptionRow()], trackedShows: [trackedShow()] })
    const handler = makeHandler({ supabase, showsById, now: () => new Date(DEFAULT_REMINDER_INSTANT) })
    const first = response()
    await handler(request({ body: { dryRun: true } }), first)
    const second = response()
    await handler(request({ body: { dryRun: true } }), second)
    expect(first.body).toEqual(second.body)
  })

  it('previews both an airtime and a reminder entry when both are independently eligible', async () => {
    // Two shows: one only just released (airtime candidate only — its
    // reminder instant hasn't arrived), one released long ago under an
    // older watermark so only its reminder is still pending.
    const showsById = {
      1: { name: 'Fresh Show', episodes: [AIRED_EPISODE] },
      2: { name: 'Old Show', episodes: [{ ...AIRED_EPISODE, air_date: '2026-01-01' }] },
    }
    const supabase = realisticSupabase({
      subscriptions: [subscriptionRow({
        automatic_notifications_enabled_at: '2025-12-01T00:00:00.000Z',
        airtime_notifications_enabled_at: '2026-07-19T00:00:00.000Z',
      })],
      trackedShows: [trackedShow({ tmdb_id: 1, name: 'Fresh Show' }), trackedShow({ tmdb_id: 2, name: 'Old Show' })],
    })
    // "Fresh Show" needs its own subscription with an airtime watermark
    // before its release — reuse the default one for it, and the
    // rolled-out-later watermark above only for "Old Show"'s scenario.
    const supabaseForFresh = realisticSupabase({
      subscriptions: [subscriptionRow()],
      trackedShows: [trackedShow({ tmdb_id: 1, name: 'Fresh Show' })],
    })
    const freshHandler = makeHandler({
      supabase: supabaseForFresh, showsById: { 1: showsById[1] }, now: () => new Date(RELEASE_INSTANT + 5 * 60 * 1000),
    })
    const freshRes = response()
    await freshHandler(request({ body: { dryRun: true } }), freshRes)
    expect(freshRes.body.preview).toEqual([
      { tmdbShowId: 1, title: 'Fresh Show - New Episode', episodeCount: 1, notificationType: EPISODE_AIRTIME_NOTIFICATION_TYPE },
    ])

    const handler = makeHandler({ supabase, showsById, now: () => new Date(DEFAULT_REMINDER_INSTANT) })
    const res = response()
    await handler(request({ body: { dryRun: true } }), res)
    const types = res.body.preview.map((p) => `${p.tmdbShowId}:${p.notificationType}`).sort()
    expect(types).toEqual(['1:episode_reminder', '2:episode_reminder'])
  })
})
