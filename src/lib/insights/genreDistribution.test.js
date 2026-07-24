import { describe, expect, it } from 'vitest'
import {
  buildGenreDistribution,
  buildGenreOrbitDistribution,
  genreColorIndex,
  OTHER_GENRE,
  UNCLASSIFIED_GENRE,
} from './genreDistribution.js'
import {
  averageRunTime,
  episodeRuntimeMinutes,
} from './statsAnalytics.js'

function show(id, genres, runtimes) {
  return {
    tmdb_id: id,
    genres,
    watchedEpisodeRuntimes: runtimes,
  }
}

describe('genre distribution', () => {
  it('returns no chart data for zero watched runtime', () => {
    expect(buildGenreDistribution([])).toEqual({
      entries: [],
      totalMinutes: 0,
      totalEpisodeEquivalent: 0,
    })
  })

  it('makes a single-genre show exactly 100%', () => {
    const distribution = buildGenreDistribution([show(1, ['Comedy'], [25, 25])])
    expect(distribution.entries).toHaveLength(1)
    expect(distribution.entries[0]).toMatchObject({
      genre: 'Comedy',
      minutes: 50,
      displayPercentage: 100,
      watchedEpisodeEquivalent: 2,
      showCount: 1,
    })
  })

  it('splits each multi-genre episode runtime evenly without double counting', () => {
    const distribution = buildGenreDistribution([
      show(1, ['Drama', 'Mystery'], [40]),
    ])
    expect(distribution.entries.map((entry) => [entry.genre, entry.minutes])).toEqual([
      ['Drama', 20],
      ['Mystery', 20],
    ])
    expect(distribution.entries.reduce((sum, entry) => sum + entry.minutes, 0)).toBe(40)
    expect(distribution.totalMinutes).toBe(40)
  })

  it('keeps allocated minutes equal to watched minutes across a mixed portfolio', () => {
    const distribution = buildGenreDistribution([
      show(1, ['Comedy', 'Drama'], [22, 24]),
      show(2, ['Mystery', 'Drama', 'Crime'], [51, 49]),
      show(3, [], [45]),
    ])
    const allocated = distribution.entries.reduce((sum, entry) => sum + entry.minutes, 0)
    expect(allocated).toBeCloseTo(191, 10)
    expect(allocated).toBeCloseTo(distribution.totalMinutes, 10)
    expect(distribution.totalEpisodeEquivalent).toBe(5)
  })

  it('uses largest-remainder rounding so displayed percentages total 100', () => {
    const distribution = buildGenreDistribution([
      show(1, ['Alpha'], [1]),
      show(2, ['Beta'], [1]),
      show(3, ['Gamma'], [1]),
    ])
    expect(distribution.entries.map((entry) => entry.displayPercentage)).toEqual([
      34, 33, 33,
    ])
    expect(
      distribution.entries.reduce((sum, entry) => sum + entry.displayPercentage, 0),
    ).toBe(100)
  })

  it('accounts for missing metadata as Unclassified instead of dropping minutes', () => {
    const distribution = buildGenreDistribution([
      show(1, [], [45]),
      show(2, ['Drama'], [55]),
    ])
    expect(distribution.entries.find((entry) => entry.genre === UNCLASSIFIED_GENRE))
      .toMatchObject({ minutes: 45, displayPercentage: 45 })
    expect(distribution.totalMinutes).toBe(100)
  })

  it('aggregates top-five-plus-Other exactly', () => {
    const distribution = buildGenreDistribution(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((genre, index) =>
        show(index + 1, [genre], [70 - index * 5]),
      ),
    )
    const orbit = buildGenreOrbitDistribution(distribution)
    expect(orbit.entries).toHaveLength(6)
    expect(orbit.entries.at(-1).genre).toBe(OTHER_GENRE)
    expect(orbit.entries.reduce((sum, entry) => sum + entry.minutes, 0))
      .toBeCloseTo(distribution.totalMinutes, 10)
    expect(orbit.entries.reduce((sum, entry) => sum + entry.displayPercentage, 0))
      .toBe(100)
  })

  it('keeps genre colours stable when rank changes', () => {
    const comedyColor = genreColorIndex('Comedy')
    const first = buildGenreDistribution([
      show(1, ['Comedy'], [60]),
      show(2, ['Drama'], [40]),
    ])
    const second = buildGenreDistribution([
      show(1, ['Comedy'], [20]),
      show(2, ['Drama'], [80]),
    ])
    expect(first.entries.find((entry) => entry.genre === 'Comedy').colorIndex)
      .toBe(comedyColor)
    expect(second.entries.find((entry) => entry.genre === 'Comedy').colorIndex)
      .toBe(comedyColor)
  })

  it('accepts runtimes resolved through every fallback tier', () => {
    const showAverage = averageRunTime([30, 50])
    const runtimes = [
      episodeRuntimeMinutes(55, showAverage),
      episodeRuntimeMinutes(null, showAverage),
      episodeRuntimeMinutes(null, null),
    ]
    const distribution = buildGenreDistribution([show(1, ['Drama'], runtimes)])
    expect(distribution.totalMinutes).toBe(140)
  })

  it('orders exact ties deterministically by genre name', () => {
    const distribution = buildGenreDistribution([
      show(1, ['Zulu'], [40]),
      show(2, ['Alpha'], [40]),
    ])
    expect(distribution.entries.map((entry) => entry.genre)).toEqual(['Alpha', 'Zulu'])
    expect(distribution.entries.map((entry) => entry.rank)).toEqual([1, 2])
  })
})
