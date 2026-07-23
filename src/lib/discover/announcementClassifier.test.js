import { describe, it, expect } from 'vitest'
import { classifyAnnouncement } from './announcementClassifier.js'
import { buildIdentityRegistry } from './identities.js'

const NOW = Date.parse('2026-07-23T00:00:00.000Z')
const RECENT = '2026-07-20T00:00:00.000Z'
const STALE = '2026-01-01T00:00:00.000Z'

// A registry of the exact high-risk titles Scope Q requires, with enough TMDB
// metadata for the corroboration paths that legitimate matches depend on.
const SHOWS = [
  { tmdb_id: 1, name: 'From' },
  { tmdb_id: 2, name: 'You' },
  { tmdb_id: 3, name: 'Dark' },
  { tmdb_id: 4, name: 'Industry' },
  { tmdb_id: 5, name: 'Love' },
  { tmdb_id: 6, name: 'Upload' },
  { tmdb_id: 7, name: 'The Bear' },
  { tmdb_id: 8, name: 'Evil' },
  { tmdb_id: 9, name: 'Lost' },
  { tmdb_id: 10, name: 'Found' },
  { tmdb_id: 11, name: 'Wednesday' },
  { tmdb_id: 12, name: 'Beef' },
  { tmdb_id: 13, name: 'Sugar' },
  { tmdb_id: 14, name: 'The Last of Us' },
  { tmdb_id: 15, name: 'A Man on the Inside' },
  { tmdb_id: 16, name: 'The Afterparty' },
  { tmdb_id: 17, name: 'Severance' },
]
const DETAILS = {
  4: { id: 4, networks: [{ name: 'HBO' }], first_air_date: '2020-11-09' },
  13: { id: 13, networks: [{ name: 'Apple TV' }], first_air_date: '2024-02-08' },
  3: { id: 3, networks: [{ name: 'Netflix' }], first_air_date: '2017-12-01', credits: { cast: [{ name: 'Louis Hofmann' }] } },
  7: { id: 7, networks: [{ name: 'FX' }], first_air_date: '2022-06-23' },
}
const registry = buildIdentityRegistry(SHOWS, DETAILS)

function classify(title, extra = {}) {
  return classifyAnnouncement(
    { title, publishedAt: RECENT, sourceName: 'Deadline', url: 'https://deadline.com/x', ...extra },
    registry,
    { now: NOW },
  )
}

describe('Scope Q — false-positive protection for risky titles', () => {
  it('does not match "From" in a retrospective listicle', () => {
    const r = classify('10 lessons from cancelled Netflix shows')
    expect(r.accepted).toBe(false)
  })

  it('does not match "You" in a clickbait pronoun headline', () => {
    const r = classify("You won't believe which series was renewed")
    expect(r.accepted).toBe(false)
  })

  it('does not match "Dark" in a genre phrase "dark comedy"', () => {
    const r = classify('Dark comedy renewed by Netflix')
    expect(r.accepted).toBe(false)
  })

  it('does not match "Industry" in generic industry news', () => {
    const r = classify('TV industry reacts to cancellation')
    expect(r.accepted).toBe(false)
  })

  it('does not match "The Bear" in an article about a literal bear', () => {
    const r = classify('Bear attacks halt production in Montana')
    expect(r.accepted).toBe(false)
  })

  it('does not match "Upload" in "upload the trailer"', () => {
    const r = classify('Upload the trailer before Friday')
    expect(r.accepted).toBe(false)
  })

  it('does not turn "Sugar star discusses renewal hopes" into a renewal', () => {
    const r = classify('Sugar star discusses renewal hopes')
    expect(r.accepted).toBe(false)
  })

  it('does not match "Love" / "Lost" / "Found" / "Evil" without corroboration', () => {
    expect(classify('Finding love in a hopeless place').accepted).toBe(false)
    expect(classify('Lost and found: a traveler tale').accepted).toBe(false)
    expect(classify('Evil deeds punished in court').accepted).toBe(false)
  })
})

describe('Scope Q — corroborated positive cases per event type', () => {
  it('accepts an ULTRA-title renewal with structural evidence: "From renewed for Season 4"', () => {
    const r = classify('From renewed for Season 4')
    expect(r.accepted).toBe(true)
    expect(r.showId).toBe(1)
    expect(r.eventType).toBe('renewal')
    expect(r.seasonNumber).toBe(4)
  })

  it('accepts a possessive ULTRA-title renewal: "Netflix\'s You renewed for Season 5"', () => {
    const r = classify("Netflix's You renewed for Season 5")
    expect(r.accepted).toBe(true)
    expect(r.showId).toBe(2)
    expect(r.eventType).toBe('renewal')
  })

  it('accepts a HIGH-title renewal corroborated by network: "Industry renewed for Season 4 at HBO"', () => {
    const r = classify('Industry renewed for Season 4 at HBO')
    expect(r.accepted).toBe(true)
    expect(r.showId).toBe(4)
    expect(r.eventType).toBe('renewal')
    expect(r.seasonNumber).toBe(4)
  })

  it('accepts a concrete season_date: "The Last of Us Season 3 premieres April 12, 2027"', () => {
    const r = classify('The Last of Us Season 3 premieres April 12, 2027')
    expect(r.accepted).toBe(true)
    expect(r.showId).toBe(14)
    expect(r.eventType).toBe('season_date')
    expect(r.premiereDate).toContain('April 12')
    expect(r.seasonNumber).toBe(3)
  })

  it('accepts a month/year window: "Severance returns in March 2027"', () => {
    const r = classify('Severance returns in March 2027')
    expect(r.accepted).toBe(true)
    expect(r.eventType).toBe('season_date')
    expect(r.releaseWindow).toBe('March 2027')
  })

  it('accepts a cancellation: "The Afterparty will not return for Season 3"', () => {
    const r = classify('The Afterparty will not return for Season 3')
    expect(r.accepted).toBe(true)
    expect(r.showId).toBe(16)
    expect(r.eventType).toBe('cancellation')
  })

  it('accepts a cast addition with a named person: "Sarah Paulson joins The Bear Season 5"', () => {
    const r = classify('Sarah Paulson joins The Bear Season 5')
    expect(r.accepted).toBe(true)
    expect(r.showId).toBe(7)
    expect(r.eventType).toBe('cast_addition')
    expect(r.personName).toBe('Sarah Paulson')
    expect(r.seasonNumber).toBe(5)
  })
})

