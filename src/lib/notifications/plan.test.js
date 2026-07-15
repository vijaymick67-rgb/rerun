import { describe, expect, it } from 'vitest'
import { classifyReleasePlatform } from '../releasePlatforms.js'
import { hasAiredAt } from '../watchHelpers.js'
import { attachEpisodeReleaseData } from '../watchingShows.js'
import {
  buildNotificationPlan,
  deliveryIdentity,
  isShowCurrentlyAiringForNotifications,
  NOTIFICATION_LOOKBACK_MS,
  posterAttachment,
} from './plan.js'

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

function episodeReleasedAt(timestamp, { season = 1, number = 1, network = 'Apple TV+', title = 'Pilot' } = {}) {
  const date = new Date(timestamp).toISOString().slice(0, 10)
  return attachEpisodeReleaseData(
    { season_number: season, episode_number: number, name: title, air_date: date, releaseOverride: new Date(timestamp).toISOString() },
    {},
    season,
    classifyReleasePlatform({ networks: [network] }),
  )
}

function show({ id = 1, name = 'Lucky', network = 'Apple TV+', episodes, watched = new Set(), status = { type: 'nextUp' }, hidden_at = null, showStatus = 'Returning Series' } = {}) {
  return {
    tmdb_id: id, name, hidden_at, status, watched,
    poster_path: '/poster.jpg',
    details: { status: showStatus, releasePlatform: classifyReleasePlatform({ networks: [network] }) },
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

  it('includes only episodes released within the exact 24-hour notification window', () => {
    const now = Date.parse('2026-07-15T12:00:00Z')
    const recent = episodeReleasedAt(now - NOTIFICATION_LOOKBACK_MS + 60_000, { number: 1 })
    const exactBoundary = episodeReleasedAt(now - NOTIFICATION_LOOKBACK_MS, { number: 2 })
    const older = episodeReleasedAt(now - NOTIFICATION_LOOKBACK_MS - 60_000, { number: 3 })
    const plan = buildNotificationPlan({ shows: [show({ episodes: [recent, exactBoundary, older] })], now })
    expect(plan.notifications[0].episodes.map((episode) => episode.episodeNumber)).toEqual([1])
    expect(plan.decisions.filter((decision) => decision.reason === 'outsideNotificationWindow')).toHaveLength(2)
  })

  it('prevents old Frasier and Sopranos backlogs while grouping recent Lucky episodes', () => {
    const now = Date.parse('2026-07-15T12:00:00Z')
    const old = Date.parse('2007-01-01T12:00:00Z')
    const recent = now - 60 * 60 * 1000
    const plan = buildNotificationPlan({
      shows: [
        show({ id: 101, name: 'Frasier', episodes: [episodeReleasedAt(old)] }),
        show({ id: 102, name: 'The Sopranos', episodes: [episodeReleasedAt(old)] }),
        show({ id: 103, name: 'Lucky', episodes: [
          episodeReleasedAt(recent, { number: 2, title: 'Second' }),
          episodeReleasedAt(recent, { number: 1, title: 'First' }),
        ] }),
      ],
      now,
    })
    expect(plan.notifications).toHaveLength(1)
    expect(plan.notifications[0]).toMatchObject({ tmdbShowId: 103, body: 'S1E1 · First\nS1E2 · Second' })
  })

  it.each([
    ['Returning Series', true],
    ['In Production', true],
    ['Ended', false],
    ['Canceled', false],
    ['Planned', false],
    ['Pilot', false],
    [null, false],
    ['Unexpected Status', false],
  ])('treats %s as notification-current=%s', (showStatus, expected) => {
    expect(isShowCurrentlyAiringForNotifications(show({ showStatus }))).toBe(expected)
  })

  it('conservatively rejects missing show status metadata', () => {
    const candidate = show()
    delete candidate.details.status
    expect(isShowCurrentlyAiringForNotifications(candidate)).toBe(false)
  })

  it('excludes a recently released episode for an ended show with an explicit reason', () => {
    const now = Date.parse('2026-07-15T12:00:00Z')
    const plan = buildNotificationPlan({
      shows: [show({ showStatus: 'Ended', episodes: [episodeReleasedAt(now - 60_000)] })],
      now,
    })
    expect(plan.notifications).toEqual([])
    expect(plan.decisions).toContainEqual(expect.objectContaining({ reason: 'showNotCurrentlyAiring' }))
  })

  it('still excludes recent watched and delivered episodes and future episodes', () => {
    const now = Date.parse('2026-07-15T12:00:00Z')
    const recentWatched = episodeReleasedAt(now - 60_000, { number: 1 })
    const recentDelivered = episodeReleasedAt(now - 60_000, { number: 2 })
    const future = episodeReleasedAt(now + 60_000, { number: 3 })
    const plan = buildNotificationPlan({
      shows: [show({ id: 88, episodes: [recentWatched, recentDelivered, future], watched: new Set(['1:1']) })],
      delivered: new Set([deliveryIdentity(88, 1, 2)]),
      now,
    })
    expect(plan.notifications).toEqual([])
    expect(plan.decisions.map((decision) => decision.reason)).toEqual(expect.arrayContaining(['watched', 'delivered', 'notAvailable']))
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
    const candidate = { ...show(), poster_path: null, details: { status: 'Returning Series', releasePlatform: classifyReleasePlatform({ networks: ['Apple TV+'] }), poster_path: null } }
    expect(buildNotificationPlan({ shows: [candidate], now: atIST('2026-07-15', 8) }).notifications[0].attachment).toBeNull()
  })
})
