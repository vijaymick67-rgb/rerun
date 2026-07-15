Exit code: 0
Wall time: 2.9 seconds
Output:
import { describe, expect, it, vi } from 'vitest'
import { executeNotificationPlan } from './execute.js'
import {
  buildNotificationPlan,
  deliveryIdentity,
  EPISODE_NOTIFICATION_TYPE,
  EPISODE_WATCH_REMINDER_TYPE,
  isWatchReminderWindow,
  watchReminderCutoffs,
} from './plan.js'
import { classifyReleasePlatform } from '../releasePlatforms.js'
import { attachEpisodeReleaseData } from '../watchingShows.js'
import { createDeliveryStore } from '../../../scripts/notifications/deliveryStore.js'

const IST = (date, hour, minute = 0) => Date.parse(`${date}T00:00:00Z`) + (hour * 60 + minute) * 60 * 1000 - 19800000

function episodeAt(timestamp, number = 1, title = 'Episode') {
  const date = new Date(timestamp).toISOString().slice(0, 10)
  return attachEpisodeReleaseData(
    { season_number: 1, episode_number: number, name: title, air_date: date, releaseOverride: new Date(timestamp).toISOString() },
    {}, 1, classifyReleasePlatform({ networks: ['Apple TV+'] }),
  )
}

function show(episodes, watched = new Set()) {
  return {
    tmdb_id: 7, name: 'Lucky', status: { type: 'nextUp' }, watched, poster_path: '/lucky.jpg',
    details: { status: 'Returning Series', releasePlatform: classifyReleasePlatform({ networks: ['Apple TV+'] }) },
    episodesBySeason: { 1: episodes },
  }
}

function planAt(now, releaseTimestamp, { watched = new Set(), delivered = new Set(), episodes = null } = {}) {
  return buildNotificationPlan({
    shows: [show(episodes ?? [episodeAt(releaseTimestamp)], watched)], delivered, now,
  })
}

describe('10 PM IST watch reminders', () => {
  const morning = IST('2026-07-15', 8)
  const before = IST('2026-07-15', 21, 59)
  const at = IST('2026-07-15', 22)
  const catchUp = IST('2026-07-15', 23, 59)
  const after = IST('2026-07-16', 0)

  it('is not eligible before 10 PM, then is eligible at 10 PM through catch-up', () => {
    expect(planAt(before, morning).watchReminders).toHaveLength(0)
    expect(planAt(at, morning).watchReminders[0].notificationType).toBe(EPISODE_WATCH_REMINDER_TYPE)
    expect(planAt(catchUp, morning).watchReminders).toHaveLength(1)
    expect(planAt(after, morning).watchReminders).toHaveLength(0)
    expect(isWatchReminderWindow(at)).toBe(true)
    expect(isWatchReminderWindow(after)).toBe(false)
  })

  it('uses exclusive previous and inclusive current IST 10 PM cutoffs', () => {
    const cutoffs = watchReminderCutoffs(at)
    expect(planAt(at, cutoffs.previous).watchReminders).toHaveLength(0)
    expect(planAt(at, cutoffs.current).watchReminders).toHaveLength(1)
  })

  it('reminds a 11 PM release on the following day, not that night', () => {
    const lateRelease = IST('2026-07-15', 23)
    expect(planAt(IST('2026-07-15', 23, 59), lateRelease).watchReminders).toHaveLength(0)
    expect(planAt(IST('2026-07-16', 22), lateRelease).watchReminders).toHaveLength(1)
  })

  it('excludes old backlog and watched episodes while preserving availability behavior', () => {
    const old = IST('2026-07-13', 8)
    const watchedPlan = planAt(at, morning, { watched: new Set(['1:1']) })
    const oldPlan = planAt(at, old)
    expect(watchedPlan.notifications).toHaveLength(0)
    expect(watchedPlan.watchReminders).toHaveLength(0)
    expect(oldPlan.notifications).toHaveLength(0)
    expect(oldPlan.watchReminders).toHaveLength(0)
    expect(planAt(at, morning).notifications[0].notificationType).toBe(EPISODE_NOTIFICATION_TYPE)
  })

  it('keeps availability and reminder delivery identities independent', () => {
    const availability = deliveryIdentity(7, 1, 1)
    const reminder = deliveryIdentity(7, 1, 1, EPISODE_WATCH_REMINDER_TYPE)
    expect(availability).not.toBe(reminder)
    expect(planAt(at, morning, { delivered: new Set([availability]) }).watchReminders).toHaveLength(1)
    expect(planAt(at, morning, { delivered: new Set([reminder]) }).notifications).toHaveLength(1)
    expect(planAt(at, morning, { delivered: new Set([reminder]) }).watchReminders).toHaveLength(0)
  })

  it('groups naturally ordered reminder episodes with poster and Unicode text', () => {
    const plan = planAt(at, morning, { episodes: [episodeAt(morning, 2, 'Make ’em Dance'), episodeAt(morning, 1, 'No Shortcuts')] })
    expect(plan.watchReminders[0]).toMatchObject({
      title: 'Lucky — 2 new episodes', body: 'S1E1 · No Shortcuts\nS1E2 · Make ’em Dance',
      attachment: { url: 'https://image.tmdb.org/t/p/w342/lucky.jpg', filename: 'rerun-7.jpg' },
    })
  })

  it('failed reminder publishing releases claims and success completes reminder rows', async () => {
    const reminder = planAt(at, morning).watchReminders[0]
    const store = { claim: vi.fn(async () => reminder.episodes.map((episode) => episode.identity)), complete: vi.fn(), release: vi.fn() }
    await expect(executeNotificationPlan({ plan: { notifications: [], watchReminders: [reminder] }, enabled: true, deliveryStore: store, publish: async () => { throw new Error('down') } })).rejects.toThrow('down')
    expect(store.release).toHaveBeenCalledWith([reminder.episodes[0].identity])
    store.claim.mockResolvedValue(reminder.episodes.map((episode) => episode.identity))
    await executeNotificationPlan({ plan: { notifications: [], watchReminders: [reminder] }, enabled: true, deliveryStore: store, publish: async () => {} })
    expect(store.complete).toHaveBeenCalledWith([reminder.episodes[0].identity])
  })

  it('claims the distinct reminder notification type', async () => {
    let rpcArgs
    const supabase = {
      rpc: vi.fn(async (_name, args) => { rpcArgs = args; return { data: [{ identity: '7:1:1:episode_watch_reminder' }], error: null } }),
      from: vi.fn(() => ({ update: () => ({ error: null }) })),
    }
    const store = createDeliveryStore(supabase, () => new Date(IST('2026-07-15', 22)))
    const reminder = planAt(at, morning).watchReminders[0]
    await store.claim(reminder)
    expect(rpcArgs.p_episodes).toEqual([{ season_number: 1, episode_number: 1, notification_type: EPISODE_WATCH_REMINDER_TYPE }])
  })

  it('dry-run labels reminder notifications without side effects', async () => {
    const reminder = planAt(at, morning).watchReminders[0]
    const log = vi.fn()
    const store = { claim: vi.fn(), complete: vi.fn(), release: vi.fn() }
    await executeNotificationPlan({ plan: { notifications: [], watchReminders: [reminder] }, dryRun: true, deliveryStore: store, publish: vi.fn(), log })
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ type: 'wouldNotifyWatchReminder' }))
    expect(store.claim).not.toHaveBeenCalled()
  })
})

