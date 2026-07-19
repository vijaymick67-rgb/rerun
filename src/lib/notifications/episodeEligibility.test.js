import { describe, expect, it } from 'vitest'
import {
  buildEpisodeNotificationPayload,
  collectAiredUnwatchedEpisodes,
  episodeNotificationTag,
  episodeNotificationUrl,
  episodesSinceWatermark,
} from './episodeEligibility.js'

// 2026-07-19T08:00:00Z is a fixed "now" used throughout — everything below
// is expressed relative to it so eligibility boundaries stay exact.
const NOW = Date.parse('2026-07-19T08:00:00Z')
const VISIBLE_STATUS = { type: 'nextUp' }

// releaseOverride takes precedence over every other release source and
// round-trips to the exact instant given (at minute precision — NOW and its
// offsets below all land on whole-minute IST boundaries), so tests can pin
// an episode's resolved release timestamp exactly without depending on
// platform-threshold defaults.
function episode(overrides = {}) {
  return { episode_number: 1, name: 'Pilot', ...overrides }
}

function withRelease(msOffsetFromNow) {
  return episode({ releaseOverride: new Date(NOW + msOffsetFromNow).toISOString() })
}

describe('collectAiredUnwatchedEpisodes', () => {
  it('returns an aired, unwatched episode for a visible show', () => {
    const show = { tmdb_id: 1, name: 'Test Show' }
    const episodesBySeason = { 1: [withRelease(-60 * 60 * 1000)] }
    const result = collectAiredUnwatchedEpisodes({
      show, status: VISIBLE_STATUS, episodesBySeason, watched: new Set(), evaluationTime: NOW,
    })
    expect(result).toEqual([
      { seasonNumber: 1, episodeNumber: 1, name: 'Pilot', releaseTimestamp: NOW - 60 * 60 * 1000 },
    ])
  })

  it('skips an episode with no real availability timestamp', () => {
    const show = { tmdb_id: 1, name: 'Test Show' }
    const episodesBySeason = { 1: [episode()] }
    const result = collectAiredUnwatchedEpisodes({
      show, status: VISIBLE_STATUS, episodesBySeason, watched: new Set(), evaluationTime: NOW,
    })
    expect(result).toEqual([])
  })

  it('exact boundary: a release exactly at evaluationTime is eligible', () => {
    const show = { tmdb_id: 1, name: 'Test Show' }
    const episodesBySeason = { 1: [withRelease(0)] }
    const result = collectAiredUnwatchedEpisodes({
      show, status: VISIBLE_STATUS, episodesBySeason, watched: new Set(), evaluationTime: NOW,
    })
    expect(result).toHaveLength(1)
  })

  it('skips a release one minute after evaluationTime', () => {
    const show = { tmdb_id: 1, name: 'Test Show' }
    const episodesBySeason = { 1: [withRelease(60 * 1000)] }
    const result = collectAiredUnwatchedEpisodes({
      show, status: VISIBLE_STATUS, episodesBySeason, watched: new Set(), evaluationTime: NOW,
    })
    expect(result).toEqual([])
  })

  it('skips an already-watched episode', () => {
    const show = { tmdb_id: 1, name: 'Test Show' }
    const episodesBySeason = { 1: [withRelease(-60 * 60 * 1000)] }
    const result = collectAiredUnwatchedEpisodes({
      show, status: VISIBLE_STATUS, episodesBySeason, watched: new Set(['1:1']), evaluationTime: NOW,
    })
    expect(result).toEqual([])
  })

  it('never sees season 0 specials — episodesBySeason from loadWatchingShowData excludes them', () => {
    const show = { tmdb_id: 1, name: 'Test Show' }
    // A caller could still hand in a season-0 key defensively; it must be ignored.
    const episodesBySeason = { 0: [withRelease(-60 * 60 * 1000)] }
    const result = collectAiredUnwatchedEpisodes({
      show, status: VISIBLE_STATUS, episodesBySeason, watched: new Set(), evaluationTime: NOW,
    })
    expect(result).toEqual([])
  })

  it('a hidden show yields no eligible episodes regardless of status', () => {
    const show = { tmdb_id: 1, name: 'Test Show', hidden_at: '2026-01-01T00:00:00Z' }
    const episodesBySeason = { 1: [withRelease(-60 * 60 * 1000)] }
    const result = collectAiredUnwatchedEpisodes({
      show, status: VISIBLE_STATUS, episodesBySeason, watched: new Set(), evaluationTime: NOW,
    })
    expect(result).toEqual([])
  })

  it('a finished show whose status is caughtUp yields no eligible episodes', () => {
    const show = { tmdb_id: 1, name: 'Test Show', finished_at: '2026-01-01T00:00:00Z' }
    const episodesBySeason = { 1: [withRelease(-60 * 60 * 1000)] }
    const result = collectAiredUnwatchedEpisodes({
      show, status: { type: 'caughtUp' }, episodesBySeason, watched: new Set(), evaluationTime: NOW,
    })
    expect(result).toEqual([])
  })

  it('a finished show whose status is nextUp (returned) still yields episodes', () => {
    const show = { tmdb_id: 1, name: 'Test Show', finished_at: '2026-01-01T00:00:00Z' }
    const episodesBySeason = { 1: [withRelease(-60 * 60 * 1000)] }
    const result = collectAiredUnwatchedEpisodes({
      show, status: { type: 'nextUp' }, episodesBySeason, watched: new Set(), evaluationTime: NOW,
    })
    expect(result).toHaveLength(1)
  })

  it('prefers a TVmaze airstamp over the raw TMDB air_date when both are present', () => {
    const show = { tmdb_id: 1, name: 'Test Show' }
    // TMDB's air_date alone would already read as aired well before NOW; the
    // attached TVmaze airstamp says the real release is still two days out —
    // eligibility must follow TVmaze, not the plain TMDB date string.
    const episodesBySeason = {
      1: [episode({ air_date: '2026-07-17', airstamp: '2026-07-21T00:00:00Z' })],
    }
    const result = collectAiredUnwatchedEpisodes({
      show, status: VISIBLE_STATUS, episodesBySeason, watched: new Set(), evaluationTime: NOW,
    })
    expect(result).toEqual([]) // not yet aired per the more precise TVmaze instant
  })

  it('an IST platform-threshold boundary from a TMDB-only air_date (no TVmaze data) resolves correctly', () => {
    const show = { tmdb_id: 1, name: 'Test Show' }
    // air_date '2026-07-18' with the default 'unknown' platform threshold
    // (18:00 IST = 12:30 UTC) resolves to exactly 2026-07-18T12:30:00Z.
    const episodesBySeason = { 1: [episode({ air_date: '2026-07-18' })] }

    const justBefore = collectAiredUnwatchedEpisodes({
      show, status: VISIBLE_STATUS, episodesBySeason, watched: new Set(),
      evaluationTime: Date.parse('2026-07-18T12:29:59Z'),
    })
    expect(justBefore).toEqual([])

    const atThreshold = collectAiredUnwatchedEpisodes({
      show, status: VISIBLE_STATUS, episodesBySeason, watched: new Set(),
      evaluationTime: Date.parse('2026-07-18T12:30:00Z'),
    })
    expect(atThreshold).toHaveLength(1)
  })

  it('sorts results by season then episode number', () => {
    const show = { tmdb_id: 1, name: 'Test Show' }
    const episodesBySeason = {
      2: [episode({ episode_number: 1, releaseOverride: new Date(NOW - 1000).toISOString() })],
      1: [
        episode({ episode_number: 2, releaseOverride: new Date(NOW - 1000).toISOString() }),
        episode({ episode_number: 1, releaseOverride: new Date(NOW - 1000).toISOString() }),
      ],
    }
    const result = collectAiredUnwatchedEpisodes({
      show, status: VISIBLE_STATUS, episodesBySeason, watched: new Set(), evaluationTime: NOW,
    })
    expect(result.map((ep) => [ep.seasonNumber, ep.episodeNumber])).toEqual([[1, 1], [1, 2], [2, 1]])
  })
})

