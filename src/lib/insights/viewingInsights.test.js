import { describe, expect, it } from 'vitest'
import { buildGenreDistribution } from './genreDistribution.js'
import {
  buildAnalyticsFingerprint,
  buildViewingInsightCandidates,
  INSIGHT_HISTORY_LIMIT,
  parseInsightHistory,
  pruneInsightHistory,
  selectDailyInsight,
} from './viewingInsights.js'

function makeShow(id, options = {}) {
  const runtimes = options.runtimes ?? [40, 40, 40, 40, 40, 40]
  const watchedEpisodeCount = runtimes.length
  const totalKnownEpisodeCount = options.totalKnownEpisodeCount ?? watchedEpisodeCount
  const watched = options.watched ?? watchedEpisodeCount
  return {
    tmdb_id: id,
    name: options.name ?? `Show ${id}`,
    genres: options.genres ?? ['Drama'],
    networks: options.networks ?? [`Network ${id}`],
    watchedEpisodeRuntimes: runtimes,
    watchedEpisodeCount,
    minutes: runtimes.reduce((sum, runtime) => sum + runtime, 0),
    distinctWatchedSeasons: options.distinctWatchedSeasons ?? 1,
    totalKnownEpisodeCount,
    total: totalKnownEpisodeCount,
    watched,
    completionRatio:
      options.completionRatio ??
      (totalKnownEpisodeCount > 0 ? Math.min(1, watched / totalKnownEpisodeCount) : null),
    metadataComplete: options.metadataComplete ?? true,
    finished_at: options.finishedAt ?? null,
  }
}

function candidatesFor(shows) {
  const totalMinutes = shows.reduce((sum, show) => sum + show.minutes, 0)
  return buildViewingInsightCandidates({
    shows,
    totalMinutes,
    genreDistribution: buildGenreDistribution(shows),
  })
}

function selectionCandidate(id, category, options = {}) {
  return {
    id,
    category,
    factFamily: options.factFamily ?? id,
    text: options.text ?? id,
    involvedShowIds: options.showIds ?? [],
    involvedGenres: options.genres ?? [],
    strength: options.strength ?? 0.8,
    scope: options.scope ?? 'portfolio',
    evidence: {},
  }
}

