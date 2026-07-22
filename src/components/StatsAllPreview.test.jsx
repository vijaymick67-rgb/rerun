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

describe('StatsAllPreview — literal ">>" overlay on the partial poster', () => {
  it('1. the visible text contains a literal ">>"', () => {
    const html = render(manyShows(90))
    const linkBlock = html.slice(html.indexOf('stats-all-preview__more-link'))
    expect(linkBlock).toContain('&gt;&gt;')
  })

  it('2. no SVG chevron icon exists anywhere in the preview', () => {
    const html = render(manyShows(90))
    expect(html).not.toContain('<svg')
  })

  it('3. no circular chevron class exists', () => {
    const html = render(manyShows(90))
    expect(html).not.toContain('stats-all-preview__chevron')
    expect(previewCss).not.toContain('.stats-all-preview__chevron')
  })

  it('4. exactly one link exists for a history with more shows than fit in the preview', () => {
    const html = render(manyShows(90))
    expect((html.match(/<a /g) ?? []).length).toBe(1)
    expect(html).not.toContain('<button')
  })

  it('5. the single link points to /stats/all', () => {
    const html = render(manyShows(90))
    expect(html).toContain('href="/stats/all"')
  })

  it('6. the link\'s accessible name includes the live count', () => {
    const html = render(manyShows(90))
    expect(html).toMatch(/aria-label="View all 90 shows"/)
  })

  it('7. the link\'s hit-target CSS is at least 44x44px', () => {
    const linkRule = previewCss.match(/\.stats-all-preview__more-link \{[^}]*\}/)[0]
    const width = remToPx(linkRule.match(/(?:^|\s)width:\s*([\d.]+rem)/)[1])
    const height = remToPx(linkRule.match(/(?:^|\s)height:\s*([\d.]+rem)/)[1])
    expect(width).toBeGreaterThanOrEqual(44)
    expect(height).toBeGreaterThanOrEqual(44)
  })

  it('8. the link width is not the previous 72px full-edge zone', () => {
    const linkRule = previewCss.match(/\.stats-all-preview__more-link \{[^}]*\}/)[0]
    const width = remToPx(linkRule.match(/(?:^|\s)width:\s*([\d.]+rem)/)[1])
    expect(width).toBeLessThan(72)
  })

  it('9. the link does not span the full preview card height', () => {
    const linkRule = previewCss.match(/\.stats-all-preview__more-link \{[^}]*\}/)[0]
    expect(linkRule).not.toMatch(/inset:\s*0/)
    expect(linkRule).not.toContain('min-height: 2.75rem')
    expect(linkRule).toMatch(/height:\s*2\.75rem/)
  })

  it('10. posters remain plain, passive divs — not links or buttons', () => {
    const html = render(manyShows(90))
    expect(html).not.toMatch(/<a [^>]*class="stats-all-preview__poster"/)
    expect(html).not.toMatch(/<button[^>]*class="stats-all-preview__poster"/)
  })

  it('11-13. tapping posters or the shaded partial poster (outside the link) does not navigate', async () => {
    let container = document.createElement('div')
    document.body.appendChild(container)
    let root = createRoot(container)

    function LocationProbe() {
      const location = useLocation()
      return <div data-testid="location-probe">{location.pathname}</div>
    }

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/stats']}>
          <StatsAllPreview shows={manyShows(90)} />
          <LocationProbe />
        </MemoryRouter>,
      )
    })

    function locationPath() {
      return container.querySelector('[data-testid="location-probe"]').textContent
    }

    function click(el) {
      return act(async () => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
    }

    const posters = container.querySelectorAll('.stats-all-preview__poster')
    await click(posters[0])
    expect(locationPath()).toBe('/stats')

    await click(posters[2])
    expect(locationPath()).toBe('/stats')

    const shade = container.querySelector('.stats-all-preview__partial-shade')
    expect(shade).not.toBeNull()
    await click(shade)
    expect(locationPath()).toBe('/stats')

    await act(async () => root.unmount())
    container.remove()
    container = null
    root = null
  })

  it('14. tapping the ">>" link navigates to /stats/all', async () => {
    let container = document.createElement('div')
    document.body.appendChild(container)
    let root = createRoot(container)

    function LocationProbe() {
      const location = useLocation()
      return <div data-testid="location-probe">{location.pathname}</div>
    }

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/stats']}>
          <StatsAllPreview shows={manyShows(90)} />
          <LocationProbe />
        </MemoryRouter>,
      )
    })

    const moreLink = container.querySelector('.stats-all-preview__more-link')
    expect(moreLink).not.toBeNull()
    expect(moreLink.getAttribute('href')).toBe('/stats/all')
    await act(async () => {
      moreLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(container.querySelector('[data-testid="location-probe"]').textContent).toBe('/stats/all')

    await act(async () => root.unmount())
    container.remove()
    container = null
    root = null
  })

  it('15. 1, 2, and 3 shows render zero links and no ">>"', () => {
    for (const count of [1, 2, 3]) {
      const html = render(manyShows(count))
      expect((html.match(/<a /g) ?? []).length).toBe(0)
      expect(html).not.toContain('&gt;&gt;')
      expect(html).not.toContain('stats-all-preview__partial-shade')
    }
  })

  it('16. no SVG chevron remains anywhere in the source or CSS', () => {
    const source = readFileSync(new NodeURL('./StatsAllPreview.jsx', import.meta.url), 'utf8')
    expect(source).not.toContain('<svg')
    expect(source).not.toContain('stats-all-preview__chevron')
  })

  it('17. the shading overlay has pointer-events: none', () => {
    const shadeRule = previewCss.match(/\.stats-all-preview__partial-shade \{[^}]*\}/)[0]
    expect(shadeRule).toContain('pointer-events: none;')
  })

  it('18. no viewport JS sizing is introduced', () => {
    const source = readFileSync(new NodeURL('./StatsAllPreview.jsx', import.meta.url), 'utf8')
    expect(source).not.toContain('innerWidth')
    expect(source).not.toContain('useState')
    expect(source).not.toContain('useEffect')
    const posterRule = previewCss.match(/\.stats-all-preview__poster \{[^}]*\}/)[0]
    expect(posterRule).toMatch(/width:\s*clamp\(/)
    expect(posterRule).toContain('calc(')
    expect(posterRule).not.toContain('vw')
  })

  it('19. the preview row clips overflow with no horizontal scrollbar', () => {
    expect(previewCss).toContain('.stats-all-preview__row {')
    const rowRule = previewCss.match(/\.stats-all-preview__row \{[^}]*\}/)[0]
    expect(rowRule).toContain('overflow: hidden;')
    expect(previewCss).not.toContain('overflow-x: auto')
    expect(previewCss).not.toContain('overflow-x: scroll')
  })

  it('20. poster count remains capped at six, even for long histories', () => {
    const html = render(manyShows(30))
    const posterCount = (html.match(/class="stats-all-preview__poster"/g) ?? []).length
    expect(posterCount).toBeLessThanOrEqual(6)
  })

  it('renders the exact "All(90)" heading — no space before the parenthesis', () => {
    const html = render(manyShows(90))
    expect(html).toContain('All(90)')
    expect(html).not.toContain('All (90)')
  })

  it('renders nothing for an empty history — no All(0) heading', () => {
    const html = render([])
    expect(html).toBe('')
    expect(html).not.toContain('All(0)')
  })

  it('the partial 4th poster runs flush to the card\'s right edge (no right padding on the card)', () => {
    const cardRule = previewCss.match(/\.stats-all-preview \{[^}]*\}/)[0]
    expect(cardRule).toContain('overflow: hidden;')
    expect(cardRule).toMatch(/padding:\s*0\.75rem 0 0\.875rem 0\.75rem;/)
  })

  it('the shade does not use a wide gradient covering the 3rd poster', () => {
    const shadeRule = previewCss.match(/\.stats-all-preview__partial-shade \{[^}]*\}/)[0]
    expect(shadeRule).not.toContain('gradient')
    const width = remToPx(shadeRule.match(/width:\s*([\d.]+rem)/)[1])
    expect(width).toBeLessThanOrEqual(44)
  })

  it('the more-link has no circular background, border, or box-shadow', () => {
    const linkRule = previewCss.match(/\.stats-all-preview__more-link \{[^}]*\}/)[0]
    expect(linkRule).not.toContain('border-radius')
    expect(linkRule).not.toContain('border:')
    expect(linkRule).not.toContain('box-shadow')
    expect(linkRule).not.toContain('background')
  })

  it('focus-visible styling exists for the more-link', () => {
    expect(previewCss).toContain('.stats-all-preview__more-link:focus-visible {')
    expect(previewCss).toMatch(/\.stats-all-preview__more-link:focus-visible \{[^}]*outline:/)
  })
})

describe('StatsAllPreview — interaction cleanup', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('a small history (3 shows) has no link and no shade to tap at all', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/stats']}>
          <StatsAllPreview shows={manyShows(3)} />
        </MemoryRouter>,
      )
    })
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('.stats-all-preview__partial-shade')).toBeNull()
    await act(async () => root.unmount())
  })
})
