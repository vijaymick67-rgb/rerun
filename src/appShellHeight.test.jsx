import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./components/ReloadPrompt', () => ({ default: () => null }))

import App from './App.jsx'

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')

function getRuleBody(source, selector) {
  const match = source.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? ''
}

function renderApp(path) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

describe('app shell height contract', () => {
  it('anchors .app-shell to the real dynamic viewport instead of an ancestor % chain', () => {
    const shellRule = getRuleBody(css, '\\.app-shell')
    expect(shellRule).toMatch(/min-height:\s*100vh/)
    expect(shellRule).toMatch(/min-height:\s*100dvh/)
    // A bare `min-height: 100%` depends on html/body/#root resolving their own
    // % chain correctly; on a short route that chain can settle shorter than
    // the true viewport, leaving the fixed TabBar pinned above the physical
    // bottom edge. dvh is computed directly from the live viewport, so it
    // can't be shortchanged by ancestor layout the way % can.
    expect(shellRule).not.toMatch(/min-height:\s*100%/)
  })

  it('reserves exactly the tab bar plus safe-area space once, not twice', () => {
    expect(css.match(/\.app-shell\s*\{/g)).toHaveLength(1)
    const shellRule = getRuleBody(css, '\\.app-shell')
    expect(shellRule).toContain('padding-bottom: calc(4rem + var(--safe-area-inset-bottom))')

    const tabBarRule = getRuleBody(css, '\\.app-tab-bar')
    expect(tabBarRule).toContain('min-height: 4rem')
    expect(tabBarRule).toContain('padding-bottom: var(--safe-area-inset-bottom)')
  })

  it.each(['/browse', '/watching', '/stats', '/settings'])(
    'keeps the global TabBar outside route-specific content on %s',
    (path) => {
      const html = renderApp(path)
      expect(html.match(/app-tab-bar/g)?.length).toBeGreaterThan(0)
      expect(html.indexOf('route-content')).toBeLessThan(html.indexOf('app-tab-bar'))
      expect(html).toContain('class="app-shell"')
    },
  )

  it('gives Settings the same shell-height contract as every other main tab', () => {
    const source = readFileSync(new URL('./routes/Settings.jsx', import.meta.url), 'utf8')
    expect(source).toContain('app-page')
    expect(source).not.toMatch(/min-h-screen|100vh|100dvh|position:\s*fixed/)
  })
})
