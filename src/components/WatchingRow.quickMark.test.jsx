// @vitest-environment jsdom
//
// The persistent rounded-square status button that replaced the mobile
// right-swipe quick-mark gesture (see WatchingRow.leftSwipe.test.jsx for the
// gesture-removal coverage). This file covers the button's own visual
// states (notReady / available / accepted / caughtUp), its accessible
// semantics, its shape/dimensions, and the bounded accepted-confirmation
// state machine (minimum dwell + row-advance synchronization) described in
// the button redesign spec.
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WatchingRow from './WatchingRow'

const indexCss = readFileSync('src/index.css', 'utf8')

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

const nextUpShow = baseShow()

const caughtUpShow = baseShow({
  status: { type: 'caughtUp' },
  nextReleasedUnwatchedEpisode: null,
})

const completedShow = baseShow({
  status: { type: 'completed' },
  nextReleasedUnwatchedEpisode: null,
})

const countdownShow = baseShow({
  status: { type: 'countdown', daysUntil: 5, air_date: '2026-08-01' },
  nextReleasedUnwatchedEpisode: null,
})

const advancedShow = baseShow({
  status: { type: 'nextUp', season_number: 2, episode_number: 6, name: 'Ep 6' },
  nextReleasedUnwatchedEpisode: { season_number: 2, episode_number: 6, name: 'Ep 6', runtime: 44 },
})

function staticHtml(show, props = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <WatchingRow
        show={show}
        isRemoving={false}
        isOpen={false}
        onOpenChange={vi.fn()}
        onRemove={vi.fn()}
        onQuickMark={vi.fn()}
        isQuickMarking={false}
        canQuickMark={true}
        {...props}
      />
    </MemoryRouter>,
  )
}

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
  async function render(nextShow, nextProps = {}) {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <WatchingRow
            show={nextShow}
            isRemoving={false}
            isOpen={false}
            onOpenChange={vi.fn()}
            onRemove={vi.fn()}
            onQuickMark={onQuickMark}
            isQuickMarking={nextProps.isQuickMarking ?? false}
            canQuickMark={nextProps.canQuickMark ?? true}
          />
        </MemoryRouter>,
      )
    })
  }
  await render(show, props)
  return { onQuickMark, update: render, button: () => container.querySelector('.watching-status-button') }
}

