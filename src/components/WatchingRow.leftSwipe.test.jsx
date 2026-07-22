// @vitest-environment jsdom
//
// Realistic touch-event-sequence coverage for WatchingRow's gesture engine
// after the mobile right-swipe quick-mark gesture (PRs #109–#111) was
// removed entirely in favor of a persistent status button (see
// WatchingRow.quickMark.test.jsx). This file proves two things: the
// left-swipe Remove-reveal recognizer still works exactly as before, and
// nothing rightward is a recognized gesture anymore — no displacement, no
// mutation, no visual feedback, no leftover CSS/constants/refs.
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WatchingRow from './WatchingRow'

// Read via a repo-root-relative path (not `new URL(path, import.meta.url)`,
// which Vite intercepts as an asset reference for .css specifically) so this
// resolves to a plain filesystem read under vitest.
const indexCss = readFileSync('src/index.css', 'utf8')
const watchingRowSrc = readFileSync('src/components/WatchingRow.jsx', 'utf8')

const REVEAL_WIDTH = 84

function baseShow(overrides = {}) {
  return {
    id: 1,
    tmdb_id: 100,
    name: 'The Sopranos',
    poster_path: null,
    status: { type: 'nextUp', season_number: 2, episode_number: 5, name: 'Ep 5' },
    nextReleasedUnwatchedEpisode: { season_number: 2, episode_number: 5, name: 'Ep 5', runtime: 42 },
    ...overrides,
  }
}

const caughtUpShow = baseShow({
  status: { type: 'caughtUp' },
  nextReleasedUnwatchedEpisode: null,
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let container = null
let root = null

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
  vi.useRealTimers()
})

async function mount(show, props = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const onQuickMark = props.onQuickMark ?? vi.fn()
  const onOpenChange = props.onOpenChange ?? vi.fn()
  const onRemove = props.onRemove ?? vi.fn()
  await act(async () => {
    root.render(
      <MemoryRouter>
        <WatchingRow
          show={show}
          isRemoving={false}
          isOpen={props.isOpen ?? false}
          onOpenChange={onOpenChange}
          onRemove={onRemove}
          onQuickMark={onQuickMark}
          isQuickMarking={props.isQuickMarking ?? false}
          canQuickMark={props.canQuickMark ?? true}
        />
      </MemoryRouter>,
    )
  })
  const front = container.querySelector('.touch-pan-y')
  return { onQuickMark, onOpenChange, onRemove, front }
}

// Mounts through a real <Routes> switch (rather than a bare MemoryRouter)
// so a click reaching the Link's default react-router-dom navigation
// actually renders different content — the only reliable way to prove
// navigation did or didn't happen, since MemoryRouter's history isn't
// reflected on window.location.
async function mountRouted(show, props = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const onQuickMark = props.onQuickMark ?? vi.fn()
  const onOpenChange = props.onOpenChange ?? vi.fn()
  const onRemove = props.onRemove ?? vi.fn()
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/watching']}>
        <Routes>
          <Route
            path="/watching"
            element={(
              <WatchingRow
                show={show}
                isRemoving={false}
                isOpen={props.isOpen ?? false}
                onOpenChange={onOpenChange}
                onRemove={onRemove}
                onQuickMark={onQuickMark}
                isQuickMarking={props.isQuickMarking ?? false}
                canQuickMark={props.canQuickMark ?? true}
              />
            )}
          />
          <Route path="/watching/:id" element={<div data-testid="detail-marker">Detail</div>} />
        </Routes>
      </MemoryRouter>,
    )
  })
  const front = container.querySelector('.touch-pan-y')
  const link = container.querySelector('a')
  return { onQuickMark, onOpenChange, onRemove, front, link }
}

function navigated() {
  return container.querySelector('[data-testid="detail-marker"]') !== null
}

async function clickAnchor(link) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  await act(async () => { link.dispatchEvent(event) })
  return event
}

function touchEvent(type, x, y) {
  return new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }],
  })
}

async function fire(target, type, x, y) {
  const event = touchEvent(type, x, y)
  await act(async () => { target.dispatchEvent(event) })
  return event
}

// Drives a full gesture: touchstart at (x0,y0) — optionally on a different
// element so a gesture can be made to "start on" an interactive control —
// then linear touchmove steps to (x0+dx, y0+dy), then a release event.
// Returns the dispatched touchmove events so callers can assert on
// preventDefault().
async function drag(front, {
  startTarget = front, x0 = 40, y0 = 40, dx, dy = 0, steps = 6, release = 'touchend',
} = {}) {
  await fire(startTarget, 'touchstart', x0, y0)
  const moves = []
  for (let i = 1; i <= steps; i += 1) {
    const x = x0 + (dx * i) / steps
    const y = y0 + (dy * i) / steps
    moves.push(await fire(front, 'touchmove', x, y))
  }
  await fire(front, release, x0 + dx, y0 + dy)
  return moves
}

function transformOf(front) {
  return front.style.transform
}

