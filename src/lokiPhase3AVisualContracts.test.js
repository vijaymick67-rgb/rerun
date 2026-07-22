import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = source('./index.css')

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? ''
}

describe('Loki Armour Phase 3A visual contracts', () => {
  it('uses aged gold for Insights structure without borrowing progress emerald', () => {
    const summary = rule('.stats-summary')
    const insight = rule('.stats-insight')
    const continuation = rule('.stats-all-preview__more-text')

    expect(summary).toContain('var(--color-armour-edge-strong)')
    expect(continuation).toContain('var(--color-gold-accent-strong)')
    expect(`${summary}${insight}${continuation}`).not.toMatch(/--color-(?:emerald|completion|progress)/)
    expect(`${summary}${insight}`).not.toMatch(/rgb\(139 120 255|rgb\(73 117 255|--color-violet|--color-accent\)/)
  })

  it('keeps the archive preview geometry and interaction contracts untouched', () => {
    const preview = source('./components/StatsAllPreview.jsx')
    expect(preview).toContain('const PREVIEW_LIMIT = 6')
    expect(preview).toContain('shows.slice(0, PREVIEW_LIMIT)')
    expect(preview).toContain('to="/stats/all"')
    expect(rule('.stats-all-preview__continuation')).toContain('z-index: 2')
    expect(rule('.stats-all-preview__more-link')).toContain('width: 2.75rem')
    expect(rule('.stats-all-preview__more-link')).toContain('height: 2.75rem')
  })

  it('lets synopsis prose flow below the floated poster at compact supporting type', () => {
    const detail = source('./routes/ShowDetail.jsx')
    const poster = rule('.show-detail-poster')
    const flow = rule('.show-detail-hero__flow')
    const synopsis = rule('.show-detail-hero__synopsis')

    // One semantic synopsis paragraph, floated poster ahead of it in the same
    // flow-root context — no duplicate copy, no JS splitting.
    expect(detail).toContain('<p className="show-detail-hero__synopsis">')
    expect(detail.match(/show-detail-hero__synopsis/g)).toHaveLength(1)
    expect(detail).toContain('className="phase2-poster-frame show-detail-poster h-32 w-24"')
    expect(poster).toContain('float: left')
    expect(flow).toContain('display: flow-root')

    // Long-copy control lives on the flow container (bounded height + clip),
    // NOT a rectangular clamped box on the paragraph. The max-height is an
    // exact whole-line multiple (10 * 0.875rem*1.55 + 0.125rem padding) so a
    // long synopsis is cut between lines, never through a partial one.
    expect(flow).toContain('max-height: 13.6875rem')
    expect(flow).toContain('overflow: hidden')
    // The base (unclipped) rule must not itself carry a mask — so short
    // synopsis text is structurally guaranteed to be unaffected.
    expect(flow).not.toMatch(/mask-image/)

    // The paragraph must be a normal block so prose wraps under the poster.
    expect(synopsis).toContain('font-size: 0.875rem')
    expect(synopsis).not.toContain('-webkit-box')
    expect(synopsis).not.toContain('-webkit-line-clamp')
    expect(synopsis).not.toMatch(/\bline-clamp\b/)
    expect(detail).toContain('<h2>Seasons ({seasons.length})</h2>')
  })

  it('fades a genuinely clipped synopsis via a measured mask, never a solid strip', () => {
    const detail = source('./routes/ShowDetail.jsx')
    const clipped = rule('.show-detail-hero__flow--clipped')

    // The fade is a mask (reveals the hero's own surface), not an opaque
    // background overlay — so it can't read as a decorative gold strip.
    expect(clipped).toMatch(/mask-image:\s*linear-gradient\(to bottom, black/)
    expect(clipped).toContain('-webkit-mask-image')
    expect(clipped).not.toMatch(/background\s*:/)
    expect(clipped).not.toContain('gold')

    // Applied only when JS measurement finds real overflow (scrollHeight >
    // clientHeight) — never unconditionally, so short copy never gets it.
    expect(detail).toContain('node.scrollHeight > node.clientHeight')
    expect(detail).toContain('synopsisClipped')
    expect(detail).toContain("show-detail-hero__flow--clipped")
    expect(detail).not.toMatch(/split\(|slice\(0,\s*\d/)
  })

  it('drops the decorative eyebrows and the viewing-time corner stroke', () => {
    const stats = source('./routes/Stats.jsx')
    const allShows = source('./routes/StatsAllShows.jsx')

    expect(stats).not.toMatch(/Personal archive/i)
    expect(allShows).not.toMatch(/Viewing archive/i)
    // The decorative gold line/corner pseudo-element on the viewing-time card
    // is gone entirely.
    expect(css).not.toMatch(/\.stats-summary::after\s*\{/)
  })

  it('keeps the All Shows back control pointing at /stats', () => {
    const allShows = source('./routes/StatsAllShows.jsx')
    expect(allShows).toContain('to="/stats"')
    expect(allShows).toContain('aria-label="Back to Insights"')
  })

  it('renders the poster menu as plain upper-left dots with no tile, high-contrast shadow', () => {
    const card = source('./components/StatsShowCard.jsx')
    const actions = rule('.stats-show-card__actions')
    const svgRule = rule('.stats-show-card__actions svg')

    // 44x44 hit target retained, but positioned upper-left.
    expect(card).toContain('h-11 w-11')
    expect(card).toContain('left-0 top-0')
    expect(card).not.toContain('right-0.5 top-0.5')

    // No visible enclosure: no background/border tile behind the dots.
    expect(actions).not.toMatch(/background\s*:/)
    expect(actions).not.toMatch(/box-shadow\s*:/)

    // Ivory dots with a multi-direction drop-shadow halo for contrast.
    expect(actions).toContain('#f4efe2')
    expect(svgRule).toContain('drop-shadow')
  })
})
