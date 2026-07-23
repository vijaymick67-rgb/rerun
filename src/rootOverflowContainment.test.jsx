// Regression coverage for the "installed iPhone PWA shifts horizontally
// after leaving Discover search" fix. There was previously no root-level
// horizontal-overflow guard anywhere in the document (html, body, #root,
// .app-shell) — this pins the guard to exactly one boundary and confirms it
// doesn't quietly turn into a scroll container or spread beyond that one
// selector, and that it doesn't clip the app's one legitimate horizontally
// clipped (not scrolled) strip, .stats-all-preview__row.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')

function getRuleBody(source, selector) {
  const match = source.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? ''
}

describe('root horizontal-overflow containment', () => {
  it('clips document-level horizontal drift at html, without becoming a scroll container', () => {
    const htmlRule = getRuleBody(css, 'html')
    expect(htmlRule).toMatch(/overflow-x:\s*clip/)
    // clip (not hidden/auto/scroll) so html never becomes an unintended
    // independently-scrollable element.
    expect(htmlRule).not.toMatch(/overflow-x:\s*(hidden|auto|scroll)/)
  })

  it('adds the guard at exactly one place, not spread across the shell', () => {
    expect(css.match(/overflow-x:\s*clip/g)).toHaveLength(1)
    expect(getRuleBody(css, 'body')).not.toMatch(/overflow-x/)
    expect(getRuleBody(css, '#root')).not.toMatch(/overflow-x/)
    expect(getRuleBody(css, '\\.app-shell')).not.toMatch(/overflow-x/)
    expect(getRuleBody(css, '\\.app-tab-bar')).not.toMatch(/overflow-x/)
  })

  it('does not touch app-shell width, safe-area, or route geometry', () => {
    const shellRule = getRuleBody(css, '\\.app-shell')
    expect(shellRule).toContain('max-width: 42rem')
    expect(shellRule).toContain('padding-bottom: calc(4rem + var(--safe-area-inset-bottom))')
  })

  it('leaves the app\'s one intentionally horizontally-clipped strip alone', () => {
    // .stats-all-preview__row is a fixed, non-scrolling clipped reveal (see
    // StatsAllPreview.test.jsx) — confirm this fix didn't touch its own
    // local overflow rule.
    const rowRule = getRuleBody(css, '\\.stats-all-preview__row')
    expect(rowRule).toMatch(/overflow:\s*hidden/)
  })
})
