import { describe, expect, it } from 'vitest'
import { classifyVideo, isAcceptableTrailer } from './trailerFilter.js'
import {
  buildTrailer, dedupeTrailers, rankTrailers, selectPerMedia, youtubeUrl, trailerVariant,
} from './trailerRank.js'
import { DISCOVER_TRAILER_MAX_AGE_MS } from './trailerFreshness.js'

const NOW = Date.parse('2026-07-23T00:00:00.000Z')

function video(overrides = {}) {
  return {
    key: 'abc123', site: 'YouTube', type: 'Trailer', name: 'Official Trailer',
    official: true, iso_639_1: 'en', published_at: '2026-07-01T00:00:00.000Z',
    size: 1080, ...overrides,
  }
}

describe('classifyVideo - accepted cases', () => {
  it('accepts flexible, unambiguous official trailer and teaser names', () => {
    const accepted = [
      ['Trailer', 'Official Trailer'],
      ['Trailer', 'Official Trailer 2'],
      ['Trailer', 'Final Trailer'],
      ['Trailer', 'Main Trailer'],
      ['Trailer', 'Teaser Trailer'],
      ['Teaser', 'Official Teaser'],
      ['Trailer', 'Season 2 Trailer'],
      ['Trailer', 'Trailer - Season 2'],
      ['Trailer', 'Trailer'],
      ['Teaser', 'Teaser'],
      ['Trailer', 'Red Band Trailer'],
      ['Trailer', 'Launch Trailer'],
      ['Trailer', "Final Trailer (Peter's Journey)"],
      ['Trailer', 'New Trailer'],
    ]
    for (const [type, name] of accepted) {
      expect(isAcceptableTrailer(video({ type, name })), name).toBe(true)
    }
  })
})

describe('classifyVideo - rejected cases', () => {
  it('requires a positive name signal even when TMDB says Trailer', () => {
    expect(isAcceptableTrailer(video({ name: 'One week until a brand new day' }))).toBe(false)
    expect(classifyVideo(video({ name: 'A brand new day' })).reasons)
      .toContain('missing_name_signal')
  })

  it('rejects episodic promotion and countdown material mistyped as trailers', () => {
    const rejected = [
      'Episode 2 Preview',
      'Episode 1 Official Trailer',
      'Episode One Trailer',
      'Next on Season 2 Trailer',
      'Coming Up Trailer',
      'This Week Trailer',
      'Next Week Trailer',
      'One week until the Official Trailer',
      '7 days to go Trailer',
      'Official Trailer Countdown',
    ]
    for (const name of rejected) {
      expect(isAcceptableTrailer(video({ name })), name).toBe(false)
    }
  })

  it('rejects promotional looks, promos, and date announcements', () => {
    for (const name of [
      'First Look Trailer',
      'Special Look Trailer',
      'Official Promo Trailer',
      'Date Announcement Trailer',
    ]) {
      expect(isAcceptableTrailer(video({ name })), name).toBe(false)
    }
  })

  it('rejects an Official Clip even when TMDB types it as a Trailer', () => {
    expect(isAcceptableTrailer(video({ name: 'Official Clip' }))).toBe(false)
  })

  it('rejects interviews, previews, sneak peeks, and inside-the-episode material', () => {
    expect(isAcceptableTrailer(video({ name: 'Cast Interview' }))).toBe(false)
    expect(isAcceptableTrailer(video({ name: 'Episode 4 Preview' }))).toBe(false)
    expect(isAcceptableTrailer(video({ name: 'Sneak Peek Trailer' }))).toBe(false)
    expect(isAcceptableTrailer(video({ name: 'Inside the Episode Trailer' }))).toBe(false)
  })

  it('rejects fan and concept trailers', () => {
    expect(isAcceptableTrailer(video({ type: 'Teaser', name: 'Concept Teaser' }))).toBe(false)
    expect(isAcceptableTrailer(video({ name: 'Concept Trailer' }))).toBe(false)
    expect(isAcceptableTrailer(video({ name: 'Fan Trailer' }))).toBe(false)
    expect(isAcceptableTrailer(video({ name: 'Fan Made Trailer' }))).toBe(false)
  })

  it('rejects non-trailer TMDB types', () => {
    expect(isAcceptableTrailer(video({ type: 'Clip', name: 'Trailer' }))).toBe(false)
    expect(isAcceptableTrailer(video({ type: 'Featurette', name: 'Trailer' }))).toBe(false)
    expect(isAcceptableTrailer(video({ type: 'Behind the Scenes', name: 'Trailer' }))).toBe(false)
  })

  it('rejects non-YouTube and missing-key records', () => {
    expect(isAcceptableTrailer(video({ site: 'Vimeo' }))).toBe(false)
    expect(isAcceptableTrailer(video({ key: null }))).toBe(false)
  })

  it('rejects unofficial uploads unless fallback is explicitly allowed', () => {
    expect(isAcceptableTrailer(video({ official: false }))).toBe(false)
    expect(isAcceptableTrailer(video({ official: false }), { allowUnofficialFallback: true })).toBe(true)
  })

  it('reports auditable rejection reasons', () => {
    expect(classifyVideo(video({ name: 'Official Clip' })).reasons).toContain('rejected_name')
  })
})