describe('Scope F — negation and speculation', () => {
  it('rejects "not yet renewed"', () => {
    expect(classify('Industry has not yet been renewed at HBO').accepted).toBe(false)
  })

  it('rejects speculative renewal chances', () => {
    expect(classify('Sugar renewal chances at Apple TV look strong').accepted).toBe(false)
    expect(classify('Industry could be renewed for Season 4 at HBO').accepted).toBe(false)
  })

  it('rejects "at risk of cancellation" fear pieces', () => {
    expect(classify('Industry at risk of cancellation at HBO').accepted).toBe(false)
  })

  it('honors the definitive clause: "renewed after fears it would be cancelled"', () => {
    const r = classify('From renewed after fears it would be cancelled')
    expect(r.accepted).toBe(true)
    expect(r.eventType).toBe('renewal')
  })

  it('honors the definitive clause: "not cancelled; renewed for Season 3"', () => {
    const r = classify('Industry not cancelled at HBO; renewed for Season 3')
    expect(r.accepted).toBe(true)
    expect(r.eventType).toBe('renewal')
  })

  it('rejects when the description contradicts the headline', () => {
    const r = classify('Industry renewed for Season 4 at HBO', {
      description: 'The network has not been renewed the show yet, sources say no renewal is confirmed.',
    })
    expect(r.accepted).toBe(false)
  })
})

describe('cancellation vs planned final season, guest vs recurring', () => {
  it('rejects a planned final season as cancellation', () => {
    expect(classify('The Bear final season will conclude the story at FX').accepted).toBe(false)
  })

  it('accepts an explicit cancellation even with "final season" language', () => {
    const r = classify('The Bear cancelled at FX, denied a final season')
    expect(r.accepted).toBe(true)
    expect(r.eventType).toBe('cancellation')
  })

  it('rejects a one-episode guest star as a cast addition', () => {
    expect(classify('Jamie Lee Curtis to guest star in The Bear').accepted).toBe(false)
  })

  it('accepts a confirmed series-regular addition', () => {
    const r = classify('Josh Brolin joins The Bear as a series regular')
    expect(r.accepted).toBe(true)
    expect(r.eventType).toBe('cast_addition')
    expect(r.personName).toBe('Josh Brolin')
  })

  it('rejects an actor leaving', () => {
    expect(classify('Jeremy Allen White exits The Bear').accepted).toBe(false)
  })
})

describe('date handling', () => {
  it('rejects an individual episode date', () => {
    expect(classify('The Last of Us Season 3 Episode 4 airs April 12').accepted).toBe(false)
  })

  it('rejects a filming-start date', () => {
    expect(classify('The Last of Us Season 3 begins filming in March 2026').accepted).toBe(false)
  })

  it('rejects vague "coming soon"', () => {
    expect(classify('The Last of Us Season 3 coming soon').accepted).toBe(false)
  })

  it('rejects date-release speculation', () => {
    expect(classify('The Last of Us Season 3 release date speculation heats up').accepted).toBe(false)
  })
})

describe('Scope C — multi-title headlines and attachment', () => {
  it('credits a date only to the show it is attached to', () => {
    const r = classify('Sugar returns soon while The Last of Us Season 3 premieres March 2027')
    // The date belongs to The Last of Us, not Sugar.
    expect(r.accepted).toBe(true)
    expect(r.showId).toBe(14)
  })

  it('rejects a multi-show roundup where two tracked shows both qualify', () => {
    const r = classify('The Last of Us and Severance both renewed for new seasons')
    expect(r.accepted).toBe(false)
    expect(r.rejectionReasons).toContain('multi_title_roundup')
  })
})

describe('formatting robustness', () => {
  it('handles a colon subtitle', () => {
    const r = classify('The Last of Us: Season 3 premieres April 12, 2027')
    expect(r.accepted).toBe(true)
  })

  it('handles a possessive in the title text', () => {
    const r = classify("A Man on the Inside renewed for Season 2 by Netflix")
    expect(r.accepted).toBe(true)
    expect(r.showId).toBe(15)
  })
})

describe('Scope G — source tiers and freshness', () => {
  it('rejects a stale renewal', () => {
    expect(classify('From renewed for Season 4', { publishedAt: STALE }).accepted).toBe(false)
  })

  it('rejects a Tier 3 source establishing a HIGH-ambiguity event on language alone', () => {
    const r = classify('Sugar renewed for Season 2 at Apple TV', {
      sourceName: 'Some Fan Blog', url: 'https://fanblog.example.com/x',
    })
    // Apple TV corroborates identity, but a Tier 3 outlet cannot clear the bar
    // for a single-common-word title.
    expect(r.accepted).toBe(false)
  })

  it('accepts the same event from a Tier 2 trade', () => {
    const r = classify('Sugar renewed for Season 2 at Apple TV')
    expect(r.accepted).toBe(true)
    expect(r.showId).toBe(13)
  })
})
