import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const browseSource = readFileSync(new URL('./Browse.jsx', import.meta.url), 'utf8')
const skeletonSource = readFileSync(
  new URL('../components/BrowseResultsSkeleton.jsx', import.meta.url),
  'utf8',
)

describe('Browse search loading state', () => {
  it('replaces the plain visible "Searching…" paragraph with a card-shaped skeleton', () => {
    expect(browseSource).not.toContain('<p className="mt-4 text-sm text-(--color-text-muted)">Searching…</p>')
    expect(browseSource).toContain("import BrowseResultsSkeleton from '../components/BrowseResultsSkeleton'")
    expect(browseSource).toContain('<BrowseResultsSkeleton />')
  })

  it('still gates the real results grid on the same loading/error/results state', () => {
    expect(browseSource).toContain('{!loading && !error && results.length > 0 && (')
  })

  it('does not introduce any new network calls for the loading-state change', () => {
    expect(browseSource).not.toContain('fetch(')
    // The only search call remains the existing debounced TMDB search.
    expect((browseSource.match(/searchShows\(/g) ?? []).length).toBe(1)
  })

  it('keeps the visual skeleton fully decorative', () => {
    expect(skeletonSource).toContain('aria-hidden="true"')
    // The skeleton component itself carries no accessible status text —
    // that lives in Browse.jsx so screen-reader users get exactly one
    // announcement per real loading transition, not one per placeholder card.
    expect(skeletonSource).not.toContain('role="status"')
    expect(skeletonSource).not.toContain('aria-live')
  })

  it('announces an accessible "Searching…" status only while loading, without being visible', () => {
    const loadingBlock = browseSource.slice(
      browseSource.indexOf('{loading && ('),
      browseSource.indexOf('{error &&'),
    )

    expect(loadingBlock).toContain('role="status"')
    expect(loadingBlock).toContain('aria-live="polite"')
    expect(loadingBlock).toContain('Searching…')

    // sr-only, not the old visible paragraph styling — the fix must not
    // resurrect a visible loading line alongside the skeleton.
    expect(loadingBlock).toContain('sr-only')
    expect(loadingBlock).not.toContain('text-sm text-(--color-text-muted)">Searching…')
  })
})
