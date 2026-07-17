import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import BrowseResultsSkeleton from './BrowseResultsSkeleton'

describe('BrowseResultsSkeleton', () => {
  it('renders a stable, card-shaped placeholder grid instead of empty text', () => {
    const html = renderToStaticMarkup(<BrowseResultsSkeleton />)

    // Matches Browse.jsx's real results grid so swapping loading -> loaded
    // doesn't shift layout.
    expect(html).toContain('grid-cols-2')
    expect(html).toContain('aspect-2/3')

    // A fixed, non-zero placeholder count keeps the grid's height stable
    // regardless of how many results eventually arrive.
    const cardMatches = html.match(/aspect-2\/3/g) ?? []
    expect(cardMatches.length).toBe(4)

    // Uses the animation utility governed by the app-wide
    // prefers-reduced-motion override in index.css, not bespoke motion.
    expect(html).toContain('animate-pulse')

    // Decorative only — the loading state has nothing for a screen reader
    // to announce beyond what's already conveyed elsewhere.
    expect(html).toContain('aria-hidden="true"')
  })
})
