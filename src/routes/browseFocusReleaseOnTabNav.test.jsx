// @vitest-environment jsdom
//
// Regression coverage for the "installed iPhone PWA shifts horizontally
// after leaving Discover search" fix. The suspected runtime cause is an iOS
// standalone-PWA visual-viewport pan tied to the still-focused Discover
// search input when a bottom-tab navigation fires. TabBar now releases focus
// from that one input — and only that input — before the tap's navigation
// is committed (see TabBar.jsx's releaseBrowseSearchFocus, wired to the nav's
// onPointerDown). This suite drives a real DOM/router tree to prove:
//   - the Browse search input is blurred when a bottom-tab link is tapped
//     while it is focused, and the tapped route still loads;
//   - the typed query text itself is never touched by that release;
//   - an unrelated focused control survives both a bottom-tab tap (when the
//     search input isn't the active element) and an ordinary nested route
//     navigation untouched by this fix.
import { useState, act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
// jsdom stubs the global URL constructor; readFileSync requires Node's own.
import { URL as NodeURL } from 'node:url'
import { Link, MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../routes/Browse', () => ({
  default: function BrowseSearchStub() {
    const [value, setValue] = useState('')
    return (
      <input
        className="browse-search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    )
  },
}))
vi.mock('../routes/Watching', () => ({
  default: function WatchingStub() {
    return (
      <div data-testid="watching-stub">
        <button type="button" data-testid="watching-focus-target">focus me</button>
        <Link to="/watching/123">open detail</Link>
      </div>
    )
  },
}))
vi.mock('../routes/ShowDetail', () => ({ default: () => <div data-testid="show-detail-stub">show detail</div> }))
vi.mock('../routes/SeasonDetail', () => ({ default: () => <div data-testid="season-detail-stub">season detail</div> }))
vi.mock('../routes/Stats', () => ({ default: () => <div data-testid="stats-stub">stats</div> }))
vi.mock('../routes/Settings', () => ({ default: () => <div data-testid="settings-stub">settings</div> }))
vi.mock('../components/ReloadPrompt', () => ({ default: () => null }))
vi.mock('../components/ScrollRestorationManager', () => ({ default: () => null }))
vi.mock('../hooks/usePressIntent', () => ({ default: () => {} }))

import App from '../App.jsx'

const tabBarSource = readFileSync(new NodeURL('../components/TabBar.jsx', import.meta.url), 'utf8')

let container = null
let root = null

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
})

function renderApp(path) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    )
  })
  return container
}

function tapTab(label) {
  const link = container.querySelector(`a[aria-label="${label}"]`)
  act(() => {
    link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
  })
  act(() => {
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

describe('TabBar releases the Browse search input focus on tab navigation', () => {
  it('blurs the focused Browse search input when a bottom-tab link is tapped, and the destination route still loads', () => {
    renderApp('/browse')
    const input = container.querySelector('.browse-search')
    act(() => input.focus())
    expect(document.activeElement).toBe(input)

    tapTab('Watching')

    expect(document.activeElement).not.toBe(input)
    expect(container.querySelector('[data-testid="watching-stub"]')).not.toBeNull()
  })

  it('preserves the typed search query text — the release only blurs, it never clears the field', () => {
    renderApp('/browse')
    const input = container.querySelector('.browse-search')
    act(() => {
      input.focus()
      input.value = 'batman'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe('batman')

    const watchingLink = container.querySelector('a[aria-label="Watching"]')
    act(() => {
      watchingLink.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    })

    expect(document.activeElement).not.toBe(input)
    expect(input.value).toBe('batman')
  })

  it('leaves an unrelated focused control alone when the Browse search input is not the active element', () => {
    renderApp('/watching')
    const button = container.querySelector('[data-testid="watching-focus-target"]')
    act(() => button.focus())
    expect(document.activeElement).toBe(button)

    tapTab('Settings')

    expect(document.activeElement).toBe(button)
    expect(container.querySelector('[data-testid="settings-stub"]')).not.toBeNull()
  })

  it('leaves an unrelated focused control alone during ordinary nested route navigation (not routed through TabBar)', () => {
    renderApp('/watching')
    const button = container.querySelector('[data-testid="watching-focus-target"]')
    act(() => button.focus())
    expect(document.activeElement).toBe(button)

    const detailLink = container.querySelector('a[href="/watching/123"]')
    act(() => {
      detailLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    })

    expect(document.activeElement).toBe(button)
    expect(container.querySelector('[data-testid="show-detail-stub"]')).not.toBeNull()
  })

  it('keeps the four bottom-tab route targets unchanged', () => {
    expect(tabBarSource).toContain("{ to: '/browse', label: 'Discover', Icon: DiscoverIcon }")
    expect(tabBarSource).toContain("{ to: '/watching', label: 'Watching', Icon: WatchingIcon }")
    expect(tabBarSource).toContain("{ to: '/stats', label: 'Insights', Icon: InsightsIcon }")
    expect(tabBarSource).toContain("{ to: '/settings', label: 'Settings', Icon: SettingsIcon }")
  })

  it('scopes the release to the nav, targeting only the .browse-search element', () => {
    expect(tabBarSource).toContain("active.classList.contains('browse-search')")
    expect(tabBarSource).toContain('onPointerDown={releaseBrowseSearchFocus}')
  })
})