describe('viewing insight candidates', () => {
  it('emits structured candidates with stable identity and novelty metadata', () => {
    const candidates = candidatesFor([
      makeShow(1, { genres: ['Comedy'], runtimes: Array(12).fill(24) }),
      makeShow(2, { genres: ['Drama'], runtimes: Array(8).fill(55) }),
      makeShow(3, { genres: ['Mystery'], runtimes: Array(6).fill(45) }),
      makeShow(4, { genres: ['Crime'], runtimes: Array(6).fill(48) }),
    ])
    expect(candidates.length).toBeGreaterThan(2)
    for (const entry of candidates) {
      expect(entry).toEqual(expect.objectContaining({
        id: expect.any(String),
        category: expect.any(String),
        factFamily: expect.any(String),
        text: expect.any(String),
        involvedShowIds: expect.any(Array),
        involvedGenres: expect.any(Array),
        strength: expect.any(Number),
        evidence: expect.any(Object),
      }))
    }
  })

  it('excludes sample-poor portfolio claims and degrades to one honest overview', () => {
    const candidates = candidatesFor([
      makeShow(1, { name: 'Pilot Light', runtimes: [28], genres: [] }),
    ])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      category: 'overview',
      factFamily: 'early-history-summary',
    })
    expect(candidates[0].text).toContain('Pilot Light')
  })

  it('does not manufacture a unique "most" observation when leaders are tied', () => {
    const candidates = candidatesFor([
      makeShow(1),
      makeShow(2),
      makeShow(3),
      makeShow(4),
    ])
    expect(candidates.find((entry) => entry.id.startsWith('concentration:top-show')))
      .toBeUndefined()
    expect(candidates.find((entry) => entry.id === 'concentration:balanced-portfolio'))
      .toBeDefined()
    expect(candidates.map((entry) => entry.text).join(' ')).not.toContain('biggest watch')
  })

  it('calculates a dominant show from actual runtime share', () => {
    const candidates = candidatesFor([
      makeShow(1, { name: 'Modern Family', runtimes: Array(14).fill(24) }),
      makeShow(2, { runtimes: Array(4).fill(40) }),
      makeShow(3, { runtimes: Array(4).fill(40) }),
      makeShow(4, { runtimes: Array(4).fill(40) }),
    ])
    const concentration = candidates.find(
      (entry) => entry.factFamily === 'top-show-runtime-share',
    )
    expect(concentration).toBeDefined()
    expect(concentration.involvedShowIds).toEqual([1])
    expect(concentration.evidence.share).toBeCloseTo(336 / 816)
    expect(concentration.text).toContain('41%')
  })

  it('recognizes effective genre diversity rather than raw labels alone', () => {
    const candidates = candidatesFor([
      makeShow(1, { genres: ['Comedy'], runtimes: Array(10).fill(30) }),
      makeShow(2, { genres: ['Drama'], runtimes: Array(10).fill(30) }),
      makeShow(3, { genres: ['Mystery'], runtimes: Array(10).fill(30) }),
      makeShow(4, { genres: ['Crime'], runtimes: Array(10).fill(30) }),
    ])
    const diversity = candidates.find(
      (entry) => entry.factFamily === 'effective-genre-diversity',
    )
    expect(diversity).toBeDefined()
    expect(diversity.evidence.genreCount).toBe(4)
    expect(diversity.evidence.effectiveGenreCount).toBeCloseTo(4)
  })

  it('uses meaningful episode, season, and completion thresholds', () => {
    const candidates = candidatesFor([
      makeShow(1, { totalKnownEpisodeCount: 6, distinctWatchedSeasons: 2 }),
      makeShow(2, { totalKnownEpisodeCount: 6, distinctWatchedSeasons: 2 }),
      makeShow(3, {
        totalKnownEpisodeCount: 12,
        watched: 6,
        completionRatio: 0.5,
        distinctWatchedSeasons: 2,
      }),
    ])
    expect(candidates.find((entry) => entry.category === 'commitment')).toBeDefined()
    const completion = candidates.find((entry) => entry.category === 'completion')
    expect(completion).toBeDefined()
    expect(completion.evidence).toMatchObject({
      completedShows: 2,
      eligibleShows: 3,
    })
  })

  it('derives episode-length preference from watched episode runtimes', () => {
    const candidates = candidatesFor([
      makeShow(1, {
        genres: ['Comedy'],
        runtimes: [...Array(20).fill(25), ...Array(5).fill(60)],
      }),
    ])
    const length = candidates.find((entry) => entry.category === 'episode-length')
    expect(length).toBeDefined()
    expect(length.factFamily).toBe('short-episode-count-share')
    expect(length.text).toContain('80%')
  })

  it('builds a cross-dimensional genre/length observation from real buckets', () => {
    const candidates = candidatesFor([
      makeShow(1, { genres: ['Comedy'], runtimes: Array(10).fill(25) }),
      makeShow(2, { genres: ['Drama'], runtimes: Array(10).fill(60) }),
    ])
    const cross = candidates.find((entry) => entry.category === 'cross-dimensional')
    expect(cross).toBeDefined()
    expect(cross.involvedGenres).toEqual(['Comedy', 'Drama'])
    expect(cross.evidence).toMatchObject({ shortEpisodes: 10, longEpisodes: 10 })
  })

  it('emits only one candidate per underlying fact family', () => {
    const candidates = candidatesFor([
      makeShow(1, { genres: ['Comedy'], runtimes: Array(20).fill(25) }),
      makeShow(2, { genres: ['Drama'], runtimes: Array(10).fill(60) }),
      makeShow(3, { genres: ['Mystery'], runtimes: Array(8).fill(45) }),
      makeShow(4, { genres: ['Crime'], runtimes: Array(8).fill(45) }),
    ])
    expect(new Set(candidates.map((entry) => entry.factFamily)).size)
      .toBe(candidates.length)
  })
})