describe('right-swipe removal — rightward drag is no longer a recognized gesture', () => {
  it('a deliberate rightward drag never moves the row', async () => {
    const { front } = await mount(baseShow())
    await drag(front, { dx: 90 })
    expect(transformOf(front)).toBe('translateX(0px)')
  })

  it('a deliberate rightward drag never invokes quick mark', async () => {
    const { onQuickMark, front } = await mount(baseShow())
    await drag(front, { dx: 90 })
    expect(onQuickMark).not.toHaveBeenCalled()
  })

  it('a wildly overshooting rightward drag still never moves the row or marks anything', async () => {
    const { onQuickMark, front } = await mount(baseShow())
    await fire(front, 'touchstart', 40, 40)
    await fire(front, 'touchmove', 540, 40)
    expect(transformOf(front)).toBe('translateX(0px)')
    await fire(front, 'touchend', 540, 40)
    expect(onQuickMark).not.toHaveBeenCalled()
  })

  it('rightward drag never moves or marks regardless of eligibility (available, caught up, or not ready)', async () => {
    for (const props of [
      {}, // available: a released unwatched episode exists
      { show: caughtUpShow },
      { canQuickMark: false },
    ]) {
      const { onQuickMark, front } = await mount(props.show ?? baseShow(), props)
      await drag(front, { dx: 90 })
      expect(transformOf(front)).toBe('translateX(0px)')
      expect(onQuickMark).not.toHaveBeenCalled()
      if (root) await act(async () => root.unmount())
      container?.remove()
    }
  })

  it('reversing a left-swipe past the start point never crosses into positive (rightward) territory', async () => {
    const { onOpenChange, front } = await mount(baseShow())
    await fire(front, 'touchstart', 40, 40)
    await fire(front, 'touchmove', -20, 40) // dx=-60, opening Remove
    await fire(front, 'touchmove', 130, 40) // dx=+90 — reversed rightward
    expect(transformOf(front)).toBe('translateX(0px)')
    await fire(front, 'touchend', 130, 40)
    for (const call of onOpenChange.mock.calls) {
      expect(call[0]).toBeNull()
    }
  })
})

describe('right-swipe removal — no leftover state, constants, or CSS', () => {
  it('the right-swipe activation/pull constants and resistance helper are gone', () => {
    expect(watchingRowSrc).not.toContain('RIGHT_ACTIVATION_DISTANCE')
    expect(watchingRowSrc).not.toContain('RIGHT_MAX_PULL')
    expect(watchingRowSrc).not.toContain('RIGHT_RESISTANCE_DIVISOR')
    expect(watchingRowSrc).not.toContain('pullWithResistance')
    expect(watchingRowSrc).not.toContain('SUCCESS_FLASH_DURATION')
  })

  it('no right-swipe family/eligibility state or refs remain', () => {
    expect(watchingRowSrc).not.toContain('rightSwipeEligible')
    expect(watchingRowSrc).not.toContain('rightSwipePulling')
    expect(watchingRowSrc).not.toContain('rightSwipeArmed')
    expect(watchingRowSrc).not.toContain('state.family')
    expect(watchingRowSrc).not.toContain('successTimerRef')
    expect(watchingRowSrc).not.toContain('showSuccessFlash')
  })

  it('no swipe-glow or success-flash data attributes are ever rendered', async () => {
    const { front } = await mount(baseShow())
    await drag(front, { dx: 90 })
    expect(container.querySelector('[data-swipe-glow]')).toBeNull()
    expect(container.querySelector('[data-success-flash]')).toBeNull()
  })

  it('no emerald swipe underlay is ever rendered', async () => {
    const { front } = await mount(baseShow())
    expect(container.querySelector('.watching-swipe-underlay')).toBeNull()
    await drag(front, { dx: 90 })
    expect(container.querySelector('.watching-swipe-underlay')).toBeNull()
  })

  it('none of the right-swipe CSS remains in index.css', () => {
    expect(indexCss).not.toContain('watching-swipe-underlay')
    expect(indexCss).not.toContain('data-swipe-glow')
    expect(indexCss).not.toContain('data-success-flash')
    expect(indexCss).not.toContain('watching-row-success-flash')
  })
})

