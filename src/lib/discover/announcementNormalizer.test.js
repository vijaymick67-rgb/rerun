import { describe, it, expect } from 'vitest'
import { normalizeAnnouncement, announcementEventKey } from './announcementNormalizer.js'
import { dedupeAnnouncements } from './announcementDedup.js'

const identity = { canonicalTitle: 'The Bear', posterPath: '/bear.jpg' }

function accepted(overrides = {}) {
  return {
    accepted: true, showId: 7, showName: 'The Bear', eventType: 'renewal',
    seasonNumber: 5, premiereDate: null, releaseWindow: null, personName: null,
    confidence: 0.8, ...overrides,
  }
}
function article(overrides = {}) {
  return {
    sourceName: 'Deadline', canonicalUrl: 'https://deadline.com/a',
    publishedAt: '2026-07-20T00:00:00.000Z', ...overrides,
  }
}

describe('normalizeAnnouncement', () => {
  it('produces a stable model with generated copy for a renewal', () => {
    const a = normalizeAnnouncement(accepted(), article(), identity)
    expect(a.label).toBe('Renewed')
    expect(a.detail).toBe('The Bear will return for Season 5')
    expect(a.posterPath).toBe('/bear.jpg')
    expect(a.sourceUrl).toBe('https://deadline.com/a')
  })

  it('omits an unknown season rather than guessing', () => {
    const a = normalizeAnnouncement(accepted({ seasonNumber: null }), article(), identity)
    expect(a.detail).toBe('The Bear has been renewed')
  })

  it('formats each event type', () => {
    expect(normalizeAnnouncement(accepted({ eventType: 'cancellation' }), article(), identity).detail)
      .toBe('The Bear will not return for Season 5')
    expect(normalizeAnnouncement(accepted({ eventType: 'season_date', premiereDate: 'April 12' }), article(), identity).detail)
      .toBe('The Bear Season 5 premieres April 12')
    expect(normalizeAnnouncement(accepted({ eventType: 'cast_addition', personName: 'Sarah Paulson' }), article(), identity).detail)
      .toBe('Sarah Paulson joins The Bear Season 5')
  })

  it('returns null for a non-accepted result', () => {
    expect(normalizeAnnouncement({ accepted: false }, article(), identity)).toBe(null)
  })
})

describe('announcementEventKey', () => {
  it('gives the same key regardless of publisher and date wording for a season premiere', () => {
    const base = { showId: 1, eventType: 'season_date', seasonNumber: 3 }
    expect(announcementEventKey({ ...base, premiereDate: 'April 12' }))
      .toBe(announcementEventKey({ ...base, premiereDate: 'April 13' }))
  })

  it('keeps distinct cast additions separate', () => {
    expect(announcementEventKey({ showId: 1, eventType: 'cast_addition', personName: 'A B', seasonNumber: 2 }))
      .not.toBe(announcementEventKey({ showId: 1, eventType: 'cast_addition', personName: 'C D', seasonNumber: 2 }))
  })
})

describe('dedupeAnnouncements', () => {
  it('keeps one representative per event, preferring higher trust', () => {
    const trade = normalizeAnnouncement(accepted(), article({ sourceName: 'Deadline', canonicalUrl: 'https://deadline.com/a' }), identity)
    const official = normalizeAnnouncement(accepted(), article({ sourceName: 'FX', canonicalUrl: 'https://fxnetworks.com/b', publishedAt: '2026-07-19T00:00:00.000Z' }), identity)
    const other = normalizeAnnouncement(accepted(), article({ sourceName: 'Fan Blog', canonicalUrl: 'https://fan.example.com/c' }), identity)
    const result = dedupeAnnouncements([trade, other, official])
    expect(result).toHaveLength(1)
    expect(result[0].sourceName).toBe('FX') // Tier 1 wins over trade/other
  })

  it('supersedes an older premiere date with the newest report for the same season', () => {
    const older = normalizeAnnouncement(
      accepted({ eventType: 'season_date', premiereDate: 'April 12' }),
      article({ publishedAt: '2026-07-10T00:00:00.000Z', canonicalUrl: 'https://deadline.com/old' }), identity)
    const newer = normalizeAnnouncement(
      accepted({ eventType: 'season_date', premiereDate: 'April 19' }),
      article({ publishedAt: '2026-07-21T00:00:00.000Z', canonicalUrl: 'https://deadline.com/new' }), identity)
    const result = dedupeAnnouncements([older, newer])
    expect(result).toHaveLength(1)
    expect(result[0].detail).toContain('April 19')
  })

  it('never merges a renewal and a cancellation', () => {
    const renewal = normalizeAnnouncement(accepted({ eventType: 'renewal' }), article(), identity)
    const cancellation = normalizeAnnouncement(accepted({ eventType: 'cancellation' }), article(), identity)
    expect(dedupeAnnouncements([renewal, cancellation])).toHaveLength(2)
  })
})
