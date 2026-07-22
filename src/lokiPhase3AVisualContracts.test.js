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

    expect(detail).toContain('<p className="show-detail-hero__synopsis">')
    expect(detail).toContain('className="phase2-poster-frame show-detail-poster h-32 w-24"')
    expect(poster).toContain('float: left')
    expect(flow).toContain('display: flow-root')
    expect(flow).toContain('max-height: 13.5rem')
    expect(synopsis).toContain('font-size: 0.875rem')
    expect(synopsis).toContain('line-height: 1.48')
    expect(synopsis).toContain('-webkit-line-clamp: 10')
    expect(detail).toContain('<h2>Seasons ({seasons.length})</h2>')
  })
})
