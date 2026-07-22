// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
// jsdom stubs the global URL constructor; readFileSync requires Node's own.
import { URL as NodeURL } from 'node:url'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import StatsAllPreview from './StatsAllPreview'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const css = readFileSync(new NodeURL('../index.css', import.meta.url), 'utf8')
const previewCss = css.slice(css.indexOf('.stats-all-preview {'), css.indexOf('.progress-track {'))

function show(tmdbId, name) {
  return { tmdb_id: tmdbId, name, poster_path: `/poster-${tmdbId}.jpg` }
}

function manyShows(count) {
  return Array.from({ length: count }, (_, i) => show(i + 1, `Show ${i + 1}`))
}

function render(shows) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <StatsAllPreview shows={shows} />
    </MemoryRouter>,
  )
}

function remToPx(remCss) {
  return parseFloat(remCss) * 16
}

describe('StatsAllPreview — main Insights compact collection preview', () => {
  it('renders the exact "All(90)" heading — no space before the parenthesis', () => {
    const html = render(manyShows(90))
    expect(html).toContain('All(90)')
    expect(html).not.toContain('All (90)')
    expect(html).not.toContain('>90 shows<')
  })

  it('renders exactly one link for a history with more shows than fit in the preview', () => {
    const html = render(manyShows(90))
    expect((html.match(/<a /g) ?? []).length).toBe(1)
    expect(html).not.toContain('<button')
  })

  it('the single link points to /stats/all', () => {
    const html = render(manyShows(90))
    expect(html).toContain('href="/stats/all"')
  })

  it('the outer preview card is a plain container, not a link', () => {
    const html = render(manyShows(90))
    expect(html).toMatch(/<div class="stats-all-preview content-surface">/)
  })

  it('poster elements are plain divs — not links or buttons', () => {
    const html = render(manyShows(90))
    const posterOpenTags = html.match(/<div class="stats-all-preview__poster">/g) ?? []
    expect(posterOpenTags.length).toBeGreaterThan(0)
    // No poster markup is itself an <a> or <button>.
    expect(html).not.toMatch(/<a [^>]*class="stats-all-preview__poster"/)
    expect(html).not.toMatch(/<button[^>]*class="stats-all-preview__poster"/)
  })

  it('accessible name on the more-link includes the live count', () => {
    const html = render(manyShows(90))
    expect(html).toMatch(/aria-label="View all 90 shows"/)
  })

  it('the chevron svg is decorative (aria-hidden)', () => {
    const html = render(manyShows(90))
    const chevronBlock = html.slice(html.indexOf('stats-all-preview__chevron'))
    expect(chevronBlock).toMatch(/<svg[^>]*aria-hidden="true"/)
  })

  it('1, 2, and 3 shows render zero links — no navigation from the preview', () => {
    for (const count of [1, 2, 3]) {
      const html = render(manyShows(count))
      expect((html.match(/<a /g) ?? []).length).toBe(0)
    }
  })

  it('4 shows render exactly one link, and it is the more-link', () => {
    const html = render(manyShows(4))
    expect((html.match(/<a /g) ?? []).length).toBe(1)
    expect(html).toContain('stats-all-preview__more-link')
  })

  it('4-6 shows retain the chevron affordance', () => {
    for (const count of [4, 5, 6]) {
      const html = render(manyShows(count))
      expect(html).toContain('stats-all-preview__chevron')
    }
  })

  it('renders only a bounded subset of posters, never the full history', () => {
    const html = render(manyShows(30))
    const posterCount = (html.match(/stats-all-preview__poster/g) ?? []).length
    expect(posterCount).toBeLessThan(30)
    expect(posterCount).toBeLessThanOrEqual(6)
  })

  it('still caps the number of mounted poster elements at 6, even when the chevron shows for fewer', () => {
    const html = render(manyShows(4))
    expect((html.match(/stats-all-preview__poster/g) ?? []).length).toBe(4)
  })

  it('small histories (2-3 shows) render exactly that many posters, no chevron, no link', () => {
    const html = render([show(1, 'Alpha'), show(2, 'Beta')])
    expect((html.match(/stats-all-preview__poster/g) ?? []).length).toBe(2)
    expect(html).not.toContain('stats-all-preview__chevron')
    expect((html.match(/<a /g) ?? []).length).toBe(0)
  })

  it('a single show renders cleanly with no fake partial poster, no chevron, and no link', () => {
    const html = render([show(1, 'Only Show')])
    expect((html.match(/stats-all-preview__poster/g) ?? []).length).toBe(1)
    expect(html).not.toContain('stats-all-preview__chevron')
    expect((html.match(/<a /g) ?? []).length).toBe(0)
    expect(html).not.toContain('aria-label="View all 1 show"')
  })

  it('renders nothing for an empty history — no All(0) heading', () => {
    const html = render([])
    expect(html).toBe('')
    expect(html).not.toContain('All(0)')
  })

  it('poster thumbnails are decorative (no repeated per-show alt text)', () => {
    const html = render(manyShows(4))
    expect(html).not.toContain('alt="Show 1"')
    expect(html).toContain('aria-hidden="true"')
  })

  it('the preview row clips overflow with no horizontal scrollbar', () => {
    expect(previewCss).toContain('.stats-all-preview__row {')
    expect(previewCss).toContain('overflow: hidden;')
    expect(previewCss).not.toContain('overflow-x: auto')
    expect(previewCss).not.toContain('overflow-x: scroll')
  })

  it('poster width is derived from the row\'s own available width (calc/clamp), not a viewport unit', () => {
    const posterRule = previewCss.match(/\.stats-all-preview__poster \{[^}]*\}/)[0]
    expect(posterRule).toMatch(/width:\s*clamp\(/)
    expect(posterRule).toContain('calc(')
    expect(posterRule).not.toContain('vw')
  })

  it('the source itself never measures window.innerWidth for the preview sizing', () => {
    const source = readFileSync(new NodeURL('./StatsAllPreview.jsx', import.meta.url), 'utf8')
    expect(source).not.toContain('innerWidth')
    expect(source).not.toContain('useState')
    expect(source).not.toContain('useEffect')
  })

  it('does not introduce a bespoke transition/animation outside the existing motion-press + reduced-motion conventions', () => {
    expect(previewCss).not.toContain('transition:')
    expect(previewCss).not.toContain('animation:')
  })

  it('preview posters no longer carry the individual border that caused the seam between the 3rd and clipped 4th poster', () => {
    const posterRule = previewCss.match(/\.stats-all-preview__poster \{[^}]*\}/)[0]
    expect(posterRule).not.toContain('border:')
    // The shared ProgressiveImage base's own inset hairline is neutralized
    // for this preview specifically (scoped selector, not a global change).
    expect(previewCss).toContain('.stats-all-preview__poster .progressive-image {')
    expect(previewCss).toContain('box-shadow: none;')
  })

  it('the more-link touch target meets the 44px minimum and the ~64-76px preferred iPhone width', () => {
    const linkRule = previewCss.match(/\.stats-all-preview__more-link \{[^}]*\}/)[0]
    const widthMatch = linkRule.match(/(?:^|\s)width:\s*([\d.]+rem)/)
    const minHeightMatch = linkRule.match(/min-height:\s*([\d.]+rem)/)
    expect(widthMatch).not.toBeNull()
    expect(minHeightMatch).not.toBeNull()
    expect(remToPx(widthMatch[1])).toBeGreaterThanOrEqual(64)
    expect(remToPx(minHeightMatch[1])).toBeGreaterThanOrEqual(44)
  })

  it('the more-link hit zone is substantially wider than the visible 44px chevron circle', () => {
    const linkRule = previewCss.match(/\.stats-all-preview__more-link \{[^}]*\}/)[0]
    const chevronRule = previewCss.match(/\.stats-all-preview__chevron \{[^}]*\}/)[0]
    const linkWidthPx = remToPx(linkRule.match(/(?:^|\s)width:\s*([\d.]+rem)/)[1])
    const chevronWidthPx = remToPx(chevronRule.match(/width:\s*([\d.]+rem)/)[1])
    expect(linkWidthPx).toBeGreaterThan(chevronWidthPx)
  })

  it('focus-visible styling exists for the more-link', () => {
    expect(previewCss).toContain('.stats-all-preview__more-link:focus-visible {')
    expect(previewCss).toMatch(/\.stats-all-preview__more-link:focus-visible \{[^}]*outline:/)
  })
})

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location-probe">{location.pathname}</div>
}

