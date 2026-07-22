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

// A row that genuinely lacks enough information to know its status — no
// episode identity and no derived `status.type` at all. This is the only
// shape that should ever render notReady; a known available/caughtUp row
// must not, even while canQuickMark is still false (see the fresh-launch
// replay regression coverage below).
const unresolvedShow = baseShow({
  status: null,
  nextReleasedUnwatchedEpisode: null,
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
      expect(html).toContain('d="M4.5 12.5 9.5 17.5 19.5 6.5"')
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

// The square body is one premium dark-graphite surface in every state — the
// only thing that changes between available/accepted/caughtUp/notReady is
// the check glyph's color (and a tiny supporting tint in the border/inner
// highlight immediately around it). See the review correction this design
// implements: no flat grey-filled slab, no emerald/lime-filled tile.
describe('status button — surface stays neutral graphite in every state', () => {
  function ruleBlockFor(selector) {
    const start = indexCss.indexOf(selector)
    expect(start).toBeGreaterThan(-1)
    return indexCss.slice(start, indexCss.indexOf('}', start) + 1)
  }

  it('the base button rule declares one dark graphite background — no per-state background override', () => {
    const base = ruleBlockFor('.watching-status-button {')
    expect(base).toMatch(/background: linear-gradient\(175deg, #171b25, #11151e\)/i)

    for (const status of ['available', 'caughtUp', 'accepted', 'notReady']) {
      const start = indexCss.indexOf(`.watching-status-button[data-status='${status}']`)
      expect(start).toBeGreaterThan(-1)
      const block = indexCss.slice(start, indexCss.indexOf('\n\n', start))
      // Per-state blocks that target the button itself (not the .__check
      // descendant) must never declare a background — only border/box-shadow
      // supporting tints are allowed there.
      const buttonOnlyBlock = block
        .split('\n\n')
        .filter((chunk) => !chunk.includes('.watching-status-button__check'))
        .join('\n\n')
      expect(buttonOnlyBlock).not.toMatch(/\bbackground:/)
    }
  })

  it('available and caughtUp reach the DOM with the expected data-status', () => {
    for (const status of ['available', 'caughtUp']) {
      const html = staticHtml(baseShow({
        status: status === 'available' ? { type: 'nextUp', season_number: 1, episode_number: 1 } : { type: 'caughtUp' },
        nextReleasedUnwatchedEpisode: status === 'available'
          ? { season_number: 1, episode_number: 1, name: 'Ep', runtime: 30 }
          : null,
      }))
      expect(html).toContain(`data-status="${status}"`)
    }
  })

  it('a genuinely unresolved row reaches the DOM with data-status="notReady"', () => {
    const html = staticHtml(unresolvedShow)
    expect(html).toContain('data-status="notReady"')
  })

  it('the button element never carries an inline background style or a Tailwind bg- utility class, in any state', async () => {
    function buttonTagFrom(html) {
      const buttonStart = html.indexOf('watching-status-button absolute')
      return html.slice(html.lastIndexOf('<button', buttonStart), html.indexOf('>', buttonStart) + 1)
    }

    // available (static) and notReady (static) — the surface comes solely
    // from the one shared CSS rule, never an inline style or bg- class.
    for (const html of [staticHtml(nextUpShow), staticHtml(nextUpShow, { canQuickMark: false }), staticHtml(caughtUpShow)]) {
      const buttonTag = buttonTagFrom(html)
      expect(buttonTag).not.toMatch(/\bbg-/)
      expect(buttonTag).not.toContain('style=')
    }

    // accepted only exists after a real tap — verify the same holds live.
    const { button, onQuickMark: _onQuickMark } = await mount(nextUpShow)
    await click(button())
    expect(button().getAttribute('data-status')).toBe('accepted')
    expect(button().className).not.toMatch(/\bbg-/)
    expect(button().getAttribute('style')).toBeNull()
  })

  it('never uses a flat grey/green/emerald/lime/chartreuse fill token as the square background', () => {
    const base = ruleBlockFor('.watching-status-button {')
    expect(base).not.toContain('--color-success')
    expect(base).not.toContain('--color-status-check-done')
    expect(base).not.toContain('--color-surface-interactive')
  })

  it('no emerald token (--color-success) is used anywhere in the status button rules', () => {
    const start = indexCss.indexOf('.watching-status-button {')
    const end = indexCss.indexOf('.watching-countdown-pill', start)
    const section = indexCss.slice(start, end)
    expect(section).not.toContain('--color-success')
  })

  it('no row-wide or button-wide glow — box-shadow spread stays tight (no large blurred outer glow)', () => {
    const start = indexCss.indexOf('.watching-status-button {')
    const end = indexCss.indexOf('.watching-countdown-pill', start)
    const section = indexCss.slice(start, end)
    // No box-shadow rule in this section should use a blur radius larger
    // than 8px, which would read as a glow rather than a restrained shadow.
    const blurs = [...section.matchAll(/0\s+(-?\d+)px\s+(\d+)px/g)].map((m) => Number(m[2]))
    for (const blur of blurs) {
      expect(blur).toBeLessThanOrEqual(8)
    }
  })

  it('state is conveyed primarily through the check glyph color, not the button background', () => {
    const availableCheck = ruleBlockFor("[data-status='available'] .watching-status-button__check {")
    expect(availableCheck).toContain('var(--color-status-check-idle)')

    const doneCheckStart = indexCss.indexOf("[data-status='caughtUp'] .watching-status-button__check,")
    expect(doneCheckStart).toBeGreaterThan(-1)
    const doneCheck = indexCss.slice(doneCheckStart, indexCss.indexOf('}', doneCheckStart) + 1)
    expect(doneCheck).toContain('var(--color-status-check-done)')
  })

  it('available check uses the muted smoky periwinkle-grey palette', () => {
    expect(indexCss).toContain('--color-status-check-idle: #8d93b4;')
  })

  it('accepted/caughtUp check uses the pistachio-lime palette, not emerald', () => {
    expect(indexCss).toContain('--color-status-check-done: #a7e85b;')
    expect(indexCss.toLowerCase()).not.toMatch(/--color-status-check-done:\s*#72c9a4/)
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

  it('notReady: a genuinely unresolved row (no episode, no status) is quiet and non-actionable, never falsely green', () => {
    const html = staticHtml(unresolvedShow, { canQuickMark: false })
    expect(html).toContain("data-status=\"notReady\"")
    expect(html).toContain('disabled=""')
    expect(html).not.toContain("data-status=\"caughtUp\"")
    expect(html).not.toContain('aria-label="Caught up with The Sopranos"')
  })

  it('an available row not yet ready renders grey (available), never notReady — no false-unknown state', () => {
    const html = staticHtml(nextUpShow, { canQuickMark: false })
    expect(html).toContain('data-status="available"')
    expect(html).toContain('disabled=""')
  })

  it('a caught-up show that has not yet loaded its mutation context still reads caughtUp (green) immediately — fresh-launch regression', () => {
    const html = staticHtml(caughtUpShow, { canQuickMark: false })
    expect(html).toContain("data-status=\"caughtUp\"")
    expect(html).toContain('disabled=""')
    expect(html).not.toContain("data-status=\"notReady\"")
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
    const html = staticHtml(unresolvedShow, { canQuickMark: false })
    expect(html).toContain('aria-label="Loading watch status for The Sopranos"')
  })

  it('an available-but-not-ready row uses a truthful non-actionable label, never claiming it is currently tappable', () => {
    const html = staticHtml(nextUpShow, { canQuickMark: false })
    expect(html).toContain('aria-label="Loading watch status for The Sopranos"')
    expect(html).not.toContain('aria-label="Mark S2E5 of The Sopranos watched"')
  })

  it('a caught-up-but-not-ready row keeps its caught-up label, not a loading label', () => {
    const html = staticHtml(caughtUpShow, { canQuickMark: false })
    expect(html).toContain('aria-label="Caught up with The Sopranos"')
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

  it('a truly unresolved row cannot be activated even if clicked', async () => {
    const { button, onQuickMark } = await mount(unresolvedShow, { canQuickMark: false })
    await click(button())
    expect(onQuickMark).not.toHaveBeenCalled()
    expect(button().getAttribute('data-status')).toBe('notReady')
  })

  it('an available-but-not-ready row cannot be activated even if clicked, despite already being grey', async () => {
    const { button, onQuickMark } = await mount(nextUpShow, { canQuickMark: false })
    expect(button().getAttribute('data-status')).toBe('available')
    await click(button())
    expect(onQuickMark).not.toHaveBeenCalled()
    expect(button().getAttribute('data-status')).toBe('available')
  })

  it('readiness resolving from notReady to available produces the correct grey state with no dimension change', async () => {
    const { button, update } = await mount(unresolvedShow, { canQuickMark: false })
    expect(button().getAttribute('data-status')).toBe('notReady')
    expect(button().className).toContain('watching-status-button')

    await update(nextUpShow, { canQuickMark: true })
    expect(button().getAttribute('data-status')).toBe('available')
    // Same base class/footprint before and after — only the state attribute changed.
    expect(button().className).toContain('watching-status-button')
  })
})

// Regression coverage for the grey → green replay on fresh app launch: a
// cached row already knows its status well before readyShowIds/canQuickMark
// hydrates. These tests rerender the exact same row data with only
// canQuickMark changing, proving color/visual state never moves on that
// transition alone — only interactivity does.
describe('status button — fresh-launch hydration does not replay color', () => {
  it('a cached caught-up row with canQuickMark=false renders green (caughtUp) immediately, disabled, with a caught-up label', () => {
    const html = staticHtml(caughtUpShow, { canQuickMark: false })
    expect(html).toContain('data-status="caughtUp"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-label="Caught up with The Sopranos"')
  })

  it('updating only canQuickMark from false to true on a caught-up row does not change its visual state or produce an accepted animation', async () => {
    const { button, update, onQuickMark } = await mount(caughtUpShow, { canQuickMark: false })
    expect(button().getAttribute('data-status')).toBe('caughtUp')
    expect(button().disabled).toBe(true)

    await update(caughtUpShow, { canQuickMark: true })
    expect(button().getAttribute('data-status')).toBe('caughtUp')
    expect(onQuickMark).not.toHaveBeenCalled()
  })

  it('a cached countdown row with no released unwatched episode renders green immediately and does not replay on readiness', async () => {
    const { button, update } = await mount(countdownShow, { canQuickMark: false })
    expect(button().getAttribute('data-status')).toBe('caughtUp')
    await update(countdownShow, { canQuickMark: true })
    expect(button().getAttribute('data-status')).toBe('caughtUp')
  })

  it('a cached completed row renders green immediately and does not replay on readiness', async () => {
    const { button, update } = await mount(completedShow, { canQuickMark: false })
    expect(button().getAttribute('data-status')).toBe('caughtUp')
    await update(completedShow, { canQuickMark: true })
    expect(button().getAttribute('data-status')).toBe('caughtUp')
  })

  it('a cached available row renders grey while canQuickMark=false, stays disabled, and readiness only enables it (no color change, never caughtUp)', async () => {
    const { button, update } = await mount(nextUpShow, { canQuickMark: false })
    expect(button().getAttribute('data-status')).toBe('available')
    expect(button().disabled).toBe(true)

    await update(nextUpShow, { canQuickMark: true })
    expect(button().getAttribute('data-status')).toBe('available')
    expect(button().disabled).toBe(false)
  })

  it('a truly unresolved row stays notReady until authoritative data arrives, then resolves to available or caughtUp as appropriate', async () => {
    const { button, update: updateAvailable } = await mount(unresolvedShow, { canQuickMark: false })
    expect(button().getAttribute('data-status')).toBe('notReady')
    await updateAvailable(nextUpShow, { canQuickMark: true })
    expect(button().getAttribute('data-status')).toBe('available')

    const { button: button2, update: updateCaughtUp } = await mount(unresolvedShow, { canQuickMark: false })
    expect(button2().getAttribute('data-status')).toBe('notReady')
    await updateCaughtUp(caughtUpShow, { canQuickMark: true })
    expect(button2().getAttribute('data-status')).toBe('caughtUp')
  })

  it('a real later data change (new weekly episode released) still flips a caught-up row from green to grey, gated by readiness', async () => {
    const { button, update } = await mount(caughtUpShow, { canQuickMark: true })
    expect(button().getAttribute('data-status')).toBe('caughtUp')

    const releasedShow = baseShow({
      status: { type: 'nextUp', season_number: 3, episode_number: 1, name: 'Premiere' },
      nextReleasedUnwatchedEpisode: { season_number: 3, episode_number: 1, name: 'Premiere', runtime: 55 },
    })
    await update(releasedShow, { canQuickMark: false })
    expect(button().getAttribute('data-status')).toBe('available')
    expect(button().disabled).toBe(true)

    await update(releasedShow, { canQuickMark: true })
    expect(button().getAttribute('data-status')).toBe('available')
    expect(button().disabled).toBe(false)
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

// Regression coverage for the grey→green→(new episode)→grey desync bug: the
// row's own "Up next" text used to read straight off the live show object,
// so a fast optimistic advance (backlog shows like The Sopranos, where the
// next episode is already released) could repaint the episode text before
// the accepted-green confirmation released, producing an unsynchronized
// old-episode+grey → new-episode+green → new-episode+grey sequence. The
// text must stay pinned to the pre-tap episode for exactly as long as the
// accepted confirmation is active, and swap in the same render that the
// confirmation clears — never a frame apart, in either direction. The
// underlying mutation/cache/optimistic pipeline itself is untouched by this
// (see Watching.quickMark.test.jsx for that coverage) — only the row's own
// presentational text is ever pinned here.
describe('status button — visible status text stays synchronized with accepted confirmation', () => {
  it('backlog: text stays pinned through dwell even after the row has already advanced, then swaps atomically with the button', async () => {
    vi.useFakeTimers()
    const { button, update } = await mount(nextUpShow)
    await click(button())
    expect(container.textContent).toContain('Up next: S2E5 · Ep 5')

    // Optimistic advance lands almost immediately — well before the dwell.
    await update(advancedShow, { isQuickMarking: true })
    expect(button().getAttribute('data-status')).toBe('accepted')
    expect(container.textContent).toContain('Up next: S2E5 · Ep 5')
    expect(container.textContent).not.toContain('S2E6')

    await act(async () => { vi.advanceTimersByTime(340) })
    expect(button().getAttribute('data-status')).toBe('available')
    expect(container.textContent).toContain('Up next: S2E6 · Ep 6')
    expect(container.textContent).not.toContain('S2E5')
  })

  it('opposite ordering: text stays pinned through the dwell window, then swaps atomically once the row later advances', async () => {
    vi.useFakeTimers()
    const { button, update } = await mount(nextUpShow)
    await click(button())
    expect(container.textContent).toContain('Up next: S2E5 · Ep 5')

    await act(async () => { vi.advanceTimersByTime(340) })
    expect(button().getAttribute('data-status')).toBe('accepted')
    expect(container.textContent).toContain('Up next: S2E5 · Ep 5')

    await update(advancedShow, { isQuickMarking: false })
    expect(button().getAttribute('data-status')).toBe('available')
    expect(container.textContent).toContain('Up next: S2E6 · Ep 6')
  })

  it('weekly/caught-up: keeps the pre-tap "Up next" text through confirmation, then swaps to caught-up text with the check staying green', async () => {
    vi.useFakeTimers()
    const { button, update } = await mount(nextUpShow)
    await click(button())
    await update(caughtUpShow, { isQuickMarking: true })
    expect(button().getAttribute('data-status')).toBe('accepted')
    expect(container.textContent).toContain('Up next: S2E5 · Ep 5')

    await act(async () => { vi.advanceTimersByTime(340) })
    await update(caughtUpShow, { isQuickMarking: false })
    expect(button().getAttribute('data-status')).toBe('caughtUp')
    expect(container.textContent).toContain('Caught up')
    expect(container.textContent).not.toContain('S2E5')
  })

  it('finished show: keeps the pre-tap episode text through confirmation, then swaps to the completed caught-up text with the check staying green', async () => {
    vi.useFakeTimers()
    const { button, update } = await mount(nextUpShow)
    await click(button())
    await update(completedShow, { isQuickMarking: true })
    expect(button().getAttribute('data-status')).toBe('accepted')
    expect(container.textContent).toContain('Up next: S2E5 · Ep 5')

    await act(async () => { vi.advanceTimersByTime(340) })
    await update(completedShow, { isQuickMarking: false })
    expect(button().getAttribute('data-status')).toBe('caughtUp')
    expect(container.textContent).toContain('Caught up')
  })

  it('failure/rollback: clears the pinned snapshot immediately — text and button both revert to the original available state', async () => {
    vi.useFakeTimers()
    const { button, update } = await mount(nextUpShow)
    await click(button())
    await update(advancedShow, { isQuickMarking: true })
    expect(container.textContent).toContain('Up next: S2E5 · Ep 5')

    // Mutation fails and Watching.jsx rolls the row back well before dwell.
    await act(async () => { vi.advanceTimersByTime(50) })
    await update(nextUpShow, { isQuickMarking: false })

    expect(button().getAttribute('data-status')).toBe('available')
    expect(button().getAttribute('aria-label')).toBe('Mark S2E5 of The Sopranos watched')
    expect(container.textContent).toContain('Up next: S2E5 · Ep 5')
  })

  it('no active confirmation: an ordinary live status update renders immediately, with no pinning', async () => {
    const { update } = await mount(nextUpShow)
    expect(container.textContent).toContain('Up next: S2E5 · Ep 5')
    await update(advancedShow)
    expect(container.textContent).toContain('Up next: S2E6 · Ep 6')
  })

  it('does not leak a captured status snapshot across a show-identity change while accepted confirmation is active', async () => {
    vi.useFakeTimers()
    const { button, update } = await mount(nextUpShow)
    await click(button())
    expect(container.textContent).toContain('Up next: S2E5 · Ep 5')

    const otherShow = baseShow({
      id: 2,
      tmdb_id: 200,
      name: 'Better Call Saul',
      status: { type: 'nextUp', season_number: 1, episode_number: 1, name: 'Uno' },
      nextReleasedUnwatchedEpisode: { season_number: 1, episode_number: 1, name: 'Uno', runtime: 47 },
    })
    await update(otherShow)

    expect(container.textContent).toContain('Up next: S1E1 · Uno')
    expect(container.textContent).not.toContain('S2E5')
    expect(button().getAttribute('data-status')).toBe('available')
    expect(button().getAttribute('aria-label')).toBe('Mark S1E1 of Better Call Saul watched')

    // The stale timer from the abandoned confirmation must not fire a stray
    // update against the new show later.
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(container.textContent).toContain('Up next: S1E1 · Uno')
  })

  it('clears its confirmation timer safely on unmount mid-dwell, with no post-unmount state update', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { button } = await mount(nextUpShow)
    await click(button())
    await act(async () => { root.unmount() })
    root = null
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

// Desktop review blocker: the permanent status button and the desktop-hover
// Remove control used to share the same right-2 anchor and could visually
// collide. The hover Remove now sits immediately to the left of the status
// button (right-[3.75rem] vs right-2), vertically centered like it, with a
// dedicated desktop-only text reserve so long titles never run under either.
describe('desktop layout — status button and hover Remove occupy distinct positions', () => {
  it('the hover Remove control is anchored to the left of the status button, both vertically centered', () => {
    const html = staticHtml(nextUpShow)
    expect(html).toMatch(
      /class="motion-press watching-row-hover-remove absolute top-1\/2 right-\[3\.75rem\] -translate-y-1\/2 flex h-7 w-7[^"]*"/,
    )
    expect(html).toMatch(/class="motion-press watching-status-button absolute top-1\/2 right-2 -translate-y-1\/2"/)
  })

  it('mobile reserves text width only for the status button; desktop reserves extra width for both controls', () => {
    const baseRuleStart = indexCss.indexOf('.watching-row-link {')
    const baseRule = indexCss.slice(baseRuleStart, indexCss.indexOf('}', baseRuleStart) + 1)
    expect(baseRule).toContain('padding-right: 3.5rem')

    const hoverBlockStart = indexCss.indexOf(
      '@media (hover: hover) and (pointer: fine) {\n  /* The hover-revealed Remove control',
    )
    expect(hoverBlockStart).toBeGreaterThan(-1)
    const hoverBlockEnd = indexCss.indexOf('\n}', indexCss.indexOf('padding-right: 6rem', hoverBlockStart)) + 2
    const hoverBlock = indexCss.slice(hoverBlockStart, hoverBlockEnd)
    expect(hoverBlock).toContain('padding-right: 6rem')
  })

  it('the status button and hover Remove are two separate elements that each invoke only their own handler', async () => {
    const onRemove = vi.fn()
    const onQuickMark = vi.fn()
    const localContainer = document.createElement('div')
    document.body.appendChild(localContainer)
    const localRoot = createRoot(localContainer)
    await act(async () => {
      localRoot.render(
        <MemoryRouter>
          <WatchingRow
            show={nextUpShow}
            isRemoving={false}
            isOpen={false}
            onOpenChange={vi.fn()}
            onRemove={onRemove}
            onQuickMark={onQuickMark}
            isQuickMarking={false}
            canQuickMark={true}
          />
        </MemoryRouter>,
      )
    })

    const hoverRemove = localContainer.querySelector('.watching-row-hover-remove')
    const statusButton = localContainer.querySelector('.watching-status-button')
    expect(hoverRemove).not.toBeNull()
    expect(statusButton).not.toBeNull()
    expect(hoverRemove).not.toBe(statusButton)

    await act(async () => {
      hoverRemove.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledWith(nextUpShow)
    expect(onQuickMark).not.toHaveBeenCalled()

    await act(async () => {
      statusButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onQuickMark).toHaveBeenCalledTimes(1)
    expect(onQuickMark).toHaveBeenCalledWith(nextUpShow)
    expect(onRemove).toHaveBeenCalledTimes(1)

    await act(async () => localRoot.unmount())
    localContainer.remove()
  })
})
