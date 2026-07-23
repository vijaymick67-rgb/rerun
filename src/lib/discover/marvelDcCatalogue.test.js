import { describe, it, expect } from 'vitest'
import {
  FRANCHISE, MARVEL_DC_CATALOGUE, REJECTED_BROAD_COMPANY_IDS,
  catalogueTargets, isFranchiseMediaId, verificationStatus, isMarvelDcEnabled,
} from './marvelDcCatalogue.js'

describe('catalogue shape', () => {
  it('documents every entry with a media type, numeric id, title, franchise and a live-verification flag', () => {
    for (const entry of MARVEL_DC_CATALOGUE) {
      expect(['tv', 'movie']).toContain(entry.mediaType)
      expect(typeof entry.id).toBe('number')
      expect(entry.title.length).toBeGreaterThan(0)
      expect([FRANCHISE.MARVEL, FRANCHISE.DC]).toContain(entry.franchise)
      expect(typeof entry.liveVerified).toBe('boolean')
    }
  })

  it('has at least one entry for each franchise + media-type combination', () => {
    expect(catalogueTargets({ franchise: FRANCHISE.MARVEL, mediaType: 'tv' }).length).toBeGreaterThan(0)
    expect(catalogueTargets({ franchise: FRANCHISE.MARVEL, mediaType: 'movie' }).length).toBeGreaterThan(0)
    expect(catalogueTargets({ franchise: FRANCHISE.DC, mediaType: 'tv' }).length).toBeGreaterThan(0)
    expect(catalogueTargets({ franchise: FRANCHISE.DC, mediaType: 'movie' }).length).toBeGreaterThan(0)
  })

  it('is enabled (an explicit allowlist is safe by construction)', () => {
    expect(isMarvelDcEnabled()).toBe(true)
  })

  it('reports an honest live-verification status', () => {
    const status = verificationStatus()
    expect(status.total).toBe(MARVEL_DC_CATALOGUE.length)
    expect(status.liveVerified + status.pending).toBe(status.total)
  })
})

describe('membership — real franchise media are members', () => {
  it('recognizes real Marvel TV (Loki) and Marvel movie (Deadpool & Wolverine)', () => {
    expect(isFranchiseMediaId(84958, 'tv')).toBe(FRANCHISE.MARVEL) // Loki
    expect(isFranchiseMediaId(533535, 'movie')).toBe(FRANCHISE.MARVEL) // Deadpool & Wolverine
  })

  it('recognizes real DC TV (Peacemaker) and DC movie (The Batman)', () => {
    expect(isFranchiseMediaId(110492, 'tv')).toBe(FRANCHISE.DC) // Peacemaker
    expect(isFranchiseMediaId(414906, 'movie')).toBe(FRANCHISE.DC) // The Batman
  })

  it('does not confuse media types (a tv id is not a movie member)', () => {
    expect(isFranchiseMediaId(84958, 'movie')).toBe(null) // Loki is a tv id, not a movie
  })
})

describe('false positives — unrelated Disney/Warner titles are excluded', () => {
  it('excludes an unrelated Disney movie (Moana) even though Disney owns Marvel', () => {
    expect(isFranchiseMediaId(277834, 'movie')).toBe(null) // Moana
  })

  it('excludes an unrelated Warner movie (Barbie) even though Warner owns DC', () => {
    expect(isFranchiseMediaId(346698, 'movie')).toBe(null) // Barbie
  })

  it('excludes an unrelated tv show (Bluey)', () => {
    expect(isFranchiseMediaId(82728, 'tv')).toBe(null) // Bluey
  })

  it('rejects a null/unknown id', () => {
    expect(isFranchiseMediaId(null, 'movie')).toBe(null)
    expect(isFranchiseMediaId(999999999, 'tv')).toBe(null)
  })
})

describe('broad company ids are documented as rejected, never queried', () => {
  it('lists the dangerous broad company ids with a reason', () => {
    const ids = REJECTED_BROAD_COMPANY_IDS.map((e) => e.id)
    expect(ids).toContain(429) // DC Comics
    expect(ids).toContain(174) // Warner Bros. Pictures
    expect(ids).toContain(2) // Walt Disney Pictures
    for (const entry of REJECTED_BROAD_COMPANY_IDS) {
      expect(entry.why.length).toBeGreaterThan(0)
    }
  })

  it('none of the rejected broad company ids appear as catalogue media ids', () => {
    const broad = new Set(REJECTED_BROAD_COMPANY_IDS.map((e) => e.id))
    for (const entry of MARVEL_DC_CATALOGUE) {
      expect(broad.has(entry.id)).toBe(false)
    }
  })
})
