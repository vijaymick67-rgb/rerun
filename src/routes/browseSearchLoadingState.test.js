import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const browseSource = readFileSync(new URL('./Browse.jsx', import.meta.url), 'utf8')

describe('Browse search loading state', () => {
  it('replaces the plain "Searching…" text with a card-shaped skeleton', () => {
    expect(browseSource).not.toContain('Searching…')
    expect(browseSource).toContain("import BrowseResultsSkeleton from '../components/BrowseResultsSkeleton'")
    expect(browseSource).toContain('{loading && <BrowseResultsSkeleton />}')
  })

  it('still gates the real results grid on the same loading/error/results state', () => {
    expect(browseSource).toContain('{!loading && !error && results.length > 0 && (')
  })

  it('does not introduce any new network calls for the loading-state change', () => {
    expect(browseSource).not.toContain('fetch(')
    // The only search call remains the existing debounced TMDB search.
    expect((browseSource.match(/searchShows\(/g) ?? []).length).toBe(1)
  })
})
