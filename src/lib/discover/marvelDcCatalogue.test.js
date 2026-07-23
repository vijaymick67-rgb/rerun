import { describe, it, expect } from 'vitest'
import {
  FRANCHISE, MARVEL_COMPANY_IDS, DC_COMPANY_IDS, EXCLUDED_BROAD_COMPANY_IDS,
  companyIdList, isConfiguredCompanyId, buildDiscoverParams, classifyFranchiseMedia,
  assertVerifiedBeforeProduction, isMarvelDcEnabled,
} from './marvelDcCatalogue.js'

describe('company id configuration', () => {
  it('documents every id with a label and a verification flag', () => {
    for (const entry of [...MARVEL_COMPANY_IDS, ...DC_COMPANY_IDS]) {
      expect(typeof entry.id).toBe('number')
      expect(entry.label.length).toBeGreaterThan(0)
      expect(typeof entry.verified).toBe('boolean')
    }
  })

  it('never treats a broad parent company as configured', () => {
    for (const excluded of EXCLUDED_BROAD_COMPANY_IDS) {
      expect(isConfiguredCompanyId(excluded.id)).toBe(false)
    }
    // Warner Bros. Pictures (174) and Walt Disney Pictures (2) must be excluded.
    expect(isConfiguredCompanyId(174)).toBe(false)
    expect(isConfiguredCompanyId(2)).toBe(false)
  })

  it('recognizes configured Marvel/DC ids', () => {
    expect(isConfiguredCompanyId(420)).toBe(true) // Marvel Studios
    expect(isConfiguredCompanyId(429)).toBe(true) // DC Comics
    expect(isConfiguredCompanyId(999999)).toBe(false)
  })
})

describe('buildDiscoverParams', () => {
  it('builds an OR-joined with_companies filter for movies and tv', () => {
    const marvelMovie = buildDiscoverParams({ franchise: FRANCHISE.MARVEL, mediaType: 'movie' })
    expect(marvelMovie.path).toBe('/discover/movie')
    expect(marvelMovie.params.with_companies).toBe(companyIdList(FRANCHISE.MARVEL).join('|'))
    const dcTv = buildDiscoverParams({ franchise: FRANCHISE.DC, mediaType: 'tv' })
    expect(dcTv.path).toBe('/discover/tv')
    expect(dcTv.params.with_companies).toContain('|')
  })
})

describe('classifyFranchiseMedia — attribution only, never keywords', () => {
  it('accepts an item whose production companies intersect the configured ids', () => {
    const item = { id: 1, name: 'Some Marvel Series', production_company_ids: [420] }
    expect(classifyFranchiseMedia(item, FRANCHISE.MARVEL)?.franchise).toBe('marvel')
  })

  it('rejects an item attributed only to a non-configured company', () => {
    const item = { id: 2, name: 'Spider-Man Fan Film', production_company_ids: [999999] }
    expect(classifyFranchiseMedia(item, FRANCHISE.MARVEL)).toBe(null)
  })

  it('does not classify by title keyword when there is no attribution', () => {
    const item = { id: 3, name: 'Superman Returns (unattributed)' }
    expect(classifyFranchiseMedia(item, FRANCHISE.DC)).toBe(null)
  })

  it('trusts a company-filtered discover result flagged __fromDiscover', () => {
    const item = { id: 4, name: 'Loki', __fromDiscover: true }
    expect(classifyFranchiseMedia(item, FRANCHISE.MARVEL)?.franchise).toBe('marvel')
  })
})

describe('verification gate', () => {
  it('reports the catalogue as disabled while ids are unverified', () => {
    // Every configured id currently ships verified:false (honest default).
    expect(isMarvelDcEnabled()).toBe(false)
    expect(() => assertVerifiedBeforeProduction()).toThrow('marvel_dc_ids_unverified')
  })
})
