import { classifyReleasePlatform } from '../../src/lib/releasePlatforms.js'
import { attachEpisodeReleaseData } from '../../src/lib/watchingShows.js'
import { buildNotificationPlan, deliveryIdentity, EPISODE_WATCH_REMINDER_TYPE } from '../../src/lib/notifications/plan.js'

const IST_OFFSET = 19800000
const ist = (date, hour, minute = 0) => Date.parse(`${date}T00:00:00Z`) + (hour * 60 + minute) * 60000 - IST_OFFSET

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

const morningRelease = ist('2026-07-15', 8)
const lateRelease = ist('2026-07-15', 23)
const reminderTimes = [
  ['9:59 PM IST', ist('2026-07-15', 21, 59)],
  ['10:00 PM IST', ist('2026-07-15', 22)],
  ['10:15 PM IST', ist('2026-07-15', 22, 15)],
  ['11:59 PM IST', ist('2026-07-15', 23, 59)],
  ['12:00 AM IST', ist('2026-07-16', 0)],
]

const cases = reminderTimes.map(([label, now]) => ({
  label, now: new Date(now).toISOString(),
  reminderCount: buildNotificationPlan({ shows: [show([episodeAt(morningRelease)])], now }).watchReminders.length,
}))
cases.push(
  {
    label: '11 PM release same night',
    reminderCount: buildNotificationPlan({ shows: [show([episodeAt(lateRelease)])], now: ist('2026-07-15', 23, 59) }).watchReminders.length,
  },
  {
    label: '11 PM release next day',
    reminderCount: buildNotificationPlan({ shows: [show([episodeAt(lateRelease)])], now: ist('2026-07-16', 22) }).watchReminders.length,
  },
  {
    label: 'watched before reminder',
    reminderCount: buildNotificationPlan({ shows: [show([episodeAt(morningRelease)], new Set(['1:1']))], now: ist('2026-07-15', 22) }).watchReminders.length,
  },
  {
    label: 'availability delivered only',
    reminderCount: buildNotificationPlan({ shows: [show([episodeAt(morningRelease)])], delivered: new Set([deliveryIdentity(7, 1, 1)]), now: ist('2026-07-15', 22) }).watchReminders.length,
  },
  {
    label: 'both delivery types delivered',
    reminderCount: buildNotificationPlan({ shows: [show([episodeAt(morningRelease)])], delivered: new Set([
      deliveryIdentity(7, 1, 1), deliveryIdentity(7, 1, 1, EPISODE_WATCH_REMINDER_TYPE),
    ]), now: ist('2026-07-15', 22) }).watchReminders.length,
  },
)

if (cases[0].reminderCount !== 0 || cases[1].reminderCount !== 1 || cases[3].reminderCount !== 1 || cases[4].reminderCount !== 0) {
  throw new Error('unexpected IST reminder window simulation result')
}
console.log(JSON.stringify(cases, null, 2))

