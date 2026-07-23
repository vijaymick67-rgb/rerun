import { describe, it, expect } from 'vitest'
import { buildShowIdentity, buildIdentityRegistry, AMBIGUITY } from './identities.js'

describe('buildShowIdentity', () => {
  it('builds a normalized identity from name alone', () => {
    const identity = buildShowIdentity({ tmdb_id: 1, name: 'The Bear' })
    expect(identity.tmdbId).toBe(1)
    expect(identity.canonicalTitle).toBe('The Bear')
    expect(identity.normalizedCanonical).toBe('the bear')
    expect(identity.primaryForms).toContain('the bear')
    expect(identity.secondaryForms).toContain('bear')
    expect(identity.ambiguity).toBe(AMBIGUITY.DISTINCT)
  })

  it('returns null without an id or title', () => {
    expect(buildShowIdentity({ name: 'No Id' })).toBe(null)
    expect(buildShowIdentity({ tmdb_id: 1 })).toBe(null)
  })

  it('classifies ultra-ambiguous pronoun/preposition titles', () => {
    expect(buildShowIdentity({ tmdb_id: 1, name: 'From' }).ambiguity).toBe(AMBIGUITY.ULTRA)
    expect(buildShowIdentity({ tmdb_id: 2, name: 'You' }).ambiguity).toBe(AMBIGUITY.ULTRA)
  })

  it('classifies single common-word titles as high ambiguity', () => {
    for (const name of ['Dark', 'Industry', 'Love', 'Beef', 'Sugar', 'Evil', 'Lost', 'Found', 'Wednesday', 'Upload']) {
      expect(buildShowIdentity({ tmdb_id: 1, name }).ambiguity).toBe(AMBIGUITY.HIGH)
    }
  })

  it('classifies multi-word titles as distinct', () => {
    expect(buildShowIdentity({ tmdb_id: 1, name: 'The Last of Us' }).ambiguity).toBe(AMBIGUITY.DISTINCT)
    expect(buildShowIdentity({ tmdb_id: 2, name: 'A Man on the Inside' }).ambiguity).toBe(AMBIGUITY.DISTINCT)
  })

  it('pulls verified alternative titles and metadata from TMDB details', () => {
    const identity = buildShowIdentity(
      { tmdb_id: 42, name: 'Shogun' },
      {
        id: 42,
        original_name: '将軍',
        first_air_date: '2024-02-27',
        origin_country: ['US'],
        networks: [{ name: 'FX' }],
        alternative_titles: [{ title: 'Shōgun' }, { title: 'James Clavell\'s Shogun' }],
        credits: { cast: [{ name: 'Hiroyuki Sanada' }, { name: 'Anna Sawai' }] },
      },
    )
    expect(identity.firstAirYear).toBe(2024)
    expect(identity.networks).toContain('fx')
    expect(identity.originCountry).toEqual(['US'])
    expect(identity.knownCast).toContain('hiroyuki sanada')
    expect(identity.primaryForms).toContain('james clavell s shogun')
  })

  it('never synthesizes aliases by dropping arbitrary words', () => {
    const identity = buildShowIdentity({ tmdb_id: 1, name: 'The Last of Us' })
    // "last of us" (article-stripped) is a secondary form, but "last" / "us" are NOT.
    expect(identity.secondaryForms).toContain('last of us')
    expect(identity.primaryForms).not.toContain('last')
    expect(identity.primaryForms).not.toContain('us')
  })
})

describe('buildIdentityRegistry', () => {
  it('indexes by tmdb id and dedupes', () => {
    const { list, byId } = buildIdentityRegistry(
      [{ tmdb_id: 1, name: 'From' }, { tmdb_id: 1, name: 'From (dupe)' }, { tmdb_id: 2, name: 'You' }],
    )
    expect(list).toHaveLength(2)
    expect(byId.get(1).canonicalTitle).toBe('From')
    expect(byId.get(2).ambiguity).toBe(AMBIGUITY.ULTRA)
  })

  it('augments identities with a passed details map without fetching', () => {
    const { byId } = buildIdentityRegistry(
      [{ tmdb_id: 7, name: 'Industry' }],
      { 7: { id: 7, networks: [{ name: 'HBO' }], first_air_date: '2020-11-09' } },
    )
    expect(byId.get(7).networks).toContain('hbo')
    expect(byId.get(7).firstAirYear).toBe(2020)
  })
})
