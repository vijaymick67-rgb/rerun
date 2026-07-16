import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./components/ReloadPrompt', () => ({ default: () => null }))

import App from './App.jsx'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')
const tabBarSource = readFileSync(new URL('./components/TabBar.jsx', import.meta.url), 'utf8')

function renderApp(path) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

describe('global iOS status-bar scrim', () => {
  it.each(['/browse', '/watching', '/stats', '/settings', '/watching/123', '/watching/123/season/1', '/missing'])(
    'renders exactly once for %s through the shared shell',
    (path) => {
      expect(renderApp(path).match(/global-top-scrim/g)).toHaveLength(1)
    },
  )

  it('uses a shallow fixed, non-interactive, blurred layer with fallbacks', () => {
    expect(css).toContain('.global-top-scrim {')
    expect(css).toContain('position: fixed')
    expect(css).toContain('height: calc(var(--safe-area-inset-top) + 0.75rem)')
    expect(css).toContain('pointer-events: none')
    expect(css).toContain('backdrop-filter: blur(10px)')
    expect(css).toContain('-webkit-backdrop-filter: blur(10px)')
    expect(css).toContain('mask-image: linear-gradient')
    expect(css).toContain('-webkit-mask-image: linear-gradient')
    expect(css).toContain('prefers-reduced-transparency: reduce')
    expect(css).not.toContain('var(--safe-area-inset-top) + 2.5rem')
  })

  it('retains one safe-area offset for tab and nested content', () => {
    expect(css.match(/\.app-page\s*\{/g)).toHaveLength(1)
    expect(css.match(/\.nested-page\s*\{/g)).toHaveLength(1)
    expect(css).toContain('padding-top: max(1rem, var(--safe-area-inset-top))')
    expect(css).toContain('padding-top: calc(var(--safe-area-inset-top) + 1rem)')
  })

  it('leaves bottom navigation and its safe-area behavior unchanged', () => {
    expect(tabBarSource).toContain('app-tab-bar fixed inset-x-0 bottom-0')
    expect(css).toContain('padding-bottom: var(--safe-area-inset-bottom)')
  })

  it('keeps route transitions between the stable shell layers', () => {
    const html = renderApp('/watching/123')
    expect(html).toContain('class="global-top-scrim"')
    expect(html).toContain('route-content route-content--nested')
    expect(html).toContain('app-tab-bar fixed inset-x-0 bottom-0')
    expect(html.indexOf('global-top-scrim')).toBeLessThan(html.indexOf('route-content'))
    expect(html.indexOf('route-content')).toBeLessThan(html.indexOf('app-tab-bar'))
    expect(css).toContain('animation: route-content-fade 160ms')
    expect(css).toContain('animation: route-content-nested-in 160ms')
    expect(css).toContain('route-content--tab')
    expect(css).toContain('route-content--nested')
    expect(css).toContain('animation: none')
  })
})
