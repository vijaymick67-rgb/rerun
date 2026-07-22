import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import StatsAllPreview from './StatsAllPreview'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

function show(tmdbId, name) {
  return { tmdb_id: tmdbId, name, poster_path: `/poster-${tmdbId}.jpg` }
}

function render(shows) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <StatsAllPreview shows={shows} />
    </MemoryRouter>,
  )
}

function manyShows(count) {
  return Array.from({ length: count }, (_, i) => show(i + 1, `Show ${i + 1}`))
}

describe('StatsAllPreview — main Insights compact collection preview', () => {
  it('renders the exact "All(42)" heading — no space before the parenthesis', () => {
    const html = render(manyShows(42))
    expect(html).toContain('All(42)')
    expect(html).not.toContain('All (42)')
    // The count appears once, in the heading — not as a separate visible
    // "42 shows" label (the aria-label attribute is not visible text).
    expect(html).not.toContain('>42 shows<')
  })

  it('navigates to /stats/all from a single link wrapping the whole card', () => {
    const html = render(manyShows(5))
    expect(html).toContain('href="/stats/all"')
    // Exactly one interactive control — no nested links/buttons inside it.
    expect((html.match(/<a /g) ?? []).length).toBe(1)
    expect(html).not.toContain('<button')
  })

  it('accessible name on the collection link includes the live count', () => {
    const html = render(manyShows(42))
    expect(html).toMatch(/aria-label="View all 42 shows"/)
  })

  it('renders only a bounded subset of posters, never the full history', () => {
    const html = render(manyShows(30))
    expect((html.match(/stats-all-preview__poster/g) ?? []).length).toBeLessThan(30)
    // Bounded to a conservative small number regardless of how large the
    // history is — the DOM never scales with total show count.
    expect((html.match(/stats-all-preview__poster/g) ?? []).length).toBeLessThanOrEqual(6)
  })

  it('shows the clipped-edge chevron affordance only when more shows exist than fit in the bounded preview', () => {
    const htmlMany = render(manyShows(10))
    expect(htmlMany).toContain('stats-all-preview__chevron')

    const htmlFew = render(manyShows(3))
    expect(htmlFew).not.toContain('stats-all-preview__chevron')
  })

  it('shows the chevron once the row actually clips (4+ shows), even below the DOM-mount cap of 6', () => {
    // Only ~3 posters are ever fully visible at the narrowest supported
    // width (see .stats-all-preview__poster's clamp() in index.css), so any
    // count above 3 is already clipped content and must surface the "more"
    // affordance — not just once the DOM-mount bound of 6 is exceeded.
    for (const count of [4, 5, 6]) {
      const html = render(manyShows(count))
      expect(html).toContain('stats-all-preview__chevron')
    }
  })

  it('still caps the number of mounted poster elements at 6, even when the chevron shows for fewer', () => {
    const html = render(manyShows(4))
    expect((html.match(/stats-all-preview__poster/g) ?? []).length).toBe(4)
  })

  it('small histories (2-3 shows) render exactly that many posters, never cloned, never a false "more" affordance', () => {
    const html = render([show(1, 'Alpha'), show(2, 'Beta')])
    expect((html.match(/stats-all-preview__poster/g) ?? []).length).toBe(2)
    expect(html).not.toContain('stats-all-preview__chevron')
  })

  it('a single show renders cleanly with no fake partial poster and no misleading chevron', () => {
    const html = render([show(1, 'Only Show')])
    expect((html.match(/stats-all-preview__poster/g) ?? []).length).toBe(1)
    expect(html).not.toContain('stats-all-preview__chevron')
    expect(html).toMatch(/aria-label="View all 1 show"/)
    expect(html).not.toContain('View all 1 shows')
  })

  it('renders nothing for an empty history — no All(0) heading', () => {
    const html = render([])
    expect(html).toBe('')
    expect(html).not.toContain('All(0)')
  })

  it('poster thumbnails are decorative (no repeated per-show alt text) since the parent link already carries the accessible name', () => {
    const html = render(manyShows(4))
    expect(html).not.toContain('alt="Show 1"')
    expect(html).toContain('aria-hidden="true"')
  })

  it('the preview row clips overflow with no horizontal scrollbar, sized to fit iPhone width via CSS (no JS viewport measurement)', () => {
    const previewBlock = css.slice(
      css.indexOf('.stats-all-preview {'),
      css.indexOf('.stats-all-preview__chevron svg'),
    )
    expect(previewBlock).toContain('.stats-all-preview__row {')
    expect(previewBlock).toContain('overflow: hidden;')
    expect(previewBlock).not.toContain('overflow-x: auto')
    expect(previewBlock).not.toContain('overflow-x: scroll')
    // Poster width is a CSS clamp/percentage, not a hard-coded device pixel
    // count — this is what produces the "~3 full + 1 clipped" reveal.
    expect(previewBlock).toMatch(/width:\s*clamp\(/)
  })

  it('the source itself never measures window.innerWidth for the preview sizing', () => {
    const source = readFileSync(new URL('./StatsAllPreview.jsx', import.meta.url), 'utf8')
    expect(source).not.toContain('innerWidth')
    expect(source).not.toContain('useState')
    expect(source).not.toContain('useEffect')
  })

  it('does not introduce a bespoke transition/animation outside the existing motion-press + reduced-motion conventions', () => {
    const previewBlock = css.slice(
      css.indexOf('.stats-all-preview {'),
      css.indexOf('.stats-all-preview__chevron svg'),
    )
    expect(previewBlock).not.toContain('transition:')
    expect(previewBlock).not.toContain('animation:')
  })
})
