import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { executeNotificationPlan } from '../src/lib/notifications/execute.js'
import { createNotificationCronHandler } from '../api/notification-cron.js'

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

function request({ method = 'GET', authorization } = {}) {
  return { method, headers: authorization === undefined ? {} : { authorization } }
}

describe('notification cron endpoint', () => {
  it('rejects unauthorized GET without invoking the worker', async () => {
    const runWorker = vi.fn()
    const res = response()
    await createNotificationCronHandler({ env: { CRON_SECRET: 'secret' }, runWorker })(request(), res)
    expect(res.statusCode).toBe(401)
    expect(runWorker).not.toHaveBeenCalled()
  })

  it('fails closed when CRON_SECRET is missing', async () => {
    const runWorker = vi.fn()
    const res = response()
    await createNotificationCronHandler({ env: {}, runWorker })(request({ authorization: 'Bearer undefined' }), res)
    expect(res.statusCode).toBe(401)
    expect(runWorker).not.toHaveBeenCalled()
  })

  it('rejects non-GET methods without invoking the worker', async () => {
    const runWorker = vi.fn()
    const res = response()
    await createNotificationCronHandler({ env: { CRON_SECRET: 'secret' }, runWorker })(request({ method: 'POST', authorization: 'Bearer secret' }), res)
    expect(res.statusCode).toBe(405)
    expect(res.headers.Allow).toBe('GET')
    expect(runWorker).not.toHaveBeenCalled()
  })

  it('invokes the existing worker once and returns only safe operational fields', async () => {
    const instant = new Date('2026-07-15T16:35:00.000Z')
    const env = { CRON_SECRET: 'cron-secret', NTFY_TOPIC: 'private-topic' }
    const log = vi.fn()
    const runWorker = vi.fn(async () => ({ sent: 1, disabled: false, dryRun: false, ignored: 'episode data' }))
    const res = response()
    await createNotificationCronHandler({ env, runWorker, now: () => instant, log })(request({ authorization: 'Bearer cron-secret' }), res)
    expect(runWorker).toHaveBeenCalledTimes(1)
    expect(runWorker).toHaveBeenCalledWith({ env, now: instant, log })
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: true, sent: 1, disabled: false, dryRun: false })
    expect(JSON.stringify(res.body)).not.toMatch(/cron-secret|private-topic|episode data/)
  })

  it('returns generic 500 JSON and redacts secrets from server logs', async () => {
    const env = { CRON_SECRET: 'cron-secret', SUPABASE_SERVICE_ROLE_KEY: 'service-secret' }
    const errorLog = vi.fn()
    const res = response()
    const runWorker = vi.fn(async () => { throw new Error('failed with service-secret and cron-secret') })
    await createNotificationCronHandler({ env, runWorker, errorLog })(request({ authorization: 'Bearer cron-secret' }), res)
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ success: false, error: 'Notification worker failed' })
    expect(JSON.stringify([res.body, errorLog.mock.calls])).not.toMatch(/service-secret|cron-secret/)
  })

  it('preserves rewrites and leaves scheduling to Supabase Cron', async () => {
    const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'))
    expect(vercel.rewrites).toEqual([
      { source: '/api/tmdb/:path*', destination: '/api/tmdb?path=:path*' },
      { source: '/:path((?!api/).*)', destination: '/index.html' },
    ])
    expect(vercel.crons).toBeUndefined()
  })

  it('defines three Vault-backed Supabase Cron requests with explicit timeout', async () => {
    const migration = await readFile(new URL('../supabase/migrations/20260715100000_schedule_notification_cron.sql', import.meta.url), 'utf8')
    const jobs = [
      ['rerun-notification-worker-10pm-ist', '30 16 * * *'],
      ['rerun-notification-worker-1005pm-ist', '35 16 * * *'],
      ['rerun-notification-worker-1010pm-ist', '40 16 * * *'],
    ]
    for (const [name, schedule] of jobs) {
      expect(migration).toContain(`'${name}'`)
      expect(migration).toContain(`'${schedule}'`)
    }
    expect(new Set(jobs.map(([name]) => name)).size).toBe(3)
    expect(migration).toContain('cron.schedule')
    expect(migration).toContain('net.http_get')
    expect(migration).toContain('/api/notification-cron')
    expect(migration).toContain('rerun_notification_endpoint_url')
    expect(migration).toContain('rerun_notification_cron_secret')
    expect(migration).toContain("'Authorization', 'Bearer '")
    expect(migration.match(/timeout_milliseconds := 120000/g)).toHaveLength(3)
    expect(migration).not.toMatch(/https?:\/\/[^\s']+/)
    expect(migration).not.toMatch(/CRON_SECRET\s*=/)
  })

  it('contains no duplicated planner, release, platform, or timezone constants', async () => {
    const source = await readFile(new URL('../api/notification-cron.js', import.meta.url), 'utf8')
    expect(source).toContain("import { runNotificationWorker } from '../scripts/notifications/worker.js'")
    expect(source).not.toMatch(/buildNotificationPlan|episodeReleaseInfo|hasAiredAt|Asia\/Kolkata|IST_OFFSET|WATCH_REMINDER|releasePlatform/)
  })

  it('relies on existing claims to prevent duplicate reminder sends across scheduler invocations', async () => {
    const identity = '7:1:1:episode_watch_reminder'
    const notification = {
      notificationType: 'episode_watch_reminder', tmdbShowId: 7, showName: 'Lucky',
      title: 'Lucky - New episode', body: 'S1E1 - Episode', attachment: null,
      episodes: [{ identity, seasonNumber: 1, episodeNumber: 1, name: 'Episode' }],
    }
    let delivered = false
    const store = {
      claim: vi.fn(async () => delivered ? [] : [identity]),
      complete: vi.fn(async () => { delivered = true }),
      release: vi.fn(),
    }
    const publish = vi.fn()
    const runWorker = vi.fn(async () => executeNotificationPlan({
      plan: { notifications: [], watchReminders: [notification] }, enabled: true,
      deliveryStore: store, publish,
    }))
    const handler = createNotificationCronHandler({ env: { CRON_SECRET: 'secret' }, runWorker })
    const first = response()
    const second = response()
    await handler(request({ authorization: 'Bearer secret' }), first)
    await handler(request({ authorization: 'Bearer secret' }), second)
    expect(first.body.sent).toBe(1)
    expect(second.body.sent).toBe(0)
    expect(publish).toHaveBeenCalledTimes(1)
  })
})
