import { describe, expect, it } from 'vitest'
import { classifyReleasePlatform } from '../releasePlatforms.js'
import { hasAiredAt } from '../watchHelpers.js'
import { attachEpisodeReleaseData } from '../watchingShows.js'
import { buildNotificationPlan, deliveryIdentity, posterAttachment } from './plan.js'

const IST_OFFSET = (5 * 60 + 30) * 60 * 1000
const atIST = (date, hour, minute = 0) => Date.parse(`${date}T00:00:00Z`) +
  (hour * 60 + minute) * 60 * 1000 - IST_OFFSET

function enrichedEpisode({ season = 1, number = 1, date = '2026-07-15', network = 'Apple TV+', title = 'Pilot' } = {}) {
  const platform = classifyReleasePlatform({ networks: [network] })
  return attachEpisodeReleaseData(
    { season_number: season, episode_number: number, name: title, air_date: date },
    { [`${season}:${number}`]: { airdate: date, airstamp: `${date}T00:00:00Z` } },
    season,
    platform,
  )
}

function show({ id = 1, name = 'Lucky', network = 'Apple TV+', episodes, watched = new Set(), status = { type: 'nextUp' }, hidden_at = null } = {}) {
  return {
    tmdb_id: id, name, hidden_at, status, watched,
    poster_path: '/poster.jpg',
    details: { releasePlatform: classifyReleasePlatform({ networks: [network] }) },
    episodesBySeason: { 1: episodes ?? [enrichedEpisode({ network })] },
  }
}

describe('notification planning', () => {
  it('derives only currently visible Watching shows and uses stable TMDB identities', () => {
    const active = show({ id: 10 })
    const hidden = show({ id: 11, hidden_at: '2026-07-01T00:00:00Z' })
    const completed = show({ id: 12, status: { type: 'completed' } })
    const plan = buildNotificationPlan({ shows: [active, hidden, completed], now: atIST('2026-07-15', 8) })
    expect(plan.notifications.map((item) => item.tmdbShowId)).toEqual([10])
    expect(plan.notifications[0].episodes[0].identity).toBe(deliveryIdentity(10, 1, 1))
  })

  it('excludes watched, future, delivered, specials, and raw-TMDB-only episodes', () => {
    const available = enrichedEpisode()
    const future = enrichedEpisode({ number: 2, date: '2026-07-16' })
    const raw = { season_number: 1, episode_number: 3, name: 'Raw', air_date: '2026-07-15', releasePlatform: classifyReleasePlatform({ networks: ['Apple TV+'] }) }
    const special = enrichedEpisode({ season: 0, number: 1 })
    const watched = new Set(['1:1'])
    const delivered = new Set([deliveryIdentity(20, 1, 2)])
    const plan = buildNotificationPlan({
      shows: [{ ...show({ id: 20, episodes: [available, future, raw], watched }), episodesBySeason: { 0: [special], 1: [available, future, raw] } }],
      delivered,
      now: atIST('2026-07-15', 20),
    })
    expect(plan.notifications).toEqual([])
    expect(plan.decisions.map((item) => item.reason)).toEqual(expect.arrayContaining([
      'watched', 'delivered', 'untrustedReleaseMetadata',
    ]))
  })

  it.each([
    ['HBO', 8], ['Max', 8], ['MGM+', 8], ['Apple TV+', 8], ['Apple TV', 8],
    ['Prime Video', 14], ['Netflix', 14], ['Disney+', 14], ['Hulu', 14], ['FX', 14],
    ['Peacock', 16], ['Unmapped Network', 18],
  ])('%s becomes eligible exactly at the unchanged %i:00 IST threshold', (network, hour) => {
    const candidate = show({ network, episodes: [enrichedEpisode({ network })] })
    expect(buildNotificationPlan({ shows: [candidate], now: atIST('2026-07-15', hour) - 1 }).notifications).toHaveLength(0)
    expect(buildNotificationPlan({ shows: [candidate], now: atIST('2026-07-15', hour) }).notifications).toHaveLength(1)
  })

  it('shares the same enriched availability result as every UI path', () => {
    const episode = enrichedEpisode({ network: 'Apple TV' })
    const before = atIST('2026-07-15', 8) - 1
    const atThreshold = before + 1
    expect(hasAiredAt(episode, before)).toBe(false)
    expect(buildNotificationPlan({ shows: [show({ episodes: [episode] })], now: before }).notifications).toHaveLength(0)
    expect(hasAiredAt(episode, atThreshold)).toBe(true)
    expect(buildNotificationPlan({ shows: [show({ episodes: [episode] })], now: atThreshold }).notifications).toHaveLength(1)
  })

  it('groups naturally ordered episodes per show while keeping shows separate', () => {
    const episodes = [
      enrichedEpisode({ number: 2, title: 'Second' }),
      enrichedEpisode({ number: 1, title: '' }),
    ]
    const plan = buildNotificationPlan({
      shows: [show({ id: 1, episodes }), show({ id: 2, name: 'Sugar' })],
      now: atIST('2026-07-15', 20),
    })
    expect(plan.notifications).toHaveLength(2)
    expect(plan.notifications[0]).toMatchObject({
      title: 'Lucky — 2 new episodes',
      body: 'S1E1\nS1E2 · Second',
    })
    expect(plan.notifications[1].title).toBe('Sugar — New episode')
  })

  it('creates a mobile HTTPS poster attachment and safely tolerates no poster', () => {
    expect(posterAttachment('/abc123.jpg', 42)).toEqual({
      url: 'https://image.tmdb.org/t/p/w342/abc123.jpg',
      filename: 'rerun-42.jpg',
    })
    expect(posterAttachment(null, 42)).toBeNull()
    const candidate = { ...show(), poster_path: null, details: { releasePlatform: classifyReleasePlatform({ networks: ['Apple TV+'] }), poster_path: null } }
    expect(buildNotificationPlan({ shows: [candidate], now: atIST('2026-07-15', 8) }).notifications[0].attachment).toBeNull()
  })
})
