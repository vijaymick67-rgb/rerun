import { describe, expect, it } from 'vitest'
import { normalizeShowDetails } from './tmdbNormalize.js'

describe('normalizeShowDetails', () => {
  it('retains compact genre and network name arrays for shared show metadata', () => {
    const normalized = normalizeShowDetails({
      id: 1,
      name: 'Orbit Show',
      genres: [
        { id: 18, name: 'Drama' },
        { id: 9648, name: 'Mystery' },
        { id: 0, name: '   ' },
      ],
      networks: [
        { id: 49, name: 'HBO' },
        { id: 213, name: 'Netflix' },
      ],
      seasons: [],
    })

    expect(normalized.genres).toEqual(['Drama', 'Mystery'])
    expect(normalized.networks).toEqual(['HBO', 'Netflix'])
    expect(normalized.genres[0]).toEqual(expect.any(String))
    expect(normalized.networks[0]).toEqual(expect.any(String))
  })

  it('defaults missing genres and networks to empty arrays', () => {
    const normalized = normalizeShowDetails({ id: 1, name: 'Unknown', seasons: [] })
    expect(normalized.genres).toEqual([])
    expect(normalized.networks).toEqual([])
  })
})
