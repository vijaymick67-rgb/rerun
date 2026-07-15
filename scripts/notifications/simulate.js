import { classifyReleasePlatform } from '../../src/lib/releasePlatforms.js'
import { buildNotificationPlan, deliveryIdentity } from '../../src/lib/notifications/plan.js'
import { attachEpisodeReleaseData } from '../../src/lib/watchingShows.js'

const now = Date.parse('2026-07-15T12:00:00Z')

function episodeAt(timestamp, number, title, network = 'Apple TV+') {
  const date = new Date(timestamp).toISOString().slice(0, 10)
  return attachEpisodeReleaseData(
    {
      season_number: 1,
      episode_number: number,
      name: title,
      air_date: date,
      releaseOverride: new Date(timestamp).toISOString(),
    },
    {},
    1,
    classifyReleasePlatform({ networks: [network] }),
  )
}

function show(id, name, episodes, options = {}) {
  return {
    tmdb_id: id,
    name,
    poster_path: options.poster === false ? null : `/${id}.jpg`,
    status: { type: 'nextUp' },
    watched: new Set(options.watched ?? []),
    details: {
      status: options.status ?? 'Returning Series',
      releasePlatform: classifyReleasePlatform({ networks: [options.network ?? 'Apple TV+'] }),
    },
    episodesBySeason: { 1: episodes },
  }
}

const hour = 60 * 60 * 1000
const fixtures = [
  show(1, 'Frasier', [episodeAt(Date.parse('2004-05-13T01:00:00Z'), 1, 'Historical backlog')]),
  show(2, 'The Sopranos', [episodeAt(Date.parse('2007-06-11T01:00:00Z'), 1, 'Historical backlog')]),
  show(3, 'Lucky', [
    episodeAt(now - hour, 2, 'Second recent episode'),
    episodeAt(now - 2 * hour, 1, 'First recent episode'),
  ]),
  show(4, 'Maximum Pleasure Guaranteed', [episodeAt(now - hour, 10, 'Recent episode')]),
  show(5, 'Sugar', [episodeAt(now + hour, 3, 'Future episode')]),
  show(6, 'Cape Fear', [episodeAt(now + hour, 4, 'Future episode')]),
  show(7, 'Watched fixture', [episodeAt(now - hour, 1, 'Already watched')], { watched: ['1:1'] }),
  show(8, 'Delivered fixture', [episodeAt(now - hour, 1, 'Already delivered')]),
  show(9, 'Ended fixture', [episodeAt(now - hour, 1, 'Recent but ended')], { status: 'Ended' }),
]

const plan = buildNotificationPlan({
  shows: fixtures,
  delivered: new Set([deliveryIdentity(8, 1, 1)]),
  now,
})

const plannedByShow = new Map(plan.notifications.map((notification) => [notification.showName, notification]))
const expected = {
  Frasier: 0,
  'The Sopranos': 0,
  Lucky: 2,
  'Maximum Pleasure Guaranteed': 1,
  Sugar: 0,
  'Cape Fear': 0,
  'Watched fixture': 0,
  'Delivered fixture': 0,
  'Ended fixture': 0,
}

for (const [showName, count] of Object.entries(expected)) {
  const actual = plannedByShow.get(showName)?.episodes.length ?? 0
  if (actual !== count) throw new Error(`${showName}: expected ${count} planned episodes, received ${actual}`)
}

console.log(JSON.stringify({
  now: new Date(now).toISOString(),
  planned: plan.notifications.map((notification) => ({
    show: notification.showName,
    episodeCount: notification.episodes.length,
    body: notification.body,
    poster: notification.attachment?.url ?? null,
  })),
  excluded: plan.decisions
    .filter((decision) => decision.reason !== 'included')
    .map((decision) => ({ show: decision.showName, reason: decision.reason })),
}, null, 2))
