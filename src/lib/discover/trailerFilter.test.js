import { describe, it, expect } from 'vitest'
import { classifyVideo, isAcceptableTrailer } from './trailerFilter.js'
import {
  buildTrailer, dedupeTrailers, rankTrailers, selectPerMedia, youtubeUrl, trailerVariant,
} from './trailerRank.js'

function video(overrides = {}) {
  return {
    key: 'abc123', site: 'YouTube', type: 'Trailer', name: 'Official Trailer',
    official: true, iso_639_1: 'en', published_at: '2026-07-01T00:00:00.000Z', size: 1080, ...overrides,
  }
}

describe('classifyVideo — accepted cases (Scope R)', () => {
  it('accepts clean official trailers and teasers', () => {
    expect(isAcceptableTrailer(video({ name: 'Official Trailer' }))).toBe(true)
    expect(isAcceptableTrailer(video({ name: 'Final Trailer' }))).toBe(true)
    expect(isAcceptableTrailer(video({ type: 'Teaser', name: 'Official Teaser' }))).toBe(true)
    expect(isAcceptableTrailer(video({ name: 'Season 3 Official Trailer' }))).toBe(true)
  })
})

describe('classifyVideo — rejected cases (Scope R)', () => {
  it('rejects an Official Clip even when TMDB types it as a Trailer', () => {
    expect(isAcceptableTrailer(video({ name: 'Official Clip' }))).toBe(false)
  })

  it('rejects interviews, previews, sneak peeks, inside-the-episode', () => {
    expect(isAcceptableTrailer(video({ name: 'Cast Interview' }))).toBe(false)
    expect(isAcceptableTrailer(video({ name: 'Episode 4 Preview' }))).toBe(false)
    expect(isAcceptableTrailer(video({ name: 'Sneak Peek' }))).toBe(false)
    expect(isAcceptableTrailer(video({ name: 'Inside the Episode' }))).toBe(false)
    expect(isAcceptableTrailer(video({ type: 'Teaser', name: 'Concept Teaser' }))).toBe(false)
  })

  it('rejects non-trailer TMDB types', () => {
    expect(isAcceptableTrailer(video({ type: 'Clip', name: 'Clip' }))).toBe(false)
    expect(isAcceptableTrailer(video({ type: 'Featurette', name: 'Featurette' }))).toBe(false)
    expect(isAcceptableTrailer(video({ type: 'Behind the Scenes', name: 'BTS' }))).toBe(false)
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
    const t = buildTrailer(video({ key: 'xyz' }), { mediaType: 'tv', mediaId: 7, title: 'The Bear' })
    expect(t.youtubeUrl).toBe('https://www.youtube.com/watch?v=xyz')
    expect(t.youtubeUrl).not.toContain('embed')
    expect(t.title).toBe('The Bear')
  })

  it('classifies distinct cuts', () => {
    expect(trailerVariant(video({ name: 'Final Trailer' }))).toBe('final')
    expect(trailerVariant(video({ type: 'Teaser', name: 'Teaser' }))).toBe('teaser')
    expect(trailerVariant(video({ name: 'Official Trailer' }))).toBe('trailer')
  })
})

describe('dedupe + ranking', () => {
  const ctx = { mediaType: 'tv', mediaId: 7, title: 'The Bear' }

  it('collapses duplicate keys and dubbed/regional reposts of the same cut', () => {
    const trailers = [
      buildTrailer(video({ key: 'a', name: 'Official Trailer', iso_639_1: 'en' }), ctx),
      buildTrailer(video({ key: 'a', name: 'Official Trailer' }), ctx), // exact dup key
      buildTrailer(video({ key: 'b', name: 'Official Trailer', iso_639_1: 'de' }), ctx), // German repost
    ]
    const result = dedupeTrailers(trailers)
    expect(result).toHaveLength(1)
    expect(result[0].language).toBe('en') // English preferred over the dub
  })

  it('keeps a teaser and a trailer as distinct', () => {
    const trailers = [
      buildTrailer(video({ key: 'a', type: 'Trailer', name: 'Official Trailer' }), ctx),
      buildTrailer(video({ key: 'b', type: 'Teaser', name: 'Official Teaser' }), ctx),
    ]
    expect(selectPerMedia(trailers)).toHaveLength(2)
  })

  it('prefers official and freshest in the final ranking', () => {
    const trailers = [
      buildTrailer(video({ key: 'old', published_at: '2026-01-01T00:00:00.000Z' }), ctx),
      buildTrailer(video({ key: 'new', published_at: '2026-07-01T00:00:00.000Z' }), ctx),
    ]
    // Same cut/media -> selectPerMedia keeps the freshest single trailer.
    const ranked = rankTrailers(trailers)
    expect(ranked[0].videoKey).toBe('new')
  })
})