describe('trailer model + URL', () => {
  it('builds a watch?v= URL, never an embed URL', () => {
    expect(youtubeUrl('xyz')).toBe('https://www.youtube.com/watch?v=xyz')
    const trailer = buildTrailer(
      video({ key: 'xyz' }),
      { mediaType: 'tv', mediaId: 7, title: 'The Bear' },
    )
    expect(trailer.youtubeUrl).toBe('https://www.youtube.com/watch?v=xyz')
    expect(trailer.youtubeUrl).not.toContain('embed')
    expect(trailer.title).toBe('The Bear')
  })

  it('classifies distinct cuts', () => {
    expect(trailerVariant(video({ name: 'Final Trailer' }))).toBe('final')
    expect(trailerVariant(video({ type: 'Teaser', name: 'Teaser' }))).toBe('teaser')
    expect(trailerVariant(video({ name: 'Official Trailer' }))).toBe('trailer')
  })
})

describe('dedupe + ranking', () => {
  const context = { mediaType: 'tv', mediaId: 7, title: 'The Bear' }

  it('collapses duplicate keys and dubbed/regional reposts of the same cut', () => {
    const trailers = [
      buildTrailer(video({ key: 'a', name: 'Official Trailer', iso_639_1: 'en' }), context),
      buildTrailer(video({ key: 'a', name: 'Official Trailer' }), context),
      buildTrailer(video({ key: 'b', name: 'Official Trailer', iso_639_1: 'de' }), context),
    ]
    const result = dedupeTrailers(trailers)
    expect(result).toHaveLength(1)
    expect(result[0].language).toBe('en')
  })

  it('keeps a teaser and a trailer as distinct', () => {
    const trailers = [
      buildTrailer(video({ key: 'a', type: 'Trailer', name: 'Official Trailer' }), context),
      buildTrailer(video({ key: 'b', type: 'Teaser', name: 'Official Teaser' }), context),
    ]
    expect(selectPerMedia(trailers)).toHaveLength(2)
  })

  it('prefers the freshest eligible item in the final ranking', () => {
    const trailers = [
      buildTrailer(video({ key: 'old', published_at: '2026-01-01T00:00:00.000Z' }), context),
      buildTrailer(video({ key: 'new', published_at: '2026-07-01T00:00:00.000Z' }), context),
    ]
    expect(rankTrailers(trailers, { now: NOW })[0].videoKey).toBe('new')
  })

  it('includes the exact 45-day boundary and excludes older or undated videos', () => {
    const exact = buildTrailer(video({
      key: 'exact',
      published_at: new Date(NOW - DISCOVER_TRAILER_MAX_AGE_MS).toISOString(),
    }), { ...context, mediaId: 8 })
    const expired = buildTrailer(video({
      key: 'expired',
      published_at: new Date(NOW - DISCOVER_TRAILER_MAX_AGE_MS - 1).toISOString(),
    }), { ...context, mediaId: 9 })
    const missing = buildTrailer(
      video({ key: 'missing', published_at: null }),
      { ...context, mediaId: 10 },
    )
    const invalid = buildTrailer(
      video({ key: 'invalid', published_at: 'not-a-date' }),
      { ...context, mediaId: 11 },
    )

    expect(rankTrailers([expired, missing, invalid, exact], { now: NOW })
      .map((item) => item.videoKey)).toEqual(['exact'])
  })

  it('keeps same-cut dedupe while preserving meaningful fresh cuts', () => {
    const trailers = [
      buildTrailer(video({ key: 'main', name: 'Official Trailer' }), context),
      buildTrailer(video({ key: 'main', name: 'Official Trailer' }), context),
      buildTrailer(video({ key: 'regional', name: 'Official Trailer', iso_639_1: 'de' }), context),
      buildTrailer(video({ key: 'teaser', type: 'Teaser', name: 'Official Teaser' }), context),
      buildTrailer(video({
        key: 'final',
        name: 'Final Trailer',
        published_at: '2026-07-02T00:00:00.000Z',
      }), context),
    ]
    expect(rankTrailers(trailers, { now: NOW }).map((item) => item.videoKey))
      .toEqual(['final', 'main', 'teaser'])
  })
})