describe('episodesSinceWatermark', () => {
  const episodes = [
    { seasonNumber: 1, episodeNumber: 1, name: 'A', releaseTimestamp: 1000 },
    { seasonNumber: 1, episodeNumber: 2, name: 'B', releaseTimestamp: 2000 },
  ]

  it('keeps only episodes released strictly after the watermark', () => {
    expect(episodesSinceWatermark(episodes, 1000)).toEqual([episodes[1]])
  })

  it('an episode released exactly at the watermark is treated as backlog (skipped)', () => {
    expect(episodesSinceWatermark(episodes, 1000).map((ep) => ep.episodeNumber)).toEqual([2])
  })

  it('an episode released after the watermark is eligible', () => {
    expect(episodesSinceWatermark(episodes, 1999)).toEqual([episodes[1]])
  })

  it('returns nothing for a non-finite watermark', () => {
    expect(episodesSinceWatermark(episodes, null)).toEqual([])
    expect(episodesSinceWatermark(episodes, undefined)).toEqual([])
  })
})

describe('buildEpisodeNotificationPayload', () => {
  it('single episode with a title', () => {
    const payload = buildEpisodeNotificationPayload(42, 'Test Show', [
      { seasonNumber: 2, episodeNumber: 5, name: 'The Return' },
    ])
    expect(payload.title).toBe('Test Show — New episode available')
    expect(payload.body).toBe('S2E5 · The Return')
    expect(payload.url).toBe('/watching/42')
    expect(payload.tag).toBe('rerun-episode-42-s2e5')
  })

  it('single episode with a missing title falls back to Season/Episode wording', () => {
    const payload = buildEpisodeNotificationPayload(42, 'Test Show', [
      { seasonNumber: 2, episodeNumber: 5, name: null },
    ])
    expect(payload.body).toBe('Season 2, Episode 5')
  })

  it('multiple episodes of the same season group into one "season is ready" body', () => {
    const payload = buildEpisodeNotificationPayload(42, 'Test Show', [
      { seasonNumber: 3, episodeNumber: 1, name: 'A' },
      { seasonNumber: 3, episodeNumber: 2, name: 'B' },
    ])
    expect(payload.title).toBe('Test Show — 2 new episodes available')
    expect(payload.body).toBe('Season 3 is ready')
    expect(payload.tag).toBe('rerun-episode-42-batch')
  })

  it('multiple episodes spanning seasons use the truthful generic body', () => {
    const payload = buildEpisodeNotificationPayload(42, 'Test Show', [
      { seasonNumber: 1, episodeNumber: 9, name: 'A' },
      { seasonNumber: 2, episodeNumber: 1, name: 'B' },
    ])
    expect(payload.title).toBe('Test Show — 2 new episodes available')
    expect(payload.body).toBe('New episodes are ready to watch')
  })
})

describe('episodeNotificationUrl', () => {
  it('opens the show-detail route for a valid tmdbId', () => {
    expect(episodeNotificationUrl(42)).toBe('/watching/42')
  })

  it('falls back to /watching when an exact route cannot safely be produced', () => {
    expect(episodeNotificationUrl(null)).toBe('/watching')
    expect(episodeNotificationUrl(0)).toBe('/watching')
    expect(episodeNotificationUrl(-1)).toBe('/watching')
    expect(episodeNotificationUrl(NaN)).toBe('/watching')
  })
})

describe('episodeNotificationTag', () => {
  it('is stable across repeated calls for the same show/episode', () => {
    const episodes = [{ seasonNumber: 1, episodeNumber: 1 }]
    expect(episodeNotificationTag(42, episodes)).toBe(episodeNotificationTag(42, episodes))
  })
})
