// @vitest-environment jsdom
//
// Realistic touch-event-sequence coverage for the mobile right-swipe quick
// mark gesture. Dispatches real touchstart/touchmove/touchend/touchcancel
// sequences at the DOM level (not just calling helper functions in
// isolation) so the tests exercise the same listeners a real device would
// drive. Mirrors WatchingRow.jsx's own gesture constants:
//   DRAG_THRESHOLD = 6, HORIZONTAL_DOMINANCE_RATIO = 1.3,
//   RIGHT_ACTIVATION_DISTANCE = 80, RIGHT_MAX_PULL = 104.
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

const RIGHT_ACTIVATION_DISTANCE = 80
const RIGHT_MAX_PULL = 104

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

describe('right-swipe quick mark — gesture intent and safety', () => {
  it('a valid deliberate right swipe invokes onQuickMark(show) exactly once', async () => {
    const { onQuickMark, front } = await mount(baseShow())
    await drag(front, { dx: 90 })
    expect(onQuickMark).toHaveBeenCalledTimes(1)
    expect(onQuickMark.mock.calls[0][0]).toMatchObject({ id: 1, tmdb_id: 100 })
  })

  it('a slight rightward touch does not invoke it', async () => {
    const { onQuickMark, front } = await mount(baseShow())
    await drag(front, { dx: 20 })
    expect(onQuickMark).not.toHaveBeenCalled()
  })

  it('a fast but too-short flick does not invoke it solely due to velocity', async () => {
    const { onQuickMark, front } = await mount(baseShow())
    // Single big jump in one touchmove tick — as "fast" as a synthetic
    // sequence can be — but still short of the activation distance.
    await drag(front, { dx: 20, steps: 1 })
    expect(onQuickMark).not.toHaveBeenCalled()
  })

  it('vertical scrolling does not move the row or invoke quick mark', async () => {
    const { onQuickMark, onOpenChange, front } = await mount(baseShow())
    await drag(front, { dx: 10, dy: 100 })
    expect(transformOf(front)).toBe('translateX(0px)')
    expect(onQuickMark).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('diagonal movement where vertical wins remains scrolling, even if a later move goes big and horizontal', async () => {
    const { onQuickMark, front } = await mount(baseShow())
    await fire(front, 'touchstart', 40, 40)
    await fire(front, 'touchmove', 90, 100) // dx=50, dy=60 — vertical dominates, locks non-horizontal
    expect(transformOf(front)).toBe('translateX(0px)')
    await fire(front, 'touchmove', 240, 130) // dx=200 now, but classification is locked
    expect(transformOf(front)).toBe('translateX(0px)')
    await fire(front, 'touchend', 240, 130)
    expect(onQuickMark).not.toHaveBeenCalled()
  })

  it('touchcancel never invokes quick mark, even past the activation threshold', async () => {
    const { onQuickMark, front } = await mount(baseShow())
    await drag(front, { dx: 90, release: 'touchcancel' })
    expect(onQuickMark).not.toHaveBeenCalled()
    expect(transformOf(front)).toBe('translateX(0px)')
  })

  it('crossing the threshold and dragging back below it before release does not invoke', async () => {
    const { onQuickMark, front } = await mount(baseShow())
    await fire(front, 'touchstart', 40, 40)
    await fire(front, 'touchmove', 140, 40) // dx=100, armed
    await fire(front, 'touchmove', 70, 40) // dx=30, back below activation
    await fire(front, 'touchend', 70, 40)
    expect(onQuickMark).not.toHaveBeenCalled()
  })

  it('reversing past the start point never crosses into the Remove-reveal action (family lock)', async () => {
    const { onQuickMark, onOpenChange, front } = await mount(baseShow())
    await fire(front, 'touchstart', 40, 40)
    await fire(front, 'touchmove', 130, 40) // dx=90, armed rightward
    await fire(front, 'touchmove', -10, 40) // dx=-50 — reversed past the start
    // Locked to the quickmark family: never allowed to go negative.
    expect(transformOf(front)).toBe('translateX(0px)')
    await fire(front, 'touchend', -10, 40)
    expect(onQuickMark).not.toHaveBeenCalled()
    // onOpenChange may be called with null (harmless no-op) but never opens Remove.
    for (const call of onOpenChange.mock.calls) {
      expect(call[0]).toBeNull()
    }
  })

  it('starting with a left drag and reversing through zero into rightward territory never arms quick mark (family lock)', async () => {
    const { onQuickMark, front } = await mount(baseShow())
    await fire(front, 'touchstart', 40, 40)
    await fire(front, 'touchmove', -20, 40) // dx=-60, opening Remove
    await fire(front, 'touchmove', 130, 40) // dx=+90 — reversed rightward
    // Locked to the reveal family: clamped at 0, never enters positive territory.
    expect(transformOf(front)).toBe('translateX(0px)')
    await fire(front, 'touchend', 130, 40)
    expect(onQuickMark).not.toHaveBeenCalled()
  })

  it('a recognized horizontal swipe calls preventDefault on its touchmove events (suppresses navigation)', async () => {
    const { front } = await mount(baseShow())
    const moves = await drag(front, { dx: 90 })
    expect(moves.some((m) => m.defaultPrevented)).toBe(true)
  })

  it('a normal tap (movement below the intent threshold) triggers neither quick mark nor Remove', async () => {
    const { onQuickMark, onOpenChange, front } = await mount(baseShow())
    await drag(front, { dx: 2, dy: 1, steps: 1 })
    expect(onQuickMark).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('a pending row (isQuickMarking) cannot quick-mark again through right swipe', async () => {
    const { onQuickMark, front } = await mount(baseShow(), { isQuickMarking: true })
    await fire(front, 'touchstart', 40, 40)
    await fire(front, 'touchmove', 130, 40) // dx=90
    // Ineligible while pending — no displacement at all.
    expect(transformOf(front)).toBe('translateX(0px)')
    await fire(front, 'touchend', 130, 40)
    expect(onQuickMark).not.toHaveBeenCalled()
  })

  it('one physical gesture cannot double-invoke, even if touchend fires twice', async () => {
    const { onQuickMark, front } = await mount(baseShow())
    await drag(front, { dx: 90 })
    expect(onQuickMark).toHaveBeenCalledTimes(1)
    // A stray duplicate touchend (already-cleared dragState) must be a no-op.
    await fire(front, 'touchend', 130, 40)
    expect(onQuickMark).toHaveBeenCalledTimes(1)
  })

  it('a gesture starting on the quick-mark tick button does not misfire the swipe', async () => {
    const { onQuickMark, front } = await mount(baseShow())
    const tick = container.querySelector('.watching-quick-mark')
    await drag(front, { startTarget: tick, dx: 90 })
    expect(onQuickMark).not.toHaveBeenCalled()
    expect(transformOf(front)).toBe('translateX(0px)')
  })

  it('a gesture starting on the Remove button does not misfire the swipe', async () => {
    const { onQuickMark, onOpenChange, front } = await mount(baseShow())
    const remove = container.querySelector('.watching-remove-surface')
    await drag(front, { startTarget: remove, dx: 90 })
    expect(onQuickMark).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(transformOf(front)).toBe('translateX(0px)')
  })
})

describe('right-swipe quick mark — eligibility', () => {
  it('a caught-up row does not move right and never invokes quick mark', async () => {
    const { onQuickMark, front } = await mount(caughtUpShow)
    await drag(front, { dx: 90 })
    expect(transformOf(front)).toBe('translateX(0px)')
    expect(onQuickMark).not.toHaveBeenCalled()
  })

  it('a row without ready mutation context (canQuickMark=false) does not move right', async () => {
    const { onQuickMark, front } = await mount(baseShow(), { canQuickMark: false })
    await drag(front, { dx: 90 })
    expect(transformOf(front)).toBe('translateX(0px)')
    expect(onQuickMark).not.toHaveBeenCalled()
  })

  it('a row with a valid released unwatched episode can move and activate', async () => {
    const { onQuickMark, front } = await mount(baseShow())
    await fire(front, 'touchstart', 40, 40)
    await fire(front, 'touchmove', 90, 40) // dx=50, still under activation but eligible to move
    expect(transformOf(front)).toBe('translateX(50px)')
    await fire(front, 'touchmove', 170, 40) // dx=130, past activation
    await fire(front, 'touchend', 170, 40)
    expect(onQuickMark).toHaveBeenCalledTimes(1)
  })

  it('an unreleased/future-episode countdown show never arms right swipe', async () => {
    const { onQuickMark, front } = await mount(baseShow({
      status: { type: 'countdown', daysUntil: 4, air_date: '2026-07-24' },
      nextReleasedUnwatchedEpisode: null,
    }))
    await drag(front, { dx: 90 })
    expect(transformOf(front)).toBe('translateX(0px)')
    expect(onQuickMark).not.toHaveBeenCalled()
  })

  it('left-swipe Remove still works normally on a caught-up (right-swipe-ineligible) row', async () => {
    const { onOpenChange, front } = await mount(caughtUpShow)
    await drag(front, { dx: -60 })
    expect(onOpenChange).toHaveBeenCalledWith(caughtUpShow.id)
  })

  it('left-swipe Remove still works normally on a right-swipe-eligible row', async () => {
    const { onOpenChange, front } = await mount(baseShow())
    await drag(front, { dx: -60 })
    expect(onOpenChange).toHaveBeenCalledWith(1)
  })
})

describe('right-swipe quick mark — post-swipe navigation suppression', () => {
  it('the click that follows a recognized right swipe never navigates, but a later fresh tap still does', async () => {
    const { front, link } = await mountRouted(baseShow())
    await drag(front, { dx: 90 })
    await clickAnchor(link)
    expect(navigated()).toBe(false)

    // A second, unrelated click — standing in for a genuine later tap —
    // must not be swallowed by the same suppression.
    await clickAnchor(link)
    expect(navigated()).toBe(true)
  })

  it('the click that follows a recognized left swipe (Remove reveal) never navigates', async () => {
    const { front, link } = await mountRouted(baseShow())
    await drag(front, { dx: -60 })
    await clickAnchor(link)
    expect(navigated()).toBe(false)
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
    await drag(front, { dx: 90 })
    await act(async () => { vi.advanceTimersByTime(600) })
    await clickAnchor(link)
    expect(navigated()).toBe(true)
  })
})

describe('right-swipe quick mark — visual state', () => {
  it('right drag is capped at RIGHT_MAX_PULL and never travels the row fully away', async () => {
    const { front } = await mount(baseShow())
    await fire(front, 'touchstart', 40, 40)
    await fire(front, 'touchmove', 40 + 500, 40) // wildly overshoot
    expect(transformOf(front)).toBe(`translateX(${RIGHT_MAX_PULL}px)`)
    await fire(front, 'touchend', 540, 40)
  })

  it('the underlay gains the armed class deterministically exactly at the activation threshold', async () => {
    const { front } = await mount(baseShow())
    await fire(front, 'touchstart', 40, 40)
    await fire(front, 'touchmove', 40 + (RIGHT_ACTIVATION_DISTANCE - 10), 40)
    let underlay = container.querySelector('.watching-swipe-underlay')
    expect(underlay).not.toBeNull()
    expect(underlay.className).not.toContain('watching-swipe-underlay--armed')

    await fire(front, 'touchmove', 40 + RIGHT_ACTIVATION_DISTANCE, 40)
    underlay = container.querySelector('.watching-swipe-underlay')
    expect(underlay.className).toContain('watching-swipe-underlay--armed')

    await fire(front, 'touchend', 40 + RIGHT_ACTIVATION_DISTANCE, 40)
  })

  it('release resets the transform back to zero when below activation', async () => {
    const { front } = await mount(baseShow())
    await drag(front, { dx: 30 })
    expect(transformOf(front)).toBe('translateX(0px)')
  })

  it('success feedback appears briefly after activation and clears itself', async () => {
    vi.useFakeTimers()
    const { front } = await mount(baseShow())
    await fire(front, 'touchstart', 40, 40)
    await fire(front, 'touchmove', 130, 40)
    await fire(front, 'touchend', 130, 40)

    expect(container.querySelector('.watching-row').getAttribute('data-success-flash')).toBe('true')

    await act(async () => { vi.advanceTimersByTime(450) })
    expect(container.querySelector('.watching-row').getAttribute('data-success-flash')).toBeNull()
  })

  it('a caught-up row never shows right-swipe visual feedback (no underlay, no success flash)', async () => {
    const { front } = await mount(caughtUpShow)
    expect(container.querySelector('.watching-swipe-underlay')).toBeNull()
    await drag(front, { dx: 90 })
    expect(container.querySelector('.watching-row').getAttribute('data-success-flash')).toBeNull()
  })
})

describe('right-swipe quick mark — reduced motion', () => {
  it('the success-flash animation and underlay opacity transition fall under the existing universal reduced-motion override', () => {
    const reducedMotionBlock = indexCss.slice(indexCss.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedMotionBlock).toContain('animation-duration: 1ms !important;')
    expect(reducedMotionBlock).toContain('transition-duration: 1ms !important;')
    // Neither new rule opts itself out of that universal collapse.
    expect(indexCss).not.toMatch(/watching-row-success-flash[^}]*animation-duration:\s*(?!1ms)/)
    expect(indexCss).not.toMatch(/watching-swipe-underlay[^}]*transition-duration:\s*(?!1ms)/)
  })
})

describe('Remove surface — refreshed destructive treatment', () => {
  it('uses a scoped, richer garnet mix instead of the flat shared destructive token', () => {
    const ruleStart = indexCss.indexOf('.watching-remove-surface {')
    expect(ruleStart).toBeGreaterThan(-1)
    const rule = indexCss.slice(ruleStart, indexCss.indexOf('}', ruleStart) + 1)
    expect(rule).toContain('color-mix(in srgb, var(--color-destructive)')
    expect(rule).not.toContain('background: var(--color-destructive);')
    // Readable light text on the now-darker surface, not the old dark-on-pastel pairing.
    expect(rule).toContain('color: var(--color-text);')
  })

  it('does not alter the shared --color-destructive token used elsewhere in the app', () => {
    expect(indexCss).toContain('--color-destructive: #f0808a;')
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
