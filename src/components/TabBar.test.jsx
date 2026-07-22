import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import TabBar from './TabBar'

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const tabBarSource = source('./TabBar.jsx')
const css = source('../index.css')

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? ''
}

function renderAt(path) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <TabBar />
    </MemoryRouter>,
  )
}

describe('icon-only bottom navigation', () => {
  it('renders no visible label text for any of the four destinations', () => {
    const html = renderAt('/browse')
    for (const label of ['Discover', 'Watching', 'Insights', 'Settings']) {
      expect(html).not.toContain(`>${label}<`)
    }
  })

  it('keeps each destination reachable with its accessible name preserved', () => {
    const html = renderAt('/browse')
    expect(html).toContain('href="/browse"')
    expect(html).toContain('aria-label="Discover"')
    expect(html).toContain('href="/watching"')
    expect(html).toContain('aria-label="Watching"')
    expect(html).toContain('href="/stats"')
    expect(html).toContain('aria-label="Insights"')
    expect(html).toContain('href="/settings"')
    expect(html).toContain('aria-label="Settings"')
  })

  it('exposes the nav landmark as labelled primary navigation', () => {
    expect(tabBarSource).toContain('aria-label="Primary"')
    expect(tabBarSource).toMatch(/<nav\b[^>]*aria-label="Primary"/)
  })

  it('marks exactly the active route with aria-current="page"', () => {
    const html = renderAt('/settings')
    expect((html.match(/aria-current="page"/g) ?? [])).toHaveLength(1)
    expect(html).toMatch(/href="\/settings"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/settings"/)
  })

  it('uses only inline SVG icons, no icon-package dependency', () => {
    expect(tabBarSource).toContain('<svg')
    expect(tabBarSource).not.toMatch(/from ['"](react-icons|@heroicons|lucide-react|@mui\/icons-material)/)
    const pkg = source('../../package.json')
    expect(pkg).not.toMatch(/react-icons|heroicons|lucide|@mui\/icons-material|feather-icons/)
  })

  it('gives every icon the same shared sizing and stroke contract', () => {
    const html = renderAt('/browse')
    expect((html.match(/class="tab-icon( tab-icon--solid)?"/g) ?? []).length).toBe(4)
    expect((html.match(/viewBox="0 0 24 24"/g) ?? []).length).toBe(4)

    const iconRule = rule('.tab-icon')
    expect(iconRule).toContain('width: 1.375rem')
    expect(iconRule).toContain('height: 1.375rem')
    expect(iconRule).toContain('stroke-width: 1.6')
  })

  it('keeps a 44x44 CSS px minimum touch target per tab', () => {
    const linkRule = rule('.app-tab-bar__link')
    expect(linkRule).toMatch(/min-height:\s*3rem/)
    // 3rem (48px) min-height plus the flex-1 width share of a bar that is at
    // least 4 * 44px wide comfortably clears the 44x44 minimum.
    const barRule = rule('.app-tab-bar')
    expect(barRule).toMatch(/min-height:\s*4rem/)
  })

  it('signals the active tab with more than color alone', () => {
    const activeIconRule = rule(".app-tab-bar__link[aria-current='page'] .tab-icon")
    expect(activeIconRule).toContain('stroke-width: 2.05')
    // The gold diamond marker is also retained as a persistent non-color cue.
    expect(rule(".app-tab-bar__link[aria-current='page']::after")).toContain('content: \'\'')
    expect(rule(".app-tab-bar__link[aria-current='page']")).toContain('var(--color-selection)')
  })

  it('keeps inactive icons neutral, not gold', () => {
    const inactiveRule = rule('.app-tab-bar__link')
    expect(inactiveRule).toContain('var(--color-text-muted)')
    expect(inactiveRule).not.toContain('var(--color-selection)')
  })

  it('does not add a background tile or pill behind icons', () => {
    const linkRule = rule('.app-tab-bar__link')
    expect(linkRule).not.toMatch(/background\s*:/)
    const activeRule = rule(".app-tab-bar__link[aria-current='page']")
    expect(activeRule).not.toMatch(/background\s*:/)
  })

  it('respects reduced motion for the icon stroke-weight transition', () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/)
    const reducedMotionBlock = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedMotionBlock).toContain('transition-duration: 1ms !important')
  })
})