describe('StatsAllPreview — interaction: only the chevron zone navigates', () => {
  let container = null
  let root = null

  afterEach(async () => {
    if (root) await act(async () => root.unmount())
    container?.remove()
    container = null
    root = null
  })

  async function mount(count) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/stats']}>
          <StatsAllPreview shows={manyShows(count)} />
          <LocationProbe />
        </MemoryRouter>,
      )
    })
  }

  function click(el) {
    return act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }

  function locationPath() {
    return container.querySelector('[data-testid="location-probe"]').textContent
  }

  it('tapping a poster leaves the location unchanged', async () => {
    await mount(90)
    const poster = container.querySelector('.stats-all-preview__poster')
    expect(poster).not.toBeNull()
    await click(poster)
    expect(locationPath()).toBe('/stats')
  })

  it('tapping ordinary card space (the card itself, outside any poster or link) leaves the location unchanged', async () => {
    await mount(90)
    const card = container.querySelector('.stats-all-preview')
    await click(card)
    expect(locationPath()).toBe('/stats')
  })

  it('tapping the chevron/more-link navigates to /stats/all', async () => {
    await mount(90)
    const moreLink = container.querySelector('.stats-all-preview__more-link')
    expect(moreLink).not.toBeNull()
    expect(moreLink.getAttribute('href')).toBe('/stats/all')
    await click(moreLink)
    expect(locationPath()).toBe('/stats/all')
  })

  it('a small history (3 shows) has no link at all to tap', async () => {
    await mount(3)
    expect(container.querySelector('a')).toBeNull()
  })
})
