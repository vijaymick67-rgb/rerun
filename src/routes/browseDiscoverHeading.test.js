import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Real-device polish: Discover was the only primary tab with no visible page
// title. This covers the added <h1>, its exact copy, its reuse of the
// existing safe-area/page-heading contract, and that the surrounding page
// composition/behavior was otherwise left alone.
const browseSource = readFileSync(new URL('./Browse.jsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

describe('Discover page heading', () => {
  it('renders exactly one semantic <h1>Discover</h1>, no eyebrow/subtitle variant', () => {
    expect(browseSource).toContain('<h1 className="type-page-title text-(--color-text)">Discover</h1>')
    expect((browseSource.match(/<h1[^>]*>/g) ?? []).length).toBe(1)
    for (const forbidden of ['Discovery', 'Browse</h1>', 'Explore']) {
      expect(browseSource).not.toContain(forbidden)
    }
  })

  it('reuses the existing route-heading + app-page safe-area contract instead of hardcoded padding', () => {
    expect(browseSource).toContain('<div className="app-page px-4 pb-4">')
    expect(browseSource).toContain('<header className="route-heading">')
    // No bespoke inline/arbitrary top padding introduced alongside the heading.
    expect(browseSource).not.toMatch(/<header[^>]*style=/)
    expect(browseSource).not.toMatch(/pt-\[\d/)
    // .app-page already owns safe-area-aware top padding; Browse must not
    // declare a second, competing top-padding rule of its own.
    expect(css).not.toMatch(/\.browse-page\s*\{[^}]*padding-top/)
  })

  it('places the heading directly above the search field, preserving section order', () => {
    const headerIndex = browseSource.indexOf('<header className="route-heading">')
    const searchIndex = browseSource.indexOf('className="browse-search"')
    const discoverIndex = browseSource.indexOf('<BrowseDiscover')
    expect(headerIndex).toBeGreaterThan(-1)
    expect(headerIndex).toBeLessThan(searchIndex)
    expect(searchIndex).toBeLessThan(discoverIndex)
  })

  it('preserves search and tracking behavior while handing feed ownership to Discover', () => {
    expect((browseSource.match(/searchShows\(/g) ?? []).length).toBe(1)
    expect(browseSource).toContain('DEBOUNCE_MS = 400')
    expect(browseSource).toContain("import BrowseDiscover from '../components/BrowseDiscover'")
    expect(browseSource).toContain('trackedShowsReady={trackedShowsReady}')
    expect(browseSource).toContain('hidden={Boolean(query.trim())}')
    expect(browseSource).not.toContain('<BrowseNews')
    expect(browseSource).not.toContain('fetch(')
  })
})
