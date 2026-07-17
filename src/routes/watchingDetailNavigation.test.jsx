import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import {
  getRouteShellKey,
  getRouteLevel,
  getScrollNavigationAction,
} from '../lib/scrollRestoration'
import {
  advanceWatchingRefreshState,
  getWatchingInteractionState,
} from '../lib/watchingNavigation'

vi.mock('../components/ReloadPrompt', () => ({ default: () => null }))

import App from '../App.jsx'

function renderApp(path) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

function getTabLinkMarkup(html, label) {
  const endMarker = `>${label}</a>`
  const end = html.indexOf(endMarker)
  const start = html.lastIndexOf('<a ', end)
  if (start === -1 || end === -1) throw new Error(`Missing ${label} tab link`)
  return html.slice(start, end + endMarker.length)
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

  it('keeps unknown routes outside the Watching subtree and renders NotFound', () => {
    const html = renderApp('/missing-navigation-audit')
    expect(html).toContain('Page not found')
    expect(html).not.toContain('route-content--nested')
    expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(0)
  })
})

describe('Watching route transitions', () => {
  it('refreshes exactly once after detail -> season -> detail -> Watching', () => {
    let state = { detailOpen: false, refreshToken: 0 }
    for (const detailOpen of [true, true, true, false]) {
      state = advanceWatchingRefreshState(state, detailOpen)
    }
    expect(state).toEqual({ detailOpen: false, refreshToken: 1 })
  })

  it('increments once per repeated detail round-trip and never on detail entry', () => {
    let state = { detailOpen: false, refreshToken: 0 }
    for (let roundTrip = 0; roundTrip < 10; roundTrip += 1) {
      state = advanceWatchingRefreshState(state, true)
      expect(state.refreshToken).toBe(roundTrip)
      state = advanceWatchingRefreshState(state, false)
      expect(state.refreshToken).toBe(roundTrip + 1)
    }
  })

  it('disarms swipe and remove-dialog state while Watching is hidden', () => {
    const confirmingShow = { id: 7, name: 'Frasier' }
    expect(getWatchingInteractionState(true, 7, confirmingShow)).toEqual({
      openSwipeId: 7,
      confirmingShow,
    })
    expect(getWatchingInteractionState(false, 7, confirmingShow)).toEqual({
      openSwipeId: null,
      confirmingShow: null,
    })
  })
})

describe('tab highlighting follows route shell identity', () => {
  it('highlights Watching consistently at both / and /watching', () => {
    for (const path of ['/', '/watching']) {
      const html = renderApp(path)
      expect(getTabLinkMarkup(html, 'Watching')).toContain('aria-current="page"')
      expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(1)
    }
  })

  it('keeps Watching highlighted at Show and Season detail depths', () => {
    for (const path of ['/watching/123', '/watching/123/season/1']) {
      const html = renderApp(path)
      expect(getTabLinkMarkup(html, 'Watching')).toContain('aria-current="page"')
      expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(1)
    }
  })

  it('highlights only the selected real tab after a genuine tab switch', () => {
    for (const [path, label] of [
      ['/browse', 'Discover'],
      ['/stats', 'Insights'],
      ['/settings', 'Settings'],
    ]) {
      const html = renderApp(path)
      expect(getTabLinkMarkup(html, label)).toContain('aria-current="page"')
      expect(getTabLinkMarkup(html, 'Watching')).not.toContain('aria-current')
      expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(1)
    }
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

  it('keeps browser Forward into detail at top and Back to either list alias restored', () => {
    expect(getScrollNavigationAction({
      isInitial: false,
      navigationType: 'POP',
      previousPathname: '/watching',
      pathname: '/watching/123',
    })).toEqual({ type: 'top', key: '/watching/123' })

    expect(getScrollNavigationAction({
      isInitial: false,
      navigationType: 'POP',
      previousPathname: '/watching/123',
      pathname: '/',
    })).toEqual({ type: 'restore', key: '/watching' })
  })
})