describe('novelty-aware daily selector', () => {
  const pool = [
    selectionCandidate('a', 'concentration', { showIds: [1], strength: 0.95 }),
    selectionCandidate('b', 'genre', { genres: ['Comedy'], strength: 0.85 }),
    selectionCandidate('c', 'commitment', { strength: 0.75 }),
  ]

  it('keeps the same candidate and text stable for the same calendar day', () => {
    const first = selectDailyInsight({
      candidates: pool,
      date: '2026-07-24',
      fingerprint: 'one',
      history: [],
    })
    const changedCopy = pool.map((entry) =>
      entry.id === first.insight.id ? { ...entry, text: 'new refresh copy' } : entry,
    )
    const second = selectDailyInsight({
      candidates: changedCopy,
      date: '2026-07-24',
      fingerprint: 'two',
      history: first.history,
    })
    expect(second.insight.id).toBe(first.insight.id)
    expect(second.insight.text).toBe(first.insight.text)
  })

  it('strongly prefers a different category on the next day', () => {
    const first = selectDailyInsight({
      candidates: pool,
      date: '2026-07-24',
      fingerprint: 'one',
      history: [],
    })
    const second = selectDailyInsight({
      candidates: pool,
      date: '2026-07-25',
      fingerprint: 'one',
      history: first.history,
    })
    expect(second.insight.category).not.toBe(first.insight.category)
  })

  it('penalizes a recently featured show across different fact categories', () => {
    const history = [{
      date: '2026-07-24',
      candidateId: 'old-modern-family',
      category: 'concentration',
      factFamily: 'top-show',
      featuredShowIds: [1],
      featuredGenres: [],
      text: 'old',
    }]
    const selected = selectDailyInsight({
      candidates: [
        selectionCandidate('modern-family-depth', 'season-depth', {
          showIds: [1],
          strength: 1,
        }),
        selectionCandidate('portfolio-variety', 'variety', { strength: 0.6 }),
      ],
      date: '2026-07-25',
      fingerprint: 'same',
      history,
    })
    expect(selected.insight.id).toBe('portfolio-variety')
  })

  it('cannot let one dominant show occupy consecutive days via rephrased facts', () => {
    const first = selectDailyInsight({
      candidates: [
        selectionCandidate('modern-runtime', 'concentration', {
          showIds: [1],
          strength: 1,
        }),
        selectionCandidate('genre-balance', 'genre', { strength: 0.7 }),
      ],
      date: '2026-07-24',
      fingerprint: 'portfolio',
      history: [],
    })
    expect(first.insight.id).toBe('modern-runtime')
    const second = selectDailyInsight({
      candidates: [
        selectionCandidate('modern-seasons', 'season-depth', {
          showIds: [1],
          strength: 1,
        }),
        selectionCandidate('genre-balance', 'genre', { strength: 0.7 }),
      ],
      date: '2026-07-25',
      fingerprint: 'portfolio',
      history: first.history,
    })
    expect(second.insight.id).toBe('genre-balance')
  })

  it('keeps history bounded and recovers malformed stored history', () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-07-${String(30 - index).padStart(2, '0')}`,
      candidateId: `candidate-${index}`,
    }))
    expect(pruneInsightHistory(entries, '2026-07-30')).toHaveLength(
      INSIGHT_HISTORY_LIMIT,
    )
    expect(parseInsightHistory('{broken')).toEqual([])
    expect(parseInsightHistory({ version: 999, entries })).toEqual([])
  })

  it('degrades to the only candidate and remains deterministic as data changes', () => {
    const only = [selectionCandidate('only', 'overview')]
    const first = selectDailyInsight({
      candidates: only,
      date: '2026-07-24',
      fingerprint: 'before',
      history: [],
    })
    const nextDay = selectDailyInsight({
      candidates: only,
      date: '2026-07-25',
      fingerprint: 'after',
      history: first.history,
    })
    expect(first.insight.id).toBe('only')
    expect(nextDay.insight.id).toBe('only')

    const deterministicA = selectDailyInsight({
      candidates: pool,
      date: '2026-07-26',
      fingerprint: 'changed-data',
      history: [],
    })
    const deterministicB = selectDailyInsight({
      candidates: pool,
      date: '2026-07-26',
      fingerprint: 'changed-data',
      history: [],
    })
    expect(deterministicB.insight.id).toBe(deterministicA.insight.id)
  })

  it('fingerprints only meaningful compact analytics deterministically', () => {
    const shows = [makeShow(2), makeShow(1)]
    expect(buildAnalyticsFingerprint(shows)).toBe(
      buildAnalyticsFingerprint([...shows].reverse()),
    )
    expect(buildAnalyticsFingerprint(shows)).not.toBe(
      buildAnalyticsFingerprint([
        makeShow(2),
        makeShow(1, { runtimes: [60, 60, 60, 60, 60, 60] }),
      ]),
    )
  })
})