describe('left-swipe Remove — unchanged recognizer behavior', () => {
  it('preserves REVEAL_WIDTH, DRAG_THRESHOLD, and passive touch listener flags', () => {
    expect(watchingRowSrc).toContain('const REVEAL_WIDTH = 84')
    expect(watchingRowSrc).toContain('const DRAG_THRESHOLD = 6')
    expect(watchingRowSrc).toContain("addEventListener('touchstart', handleTouchStart, { passive: true })")
    expect(watchingRowSrc).toContain("addEventListener('touchmove', handleTouchMove, { passive: false })")
    expect(watchingRowSrc).toContain("addEventListener('touchend', handleTouchEnd, { passive: true })")
  })

  it('a leftward drag past the reveal midpoint opens Remove', async () => {
    const { onOpenChange, front } = await mount(baseShow())
    await drag(front, { dx: -60 })
    expect(onOpenChange).toHaveBeenCalledWith(1)
  })

  it('a leftward drag short of the midpoint snaps back closed', async () => {
    const { onOpenChange, front } = await mount(baseShow())
    await drag(front, { dx: -20 })
    expect(onOpenChange).toHaveBeenCalledWith(null)
  })

  it('drag is clamped to [-REVEAL_WIDTH, 0]', async () => {
    const { front } = await mount(baseShow())
    await fire(front, 'touchstart', 40, 40)
    await fire(front, 'touchmove', 40 - 500, 40)
    expect(transformOf(front)).toBe(`translateX(${-REVEAL_WIDTH}px)`)
    await fire(front, 'touchend', -460, 40)
  })

  it('touchcancel snaps back without opening Remove', async () => {
    const { onOpenChange, front } = await mount(baseShow())
    await drag(front, { dx: -60, release: 'touchcancel' })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(transformOf(front)).toBe('translateX(0px)')
  })

  it('vertical scrolling does not move the row', async () => {
    const { onOpenChange, front } = await mount(baseShow())
    await drag(front, { dx: -10, dy: 100 })
    expect(transformOf(front)).toBe('translateX(0px)')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('a recognized left swipe calls preventDefault on its touchmove events', async () => {
    const { front } = await mount(baseShow())
    const moves = await drag(front, { dx: -60 })
    expect(moves.some((m) => m.defaultPrevented)).toBe(true)
  })

  it('a normal tap (movement below the intent threshold) triggers neither Remove nor navigation state changes', async () => {
    const { onOpenChange, front } = await mount(baseShow())
    await drag(front, { dx: 2, dy: 1, steps: 1 })
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('left-swipe Remove works identically whether the row is quick-mark eligible, caught up, or not ready', async () => {
    for (const props of [{}, { show: caughtUpShow }, { canQuickMark: false }]) {
      const { onOpenChange, front } = await mount(props.show ?? baseShow(), props)
      await drag(front, { dx: -60 })
      expect(onOpenChange).toHaveBeenCalledWith(1)
      if (root) await act(async () => root.unmount())
      container?.remove()
    }
  })

  it('a gesture starting on the status button does not misfire the row swipe', async () => {
    const { onOpenChange, front } = await mount(baseShow())
    const statusButton = container.querySelector('.watching-status-button')
    await drag(front, { startTarget: statusButton, dx: -60 })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(transformOf(front)).toBe('translateX(0px)')
  })

  it('a gesture starting on the Remove button does not misfire the row swipe', async () => {
    const { onOpenChange, front } = await mount(baseShow())
    const remove = container.querySelector('.watching-remove-surface')
    await drag(front, { startTarget: remove, dx: -60 })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(transformOf(front)).toBe('translateX(0px)')
  })

  it('one physical gesture cannot double-invoke onOpenChange, even if touchend fires twice', async () => {
    const { onOpenChange, front } = await mount(baseShow())
    await drag(front, { dx: -60 })
    expect(onOpenChange).toHaveBeenCalledTimes(1)
    await fire(front, 'touchend', -20, 40)
    expect(onOpenChange).toHaveBeenCalledTimes(1)
  })
})

describe('left-swipe Remove — post-swipe navigation suppression', () => {
  it('the click that follows a recognized left swipe never navigates, but a later fresh tap still does', async () => {
    const { front, link } = await mountRouted(baseShow())
    await drag(front, { dx: -60 })
    await clickAnchor(link)
    expect(navigated()).toBe(false)

    await clickAnchor(link)
    expect(navigated()).toBe(true)
  })

  it('a swipe that never crosses the intent threshold (a genuine tap) still navigates normally', async () => {
    const { front, link } = await mountRouted(baseShow())
    await drag(front, { dx: 2, dy: 1, steps: 1 })
    await clickAnchor(link)
    expect(navigated()).toBe(true)
  })

  it('suppression auto-clears after its bounded window if the browser never synthesizes a click', async () => {
    vi.useFakeTimers()
    const { front, link } = await mountRouted(baseShow())
    await drag(front, { dx: -60 })
    await act(async () => { vi.advanceTimersByTime(600) })
    await clickAnchor(link)
    expect(navigated()).toBe(true)
  })
})

describe('Remove surface — refreshed destructive treatment (unchanged)', () => {
  it('uses a scoped, richer garnet mix instead of the flat shared destructive token', () => {
    const ruleStart = indexCss.indexOf('.watching-remove-surface {')
    expect(ruleStart).toBeGreaterThan(-1)
    const rule = indexCss.slice(ruleStart, indexCss.indexOf('}', ruleStart) + 1)
    expect(rule).toContain('color-mix(in srgb, var(--color-destructive)')
    expect(rule).not.toContain('background: var(--color-destructive);')
    expect(rule).toContain('color: var(--color-text);')
  })

  it('uses the approved shared destructive role without changing swipe ownership', () => {
    expect(indexCss).toContain('--color-destructive: #dc7e79;')
  })

  it('gives the desktop hover/focus Remove affordance a matching richer treatment', () => {
    expect(indexCss).toContain(
      ".watching-row-hover-remove:hover {\n    background: color-mix(in srgb, var(--color-destructive)",
    )
    expect(indexCss).toContain(
      ".watching-row-hover-remove:focus-visible {\n  background: color-mix(in srgb, var(--color-destructive)",
    )
  })
})
