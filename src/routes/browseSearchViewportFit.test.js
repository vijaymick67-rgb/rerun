import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Regression coverage for "installed iPhone PWA shifts horizontally after
// Discover search".
//
// Empirically — measured in real Chromium at a mobile viewport across
// 320/360/375/390/414/430 CSS px — the Discover search-results layout has NO
// static horizontal overflow: the two-column grid resolves to minmax(0, 1fr)
// tracks, and the search field, the grid, and every result card sit exactly
// inside the route content width (document scrollWidth === clientWidth at
// every width). So the visible "everything is wider than the screen" in the
// bug report is not a width/box-sizing/min-width defect.
//
// The actual cause is iOS Safari's focus auto-zoom: focusing a text field
// whose computed font-size is below 16px zooms the visual viewport to enlarge
// the field. The Discover search field rendered at 15px (the --type-body-size
// token), so tapping it zoomed and panned the whole surface — the field spilled
// past the right edge, the grid looked over-wide, the trailing card was
// clipped, and because SPA tab navigation never resets that zoom, the next tab
// (Watching) stayed shifted too. Rendering the field at exactly 16px removes
// the zoom trigger; the layout is otherwise identical (width:100% field, fixed
// 2.75rem min-height).
//
// jsdom cannot lay out or zoom, so these are contract tests: they pin the real
// fix (16px field) and the surrounding layout contracts that prove the grid and
// input are contained (not the offender) and were not disturbed. The rendered
// geometry was verified manually in Chromium (see PR notes).
const browseSource = readFileSync(new URL('./Browse.jsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

function getRuleBody(source, selector) {
  const match = source.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? ''
}

describe('Discover search field fits the viewport (no iOS focus auto-zoom)', () => {
  it('renders the search field at 16px so iOS never auto-zooms on focus', () => {
    const rule = getRuleBody(css, '\\.browse-search')
    // The iOS auto-zoom threshold is a hard 16 CSS px. The field must sit at or
    // above it and must NOT fall back to the sub-16px body token that caused
    // the zoom.
    expect(rule).toMatch(/font-size:\s*16px/)
    expect(rule).not.toMatch(/font-size:\s*var\(--type-body-size\)/)
  })

  it('keeps the search field a contained full-width control, never a viewport-width one', () => {
    const rule = getRuleBody(css, '\\.browse-search')
    // width:100% fills the padded route content box; it must never be sized to
    // the viewport (100vw / w-screen), which would ignore the shell padding.
    expect(rule).toMatch(/width:\s*100%/)
    expect(rule).not.toMatch(/100vw/)
    // Touch target preserved (44px).
    expect(rule).toMatch(/min-height:\s*2\.75rem/)
  })

  it('keeps the results grid a contained two-column grid inside the padded page', () => {
    // grid-cols-2 compiles to repeat(2, minmax(0, 1fr)) — tracks that cannot
    // expand past the parent, which is why long titles / missing posters can't
    // widen it. It lives inside .app-page's px-4, not at viewport width.
    expect(browseSource).toContain('<div className="app-page px-4 pb-4">')
    expect(browseSource).toContain('className="mt-2 grid grid-cols-2 gap-3"')
  })

  it('introduces no viewport-width or negative-margin bleed in the Browse subtree', () => {
    expect(browseSource).not.toContain('w-screen')
    expect(browseSource).not.toContain('100vw')
    expect(browseSource).not.toMatch(/className="[^"]*-m[xlr]-/)
  })

  it('preserves the Add and Log-as-watched 44px touch targets', () => {
    // Both result-card actions keep their min-h-11 (44px) full-width targets.
    expect((browseSource.match(/motion-press mt-2 min-h-11 w-full/g) ?? []).length).toBe(1)
    expect((browseSource.match(/motion-press mt-1\.5 min-h-11 w-full/g) ?? []).length).toBe(1)
  })

  it('keeps the PR #135 root-containment and targeted-blur protections intact', () => {
    // This fix targets the true cause; it must not regress the earlier
    // defensive guards.
    expect(getRuleBody(css, 'html')).toMatch(/overflow-x:\s*clip/)
    const tabBar = readFileSync(new URL('../components/TabBar.jsx', import.meta.url), 'utf8')
    expect(tabBar).toContain("active.classList.contains('browse-search')")
    expect(tabBar).toContain('onPointerDown={releaseBrowseSearchFocus}')
  })
})