function click(button) {
  return act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('status button — shape and dimensions', () => {
  it('renders on both mobile and desktop with no pointer/hover gating', () => {
    // No `display: none` default and no `@media (hover: hover)` gate on the
    // control itself — unlike the old tick, it is always present.
    const ruleStart = indexCss.indexOf('.watching-status-button {')
    expect(ruleStart).toBeGreaterThan(-1)
    const rule = indexCss.slice(ruleStart, indexCss.indexOf('}', ruleStart) + 1)
    expect(rule).not.toContain('display: none')
    expect(indexCss).not.toContain('.watching-status-button {\n  display: none')
  })

  it('is positioned at the far right, vertically centered', () => {
    const html = staticHtml(nextUpShow)
    expect(html).toContain('watching-status-button')
    expect(html).toMatch(/class="motion-press watching-status-button absolute top-1\/2 right-2 -translate-y-1\/2"/)
  })

  it('uses a fixed 44px rounded-square footprint, not a circle', () => {
    const ruleStart = indexCss.indexOf('.watching-status-button {')
    const rule = indexCss.slice(ruleStart, indexCss.indexOf('}', ruleStart) + 1)
    expect(rule).toContain('width: 2.75rem')
    expect(rule).toContain('height: 2.75rem')
    expect(rule).toContain('border-radius: 0.875rem')
    expect(rule).not.toContain('border-radius: 50%')
    expect(rule).not.toContain('border-radius: 9999px')
    expect(rule).not.toContain('border-radius: 999px')
  })

  it('never overrides width/height/border-radius per visual state — shape is identical grey vs green vs not-ready', () => {
    for (const status of ['available', 'caughtUp', 'accepted', 'notReady']) {
      const ruleStart = indexCss.indexOf(`.watching-status-button[data-status='${status}']`)
      expect(ruleStart).toBeGreaterThan(-1)
      const block = indexCss.slice(ruleStart, indexCss.indexOf('\n\n', ruleStart))
      expect(block).not.toMatch(/\bwidth:/)
      expect(block).not.toMatch(/\bheight:/)
      expect(block).not.toMatch(/border-radius:/)
    }
  })

  it('the check glyph is centered and uses the same path across every state', () => {
    for (const [show, props] of [
      [nextUpShow, {}],
      [caughtUpShow, {}],
      [nextUpShow, { canQuickMark: false }],
    ]) {
      const html = staticHtml(show, props)
      expect(html).toContain('watching-status-button__check')
      expect(html).toContain('d="m5 12 4 4L19 6"')
    }
  })

  it('no spinner is ever rendered on the control', () => {
    for (const [show, props] of [
      [nextUpShow, {}],
      [nextUpShow, { isQuickMarking: true }],
      [caughtUpShow, {}],
      [nextUpShow, { canQuickMark: false }],
    ]) {
      const html = staticHtml(show, props)
      expect(html).not.toContain('spinner')
      expect(html).not.toContain('role="progressbar"')
    }
  })

  it('never causes a row-wide flash — the outer row and front row never carry a glow/flash attribute', async () => {
    const { button, onQuickMark: _onQuickMark } = await mount(nextUpShow)
    await click(button())
    expect(container.querySelector('.watching-row').getAttribute('data-swipe-glow')).toBeNull()
    expect(container.querySelector('.watching-row').getAttribute('data-success-flash')).toBeNull()
    expect(container.querySelector('.watching-row-front').getAttribute('data-swipe-glow')).toBeNull()
    expect(container.querySelector('.watching-row-front').getAttribute('data-success-flash')).toBeNull()
  })
})

describe('status button — visual states', () => {
  it('grey/available: a released unwatched episode can be quick-marked', () => {
    const html = staticHtml(nextUpShow)
    expect(html).toContain("data-status=\"available\"")
    expect(html).toContain('aria-label="Mark S2E5 of The Sopranos watched"')
    expect(html).not.toContain('disabled=""')
  })

  it('green/caughtUp: no released unwatched episode remains, persistent and non-actionable', () => {
    for (const show of [caughtUpShow, completedShow, countdownShow]) {
      const html = staticHtml(show)
      expect(html).toContain("data-status=\"caughtUp\"")
      expect(html).toContain(`aria-label="Caught up with ${show.name}"`)
      expect(html).toContain('disabled=""')
    }
  })

  it('notReady: mutation context not yet populated, quiet and non-actionable, never falsely green', () => {
    const html = staticHtml(nextUpShow, { canQuickMark: false })
    expect(html).toContain("data-status=\"notReady\"")
    expect(html).toContain('disabled=""')
    expect(html).not.toContain("data-status=\"caughtUp\"")
    expect(html).not.toContain('Caught up')
  })

  it('a caught-up show that has not yet loaded its mutation context still reads notReady, never caughtUp', () => {
    const html = staticHtml(caughtUpShow, { canQuickMark: false })
    expect(html).toContain("data-status=\"notReady\"")
    expect(html).not.toContain("data-status=\"caughtUp\"")
  })

  it('a tap fires the accepted (green) state synchronously, before any prop update', async () => {
    const { button, onQuickMark } = await mount(nextUpShow)
    await click(button())
    expect(onQuickMark).toHaveBeenCalledTimes(1)
    expect(onQuickMark).toHaveBeenCalledWith(nextUpShow)
    expect(button().getAttribute('data-status')).toBe('accepted')
    expect(button().disabled).toBe(true)
  })
})

describe('status button — accessibility', () => {
  it('grey state is a real, enabled, keyboard-operable button with an episode-naming label', () => {
    const html = staticHtml(nextUpShow)
    expect(html).toMatch(/<button[^>]*aria-label="Mark S2E5 of The Sopranos watched"/)
  })

  it('caughtUp state uses a disabled button with a caught-up label, never claiming an actionable mark-watched role', () => {
    const html = staticHtml(caughtUpShow)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Caught up with The Sopranos"/)
  })

  it('notReady state never claims caught-up in its label', () => {
    const html = staticHtml(nextUpShow, { canQuickMark: false })
    expect(html).toContain('aria-label="Loading watch status for The Sopranos"')
  })

  it('sets aria-busy while the mutation is pending', () => {
    const html = staticHtml(nextUpShow, { isQuickMarking: true })
    expect(html).toContain('aria-busy="true"')
  })

  it('has a visible focus-visible treatment', () => {
    expect(indexCss).toContain('.watching-status-button:focus-visible {')
  })

  it('desktop keyboard activation (a real <button>, Enter/Space handled natively) invokes quick mark', async () => {
    const { button, onQuickMark } = await mount(nextUpShow)
    const el = button()
    el.focus()
    expect(document.activeElement).toBe(el)
    await click(el)
    expect(onQuickMark).toHaveBeenCalledTimes(1)
  })
})

describe('status button — accepted-confirmation state machine (backlog/Sopranos-style flow)', () => {
  it('does not turn grey before the row has advanced, even after the minimum dwell elapses (dwell finishes first)', async () => {
    vi.useFakeTimers()
    const { button, update, onQuickMark } = await mount(nextUpShow)
    await click(button())
    expect(button().getAttribute('data-status')).toBe('accepted')

    // Minimum dwell (340ms) elapses, but the row has not advanced yet.
    await act(async () => { vi.advanceTimersByTime(340) })
    expect(button().getAttribute('data-status')).toBe('accepted')

    // Now the row advances (optimistic commit lands).
    await update(advancedShow, { isQuickMarking: false })
    expect(button().getAttribute('data-status')).toBe('available')
    expect(button().getAttribute('aria-label')).toBe('Mark S2E6 of The Sopranos watched')
    expect(onQuickMark).toHaveBeenCalledTimes(1)
  })

  it('does not turn grey before the minimum dwell elapses, even once the row has already advanced (advance finishes first)', async () => {
    vi.useFakeTimers()
    const { button, update } = await mount(nextUpShow)
    await click(button())

    // The row advances almost immediately (synchronous optimistic commit).
    await update(advancedShow, { isQuickMarking: true })
    expect(button().getAttribute('data-status')).toBe('accepted')

    await act(async () => { vi.advanceTimersByTime(200) })
    expect(button().getAttribute('data-status')).toBe('accepted')

    await act(async () => { vi.advanceTimersByTime(140) }) // total 340ms
    expect(button().getAttribute('data-status')).toBe('available')
  })

  it('remains green (caughtUp) when the optimistic result has no next episode — no flicker through grey', async () => {
    vi.useFakeTimers()
    const { button, update } = await mount(nextUpShow)
    await click(button())
    await update(caughtUpShow, { isQuickMarking: true })
    expect(button().getAttribute('data-status')).toBe('accepted')

    await act(async () => { vi.advanceTimersByTime(340) })
    await update(caughtUpShow, { isQuickMarking: false })
    expect(button().getAttribute('data-status')).toBe('caughtUp')
    expect(button().getAttribute('aria-label')).toBe('Caught up with The Sopranos')
  })

  it('blocks a duplicate tap while confirmation/pending is active', async () => {
    vi.useFakeTimers()
    const { button, update, onQuickMark } = await mount(nextUpShow)
    await click(button())
    await update(advancedShow, { isQuickMarking: true })
    await click(button()) // still accepted/disabled — must be ignored
    expect(onQuickMark).toHaveBeenCalledTimes(1)

    await act(async () => { vi.advanceTimersByTime(340) })
    await update(advancedShow, { isQuickMarking: false })
    expect(button().getAttribute('data-status')).toBe('available')

    await click(button())
    expect(onQuickMark).toHaveBeenCalledTimes(2)
    expect(onQuickMark).toHaveBeenNthCalledWith(2, advancedShow)
  })

  it('rolls back to grey immediately on mutation failure, without waiting for the minimum dwell', async () => {
    vi.useFakeTimers()
    const { button, update, onQuickMark } = await mount(nextUpShow)
    await click(button())
    // Optimistic commit lands...
    await update(advancedShow, { isQuickMarking: true })
    expect(button().getAttribute('data-status')).toBe('accepted')

    // ...then the mutation fails and Watching.jsx rolls the row back, well
    // before the 340ms minimum dwell has elapsed.
    await act(async () => { vi.advanceTimersByTime(50) })
    await update(nextUpShow, { isQuickMarking: false })

    expect(button().getAttribute('data-status')).toBe('available')
    expect(button().getAttribute('aria-label')).toBe('Mark S2E5 of The Sopranos watched')
    expect(onQuickMark).toHaveBeenCalledTimes(1)

    // A retry afterward works normally.
    await click(button())
    expect(onQuickMark).toHaveBeenCalledTimes(2)
  })

  it('a fully completed/fully watched show tap never invokes quick mark', async () => {
    const { button, onQuickMark } = await mount(completedShow)
    await click(button())
    expect(onQuickMark).not.toHaveBeenCalled()
    expect(button().getAttribute('data-status')).toBe('caughtUp')
  })

  it('a countdown (future-episode) show tap never invokes quick mark', async () => {
    const { button, onQuickMark } = await mount(countdownShow)
    await click(button())
    expect(onQuickMark).not.toHaveBeenCalled()
    expect(button().getAttribute('data-status')).toBe('caughtUp')
  })

  it('a not-ready row cannot be activated even if clicked', async () => {
    const { button, onQuickMark } = await mount(nextUpShow, { canQuickMark: false })
    await click(button())
    expect(onQuickMark).not.toHaveBeenCalled()
    expect(button().getAttribute('data-status')).toBe('notReady')
  })

  it('readiness resolving from notReady to available produces the correct grey state with no dimension change', async () => {
    const { button, update } = await mount(nextUpShow, { canQuickMark: false })
    expect(button().getAttribute('data-status')).toBe('notReady')
    expect(button().className).toContain('watching-status-button')

    await update(nextUpShow, { canQuickMark: true })
    expect(button().getAttribute('data-status')).toBe('available')
    // Same base class/footprint before and after — only the state attribute changed.
    expect(button().className).toContain('watching-status-button')
  })
})

describe('status button — weekly/House of the Dragon-style flow', () => {
  it('a caught-up show that later has a released unwatched episode automatically becomes grey and enabled, with no persisted flag', async () => {
    const { button, update } = await mount(caughtUpShow)
    expect(button().getAttribute('data-status')).toBe('caughtUp')

    const releasedShow = baseShow({
      status: { type: 'nextUp', season_number: 3, episode_number: 1, name: 'Premiere' },
      nextReleasedUnwatchedEpisode: { season_number: 3, episode_number: 1, name: 'Premiere', runtime: 55 },
    })
    await update(releasedShow)
    expect(button().getAttribute('data-status')).toBe('available')
    expect(button().getAttribute('aria-label')).toBe('Mark S3E1 of The Sopranos watched')
  })

  it('remains green through a countdown state after catching up (no tap yet)', async () => {
    const { button, update } = await mount(nextUpShow)
    await update(countdownShow)
    expect(button().getAttribute('data-status')).toBe('caughtUp')
  })
})
