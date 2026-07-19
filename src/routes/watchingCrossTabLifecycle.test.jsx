// @vitest-environment jsdom
//
// Behavioral lifecycle proof for the "red Remove-layer flash on tab return" fix.
//
// The flash was caused by the Watching list REMOUNTING (and replaying the
// `.route-content--tab` opacity fade over freshly built swipe rows) every time
// you switched into the Watching tab from another main tab. PR #77 removed that
// remount for detail (Show/Season) round-trips only; main-tab returns still
// remounted. This suite drives a live React tree through real router
// navigations and asserts — with an actual mount/unmount counter, not source
// strings — that exactly one Watching instance is created and it is never
// remounted on any route into Watching. It also pins the active/visible state
// and the quiet-refresh signal on every transition.
import { useEffect, act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The Watching instance under test: a stub that logs mount/unmount and exposes
// the props App feeds it (active + refreshSignal) as DOM attributes.
const lifecycle = []
vi.mock('../routes/Watching', () => ({
  default: function WatchingStub(props) {
    useEffect(() => {
      lifecycle.push('mount')
      return () => lifecycle.push('unmount')
    }, [])
    return (
      <div
        data-testid="watching-stub"
        data-active={String(props.active)}
        data-refresh={String(props.refreshSignal)}
      >
        watching
      </div>
    )
  },
}))

// Other screens are stubbed so the test exercises App's routing/lifecycle only,
// with no Supabase/TMDB effects. Their own remount-per-visit behaviour is
// unchanged and irrelevant here — we only assert Watching's lifecycle.
vi.mock('../routes/Browse', () => ({ default: () => <div data-testid="browse-stub">browse</div> }))
vi.mock('../routes/Stats', () => ({ default: () => <div data-testid="stats-stub">stats</div> }))
vi.mock('../routes/Settings', () => ({ default: () => <div data-testid="settings-stub">settings</div> }))
vi.mock('../routes/ShowDetail', () => ({ default: () => <div data-testid="show-detail-stub">show</div> }))
vi.mock('../routes/SeasonDetail', () => ({ default: () => <div data-testid="season-detail-stub">season</div> }))
vi.mock('../components/ReloadPrompt', () => ({ default: () => null }))
vi.mock('../components/ScrollRestorationManager', () => ({ default: () => null }))
vi.mock('../hooks/usePressIntent', () => ({ default: () => {} }))

import App from '../App.jsx'

let container = null
let root = null
let navigate = null

function CaptureNavigate() {
  navigate = useNavigate()
  return null
}

async function mountApp(initialPath) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <CaptureNavigate />
        <App />
      </MemoryRouter>,
    )
  })
}

async function go(path) {
  await act(async () => {
    navigate(path)
  })
}

const watchingEl = () => container.querySelector('[data-testid="watching-stub"]')
const activeState = () => watchingEl().getAttribute('data-active')
const refreshValue = () => Number(watchingEl().getAttribute('data-refresh'))

beforeEach(() => {
  lifecycle.length = 0
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
  navigate = null
})

describe('Watching lifecycle: mounted exactly once, never remounted on tab return', () => {
  it('mounts the Watching list exactly once on entry', async () => {
    await mountApp('/watching')
    expect(lifecycle).toEqual(['mount'])
    expect(watchingEl()).not.toBeNull()
    expect(activeState()).toBe('true')
  })

  it('does not remount Watching across a Discover round-trip (removes the flash precondition)', async () => {
    await mountApp('/watching')
    await go('/browse')
    await go('/watching')
    // One mount, zero unmounts: the same instance was hidden and revealed, not
    // rebuilt — so there are no freshly constructed swipe rows and no fade replay.
    expect(lifecycle).toEqual(['mount'])
  })

  it.each([
    ['Discover', '/browse'],
    ['Insights', '/stats'],
    ['Settings', '/settings'],
  ])('keeps a single Watching instance across repeated %s round-trips', async (_label, path) => {
    await mountApp('/watching')
    for (let i = 0; i < 3; i += 1) {
      await go(path)
      await go('/watching')
    }
    expect(lifecycle).toEqual(['mount'])
  })

  it('survives rapid alternating tab taps without ever remounting', async () => {
    await mountApp('/watching')
    for (const path of ['/browse', '/watching', '/stats', '/watching', '/settings', '/watching', '/browse', '/watching']) {
      await go(path)
    }
    expect(lifecycle).toEqual(['mount'])
  })

  it('reuses the same Watching instance across Show and Season detail Back navigation', async () => {
    await mountApp('/watching')
    await go('/watching/123')
    await go('/watching/123/season/1')
    await go('/watching/123')
    await go('/watching')
    expect(lifecycle).toEqual(['mount'])
  })

  it('mounts Watching once even when cold-starting on another tab, then never remounts', async () => {
    await mountApp('/settings')
    // Present but hidden from the start; still a single instance across returns.
    expect(lifecycle).toEqual(['mount'])
    await go('/watching')
    await go('/browse')
    await go('/watching')
    expect(lifecycle).toEqual(['mount'])
  })
})

describe('Watching active/visible state per route', () => {
  it('is active only when the list itself is on screen', async () => {
    await mountApp('/watching')
    expect(activeState()).toBe('true') // list visible
    await go('/watching/123')
    expect(activeState()).toBe('false') // covered by detail overlay
    await go('/watching')
    expect(activeState()).toBe('true')
    await go('/browse')
    expect(activeState()).toBe('false') // covered by another tab
    await go('/watching')
    expect(activeState()).toBe('true')
  })

  it('hides the Watching subtree (display:none + aria-hidden) while another tab is active', async () => {
    await mountApp('/browse')
    const hiddenWrapper = watchingEl().closest('[aria-hidden="true"]')
    expect(hiddenWrapper).not.toBeNull()
    expect(hiddenWrapper.style.display).toBe('none')
    // The active tab still renders and is not obscured by the hidden list.
    expect(container.querySelector('[data-testid="browse-stub"]')).not.toBeNull()
  })
})

describe('Watching quiet-refresh signal', () => {
  it('does not bump on first reveal, then bumps once per return into view', async () => {
    await mountApp('/watching')
    expect(refreshValue()).toBe(0) // first reveal: served by mount-time load

    await go('/browse')
    await go('/watching')
    expect(refreshValue()).toBe(1) // tab return → one quiet refresh

    await go('/watching/123')
    await go('/watching')
    expect(refreshValue()).toBe(2) // detail return → one quiet refresh

    await go('/stats')
    await go('/watching')
    expect(refreshValue()).toBe(3)
  })

  it('does not bump on the first reveal even when cold-starting on another tab', async () => {
    await mountApp('/settings')
    expect(refreshValue()).toBe(0)
    await go('/watching')
    expect(refreshValue()).toBe(0) // first time the list is shown: no refresh
    await go('/settings')
    await go('/watching')
    expect(refreshValue()).toBe(1) // subsequent returns refresh quietly
  })
})
