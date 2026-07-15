import { classifyReleasePlatform } from '../../src/lib/releasePlatforms.js'
import { executeNotificationPlan } from '../../src/lib/notifications/execute.js'
import { buildNotificationPlan } from '../../src/lib/notifications/plan.js'
import { attachEpisodeReleaseData } from '../../src/lib/watchingShows.js'

const now = Date.parse('2026-07-15T14:30:00Z')
function episode(network, number, title, date = '2026-07-15') {
  return attachEpisodeReleaseData(
    { season_number: 1, episode_number: number, name: title, air_date: date },
    { [`1:${number}`]: { airstamp: `${date}T00:00:00Z`, airdate: date } },
    1,
    classifyReleasePlatform({ networks: [network] }),
  )
}
function show(id, name, network, episodes, options = {}) {
  return {
    tmdb_id: id,
    name,
    poster_path: options.poster === false ? null : `/${id}.jpg`,
    status: { type: 'nextUp' },
    watched: new Set(options.watched ?? []),
    details: { releasePlatform: classifyReleasePlatform({ networks: [network] }) },
    episodesBySeason: { 1: episodes },
  }
}

const shows = [
  show(1, 'Apple fixture', 'Apple TV+', [episode('Apple TV+', 1, 'Apple episode')]),
  show(2, 'HBO fixture', 'Max', [episode('Max', 1, 'HBO episode')]),
  show(3, 'Unknown fixture', 'Unmapped', [episode('Unmapped', 1, 'Unknown episode')], { poster: false }),
  show(4, 'Watched fixture', 'Apple TV+', [episode('Apple TV+', 1, 'Watched')], { watched: ['1:1'] }),
  show(5, 'Grouped fixture', 'Apple TV+', [
    episode('Apple TV+', 2, 'Second'), episode('Apple TV+', 1, 'First'),
  ]),
]

const firstPlan = buildNotificationPlan({ shows, now })
const delivered = new Set()
let failOnce = true
const store = {
  async claim(notification) {
    return notification.episodes.map((item) => item.identity).filter((identity) => !delivered.has(identity))
  },
  async complete(identities) { for (const identity of identities) delivered.add(identity) },
  async release() {},
}
try {
  await executeNotificationPlan({
    plan: firstPlan, enabled: true, deliveryStore: store,
    publish: async (notification) => {
      if (notification.tmdbShowId === 3 && failOnce) {
        failOnce = false
        throw new Error('simulated ntfy failure')
      }
    },
  })
} catch (error) {
  console.log(error.message)
}
await executeNotificationPlan({
  plan: firstPlan, enabled: true, deliveryStore: store, publish: async () => {},
})
const duplicate = await executeNotificationPlan({
  plan: firstPlan, enabled: true, deliveryStore: store, publish: async () => {},
})

console.log(JSON.stringify({
  planned: firstPlan.notifications.map((item) => ({
    show: item.showName, body: item.body, poster: item.attachment?.url ?? null,
  })),
  excluded: firstPlan.decisions.filter((item) => item.reason !== 'included').map((item) => ({
    show: item.showName, reason: item.reason,
  })),
  delivered: [...delivered].sort(),
  duplicateRerunSent: duplicate.sent,
}, null, 2))
