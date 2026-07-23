import { describe, it, expect } from 'vitest'
import {
  FRANCHISE, STATUS, POLL_TIER, MARVEL_DC_CATALOGUE, REJECTED_BROAD_COMPANY_IDS,
  catalogueTargets, filterCatalogue, isFranchiseMediaId, verificationStatus, isMarvelDcEnabled,
} from './marvelDcCatalogue.js'

describe('catalogue shape', () => {
  it('documents every entry with media type, id, title, franchise, status, release date, poll tier and verification flag', () => {
    for (const entry of MARVEL_DC_CATALOGUE) {
      expect(['tv', 'movie']).toContain(entry.mediaType)
      expect(typeof entry.id).toBe('number')
      expect(entry.title.length).toBeGreaterThan(0)
      expect([FRANCHISE.MARVEL, FRANCHISE.DC]).toContain(entry.franchise)
      expect([STATUS.UPCOMING, STATUS.RELEASED]).toContain(entry.status)
      expect(entry.releaseDate === null || /^\d{4}-\d{2}-\d{2}$/.test(entry.releaseDate)).toBe(true)
      expect([POLL_TIER.ACTIVE, POLL_TIER.LEGACY, POLL_TIER.RETIRED]).toContain(entry.pollTier)
      expect(typeof entry.liveVerified).toBe('boolean')
      expect(typeof entry.enabled).toBe('boolean')
    }
  })

  it('has at least one ACTIVE (pollable) entry for each franchise + media-type combination', () => {
    expect(catalogueTargets({ franchise: FRANCHISE.MARVEL, mediaType: 'tv' }).length).toBeGreaterThan(0)
    expect(catalogueTargets({ franchise: FRANCHISE.MARVEL, mediaType: 'movie' }).length).toBeGreaterThan(0)
    expect(catalogueTargets({ franchise: FRANCHISE.DC, mediaType: 'tv' }).length).toBeGreaterThan(0)
    expect(catalogueTargets({ franchise: FRANCHISE.DC, mediaType: 'movie' }).length).toBeGreaterThan(0)
  })

  it('is enabled (an explicit allowlist is safe by construction)', () => {
    expect(isMarvelDcEnabled()).toBe(true)
  })

  it('reports an honest live-verification status (nothing live-verified in the keyless sandbox)', () => {
    const status = verificationStatus()
    expect(status.total).toBe(MARVEL_DC_CATALOGUE.length)
    expect(status.liveVerified + status.pending).toBe(status.total)
    expect(status.liveVerified).toBe(0) // no TMDB key here; a maintainer flips these
    expect(status.active + status.legacy + status.retired).toBe(status.total)
  })
})

describe('current & upcoming coverage — the projects most likely to publish trailers', () => {
  it('includes an upcoming/current Marvel movie and Marvel TV project as active poll targets', () => {
    const marvelMovies = catalogueTargets({ franchise: FRANCHISE.MARVEL, mediaType: 'movie' }).map((t) => t.id)
    const marvelTv = catalogueTargets({ franchise: FRANCHISE.MARVEL, mediaType: 'tv' }).map((t) => t.id)
    expect(marvelMovies).toContain(617126) // The Fantastic Four: First Steps
    expect(marvelTv).toContain(202555) // Daredevil: Born Again
  })

  it('includes an upcoming/current DC movie and DC TV project as active poll targets', () => {
    const dcMovies = catalogueTargets({ franchise: FRANCHISE.DC, mediaType: 'movie' }).map((t) => t.id)
    const dcTv = catalogueTargets({ franchise: FRANCHISE.DC, mediaType: 'tv' }).map((t) => t.id)
    expect(dcMovies).toContain(1061474) // Superman (2025)
    expect(dcTv).toContain(110492) // Peacemaker (S2)
  })

  it('carries release/status metadata for scheduling', () => {
    const superman = MARVEL_DC_CATALOGUE.find((e) => e.id === 1061474)
    expect(superman.status).toBe(STATUS.UPCOMING)
    expect(superman.releaseDate).toBe('2025-07-09')
  })
})

describe('poll cadence & retirement', () => {
  it('annotates active targets as fast cadence and legacy targets as slow', () => {
    const targets = catalogueTargets()
    const active = targets.find((t) => t.id === 202555) // Daredevil: Born Again (active)
    const legacy = targets.find((t) => t.id === 533535) // Deadpool & Wolverine (legacy)
    expect(active.cadence).toBe('fast')
    expect(legacy.cadence).toBe('slow')
  })

  it('excludes long-retired titles from the polling set to save requests', () => {
    const ids = catalogueTargets().map((t) => t.id)
    expect(ids).not.toContain(84958) // Loki (2021) — retired, not polled
    expect(ids).not.toContain(475557) // Joker (2019) — retired, not polled
  })

  it('still classifies a retired title as a franchise member (cadence != membership)', () => {
    // Retired entries are dropped from polling but must remain members so a stray
    // franchise video is tagged correctly rather than mislabelled.
    expect(isFranchiseMediaId(84958, 'tv')).toBe(FRANCHISE.MARVEL) // Loki, retired
    expect(isFranchiseMediaId(414906, 'movie')).toBe(FRANCHISE.DC) // The Batman, retired
  })

  it('can include retired entries explicitly when asked', () => {
    const withRetired = filterCatalogue(MARVEL_DC_CATALOGUE, { includeRetired: true }).map((e) => e.id)
    expect(withRetired).toContain(84958) // Loki now present
  })
})

describe('per-entry enable gate — one invalid id disables only itself', () => {
  it('drops a single disabled entry from targets and membership while its siblings remain', () => {
    const synthetic = [
      { mediaType: 'movie', id: 111, title: 'Good One', franchise: FRANCHISE.MARVEL, status: STATUS.RELEASED, releaseDate: '2025-01-01', pollTier: POLL_TIER.ACTIVE, liveVerified: true, enabled: true },
      { mediaType: 'movie', id: 222, title: 'Bad One', franchise: FRANCHISE.MARVEL, status: STATUS.RELEASED, releaseDate: '2025-01-01', pollTier: POLL_TIER.ACTIVE, liveVerified: false, enabled: false },
    ]
    const ids = filterCatalogue(synthetic).map((e) => e.id)
    expect(ids).toContain(111) // sibling survives
    expect(ids).not.toContain(222) // disabled id removed — and only that id
    expect(filterCatalogue(synthetic, { includeDisabled: true }).map((e) => e.id)).toContain(222)
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

  it('recognizes upcoming franchise entries too (Fantastic Four, Superman)', () => {
    expect(isFranchiseMediaId(617126, 'movie')).toBe(FRANCHISE.MARVEL) // The Fantastic Four: First Steps
    expect(isFranchiseMediaId(1061474, 'movie')).toBe(FRANCHISE.DC) // Superman
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
