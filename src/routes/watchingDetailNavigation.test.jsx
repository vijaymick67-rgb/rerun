import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import {
  getRouteShellKey,
  getRouteLevel,
  getScrollNavigationAction,
} from '../lib/scrollRestoration'

vi.mock('../components/ReloadPrompt', () => ({ default: () => null }))

import App from '../App.jsx'

function renderApp(path) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

// The reported regression: returning from Show Detail visibly blinked/faded the
// whole Watching tab and re-exposed the red Remove layer, because the route
// wrapper was keyed by `location.key` and remounted the Watching page (replaying
// its fade) on every navigation. The fix keys the wrapper by a stable per-shell
// identity and hosts the Watching list as a persistent parent above the detail
// <Outlet>, so it is preserved (hidden, not unmounted) across detail routes.
describe('route shell identity: tab switches vs. nested detail navigation', () => {
  it('gives every Watching-subtree path the SAME shell identity (no remount into/back from detail)', () => {
    const key = getRouteShellKey('/watching')
    expect(getRouteShellKey('/')).toBe(key)
    expect(getRouteShellKey('/watching/123')).toBe(key)
    expect(getRouteShellKey('/watching/123/season/1')).toBe(key)
  })

  it('gives each real tab its own shell identity (genuine tab switches still remount + animate)', () => {
    const keys = ['/browse', '/watching', '/stats', '/settings'].map(getRouteShellKey)
    expect(new Set(keys).size).toBe(4)
    expect(getRouteShellKey('/browse')).not.toBe(getRouteShellKey('/watching'))
  })

  it('does not collapse unrelated deep paths (e.g. not-found) into the watching shell', () => {
    expect(getRouteShellKey('/missing')).toBe('/missing')
    expect(getRouteShellKey('/missing')).not.toBe(getRouteShellKey('/watching'))
  })

  it('is a different identity source than location.key — it never varies within the watching subtree', () => {
    // Same shell across list + both nested levels, so the router reuses the
    // wrapper element and neither remounts Watching nor replays the tab fade.
    const subtree = ['/', '/watching', '/watching/123', '/watching/123/season/1']
    expect(new Set(subtree.map(getRouteShellKey)).size).toBe(1)
    // ...but the shells are still level-aware for the detail overlay decision.
    expect(getRouteLevel('/watching')).toBe(0)
    expect(getRouteLevel('/watching/123')).toBe(1)
    expect(getRouteLevel('/watching/123/season/1')).toBe(2)
  })
})

describe('App structure: Watching is preserved across the detail subtree', () => {
  it('renders the Watching list (app-page) on the list route with no detail overlay', () => {
    const html = renderApp('/watching')
    expect(html).toContain('app-page')
    expect(html).not.toContain('route-content--nested')
    expect(html).not.toContain('nested-page')
  })

  it('keeps the Watching list mounted (still present) while a Show Detail route is open', () => {
    const html = renderApp('/watching/123')
    // Watching's own page container is still in the tree...
    expect(html).toContain('app-page')
    // ...but hidden behind the detail overlay rather than unmounted.
    expect(html).toContain('style="display:none"')
    // ...and the detail is shown in the nested-entry wrapper via <Outlet>.
    expect(html).toContain('route-content route-content--nested')
    expect(html).toContain('nested-page')
  })

  it('keeps the Watching list mounted while a Season Detail route is open', () => {
    const html = renderApp('/watching/123/season/1')
    expect(html).toContain('app-page')
    expect(html).toContain('style="display:none"')
    expect(html).toContain('route-content route-content--nested')
  })

  it('keeps the shared route wrapper on route-content--tab across the whole subtree', () => {
    // The outer wrapper stays a tab shell (never swapped to a nested class on the
    // shared element), so returning to the list does not re-trigger a fade.
    expect(renderApp('/watching')).toContain('route-content route-content--tab')
    expect(renderApp('/watching/123')).toContain('route-content route-content--tab')
  })

  it('does not render the Watching list under a different tab (Browse stays isolated)', () => {
    const html = renderApp('/browse')
    expect(html).toContain('route-content route-content--tab')
    expect(html).not.toContain('style="display:none"')
    expect(html).not.toContain('nested-page')
  })

  it('still mounts scroll restoration and the shared shell chrome', () => {
    const html = renderApp('/watching/123')
    expect(html).toContain('app-shell')
    expect(html).toContain('global-top-scrim')
    expect(html).toContain('app-tab-bar')
  })
})

describe('App structure: route destinations unchanged', () => {
  it('keeps every existing path registered, including the nested detail routes', () => {
    // Rendering each path resolves the expected screen, proving destinations
    // survived the layout-route refactor.
    expect(renderApp('/browse')).toContain('route-content')
    expect(renderApp('/stats')).toContain('route-content')
    expect(renderApp('/settings')).toContain('route-content')
    expect(renderApp('/watching')).toContain('app-page')
    expect(renderApp('/watching/123')).toContain('nested-page')
    expect(renderApp('/watching/123/season/1')).toContain('nested-page')
  })
})

describe('scroll restoration still restores the Watching list on detail Back', () => {
  it('treats POP back from a detail route to the watching list as a restore', () => {
    const action = getScrollNavigationAction({
      isInitial: false,
      navigationType: 'POP',
      previousPathname: '/watching/123',
      pathname: '/watching',
    })
    expect(action).toEqual({ type: 'restore', key: '/watching' })
  })
})
