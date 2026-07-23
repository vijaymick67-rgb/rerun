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

function rule(selector) {
  // Escape regex metacharacters in the selector, then grab the single rule body.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = previewCss.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`))
  return match ? match[0] : null
}

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

describe('StatsAllPreview — literal ">>" continuation overlay', () => {
  it('1. renders the exact "All(90)" heading — no space before the parenthesis', () => {
    const html = render(manyShows(90))
    expect(html).toContain('All(90)')
    expect(html).not.toContain('All (90)')
  })

  it('2. the visible text contains a literal ">>"', () => {
    const html = render(manyShows(90))
    const linkBlock = html.slice(html.indexOf('stats-all-preview__more-link'))
    expect(linkBlock).toContain('&gt;&gt;')
  })

  it('3. no SVG icon exists anywhere in the preview (markup or source)', () => {
    const html = render(manyShows(90))
    expect(html).not.toContain('<svg')
    const source = readFileSync(new NodeURL('./StatsAllPreview.jsx', import.meta.url), 'utf8')
    expect(source).not.toContain('<svg')
  })

  it('4. no old circular chevron class exists (markup, source, or CSS)', () => {
    const html = render(manyShows(90))
    const source = readFileSync(new NodeURL('./StatsAllPreview.jsx', import.meta.url), 'utf8')
    expect(html).not.toContain('stats-all-preview__chevron')
    expect(source).not.toContain('stats-all-preview__chevron')
    expect(previewCss).not.toContain('.stats-all-preview__chevron')
  })

  it('5. exactly one link exists for a history that overflows the preview', () => {
    const html = render(manyShows(90))
    expect((html.match(/<a /g) ?? []).length).toBe(1)
    expect(html).not.toContain('<button')
  })

  it('6. 1, 2, and 3 shows render zero links, no shade, and no ">>"', () => {
    for (const count of [1, 2, 3]) {
      const html = render(manyShows(count))
      expect((html.match(/<a /g) ?? []).length).toBe(0)
      expect(html).not.toContain('&gt;&gt;')
      expect(html).not.toContain('stats-all-preview__continuation')
    }
  })

  it('7. the single link points to /stats/all', () => {
    const html = render(manyShows(90))
    expect(html).toContain('href="/stats/all"')
  })

  it('8. the link\'s accessible name includes the live show count', () => {
    expect(render(manyShows(90))).toMatch(/aria-label="View all 90 shows"/)
    expect(render(manyShows(7))).toMatch(/aria-label="View all 7 shows"/)
  })

  it('9. the link is not inside an aria-hidden=true ancestor', () => {
    const html = render(manyShows(90))
    // The aria-hidden row is closed before the continuation/link opens.
    const rowStart = html.indexOf('stats-all-preview__row')
    const linkStart = html.indexOf('stats-all-preview__more-link')
    const between = html.slice(rowStart, linkStart)
    // The row div must be closed (its own subtree ended) before the link.
    expect(between).toContain('</div>')
    // The continuation wrapper that holds the link is not aria-hidden.
    expect(html).not.toMatch(/stats-all-preview__continuation"[^>]*aria-hidden="true"/)
  })

  it('10. the continuation overlay has explicit higher stacking than the poster <img>', () => {
    // The loaded poster image is position:relative; z-index:1 (.progressive-image__img).
    // The continuation MUST carry a z-index strictly above that or the artwork
    // paints over the shade and ">>" — the exact production regression.
    const imgRule = css.match(/\.progressive-image__img\s*\{[^}]*\}/)[0]
    const imgZ = Number(imgRule.match(/z-index:\s*(\d+)/)[1])
    const contRule = rule('.stats-all-preview__continuation')
    const contZ = Number(contRule.match(/z-index:\s*(\d+)/)[1])
    expect(imgZ).toBe(1)
    expect(contZ).toBeGreaterThan(imgZ)
  })

  it('11. the shade has pointer-events: none', () => {
    expect(rule('.stats-all-preview__continuation-shade')).toContain('pointer-events: none;')
  })

  it('12. the shade uses a flat tint, not a gradient', () => {
    expect(rule('.stats-all-preview__continuation-shade')).not.toContain('gradient')
  })

  it('13. the link hit target is at least 44x44px', () => {
    const linkRule = rule('.stats-all-preview__more-link')
    expect(remToPx(linkRule.match(/(?:^|\s)width:\s*([\d.]+rem)/)[1])).toBeGreaterThanOrEqual(44)
    expect(remToPx(linkRule.match(/(?:^|\s)height:\s*([\d.]+rem)/)[1])).toBeGreaterThanOrEqual(44)
  })

  it('14. the continuation width is between 48px and ~60px (matches the partial reveal)', () => {
    const width = remToPx(rule('.stats-all-preview__continuation').match(/(?:^|\s)width:\s*([\d.]+rem)/)[1])
    expect(width).toBeGreaterThanOrEqual(48)
    expect(width).toBeLessThanOrEqual(60)
  })

  it('15. the link does not span the card\'s full height (fixed height, no inset:0)', () => {
    const linkRule = rule('.stats-all-preview__more-link')
    expect(linkRule).not.toMatch(/inset:\s*0/)
    expect(linkRule).toMatch(/height:\s*2\.75rem/)
    // Nor may the continuation overlay it lives in span the full padded card.
    const contRule = rule('.stats-all-preview__continuation')
    expect(contRule).not.toMatch(/inset:\s*0/)
  })

  it('16-18. taps on posters, card space, and the shaded partial poster do not navigate', async () => {
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

    const path = () => container.querySelector('[data-testid="location-probe"]').textContent
    const click = (el) => act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    const posters = container.querySelectorAll('.stats-all-preview__poster')
    await click(posters[0])
    expect(path()).toBe('/stats')
    await click(posters[2])
    expect(path()).toBe('/stats')

    // Card space (the outer preview surface, away from the link).
    await click(container.querySelector('.stats-all-preview__row'))
    expect(path()).toBe('/stats')

    // The decorative shade over the partial poster.
    const shade = container.querySelector('.stats-all-preview__continuation-shade')
    expect(shade).not.toBeNull()
    await click(shade)
    expect(path()).toBe('/stats')

    await act(async () => root.unmount())
    container.remove()
    container = null
    root = null
  })

  it('19. tapping the ">>" link navigates to /stats/all', async () => {
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

  it('20. the preview row clips overflow and is not scrollable', () => {
    const rowRule = rule('.stats-all-preview__row')
    expect(rowRule).toContain('overflow: hidden;')
    expect(previewCss).not.toContain('overflow-x: auto')
    expect(previewCss).not.toContain('overflow-x: scroll')
    expect(previewCss).not.toContain('overflow-y: scroll')
  })

  it('21. the card has no right padding (partial poster runs flush to the right edge)', () => {
    const cardRule = rule('.stats-all-preview')
    expect(cardRule).toContain('overflow: hidden;')
    expect(cardRule).toMatch(/padding:\s*0\.75rem 0 0\.875rem 0\.75rem;/)
  })

  it('22. the continuation is aligned to the poster area only — it cannot create a bottom strip', () => {
    const contRule = rule('.stats-all-preview__continuation')
    // top/bottom equal the card's own vertical padding, so the overlay spans
    // exactly the row (poster) box and never the card's bottom padding.
    expect(contRule).toMatch(/top:\s*0\.75rem/)
    expect(contRule).toMatch(/bottom:\s*0\.875rem/)
    // The shade fills only that box (inset:0 of the continuation), no extra region.
    expect(rule('.stats-all-preview__continuation-shade')).toMatch(/inset:\s*0/)
  })

  it('23. the preview mounts at most six posters, even for a long history', () => {
    const html = render(manyShows(30))
    const posterCount = (html.match(/class="stats-all-preview__poster"/g) ?? []).length
    expect(posterCount).toBeLessThanOrEqual(6)
  })

  it('24. no viewport JS measurement is used — poster width is pure fluid CSS', () => {
    const source = readFileSync(new NodeURL('./StatsAllPreview.jsx', import.meta.url), 'utf8')
    expect(source).not.toContain('innerWidth')
    expect(source).not.toContain('resize')
    expect(source).not.toContain('useState')
    expect(source).not.toContain('useEffect')
    const posterRule = rule('.stats-all-preview__poster')
    expect(posterRule).toContain('calc(')
    expect(posterRule).not.toContain('vw')
  })

  // --- Additional guards ---

  it('posters remain plain, passive divs — not links or buttons', () => {
    const html = render(manyShows(90))
    expect(html).not.toMatch(/<a [^>]*class="stats-all-preview__poster"/)
    expect(html).not.toMatch(/<button[^>]*class="stats-all-preview__poster"/)
  })

  it('renders nothing for an empty history — no All(0) heading', () => {
    const html = render([])
    expect(html).toBe('')
    expect(html).not.toContain('All(0)')
  })

  it('the more-link has no circular background, border, or box-shadow', () => {
    const linkRule = rule('.stats-all-preview__more-link')
    expect(linkRule).not.toContain('border-radius')
    expect(linkRule).not.toContain('border:')
    expect(linkRule).not.toContain('box-shadow')
    expect(linkRule).not.toContain('background')
  })

  it('the ">>" text uses structural aged gold with a shadow for legibility over artwork', () => {
    const textRule = rule('.stats-all-preview__more-text')
    expect(textRule).toContain('color: var(--color-gold-accent-strong);')
    expect(textRule).not.toMatch(/color:\s*var\(--color-(?:emerald|completion|progress)/)
    expect(textRule).toContain('text-shadow')
    const fontPx = remToPx(textRule.match(/font-size:\s*([\d.]+rem)/)[1])
    expect(fontPx).toBeGreaterThanOrEqual(20) // 1.25rem
    expect(fontPx).toBeLessThanOrEqual(24) // 1.5rem
  })

  it('focus-visible styling exists for the more-link', () => {
    expect(previewCss).toContain('.stats-all-preview__more-link:focus-visible {')
    expect(rule('.stats-all-preview__more-link:focus-visible')).toContain('outline:')
  })

  // Real-device polish: the "SHOW HISTORY" eyebrow and the "Archive" hint
  // word are removed from this preview header specifically. All(n) is the
  // only visible label left — no replacement eyebrow/secondary word, and no
  // leftover dead wrapper for either removed label.
  it('no longer renders the "Show history" eyebrow or the "Archive" hint word', () => {
    const html = render(manyShows(90))
    expect(html).not.toContain('Show history')
    expect(html).not.toContain('SHOW HISTORY')
    expect(html).not.toContain('>Archive<')
    expect(html).toContain('All(90)')
  })

  it('does not replace either removed label with a different eyebrow/secondary word', () => {
    const source = readFileSync(new NodeURL('./StatsAllPreview.jsx', import.meta.url), 'utf8')
    expect(source).not.toContain('type-badge')
    expect(source).not.toContain('stats-archive-preview__hint')
  })

  it('leaves the poster preview, continuation link, and z-index protection unchanged', () => {
    const html = render(manyShows(90))
    expect(html).toContain('href="/stats/all"')
    expect(html).toContain('&gt;&gt;')
    const posterCount = (html.match(/class="stats-all-preview__poster"/g) ?? []).length
    expect(posterCount).toBeLessThanOrEqual(6)
  })
})

describe('StatsAllPreview — interaction cleanup', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('a small history (3 shows) has no link and no continuation to tap at all', async () => {
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
    expect(container.querySelector('.stats-all-preview__continuation')).toBeNull()
    await act(async () => root.unmount())
  })
})
