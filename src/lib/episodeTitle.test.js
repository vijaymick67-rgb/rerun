import { describe, expect, it } from 'vitest'
import { isGenericEpisodeTitle, resolveEpisodeTitle } from './episodeTitle.js'

describe('isGenericEpisodeTitle', () => {
  it('treats null/undefined/blank as generic', () => {
    expect(isGenericEpisodeTitle(null)).toBe(true)
    expect(isGenericEpisodeTitle(undefined)).toBe(true)
    expect(isGenericEpisodeTitle('')).toBe(true)
    expect(isGenericEpisodeTitle('   ')).toBe(true)
  })

  it('treats TBA/T.B.A./TBD/Untitled as generic, case/punctuation-insensitively', () => {
    for (const value of ['TBA', 'tba', ' Tba ', 'T.B.A.', 't.b.a.', 'TBD', 'tbd', 'Untitled', 'UNTITLED']) {
      expect(isGenericEpisodeTitle(value)).toBe(true)
    }
  })

  it('treats "Episode 5", "Episode 05", and "Episode #5" as generic', () => {
    expect(isGenericEpisodeTitle('Episode 5')).toBe(true)
    expect(isGenericEpisodeTitle('Episode 05')).toBe(true)
    expect(isGenericEpisodeTitle('Episode #5')).toBe(true)
    expect(isGenericEpisodeTitle('episode 5')).toBe(true)
    expect(isGenericEpisodeTitle('EPISODE 5')).toBe(true)
    expect(isGenericEpisodeTitle('Episode  5')).toBe(true)
  })

  it('matches "Episode N" against the actual episode number when provided', () => {
    expect(isGenericEpisodeTitle('Episode 5', 5)).toBe(true)
    expect(isGenericEpisodeTitle('Episode 05', 5)).toBe(true)
    // A mismatched number is not the generic placeholder for *this* episode.
    expect(isGenericEpisodeTitle('Episode 5', 12)).toBe(false)
  })

  it('preserves a legitimate title containing the word "Episode"', () => {
    expect(isGenericEpisodeTitle('The Final Episode')).toBe(false)
    expect(isGenericEpisodeTitle('Episode One')).toBe(false)
    expect(isGenericEpisodeTitle('An Episode of Grief')).toBe(false)
  })

  it('preserves ordinary legitimate titles', () => {
    expect(isGenericEpisodeTitle('Unbowed and Unbent')).toBe(false)
    expect(isGenericEpisodeTitle('The Red Dragon and the Gold')).toBe(false)
    expect(isGenericEpisodeTitle('Smallfolk')).toBe(false)
  })
})

describe('resolveEpisodeTitle', () => {
  it('prefers a proper TMDB title over TVmaze', () => {
    expect(resolveEpisodeTitle({
      tmdbName: 'The Red Dragon and the Gold', tvmazeName: 'Alternate Title', episodeNumber: 5,
    })).toBe('The Red Dragon and the Gold')
  })

  it('falls back to a proper TVmaze title when TMDB is generic', () => {
    expect(resolveEpisodeTitle({
      tmdbName: 'Episode 5', tvmazeName: 'Unbowed and Unbent', episodeNumber: 5,
    })).toBe('Unbowed and Unbent')
  })

  it('falls back to TVmaze when TMDB is missing entirely', () => {
    expect(resolveEpisodeTitle({ tmdbName: null, tvmazeName: 'Smallfolk', episodeNumber: 6 })).toBe('Smallfolk')
    expect(resolveEpisodeTitle({ tvmazeName: 'Smallfolk' })).toBe('Smallfolk')
  })

  it('resolves to TBA when both sources are generic/blank', () => {
    expect(resolveEpisodeTitle({ tmdbName: 'Episode 6', tvmazeName: '', episodeNumber: 6 })).toBe('TBA')
    expect(resolveEpisodeTitle({ tmdbName: null, tvmazeName: null })).toBe('TBA')
    expect(resolveEpisodeTitle()).toBe('TBA')
  })

  it('a later proper TMDB title takes priority again over an existing TVmaze title', () => {
    // Monday: TMDB="Episode 6", TVmaze=blank -> TBA.
    expect(resolveEpisodeTitle({ tmdbName: 'Episode 6', tvmazeName: null, episodeNumber: 6 })).toBe('TBA')
    // Wednesday: TVmaze refresh supplies a real title.
    expect(resolveEpisodeTitle({ tmdbName: 'Episode 6', tvmazeName: 'The New Title', episodeNumber: 6 }))
      .toBe('The New Title')
    // Sunday: TMDB refresh supplies its own official title — wins again.
    expect(resolveEpisodeTitle({ tmdbName: 'Official Title', tvmazeName: 'The New Title', episodeNumber: 6 }))
      .toBe('Official Title')
  })
})
